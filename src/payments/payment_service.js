const db = require("../config/db");

const {
  decrypt_json,
} = require("../utils/crypto");

const {
  normalize_phone,
} = require("../utils/phone");

const {
  simulate_c2b_payment,
} = require("./mpesa/daraja_c2b_client");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  get_payment_routing,
  apply_tenant_credits,
} = require("../billing/billing_service");

const {
  to_cents,
  from_cents,
} = require("../utils/money");

const {
  add_to_settlement_refund,
  refresh_settlement,
  check_payment_can_be_reversed,
  take_back_settlement_refund,
} = require("../deposits/settlement_live");

const {
  mpesa_paid_at,
} = require("./mpesa/mpesa_time");

function public_payment(payment) {
  return {
    id: payment.id,

    property_id: payment.property_id || null,

    unit_id: payment.unit_id || null,

    tenant_id: payment.tenant_id || null,

    tenant_name: payment.tenant_name || null,
    unit_number: payment.unit_number || null,
    property_name: payment.property_name || null,

    amount: Number(payment.amount),

    payment_method: payment.payment_method,
    payment_source: payment.payment_source,

    account_for: payment.account_for,

    provider_transaction_id:
      payment.provider_transaction_id,

    payer_phone: payment.payer_phone,
    reference: payment.reference,

    received_at: payment.received_at,
    received_at_local: payment.received_at_local || null,

    status: payment.status,
    match_type: payment.match_type,

    unmatched_reason: payment.unmatched_reason,

    notes: payment.notes || null,

    /*
      Who typed in a payment recorded by hand; null for a
      payment that arrived from M-Pesa.
    */
    recorded_by_name: payment.recorded_by_name || null,
    matched_at: payment.matched_at || null,
    created_at: payment.created_at || null,

    reversed_at: payment.reversed_at || null,
    reverse_reason: payment.reverse_reason || null,

    // When Kodi heard of an M-Pesa payment; received_at is when it was paid.
    notified_at: payment.notified_at || null,

    // "Not a tenant payment"
    dismissed_at: payment.dismissed_at || null,
    dismiss_reason: payment.dismiss_reason || null,

    // A former tenant's extra, added to the refund owed to them.
    added_to_refund: Number(payment.added_to_refund || 0),

    duplicate_override_reason:
      payment.duplicate_override_reason || null,

    applied_to: payment.applied_to || [],
  };
}

async function get_payment_with_context(
  client,
  payment_id,
  owner_id = null,
  lock = false
) {
  const conditions = ["payments.id = $1"];
  const values = [payment_id];

  if (owner_id) {
    values.push(owner_id);
    conditions.push(
      `payments.owner_id = $${values.length}`
    );
  }

  const result = await client.query(
    `
      SELECT
        payments.*,
        tenants.full_name AS tenant_name,
        units.unit_number,
        properties.name AS property_name,

        TO_CHAR(
          payments.received_at
          AT TIME ZONE 'Africa/Nairobi',
          'YYYY-MM-DD HH24:MI'
        ) AS received_at_local,

        NULLIF(
          TRIM(
            CONCAT(
              recorder.first_name,
              ' ',
              recorder.last_name
            )
          ),
          ''
        ) AS recorded_by_name

      FROM payments
      LEFT JOIN tenants
        ON tenants.id = payments.tenant_id
      LEFT JOIN units
        ON units.id = payments.unit_id
      LEFT JOIN properties
        ON properties.id = payments.property_id
      LEFT JOIN users AS recorder
        ON recorder.user_id = payments.recorded_by
      WHERE ${conditions.join(" AND ")}
      ${lock ? "FOR UPDATE OF payments" : ""}
    `,
    values
  );

  return result.rows[0] || null;
}

async function get_payment_allocations(
  payment_id
) {
  const result = await db.query(
    `
      SELECT
        payment_allocations.amount,
        tenant_charges.charge_type,
        tenant_charges.description,
        tenant_charges.billing_period,
        TO_CHAR(
          tenant_charges.billing_period,
          'Mon YYYY'
        ) AS period_label
      FROM payment_allocations
      INNER JOIN tenant_charges
        ON tenant_charges.id =
          payment_allocations.tenant_charge_id
      WHERE payment_allocations.payment_id = $1
      ORDER BY payment_allocations.id
    `,
    [payment_id]
  );

  return result.rows.map((allocation) => ({
    charge_type: allocation.charge_type,
    description: allocation.description,
    billing_period: allocation.billing_period,
    period_label: allocation.period_label,
    amount: Number(allocation.amount),
  }));
}

