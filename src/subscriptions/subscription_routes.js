const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");

const db = require("../config/db");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const subscriptions = require("./subscription_service");
const payments = require("./subscription_payment_service");
const mpesa = require("./subscription_mpesa");
const { build_receipt, receipt_number } = require("./subscription_receipt");
const { callback_ip_allowed } = require("../payments/mpesa/c2b_callback_security");

/*
  The landlord's Billing tab (owners only; caretakers see the
  account's state through /api/auth/me), and the address where
  Safaricom sends payment results.
*/
const router = express.Router();

function parse(schema, data, message = "Invalid request data.") {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error(message);

    error.status_code = 422;
    error.details = result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
    throw error;
  }

  return result.data;
}

const id_param = z.coerce.number().int().positive();

function respond(handler, status = 200) {
  return async (req, res, next) => {
    try {
      return res.status(status).json({ success: true, data: await handler(req) });
    } catch (error) {
      next(error);
    }
  };
}

/*
  Safaricom's result address. The secret in the path is long and
  random; a wrong one is answered like any unknown address. The
  answer goes back at once and the result is checked afterwards.
*/
const result_limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: "draft-8", legacyHeaders: false });

router.post("/stk-result/:secret", result_limiter, (req, res) => {
  if (!callback_ip_allowed(req.ip) || !mpesa.result_secret_matches(req.params.secret)) {
    return res.status(404).json({ success: false, error: "Route not found." });
  }

  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  payments.handle_result(req.body, req.ip).catch((error) => {
    console.error("[SUBSCRIPTIONS] Handling a payment result failed:", error.message);
  });

  return undefined;
});

// The landing page's prices (public: the cards that are on, nothing about any landlord).
const pricing_limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: "draft-8", legacyHeaders: false });

router.get(
  "/pricing",
  pricing_limiter,
  respond(async () => subscriptions.public_pricing())
);

// Every signed-in billing request is limited per network address (well above normal use).
const account_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});

/*
  Someone waiting for owner access says which card they picked on the
  home page, so the admin sees it with the new account.
*/
router.put(
  "/requested-plan",
  account_limiter,
  authenticate,
  require_role("user"),
  respond(async (req) => {
    const { months } = parse(z.object({ months: z.number().int().min(1).max(24) }).strict(), req.body || {});
    const offered = (await subscriptions.list_plans(db, { enabled_only: true })).some((plan) => plan.months === months);

    if (!offered) {
      const error = new Error("That plan is not offered.");

      error.status_code = 422;
      throw error;
    }

    await db.query("UPDATE users SET requested_plan_months = $2 WHERE user_id = $1 AND role = 'user'", [req.user.user_id, months]);
    // The admin's bell looks again.
    await db.query(`SELECT pg_notify('bell_changed', '{"to":"admin"}')`);

    return { months };
  })
);

const owner_guard = [account_limiter, authenticate, require_role("owner")];

router.get("/", owner_guard, respond((req) => subscriptions.owner_summary(req.user.user_id)));

// Per network address (an office may have several landlords); each owner is also limited to 3 prompts in 10 minutes.
const pay_limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many payment requests. Please wait a few minutes." },
});

const pay_schema = z
  .object({
    phone: z.string().trim().max(20).optional(),
    plan_months: z.number().int().min(2).max(24).nullable().optional(),
  })
  .strict();

router.post(
  "/pay",
  pay_limiter,
  owner_guard,
  respond((req) => {
    const body = parse(pay_schema, req.body || {});

    return payments.request_payment({
      owner_id: req.user.user_id,
      phone_input: body.phone,
      plan_months: body.plan_months || null,
      requested_by: req.user.acting_admin_id || req.user.user_id,
      ip_address: req.ip,
      // The admin inside the account sees M-Pesa's own reason.
      show_details: Boolean(req.user.acting_admin_id),
    });
  })
);

router.get(
  "/payment-requests/:stk_id",
  owner_guard,
  respond((req) => payments.payment_request_status(req.user.user_id, parse(id_param, req.params.stk_id)))
);

/*
  A receipt PDF, for the owner's own payments (and the admin's
  Billing page, through admin_billing_routes).
*/
async function send_receipt(res, payment_id, owner_id = null) {
  const payment = await subscriptions.get_payment(payment_id);

  if (!payment || (owner_id && String(payment.owner_id) !== String(owner_id))) {
    return res.status(404).json({ success: false, error: "Receipt not found." });
  }

  const invoice = payment.invoice_id ? await subscriptions.get_invoice(payment.invoice_id) : null;
  const owner = (await db.query("SELECT first_name, last_name, phone FROM users WHERE user_id = $1", [payment.owner_id])).rows[0];
  const pdf = await build_receipt({ payment, invoice, owner });

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${receipt_number(payment)}.pdf"`,
    "Cache-Control": "no-store",
  });

  return res.status(200).send(pdf);
}

router.get("/receipts/:payment_id", owner_guard, async (req, res, next) => {
  try {
    return await send_receipt(res, parse(id_param, req.params.payment_id), req.user.user_id);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.send_receipt = send_receipt;
module.exports.parse = parse;
module.exports.respond = respond;
