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

function public_payment(payment) {
  return {
    id: Number(payment.id),

    property_id: payment.property_id
      ? Number(payment.property_id)
      : null,

    unit_id: payment.unit_id
      ? Number(payment.unit_id)
      : null,

    tenant_id: payment.tenant_id
      ? Number(payment.tenant_id)
      : null,

    tenant_name: payment.tenant_name || null,
    unit_number: payment.unit_number || null,

    amount: Number(payment.amount),

    payment_method: payment.payment_method,
    payment_source: payment.payment_source,

    account_for: payment.account_for,

    provider_transaction_id:
      payment.provider_transaction_id,

    payer_phone: payment.payer_phone,
    reference: payment.reference,

    received_at: payment.received_at,

    status: payment.status,
    match_type: payment.match_type,

    unmatched_reason: payment.unmatched_reason,

    applied_to: payment.applied_to || [],
  };
}

function payment_priority(account_for) {
  if (account_for === "water") {
    return [
      "water_deposit",
      "water",
    ];
  }

  return [
    "rent_deposit",
    "water_deposit",
    "rent",
  ];
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
        units.unit_number
      FROM payments
      LEFT JOIN tenants
        ON tenants.id = payments.tenant_id
      LEFT JOIN units
        ON units.id = payments.unit_id
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
        tenant_charges.billing_period
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
    billing_period: allocation.billing_period,
    amount: Number(allocation.amount),
  }));
}

async function apply_payment_to_tenant(
  client,
  payment,
  tenant
) {
  let remaining_amount = Number(payment.amount);

  const priorities = payment_priority(
    payment.account_for
  );

  const charges_result = await client.query(
    `
      SELECT *
      FROM tenant_charges
      WHERE tenant_id = $1
        AND charge_type = ANY($2)
        AND status IN ('open', 'partial')
      ORDER BY
        CASE charge_type
          WHEN 'rent_deposit' THEN 1
          WHEN 'water_deposit' THEN 2
          WHEN 'rent' THEN 3
          WHEN 'water' THEN 4
          ELSE 99
        END,
        due_date ASC,
        id ASC
      FOR UPDATE
    `,
    [
      tenant.id,
      priorities,
    ]
  );

  for (const charge of charges_result.rows) {
    if (remaining_amount <= 0) {
      break;
    }

    const outstanding =
      Number(charge.amount_due) -
      Number(charge.amount_paid);

    if (outstanding <= 0) {
      continue;
    }

    const allocated_amount = Math.min(
      remaining_amount,
      outstanding
    );

    await client.query(
      `
        INSERT INTO payment_allocations (
          payment_id,
          tenant_charge_id,
          amount
        )
        VALUES ($1,$2,$3)
      `,
      [
        payment.id,
        charge.id,
        allocated_amount,
      ]
    );

    const new_paid_amount =
      Number(charge.amount_paid) +
      allocated_amount;

    await client.query(
      `
        UPDATE tenant_charges
        SET
          amount_paid = $1,
          status = CASE
            WHEN $1 >= amount_due THEN 'paid'
            ELSE 'partial'
          END
        WHERE id = $2
      `,
      [
        new_paid_amount,
        charge.id,
      ]
    );

    remaining_amount -= allocated_amount;
  }

  /*
    Excess money remains as a tenant credit. It is not lost.
    Future monthly charges will use this credit first.
  */
  if (remaining_amount > 0) {
    await client.query(
      `
        INSERT INTO tenant_credits (
          tenant_id,
          property_id,
          source_payment_id,
          original_amount,
          remaining_amount
        )
        VALUES ($1,$2,$3,$4,$4)
      `,
      [
        tenant.id,
        tenant.property_id,
        payment.id,
        remaining_amount,
      ]
    );
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
      }
    }

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
          provider_payload
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          'mpesa','mpesa_c2b',$8,$9,$10,
          $11,$12,$13,$14
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

    await client.query("COMMIT");

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
          AND status IN ('active', 'notice_given')
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
        "Choose an active tenant from the same property."
      );

      error.status_code = 422;
      throw error;
    }

    if (remember_payment_phone && payment.payer_phone) {
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
          matched_by = $1
        WHERE id = $2
      `,
      [
        owner.user_id,
        payment.id,
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
          AND status IN ('active', 'notice_given')
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
        "Active tenant not found."
      );

      error.status_code = 404;
      throw error;
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
          notes
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,'manual',
          $8,COALESCE($9, CURRENT_TIMESTAMP),
          'matched','manual',$1,$10
        )
        RETURNING *
      `,
      [
        owner.user_id,
        tenant.property_id,
        tenant.unit_id,
        tenant.id,
        data.account_for,
        data.amount,
        data.payment_method,
        data.reference || null,
        data.received_at || null,
        data.notes || null,
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

async function list_payments(owner) {
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
      WHERE payments.owner_id = $1
      ORDER BY payments.received_at DESC
    `,
    [owner.user_id]
  );

  return Promise.all(
    result.rows.map(async (payment) => {
      payment.applied_to =
        await get_payment_allocations(payment.id);

      return public_payment(payment);
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
            WHERE received_at::DATE =
              CURRENT_DATE
          ),
          0
        ) AS received_today,

        COUNT(*) FILTER (
          WHERE received_at::DATE =
            CURRENT_DATE
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
      FROM payments
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

  return Promise.all(
    result.rows.map(async (payment) => {
      payment.applied_to =
        await get_payment_allocations(payment.id);

      return public_payment(payment);
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
  match_unmatched_payment,
  record_manual_payment,
  get_payment_by_id,
  list_payments,
  list_unmatched_payments,
  get_payment_stats,
  list_tenant_payments,
  simulate_sandbox_payment,
};