async function apply_payment_to_tenant(
  client,
  payment,
  tenant
) {
  // In whole cents, so the split always adds up exactly.
  let remaining_cents = to_cents(payment.amount);

  const routing = await get_payment_routing(
    client,
    tenant.property_id,
    payment.account_for
  );

  /*
    A tenant who has moved out has no accounts to keep apart:
    whatever they pay settles what they still owe, in the
    property's order, whichever account it came into.
  */
  const moved_out = tenant.status === "moved_out";

  const charges_result = await client.query(
    `
      SELECT *
      FROM tenant_charges
      WHERE tenant_id = $1
        AND ($3 OR charge_type = ANY($2))
        AND status IN ('open', 'partial')
      ORDER BY ${routing.order_sql}
      FOR UPDATE
    `,
    [
      tenant.id,
      routing.charge_types,
      moved_out,
    ]
  );

  for (const charge of charges_result.rows) {
    if (remaining_cents <= 0) {
      break;
    }

    const outstanding_cents =
      to_cents(charge.amount_due) -
      to_cents(charge.amount_paid);

    if (outstanding_cents <= 0) {
      continue;
    }

    const allocated_cents = Math.min(
      remaining_cents,
      outstanding_cents
    );

    await client.query(
      `
        INSERT INTO payment_allocations (
          payment_id,
          tenant_charge_id,
          amount
        )
        VALUES ($1,$2,$3::NUMERIC)
      `,
      [
        payment.id,
        charge.id,
        from_cents(allocated_cents),
      ]
    );

    await client.query(
      `
        UPDATE tenant_charges
        SET
          amount_paid = $1::NUMERIC,
          status = CASE
            WHEN $1::NUMERIC >= amount_due THEN 'paid'
            ELSE 'partial'
          END
        WHERE id = $2
      `,
      [
        from_cents(
          to_cents(charge.amount_paid) + allocated_cents
        ),
        charge.id,
      ]
    );

    remaining_cents -= allocated_cents;
  }

  /*
    Money left over is not lost.
    - A former tenant whose deposits are already settled is
      owed it back: it is added to their refund (the owner's
      rule, 2026-10-29).
    - Anyone else keeps it as credit, which pays their next
      bills first.
  */
  if (remaining_cents > 0) {
    const added_to_refund = moved_out
      ? await add_to_settlement_refund(
          client,
          tenant.id,
          payment.id,
          remaining_cents
        )
      : false;

    if (!added_to_refund) {
      await client.query(
        `
          INSERT INTO tenant_credits (
            tenant_id,
            property_id,
            source_payment_id,
            original_amount,
            remaining_amount
          )
          VALUES ($1,$2,$3,$4::NUMERIC,$4::NUMERIC)
        `,
        [
          tenant.id,
          tenant.property_id,
          payment.id,
          from_cents(remaining_cents),
        ]
      );
    }
  }

  /*
    A settled former tenant's figures follow what they pay.
  */
  if (moved_out) {
    await refresh_settlement(client, tenant.id);
  }

  await client.query(
    `
      UPDATE payments
      SET
        tenant_id = $1,
        unit_id = $2,
        status = 'matched',
        matched_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `,
    [
      tenant.id,
      tenant.unit_id,
      payment.id,
    ]
  );
}

// One line in the server log for every payment notice (no names or phones).
const {
  notice_log_line,
} = require("./mpesa/notice_log");

