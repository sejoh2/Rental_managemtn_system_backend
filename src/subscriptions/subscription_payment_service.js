const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  normalize_phone,
  mask_phone,
} = require("../utils/phone");

const {
  send_sms,
} = require("../utils/sms_provider");

const subscriptions = require("./subscription_service");
const mpesa = require("./subscription_mpesa");
const dates = require("./subscription_dates");

const { service_error } = subscriptions;

/*
  Paying Kodi by M-Pesa STK push. A payment counts only when:
  - Kodi made the request itself (its CheckoutRequestID is ours),
  - the amount Safaricom reports is exactly the amount asked,
  - the M-Pesa receipt has never been used before, and
  - Safaricom confirms it when asked directly (STK Query), so a
    forged result message cannot mark a bill paid.
  The amount always comes from the bill, never from the request.
*/

const REQUESTS_PER_10_MINUTES = 3;
const WAIT_BETWEEN_REQUESTS_SECONDS = 90;

const money = (amount) => `KSh ${Number(amount).toLocaleString("en-KE")}`;

async function notify_owner(owner_id, message) {
  const owner = (await db.query("SELECT phone FROM users WHERE user_id = $1", [owner_id])).rows[0];

  if (!owner?.phone) return;

  try {
    await send_sms({ phone: owner.phone, message });
  } catch (error) {
    console.error("[SUBSCRIPTIONS] SMS to the owner failed:", error.message);
  }
}

async function void_prepaid(client, invoice_id) {
  await client.query(
    "UPDATE subscription_invoices SET status = 'void', void_reason = 'The M-Pesa payment did not go through.' WHERE invoice_id = $1 AND kind = 'prepaid' AND status = 'open'",
    [invoice_id]
  );
}