async function receive_mpesa_c2b_confirmation(payload) {
  const provider_transaction_id = String(
    payload.TransID || ""
  ).trim();

  const business_number = String(
    payload.BusinessShortCode || ""
  ).trim();

  const amount = Number(payload.TransAmount);

  const payer_phone = normalize_phone(payload.MSISDN);

  if (
    !provider_transaction_id ||
    !business_number ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Invalid M-Pesa C2B confirmation payload."
    );
  }

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `
        SELECT id
        FROM payments
        WHERE provider_transaction_id = $1
      `,
      [provider_transaction_id]
    );

    /*
      Daraja may retry callbacks. Same transaction is processed once.
    */
    if (existing.rows[0]) {
      await client.query("COMMIT");

      console.log(
        notice_log_line(payload, `sent again, already recorded (${existing.rows[0].id})`)
      );

      return {
        duplicate: true,
        payment_id: existing.rows[0].id,
      };
    }

    const account_result = await client.query(
      `
        SELECT
          payment_accounts.*,
          properties.owner_id,
          properties.id AS property_id
        FROM payment_accounts
        INNER JOIN properties
          ON properties.id =
            payment_accounts.property_id
        WHERE payment_accounts.business_number = $1
          AND payment_accounts.provider_code = 'mpesa'
          AND payment_accounts.status = 'active'
        LIMIT 1
      `,
      [business_number]
    );

    const account = account_result.rows[0] || null;

    let tenant = null;
    let unmatched_reason = null;

    if (!account) {
      unmatched_reason =
        "No active property payment account matches this M-Pesa business number.";
    } else if (!payer_phone) {
      unmatched_reason =
        "M-Pesa did not provide a valid Kenyan payer phone number.";
    } else {
      const tenant_result = await client.query(
        `
          SELECT *
          FROM tenants
          WHERE property_id = $1
            AND payment_phone = $2
            AND status IN ('active', 'notice_given')
          LIMIT 1
          FOR UPDATE
        `,
        [
          account.property_id,
          payer_phone,
        ]
      );

      tenant = tenant_result.rows[0] || null;

      if (!tenant) {
        unmatched_reason =
          "No active tenant in this property is registered with this payment phone.";

        /*
          Never matched to a former tenant by itself (a new tenant
          may have taken the number), but the owner is told whose
          it was, so they can match it in one click.
        */
        const former = await client.query(
          `
            SELECT full_name
            FROM tenants
            WHERE property_id = $1
              AND status = 'moved_out'
              AND payment_phone = $2
            ORDER BY move_out_date DESC NULLS LAST, id DESC
            LIMIT 1
          `,
          [account.property_id, payer_phone]
        );

        if (former.rows[0]) {
          unmatched_reason = `This number belongs to ${former.rows[0].full_name}, who has moved out. Match it to them if it is their payment.`;
        }
      }
    }

    /*
      When the tenant paid, by M-Pesa's own clock; when Kodi
      heard of it is kept separately.
    */
    const notified_at = new Date();
    const received_at = mpesa_paid_at(payload.TransTime, notified_at);

    const payment_result = await client.query(
      `
        INSERT INTO payments (
          owner_id,
          property_id,
          unit_id,
          tenant_id,
          payment_account_id,
          account_for,
          amount,
          payment_method,
          payment_source,
          provider_transaction_id,
          payer_phone,
          reference,
          status,
          match_type,
          unmatched_reason,
          provider_payload,
          received_at,
          notified_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          'mpesa','mpesa_c2b',$8,$9,$10,
          $11,$12,$13,$14,$15,$16
        )
        RETURNING *
      `,
      [
        account?.owner_id || null,
        account?.property_id || null,
        tenant?.unit_id || null,
        tenant?.id || null,
        account?.id || null,
        account?.account_for || null,
        amount,
        provider_transaction_id,
        payer_phone || null,
        payload.BillRefNumber || null,
        tenant ? "matched" : "unmatched",
        tenant ? "automatic" : null,
        unmatched_reason,
        JSON.stringify(payload),
        received_at,
        notified_at,
      ]
    );

    const payment = payment_result.rows[0];

    if (tenant) {
      await apply_payment_to_tenant(
        client,
        payment,
        tenant
      );
    }

    const unit_number = tenant
      ? (
          await client.query(
            "SELECT unit_number FROM units WHERE id = $1",
            [tenant.unit_id]
          )
        ).rows[0]?.unit_number
      : null;

    await client.query("COMMIT");

    console.log(
      notice_log_line(
        payload,
        tenant
          ? `matched to house ${unit_number || "?"} (${payment.id})`
          : `unmatched (${payment.id}): ${
              !account
                ? "no active Kodi payment account has this business number"
                : !payer_phone
                  ? "M-Pesa sent no valid phone number"
                  : "no current tenant of the property pays from this number"
            }`
      )
    );

    /*
      Received automatically from Safaricom, so there is no
      acting user; the entry belongs to the property's owner.
    */
    await log_audit({
      user_id: null,
      owner_id: account?.owner_id || null,
      action: "MPESA_PAYMENT_RECEIVED",
      entity_type: "payment",
      entity_id: payment.id,
      metadata: {
        amount: payment.amount,
        status: tenant ? "matched" : "unmatched",
        tenant_id: tenant?.id || null,
        account_for: account?.account_for || null,
        business_number,
        payer_phone: payer_phone || null,
        provider_transaction_id,
      },
    });

    return {
      duplicate: false,
      payment_id: payment.id,
      status: tenant ? "matched" : "unmatched",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function match_unmatched_payment(
  owner,
  payment_id,
  tenant_id,
  remember_payment_phone,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const payment = await get_payment_with_context(
      client,
      payment_id,
      owner.user_id,
      true
    );

    if (!payment) {
      const error = new Error("Payment not found.");
      error.status_code = 404;
      throw error;
    }

    if (payment.status !== "unmatched") {
      const error = new Error(
        "Only unmatched payments can be manually matched."
      );

      error.status_code = 400;
      throw error;
    }

    const tenant_result = await client.query(
      `
        SELECT *
        FROM tenants
        WHERE id = $1
          AND owner_id = $2
          AND property_id = $3
          AND status IN ('active', 'notice_given', 'moved_out')
        FOR UPDATE
      `,
      [
        tenant_id,
        owner.user_id,
        payment.property_id,
      ]
    );

    const tenant = tenant_result.rows[0];

    if (!tenant) {
      const error = new Error(
        "Choose a tenant of the same property, current or former."
      );

      error.status_code = 422;
      throw error;
    }

    /*
      The number it replaces is kept on the payment, so that
      unassigning the payment can put it back. A former tenant's
      number is never remembered: it no longer matches anything.
    */
    const replaces_phone =
      tenant.status !== "moved_out" &&
      remember_payment_phone &&
      payment.payer_phone &&
      payment.payer_phone !== tenant.payment_phone;

    if (replaces_phone) {
      await client.query(
        `
          UPDATE tenants
          SET payment_phone = $1
          WHERE id = $2
        `,
        [
          payment.payer_phone,
          tenant.id,
        ]
      );
    }

    await client.query(
      `
        UPDATE payments
        SET
          match_type = 'manual',
          matched_by = $1,
          remembered_previous_phone = $3
        WHERE id = $2
      `,
      [
        owner.user_id,
        payment.id,
        replaces_phone ? tenant.payment_phone : null,
      ]
    );

    await apply_payment_to_tenant(
      client,
      payment,
      tenant
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "PAYMENT_MANUALLY_MATCHED",
      entity_type: "payment",
      entity_id: payment.id,
      metadata: {
        tenant_id: tenant.id,
        payer_phone: payment.payer_phone,
        remembered_phone: remember_payment_phone,
      },
      ip_address,
    });

    return get_payment_by_id(owner, payment.id);
  } catch (error) {
    await client.query("ROLLBACK");

    if (
      error.code === "23505" &&
      error.constraint ===
        "uq_active_payment_phone_per_property"
    ) {
      const duplicate_error = new Error(
        "This payment phone is already used by another active tenant in this property."
      );

      duplicate_error.status_code = 409;
      throw duplicate_error;
    }

    throw error;
  } finally {
    client.release();
  }
}

/*
  Undoes a payment that was recorded or assigned wrongly.

  The money is taken back off every charge it paid and any
  credit it left is removed, so the tenant's balance returns
  to what it was before.

  - A manually recorded payment is kept on record as reversed.
  - An M-Pesa payment is real money that did arrive, so it goes
    back to unmatched and can be assigned to the right tenant.
*/
async function reverse_payment(
  owner,
  payment_id,
  reason,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const payment = await get_payment_with_context(
      client,
      payment_id,
      owner.user_id,
      true
    );

    if (!payment) {
      const error = new Error("Payment not found.");
      error.status_code = 404;
      throw error;
    }

    if (payment.status !== "matched") {
      const error = new Error(
        "Only a payment that is matched to a tenant can be reversed."
      );

      error.status_code = 400;
      throw error;
    }

    /*
      A payment the deposit settlement was worked out from waits
      until the owner reopens it (the owner's rule, 2026-10-29).
    */
    await check_payment_can_be_reversed(client, payment);

    const allocations_result = await client.query(
      `
        SELECT *
        FROM payment_allocations
        WHERE payment_id = $1
        FOR UPDATE
      `,
      [payment.id]
    );

    for (const allocation of allocations_result.rows) {
      await client.query(
        `
          UPDATE tenant_charges
          SET
            amount_paid = amount_paid - $1::NUMERIC,
            status = CASE
              WHEN status = 'void' THEN 'void'
              WHEN amount_paid - $1::NUMERIC <= 0 THEN 'open'
              ELSE 'partial'
            END
          WHERE id = $2
        `,
        [allocation.amount, allocation.tenant_charge_id]
      );
    }

    await client.query(
      `
        DELETE FROM payment_allocations
        WHERE payment_id = $1
      `,
      [payment.id]
    );

    await client.query(
      `
        DELETE FROM tenant_credits
        WHERE source_payment_id = $1
      `,
      [payment.id]
    );

    /*
      Charges this payment had settled are open again. If the
      tenant holds credit from another payment, it settles them.
    */
    if (payment.tenant_id) {
      await apply_tenant_credits(client, payment.tenant_id);

      // A settled former tenant's refund and debt follow.
      await take_back_settlement_refund(client, payment);
    }

    const is_manual = payment.payment_source === "manual";

    /*
      Unassigning says the payment was not this tenant's, so
      the number that was remembered from it is not theirs
      either. Their earlier number comes back, unless they have
      changed it since or another tenant now uses it.
    */
    let phone_restored = false;

    if (
      !is_manual &&
      payment.tenant_id &&
      payment.remembered_previous_phone
    ) {
      const restored = await client.query(
        `
          UPDATE tenants
          SET payment_phone = $1
          WHERE id = $2
            AND payment_phone = $3
            AND NOT EXISTS (
              SELECT 1
              FROM tenants AS others
              WHERE others.property_id = tenants.property_id
                AND others.id <> tenants.id
                AND others.payment_phone = $1
                AND others.status IN (
                  'active',
                  'notice_given'
                )
            )
          RETURNING id
        `,
        [
          payment.remembered_previous_phone,
          payment.tenant_id,
          payment.payer_phone,
        ]
      );

      phone_restored = Boolean(restored.rows[0]);

      await client.query(
        `
          UPDATE payments
          SET remembered_previous_phone = NULL
          WHERE id = $1
        `,
        [payment.id]
      );
    }

    if (is_manual) {
      await client.query(
        `
          UPDATE payments
          SET
            status = 'reversed',
            reversed_at = CURRENT_TIMESTAMP,
            reversed_by = $1,
            reverse_reason = $2
          WHERE id = $3
        `,
        [owner.user_id, reason, payment.id]
      );
    } else {
      await client.query(
        `
          UPDATE payments
          SET
            status = 'unmatched',
            tenant_id = NULL,
            unit_id = NULL,
            match_type = NULL,
            matched_by = NULL,
            matched_at = NULL,
            unmatched_reason = $1,
            reversed_at = CURRENT_TIMESTAMP,
            reversed_by = $2,
            reverse_reason = $3
          WHERE id = $4
        `,
        [
          `Unassigned from ${payment.tenant_name || "the tenant"}: ${reason}`,
          owner.user_id,
          reason,
          payment.id,
        ]
      );
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: is_manual
        ? "MANUAL_PAYMENT_REVERSED"
        : "PAYMENT_UNASSIGNED",
      entity_type: "payment",
      entity_id: payment.id,
      metadata: {
        tenant_id: payment.tenant_id,
        amount: payment.amount,
        reason,
        remembered_phone_removed: phone_restored,
      },
      ip_address,
    });

    return get_payment_by_id(owner, payment.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  M-Pesa receipt numbers are ten letters and digits, such as
  TJU4K8P2QX. Spaces are dropped and letters made capitals.
*/
function normalize_receipt(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function payment_error(message, status_code, details) {
  const error = new Error(message);

  error.status_code = status_code;
  error.details = details;
  return error;
}

function duplicate_summary(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    provider_transaction_id: row.provider_transaction_id,
    payer_phone: row.payer_phone,
    received_at: row.received_at,
    received_at_local: row.received_at_local,
    status: row.status,
    tenant_name: row.tenant_name || null,
    reasons: row.reasons || [],
  };
}

/*
  Unmatched M-Pesa payments in the tenant's property that may be
  the money being recorded by hand. Each carries why:
  - 'receipt': its receipt number is the one typed;
  - 'phone': it came from the tenant's number, or a number they
    paid from before;
  - 'amount': the same amount, in the last 30 days.
  A receipt or phone match is strong; an amount alone is a hint.
*/
async function find_possible_duplicates(
  client,
  owner_id,
  tenant,
  { amount, reference }
) {
  const receipt = normalize_receipt(reference);

  const result = await client.query(
    `
      WITH tenant_phones AS (
        SELECT $3::VARCHAR AS phone
        UNION
        SELECT DISTINCT payer_phone
        FROM payments
        WHERE tenant_id = $4
          AND payer_phone IS NOT NULL
      )
      SELECT
        payments.*,
        TO_CHAR(
          payments.received_at AT TIME ZONE 'Africa/Nairobi',
          'YYYY-MM-DD HH24:MI'
        ) AS received_at_local,

        ARRAY_REMOVE(ARRAY[
          CASE
            WHEN $5 <> ''
              AND UPPER(payments.provider_transaction_id) = $5
            THEN 'receipt'
          END,
          CASE
            WHEN payments.payer_phone IN (SELECT phone FROM tenant_phones)
            THEN 'phone'
          END,
          CASE
            WHEN $6::NUMERIC IS NOT NULL
              AND payments.amount = $6::NUMERIC
            THEN 'amount'
          END
        ], NULL) AS reasons

      FROM payments
      WHERE payments.owner_id = $1
        AND payments.property_id = $2
        AND payments.status = 'unmatched'
        AND (
          ($5 <> '' AND UPPER(payments.provider_transaction_id) = $5)
          OR (
            payments.received_at >=
              CURRENT_TIMESTAMP - INTERVAL '30 days'
            AND (
              payments.payer_phone IN (SELECT phone FROM tenant_phones)
              OR (
                $6::NUMERIC IS NOT NULL
                AND payments.amount = $6::NUMERIC
              )
            )
          )
        )
      ORDER BY
        COALESCE(
          UPPER(payments.provider_transaction_id) = $5,
          FALSE
        ) DESC,
        payments.received_at DESC
      LIMIT 5
    `,
    [
      owner_id,
      tenant.property_id,
      tenant.payment_phone,
      tenant.id,
      receipt,
      amount ? String(amount) : null,
    ]
  );

  return result.rows.map(duplicate_summary);
}

/*
  A payment with this M-Pesa receipt already counted for someone:
  an M-Pesa payment matched to a tenant, or one typed in by hand.
*/
async function find_recorded_receipt(client, owner_id, receipt) {
  if (!receipt) {
    return null;
  }

  const result = await client.query(
    `
      SELECT
        payments.*,
        tenants.full_name AS tenant_name,
        TO_CHAR(
          payments.received_at AT TIME ZONE 'Africa/Nairobi',
          'DD Mon YYYY'
        ) AS received_on
      FROM payments
      LEFT JOIN tenants
        ON tenants.id = payments.tenant_id
      WHERE payments.owner_id = $1
        AND payments.status = 'matched'
        AND (
          UPPER(payments.provider_transaction_id) = $2
          OR (
            payments.payment_method = 'mpesa'
            AND UPPER(REPLACE(payments.reference, ' ', '')) = $2
          )
        )
      LIMIT 1
    `,
    [owner_id, receipt]
  );

  return result.rows[0] || null;
}

// For the Record payment form, before saving.
async function list_possible_duplicates(owner, tenant_id, query) {
  const tenant_result = await db.query(
    `
      SELECT *
      FROM tenants
      WHERE id = $1
        AND owner_id = $2
    `,
    [tenant_id, owner.user_id]
  );

  const tenant = tenant_result.rows[0];

  if (!tenant) {
    throw payment_error("Tenant not found.", 404);
  }

  const receipt = normalize_receipt(query.reference);

  const recorded = await find_recorded_receipt(
    db,
    owner.user_id,
    receipt
  );

  return {
    already_recorded: recorded
      ? {
          id: recorded.id,
          tenant_name: recorded.tenant_name,
          received_on: recorded.received_on,
          amount: Number(recorded.amount),
        }
      : null,
    candidates: await find_possible_duplicates(
      db,
      owner.user_id,
      tenant,
      query
    ),
  };
}

/*
  "Not a tenant payment": an unmatched M-Pesa payment that is no
  tenant's (a wrong number, the owner's own money). It leaves the
  unmatched list and the money received, and can be put back.
*/
async function dismiss_payment(owner, payment_id, reason, ip_address) {
  const result = await db.query(
    `
      UPDATE payments
      SET
        status = 'dismissed',
        dismissed_at = CURRENT_TIMESTAMP,
        dismissed_by = $3,
        dismiss_reason = $4
      WHERE id = $1
        AND owner_id = $2
        AND status = 'unmatched'
      RETURNING id, amount, provider_transaction_id
    `,
    [payment_id, owner.user_id, owner.user_id, reason]
  );

  if (!result.rows[0]) {
    throw payment_error(
      "Only an unmatched payment can be marked as not a tenant payment.",
      409
    );
  }

  await log_audit({
    user_id: owner.user_id,
    action: "PAYMENT_DISMISSED",
    entity_type: "payment",
    entity_id: payment_id,
    metadata: {
      amount: Number(result.rows[0].amount),
      provider_transaction_id: result.rows[0].provider_transaction_id,
      reason,
    },
    ip_address,
  });

  return get_payment_by_id(owner, payment_id);
}

async function restore_payment(owner, payment_id, ip_address) {
  const result = await db.query(
    `
      UPDATE payments
      SET
        status = 'unmatched',
        dismissed_at = NULL,
        dismissed_by = NULL,
        dismiss_reason = NULL
      WHERE id = $1
        AND owner_id = $2
        AND status = 'dismissed'
      RETURNING id, amount
    `,
    [payment_id, owner.user_id]
  );

  if (!result.rows[0]) {
    throw payment_error(
      "Only a payment marked as not a tenant payment can be put back.",
      409
    );
  }

  await log_audit({
    user_id: owner.user_id,
    action: "PAYMENT_RESTORED",
    entity_type: "payment",
    entity_id: payment_id,
    metadata: {
      amount: Number(result.rows[0].amount),
    },
    ip_address,
  });

  return get_payment_by_id(owner, payment_id);
}

async function record_manual_payment(
  owner,
  tenant_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const tenant_result = await client.query(
      `
        SELECT *
        FROM tenants
        WHERE id = $1
          AND owner_id = $2
          AND status IN (
            'active',
            'notice_given',
            'moved_out'
          )
        FOR UPDATE
      `,
      [
        tenant_id,
        owner.user_id,
      ]
    );

    const tenant = tenant_result.rows[0];

    if (!tenant) {
      const error = new Error(
        "Tenant not found."
      );

      error.status_code = 404;
      throw error;
    }

    /*
      M-Pesa money must carry its receipt number (the owner's
      rule, 2026-10-29), so the same money is never counted twice.
    */
    const receipt =
      data.payment_method === "mpesa"
        ? normalize_receipt(data.reference)
        : "";

    if (
      data.payment_method === "mpesa" &&
      !/^[A-Z0-9]{8,12}$/.test(receipt)
    ) {
      throw payment_error(
        "Enter the M-Pesa receipt number, for example TJU4K8P2QX. It is in the tenant's M-Pesa message.",
        422,
        { code: "receipt_required" }
      );
    }

    const recorded = await find_recorded_receipt(
      client,
      owner.user_id,
      receipt
    );

    if (recorded) {
      throw payment_error(
        `M-Pesa receipt ${receipt} is already recorded, for ${recorded.tenant_name || "a tenant"}, on ${recorded.received_on}.`,
        409,
        { code: "receipt_recorded", payment_id: recorded.id }
      );
    }

    /*
      An unmatched M-Pesa payment that may be this money: the
      owner matches it instead, or says why this is a different
      payment. A receipt or phone match must be answered; the same
      amount alone is only shown in the form.
    */
    const candidates = await find_possible_duplicates(
      client,
      owner.user_id,
      tenant,
      { amount: data.amount, reference: receipt }
    );

    const strong = candidates.filter((candidate) =>
      candidate.reasons.some((reason) =>
        ["receipt", "phone"].includes(reason)
      )
    );

    const exact_receipt = candidates.find((candidate) =>
      candidate.reasons.includes("receipt")
    );

    if (exact_receipt) {
      throw payment_error(
        `M-Pesa receipt ${receipt} is already in Kodi as an unmatched payment of KES ${exact_receipt.amount.toLocaleString("en-KE")}. Match that payment to ${tenant.full_name} instead of recording it again.`,
        409,
        { code: "unmatched_receipt", candidates: [exact_receipt] }
      );
    }

    if (strong.length && !data.duplicate_override_reason) {
      const first = strong[0];

      throw payment_error(
        `This may already be in Kodi: an unmatched M-Pesa payment of KES ${first.amount.toLocaleString("en-KE")} from ${first.payer_phone || "an unknown number"} on ${first.received_at_local}. Match that payment to ${tenant.full_name}, or say why this is a different payment.`,
        409,
        { code: "possible_duplicate", candidates }
      );
    }

    const payment_result = await client.query(
      `
        INSERT INTO payments (
          owner_id,
          property_id,
          unit_id,
          tenant_id,
          account_for,
          amount,
          payment_method,
          payment_source,
          reference,
          received_at,
          status,
          match_type,
          recorded_by,
          notes,
          duplicate_override_reason
        )
        VALUES (
          $1,$2,$3,$4,$5,$6::NUMERIC,$7,'manual',
          $8,COALESCE($9, CURRENT_TIMESTAMP),
          'matched','manual',$11,$10,$12
        )
        RETURNING *
      `,
      [
        owner.user_id,
        tenant.property_id,
        tenant.unit_id,
        tenant.id,
        data.account_for,
        from_cents(to_cents(data.amount)),
        data.payment_method,
        receipt || data.reference || null,
        data.received_at || null,
        data.notes || null,
        /*
          Who recorded it: the caretaker, when one did.
        */
        owner.acting_caretaker_id || owner.user_id,
        candidates.length
          ? data.duplicate_override_reason || null
          : null,
      ]
    );

    const payment = payment_result.rows[0];

    await apply_payment_to_tenant(
      client,
      payment,
      tenant
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "MANUAL_PAYMENT_RECORDED",
      entity_type: "payment",
      entity_id: payment.id,
      metadata: {
        tenant_id: tenant.id,
        amount: payment.amount,
        payment_method: payment.payment_method,
        reference: payment.reference,
        /*
          Kodi showed unmatched payments that looked like this
          money, and the owner said it was a different payment.
        */
        possible_duplicates_shown: candidates.map(
          (candidate) => candidate.id
        ),
        duplicate_override_reason:
          payment.duplicate_override_reason || null,
      },
      ip_address,
    });

    return get_payment_by_id(owner, payment.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_payment_by_id(owner, payment_id) {
  const payment = await get_payment_with_context(
    db,
    payment_id,
    owner.user_id
  );

  if (!payment) {
    const error = new Error("Payment not found.");
    error.status_code = 404;
    throw error;
  }

  payment.applied_to = await get_payment_allocations(
    payment.id
  );

  return public_payment(payment);
}

/*
  filters are optional: property_id, status, and from_date /
  to_date as calendar days in Kenya.
*/
async function list_payments(owner, filters = {}) {
  const result = await db.query(
    `
      SELECT
        payments.*,
        tenants.full_name AS tenant_name,
        units.unit_number,
        properties.name AS property_name,
        TO_CHAR(
          payments.received_at
          AT TIME ZONE 'Africa/Nairobi',
          'YYYY-MM-DD HH24:MI'
        ) AS received_at_local
      FROM payments
      LEFT JOIN tenants
        ON tenants.id = payments.tenant_id
      LEFT JOIN units
        ON units.id = payments.unit_id
      LEFT JOIN properties
        ON properties.id = payments.property_id
      WHERE payments.owner_id = $1

        AND (
          $2::TEXT IS NULL
          OR payments.property_id = $2
        )

        AND (
          $3::VARCHAR IS NULL
          OR payments.status = $3
        )

        AND (
          $4::DATE IS NULL
          OR (
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE >= $4
        )

        AND (
          $5::DATE IS NULL
          OR (
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE <= $5
        )

      ORDER BY payments.received_at DESC
    `,
    [
      owner.user_id,
      filters.property_id || null,
      filters.status || null,
      filters.from_date || null,
      filters.to_date || null,
    ]
  );

  /*
    What every payment in the list was applied to, in one
    query. Looking each one up separately opened many database
    connections at once.
  */
  const allocations = await db.query(
    `
      SELECT
        payment_allocations.payment_id,
        payment_allocations.amount,
        tenant_charges.charge_type,
        tenant_charges.description,
        tenant_charges.billing_period,
        TO_CHAR(
          tenant_charges.billing_period,
          'Mon YYYY'
        ) AS period_label
      FROM payment_allocations
      INNER JOIN tenant_charges
        ON tenant_charges.id =
          payment_allocations.tenant_charge_id
      WHERE payment_allocations.payment_id = ANY($1::record_id[])
      ORDER BY payment_allocations.id
    `,
    [result.rows.map((payment) => payment.id)]
  );

  const applied_to = {};

  for (const allocation of allocations.rows) {
    applied_to[allocation.payment_id] =
      applied_to[allocation.payment_id] || [];

    applied_to[allocation.payment_id].push({
      charge_type: allocation.charge_type,
      description: allocation.description,
      billing_period: allocation.billing_period,
      period_label: allocation.period_label,
      amount: Number(allocation.amount),
    });
  }

  return result.rows.map((payment) =>
    public_payment({
      ...payment,
      applied_to: applied_to[payment.id] || [],
    })
  );
}

async function list_unmatched_payments(owner) {
  const result = await db.query(
    `
      SELECT
        payments.*,
        units.unit_number
      FROM payments
      LEFT JOIN units
        ON units.id = payments.unit_id
      WHERE payments.owner_id = $1
        AND payments.status = 'unmatched'
      ORDER BY payments.received_at DESC
    `,
    [owner.user_id]
  );

  return result.rows.map(public_payment);
}

async function get_payment_stats(owner) {
  const result = await db.query(
    `
      SELECT
        COALESCE(
          SUM(amount) FILTER (
            WHERE received_today
              AND status IN ('matched', 'unmatched')
          ),
          0
        ) AS received_today,

        COUNT(*) FILTER (
          WHERE received_today
            AND status IN ('matched', 'unmatched')
        ) AS received_today_count,

        COUNT(*) FILTER (
          WHERE status = 'matched'
            AND match_type = 'automatic'
        ) AS auto_matched_count,

        COUNT(*) FILTER (
          WHERE status IN ('matched', 'unmatched')
        ) AS total_received_count,

        COUNT(*) FILTER (
          WHERE status = 'unmatched'
        ) AS unmatched_count
      FROM (
        /*
          "Today" is the owner's day in Kenya, and reversed
          payments are not money received.
        */
        SELECT
          payments.*,
          (
            (received_at AT TIME ZONE 'Africa/Nairobi')::DATE =
            (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::DATE
          ) AS received_today
        FROM payments
      ) AS payments
      WHERE owner_id = $1
    `,
    [owner.user_id]
  );

  const stats = result.rows[0];

  const total = Number(stats.total_received_count);

  return {
    received_today: Number(stats.received_today),
    received_today_count: Number(
      stats.received_today_count
    ),
    auto_match_rate:
      total === 0
        ? 0
        : Math.round(
            (Number(stats.auto_matched_count) / total) *
              100
          ),
    unmatched_count: Number(stats.unmatched_count),
  };
}

async function list_tenant_payments(owner, tenant_id) {
  const tenant_result = await db.query(
    `
      SELECT id
      FROM tenants
      WHERE id = $1
        AND owner_id = $2
    `,
    [
      tenant_id,
      owner.user_id,
    ]
  );

  if (!tenant_result.rows[0]) {
    const error = new Error("Tenant not found.");
    error.status_code = 404;
    throw error;
  }

  const result = await db.query(
    `
      SELECT
        payments.*,
        tenants.full_name AS tenant_name,
        units.unit_number
      FROM payments
      LEFT JOIN tenants
        ON tenants.id = payments.tenant_id
      LEFT JOIN units
        ON units.id = payments.unit_id
      WHERE payments.tenant_id = $1
      ORDER BY payments.received_at DESC
    `,
    [tenant_id]
  );

  /*
    What every payment in the list was applied to, in one
    query. Looking each one up separately opened many database
    connections at once.
  */
  const allocations = await db.query(
    `
      SELECT
        payment_allocations.payment_id,
        payment_allocations.amount,
        tenant_charges.charge_type,
        tenant_charges.description,
        tenant_charges.billing_period,
        TO_CHAR(
          tenant_charges.billing_period,
          'Mon YYYY'
        ) AS period_label
      FROM payment_allocations
      INNER JOIN tenant_charges
        ON tenant_charges.id =
          payment_allocations.tenant_charge_id
      WHERE payment_allocations.payment_id = ANY($1::record_id[])
      ORDER BY payment_allocations.id
    `,
    [result.rows.map((payment) => payment.id)]
  );

  const applied_to = {};

  for (const allocation of allocations.rows) {
    applied_to[allocation.payment_id] =
      applied_to[allocation.payment_id] || [];

    applied_to[allocation.payment_id].push({
      charge_type: allocation.charge_type,
      description: allocation.description,
      billing_period: allocation.billing_period,
      period_label: allocation.period_label,
      amount: Number(allocation.amount),
    });
  }

  return result.rows.map((payment) =>
    public_payment({
      ...payment,
      applied_to: applied_to[payment.id] || [],
    })
  );
}

async function simulate_sandbox_payment(
  owner,
  data
) {
  const result = await db.query(
    `
      SELECT
        payment_accounts.*,
        provider_credentials.environment,
        provider_credentials.encrypted_credentials
      FROM payment_accounts
      INNER JOIN properties
        ON properties.id =
          payment_accounts.property_id
      INNER JOIN provider_credentials
        ON provider_credentials.payment_account_id =
          payment_accounts.id
      WHERE payment_accounts.id = $1
        AND properties.owner_id = $2
        AND payment_accounts.status = 'active'
    `,
    [
      data.payment_account_id,
      owner.user_id,
    ]
  );

  const account = result.rows[0];

  if (!account) {
    const error = new Error(
      "Payment account not found."
    );

    error.status_code = 404;
    throw error;
  }

  if (
    account.environment !== "sandbox" ||
    account.account_type !== "paybill"
  ) {
    const error = new Error(
      "Daraja simulation requires a sandbox M-Pesa PayBill account."
    );

    error.status_code = 400;
    throw error;
  }

  const credentials = decrypt_json(
    account.encrypted_credentials
  );

  return simulate_c2b_payment({
    consumer_key: credentials.consumer_key,
    consumer_secret: credentials.consumer_secret,
    business_number: account.business_number,
    phone: data.phone,
    amount: data.amount,
    bill_reference: data.bill_reference,
  });
}

module.exports = {
  receive_mpesa_c2b_confirmation,
  notice_log_line,
  match_unmatched_payment,
  record_manual_payment,
  list_possible_duplicates,
  dismiss_payment,
  restore_payment,
  reverse_payment,
  get_payment_by_id,
  list_payments,
  list_unmatched_payments,
  get_payment_stats,
  list_tenant_payments,
  simulate_sandbox_payment,
};