/*
  Sends the prompt for the current bill, or for a prepaid plan.
  phone_input defaults to the owner's sign-in phone.
*/
async function request_payment({ owner_id, phone_input, plan_months = null, requested_by = null, automatic = false, ip_address = null }) {
  if (!mpesa.configured()) {
    throw service_error("M-Pesa payments to Kodi are not set up yet. Please contact Kodi to pay.", 503);
  }

  const owner = (await db.query("SELECT user_id, phone FROM users WHERE user_id = $1 AND role = 'owner'", [owner_id])).rows[0];

  if (!owner) throw service_error("Owner account not found.", 404);

  const phone = normalize_phone(phone_input || owner.phone);

  if (!phone) throw service_error("Enter a valid Kenyan M-Pesa phone number.", 422);

  if (!automatic) {
    const recent = (
      await db.query(
        `SELECT COUNT(*)::INT AS count,
                MAX(created_at) FILTER (WHERE status IN ('sending', 'sent', 'confirming')) AS waiting_since
         FROM subscription_stk_requests
         WHERE owner_id = $1 AND NOT automatic AND created_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes'`,
        [owner_id]
      )
    ).rows[0];

    if (recent.waiting_since && Date.now() - new Date(recent.waiting_since).getTime() < WAIT_BETWEEN_REQUESTS_SECONDS * 1000) {
      throw service_error("A payment request was just sent. Check your phone and enter your M-Pesa PIN.", 409);
    }

    if (recent.count >= REQUESTS_PER_10_MINUTES) {
      throw service_error("Too many payment requests. Please wait 10 minutes and try again.", 429);
    }
  }

  let invoice;

  if (plan_months) {
    invoice = await subscriptions.create_prepaid_invoice(owner_id, plan_months);
  } else {
    invoice = (await subscriptions.ensure_monthly_invoice(owner_id)).invoice;

    if (!invoice || invoice.status !== "open") throw service_error("There is nothing to pay right now.", 409);
  }

  if (invoice.amount_due < 1) throw service_error("There is nothing to pay right now.", 409);

  const request = (
    await db.query(
      `INSERT INTO subscription_stk_requests (owner_id, invoice_id, phone, amount, requested_by, automatic)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [owner_id, invoice.invoice_id, phone, invoice.amount_due, requested_by, automatic]
    )
  ).rows[0];

  try {
    const sent = await mpesa.stk_push({
      phone: phone.slice(1),
      amount: invoice.amount_due,
      account_reference: `KODI${owner_id}`,
      description: "Kodi bill",
    });

    await db.query(
      "UPDATE subscription_stk_requests SET status = 'sent', checkout_request_id = $2, merchant_request_id = $3 WHERE stk_id = $1",
      [request.stk_id, sent.checkout_request_id, sent.merchant_request_id]
    );
  } catch (error) {
    await db.query(
      "UPDATE subscription_stk_requests SET status = 'failed', result_desc = $2, completed_at = CURRENT_TIMESTAMP WHERE stk_id = $1",
      [request.stk_id, String(error.message).slice(0, 500)]
    );
    await void_prepaid(db, invoice.invoice_id);

    throw service_error(`The payment request could not be sent: ${error.message}`, 502);
  }

  await log_audit({
    user_id: requested_by,
    owner_id,
    action: "SUBSCRIPTION_PAYMENT_REQUESTED",
    entity_type: "subscription_invoice",
    entity_id: invoice.invoice_id,
    metadata: { stk_id: request.stk_id, amount: invoice.amount_due, phone: mask_phone(phone), plan_months, automatic },
    ip_address,
  });

  return { stk_id: request.stk_id, amount: invoice.amount_due, phone: mask_phone(phone), status: "sent" };
}

async function payment_request_status(owner_id, stk_id) {
  const row = (
    await db.query(
      "SELECT stk_id, amount, status, result_desc, mpesa_receipt, created_at, completed_at FROM subscription_stk_requests WHERE stk_id = $1 AND owner_id = $2",
      [stk_id, owner_id]
    )
  ).rows[0];

  if (!row) throw service_error("Payment request not found.", 404);

  return row;
}

/*
  Counts the payment: once, in one transaction. A request whose
  bill was closed meanwhile pays the open bill of the same amount;
  otherwise the money is recorded and the admin is told.
*/
async function finalize(stk_id, { receipt = null, phone = null } = {}) {
  const outcome = await subscriptions.in_transaction(async (client) => {
    const stk = (await client.query("SELECT * FROM subscription_stk_requests WHERE stk_id = $1 FOR UPDATE", [stk_id])).rows[0];

    if (!stk || !["sent", "confirming"].includes(stk.status)) return null;

    const used_receipt = receipt || stk.mpesa_receipt || null;
    const payment = (
      await client.query(
        `INSERT INTO subscription_payments (owner_id, invoice_id, method, amount, mpesa_receipt, reference, phone, paid_on)
         VALUES ($1, $2, 'mpesa_stk', $3, $4, $5, $6, $7)
         ON CONFLICT (mpesa_receipt) WHERE mpesa_receipt IS NOT NULL DO NOTHING
         RETURNING payment_id`,
        [stk.owner_id, stk.invoice_id, stk.amount, used_receipt, `STK ${stk.checkout_request_id}`, phone ? normalize_phone(phone) || stk.phone : stk.phone, dates.today()]
      )
    ).rows[0];

    if (!payment) {
      await client.query(
        "UPDATE subscription_stk_requests SET status = 'failed', result_desc = 'This M-Pesa receipt was already counted.', completed_at = CURRENT_TIMESTAMP WHERE stk_id = $1",
        [stk_id]
      );
      return { duplicate: true, stk };
    }

    let settled = await subscriptions.settle_invoice(client, stk.invoice_id);

    if (!settled) {
      const open = (
        await client.query(
          "SELECT invoice_id FROM subscription_invoices WHERE owner_id = $1 AND kind = 'monthly' AND status = 'open' AND amount_due = $2",
          [stk.owner_id, stk.amount]
        )
      ).rows[0];

      if (open) {
        settled = await subscriptions.settle_invoice(client, open.invoice_id);
        await client.query("UPDATE subscription_payments SET invoice_id = $2 WHERE payment_id = $1", [payment.payment_id, open.invoice_id]);
      }
    }

    await client.query(
      "UPDATE subscription_stk_requests SET status = 'paid', mpesa_receipt = COALESCE($2, mpesa_receipt), completed_at = CURRENT_TIMESTAMP WHERE stk_id = $1",
      [stk_id, used_receipt]
    );

    return { stk, payment_id: payment.payment_id, settled, receipt: used_receipt };
  });

  if (!outcome) return null;

  if (outcome.duplicate) {
    await log_audit({ owner_id: outcome.stk.owner_id, action: "SUBSCRIPTION_PAYMENT_DUPLICATE_RECEIPT", entity_type: "subscription_stk", entity_id: stk_id, metadata: { receipt } });
    return null;
  }

  await log_audit({
    owner_id: outcome.stk.owner_id,
    action: outcome.settled ? "SUBSCRIPTION_PAID" : "SUBSCRIPTION_PAYMENT_UNAPPLIED",
    entity_type: "subscription_payment",
    entity_id: outcome.payment_id,
    metadata: { amount: outcome.stk.amount, receipt: outcome.receipt, paid_through: outcome.settled?.paid_through || null, stk_id },
  });

  if (outcome.settled) {
    await notify_owner(
      outcome.stk.owner_id,
      `Kodi: payment received, ${money(outcome.stk.amount)}${outcome.receipt ? `, M-Pesa ${outcome.receipt}` : ""}. Paid until ${dates.label(outcome.settled.paid_through)}. Your receipt is in Kodi, Settings, Billing. Thank you!`
    );
  }

  return outcome;
}

/*
  Asks Safaricom how the request ended and acts on it. Used after a
  result message and for requests whose result never came.
*/
async function confirm(stk) {
  let status;

  try {
    status = await mpesa.stk_status(stk.checkout_request_id);
  } catch (error) {
    await db.query("UPDATE subscription_stk_requests SET checks = checks + 1 WHERE stk_id = $1", [stk.stk_id]);

    if (!error.pending && stk.checks + 1 >= 15) {
      await db.query(
        "UPDATE subscription_stk_requests SET status = 'expired', result_desc = $2, completed_at = CURRENT_TIMESTAMP WHERE stk_id = $1 AND status IN ('sent', 'confirming')",
        [stk.stk_id, `Safaricom could not confirm it: ${error.message}`.slice(0, 500)]
      );
    }

    return "unknown";
  }

  if (status.result_code === "0") {
    await finalize(stk.stk_id);
    return "paid";
  }

  if (status.result_code === null) return "unknown";

  await subscriptions.in_transaction(async (client) => {
    const changed = (
      await client.query(
        `UPDATE subscription_stk_requests SET status = $2, result_code = $3, result_desc = $4, completed_at = CURRENT_TIMESTAMP
         WHERE stk_id = $1 AND status IN ('sent', 'confirming') RETURNING invoice_id`,
        [stk.stk_id, status.result_code === "1032" ? "cancelled" : "failed", status.result_code, status.result_desc]
      )
    ).rows[0];

    if (changed) await void_prepaid(client, changed.invoice_id);
  });

  return "failed";
}

/*
  Safaricom's result message (public address, secret in the path).
  Kept as received; acted on only after the checks above.
*/
async function handle_result(payload, ip_address) {
  const result = payload?.Body?.stkCallback;
  const checkout_request_id = typeof result?.CheckoutRequestID === "string" ? result.CheckoutRequestID.slice(0, 100) : null;

  await db.query("INSERT INTO subscription_stk_events (checkout_request_id, payload, ip_address) VALUES ($1, $2, $3)", [
    checkout_request_id,
    JSON.stringify(payload || {}).slice(0, 20000),
    ip_address,
  ]);

  if (!checkout_request_id) return;

  const stk = (await db.query("SELECT * FROM subscription_stk_requests WHERE checkout_request_id = $1", [checkout_request_id])).rows[0];

  if (!stk || !["sent", "confirming"].includes(stk.status)) return;

  if (String(result.ResultCode) !== "0") {
    // Not paid. Still confirmed with Safaricom before closing it.
    await confirm(stk);
    return;
  }

  const items = Object.fromEntries((result.CallbackMetadata?.Item || []).map((item) => [item.Name, item.Value]));
  const receipt = /^[A-Z0-9]{8,12}$/.test(String(items.MpesaReceiptNumber || "")) ? String(items.MpesaReceiptNumber) : null;

  if (Number(items.Amount) !== stk.amount || !receipt) {
    await db.query(
      "UPDATE subscription_stk_requests SET status = 'failed', result_desc = $2, completed_at = CURRENT_TIMESTAMP WHERE stk_id = $1",
      [stk.stk_id, `The result did not match the request (amount ${items.Amount}, receipt ${items.MpesaReceiptNumber}). Check M-Pesa and record it by hand if the money arrived.`.slice(0, 500)]
    );
    await log_audit({
      owner_id: stk.owner_id,
      action: "SUBSCRIPTION_PAYMENT_RESULT_MISMATCH",
      entity_type: "subscription_stk",
      entity_id: stk.stk_id,
      metadata: { expected: stk.amount, reported: items.Amount ?? null, receipt: items.MpesaReceiptNumber ?? null, ip_address },
    });
    return;
  }

  await db.query("UPDATE subscription_stk_requests SET status = 'confirming', mpesa_receipt = $2 WHERE stk_id = $1 AND status = 'sent'", [stk.stk_id, receipt]);

  await confirm({ ...stk, status: "confirming", mpesa_receipt: receipt });
}

// Requests without a result yet: asked about after a minute, then every minute.
async function check_waiting_requests() {
  await db.query(
    `UPDATE subscription_stk_requests SET status = 'expired', result_desc = 'The request was not sent.', completed_at = CURRENT_TIMESTAMP
     WHERE status = 'sending' AND created_at < CURRENT_TIMESTAMP - INTERVAL '2 minutes'`
  );

  const waiting = (
    await db.query(
      `SELECT * FROM subscription_stk_requests
       WHERE status IN ('sent', 'confirming') AND created_at < CURRENT_TIMESTAMP - INTERVAL '1 minute'
       ORDER BY created_at LIMIT 20`
    )
  ).rows;

  for (const stk of waiting) {
    try {
      await confirm(stk);
    } catch (error) {
      console.error("[SUBSCRIPTIONS] Checking a payment failed:", error.message);
    }
  }

  return waiting.length;
}

module.exports = {
  request_payment,
  payment_request_status,
  handle_result,
  confirm,
  finalize,
  check_waiting_requests,
  notify_owner,
  money,
};
