const db = require("../config/db");

const {
  list_accounts: list_billing_accounts,
} = require("../subscriptions/subscription_service");

const {
  normalize_phone,
  mask_phone,
} = require("../utils/phone");

const {
  list_audit_logs,
} = require("./admin_service");

const this_month_sql = `
  DATE_TRUNC(
    'month',
    CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
  ) AT TIME ZONE 'Africa/Nairobi'
`;

function full_name(first_name, last_name) {
  return [first_name, last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/*
  One owner account, read-only: who they are, what they
  manage, and what happened in the account lately.
*/
async function get_owner_detail(owner_id) {
  const owner_result = await db.query(
    `
      SELECT *
      FROM users
      WHERE user_id = $1
        AND role = 'owner'
    `,
    [owner_id]
  );

  const owner = owner_result.rows[0];

  if (!owner) {
    const error = new Error("Owner account not found.");

    error.status_code = 404;
    throw error;
  }

  const properties = await db.query(
    `
      SELECT
        properties.id,
        properties.name,
        properties.location,
        properties.status,
        properties.sms_sender_id,
        properties.sms_sender_status,

        (
          SELECT COUNT(*)
          FROM units
          WHERE units.property_id = properties.id
            AND units.archived_at IS NULL
        ) AS units,

        (
          SELECT COUNT(*)
          FROM tenants
          WHERE tenants.property_id = properties.id
            AND tenants.status IN (
              'active',
              'notice_given'
            )
        ) AS tenants,

        CONCAT(
          caretakers.first_name,
          ' ',
          caretakers.last_name
        ) AS caretaker_name

      FROM properties

      LEFT JOIN users AS caretakers
        ON caretakers.user_id = properties.caretaker_id

      WHERE properties.owner_id = $1
      ORDER BY
        (properties.status = 'archived'),
        properties.name
    `,
    [owner_id]
  );

  const caretakers = await db.query(
    `
      SELECT
        user_id,
        first_name,
        last_name,
        phone,
        status,
        last_login_at
      FROM users
      WHERE owner_id = $1
        AND role = 'caretaker'
      ORDER BY first_name, last_name
    `,
    [owner_id]
  );

  const money = await db.query(
    `
      SELECT
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM payments
          WHERE owner_id = $1
            AND status = 'matched'
            AND received_at >= ${this_month_sql}
        ) AS collected_this_month,

        (
          SELECT COALESCE(
            SUM(amount_due - amount_paid),
            0
          )
          FROM tenant_charges
          WHERE owner_id = $1
            AND status IN ('open', 'partial')
        ) AS owed_by_tenants,

        (
          SELECT COUNT(*)
          FROM sms_messages
          WHERE owner_id = $1
            AND created_at >= ${this_month_sql}
        ) AS sms_this_month
    `,
    [owner_id]
  );

  const activity = await list_audit_logs({
    owner_id,
    limit: 12,
    offset: 0,
  });

  const live = properties.rows.filter(
    (property) => property.status !== "archived"
  );

  return {
    owner: {
      user_id: Number(owner.user_id),
      name: full_name(owner.first_name, owner.last_name),
      phone: owner.phone,
      email: owner.email || null,
      status: owner.status,
      last_login_at: owner.last_login_at,
      created_at: owner.created_at,
    },

    totals: {
      properties: live.length,

      units: live.reduce(
        (sum, property) => sum + Number(property.units),
        0
      ),

      tenants: live.reduce(
        (sum, property) => sum + Number(property.tenants),
        0
      ),

      caretakers: caretakers.rows.length,

      collected_this_month: Number(
        money.rows[0].collected_this_month
      ),

      owed_by_tenants: Number(
        money.rows[0].owed_by_tenants
      ),

      sms_this_month: Number(
        money.rows[0].sms_this_month
      ),
    },

    properties: properties.rows.map((property) => ({
      id: Number(property.id),
      name: property.name,
      location: property.location,
      status: property.status,
      units: Number(property.units),
      tenants: Number(property.tenants),
      caretaker_name:
        (property.caretaker_name || "").trim() || null,
      sms_sender_id: property.sms_sender_id || null,
      sms_sender_status:
        property.sms_sender_status || null,
    })),

    caretakers: caretakers.rows.map((caretaker) => ({
      user_id: Number(caretaker.user_id),
      name: full_name(
        caretaker.first_name,
        caretaker.last_name
      ),
      phone: caretaker.phone,
      status: caretaker.status,
      last_login_at: caretaker.last_login_at,
    })),

    recent_activity: activity.logs,
  };
}

/*
  Messages sent this month through the platform's own sender,
  which the platform pays for. A message sent with an owner's
  approved sender ID is on the owner's own account with the
  provider, so it is left out.
*/
async function get_sms_usage() {
  const result = await db.query(`
    SELECT
      users.user_id,
      users.first_name,
      users.last_name,
      users.phone,

      COUNT(sms_messages.id) AS messages,

      COUNT(sms_messages.id) FILTER (
        WHERE sms_messages.status = 'accepted'
      ) AS accepted,

      COUNT(sms_messages.id) FILTER (
        WHERE sms_messages.status = 'failed'
      ) AS failed,

      COALESCE(
        SUM(sms_messages.estimated_cost) FILTER (
          WHERE sms_messages.status = 'accepted'
        ),
        0
      ) AS cost

    FROM users

    INNER JOIN sms_messages
      ON sms_messages.owner_id = users.user_id
      AND sms_messages.sender_id IS NULL
      AND sms_messages.status <> 'cancelled'
      AND sms_messages.created_at >= ${this_month_sql}

    WHERE users.role = 'owner'

    GROUP BY users.user_id

    ORDER BY cost DESC, messages DESC
  `);

  const owners = result.rows.map((row) => ({
    owner_id: Number(row.user_id),
    name: full_name(row.first_name, row.last_name),
    phone: row.phone,
    messages: Number(row.messages),
    accepted: Number(row.accepted),
    failed: Number(row.failed),
    cost: Number(row.cost),
  }));

  const total = (field) =>
    owners.reduce((sum, owner) => sum + owner[field], 0);

  return {
    totals: {
      messages: total("messages"),
      accepted: total("accepted"),
      failed: total("failed"),
      cost: total("cost"),
    },

    owners,
  };
}

/*
  What is waiting for the admin, and sign-in activity in the
  last 24 hours that looks like someone guessing codes:

  failed_sign_ins        5 or more wrong codes for one number
  code_requests          8 or more codes requested for one number
  admin_sign_in_failed   any wrong code for the admin's number
*/
async function get_notifications() {
  const waiting = await db.query(`
    SELECT
      (
        SELECT COUNT(*)
        FROM sms_sender_approvals
        WHERE status = 'pending'
      ) AS pending_sender_ids,

      (
        SELECT COUNT(*)
        FROM users
        WHERE role = 'user'
          AND status = 'active'
      ) AS waiting_for_access
  `);

  const admin_phone = normalize_phone(
    process.env.ADMIN_PHONE
  );

  const attempts = await db.query(
    `
      SELECT
        action,
        metadata->>'phone' AS phone,
        COUNT(*) AS attempts,
        MAX(created_at) AS last_at
      FROM audit_logs
      WHERE action IN ('LOGIN_FAILED', 'OTP_REQUESTED')
        AND created_at >
          CURRENT_TIMESTAMP - INTERVAL '24 hours'
        AND metadata->>'phone' IS NOT NULL
      GROUP BY action, metadata->>'phone'
      HAVING
        (action = 'LOGIN_FAILED' AND COUNT(*) >= 5)
        OR (action = 'OTP_REQUESTED' AND COUNT(*) >= 8)
        OR (
          action = 'LOGIN_FAILED'
          AND metadata->>'phone' = $1
        )
      ORDER BY MAX(created_at) DESC
    `,
    [admin_phone]
  );

  const security = attempts.rows.map((row) => ({
    kind:
      row.action === "OTP_REQUESTED"
        ? "code_requests"
        : row.phone === admin_phone
          ? "admin_sign_in_failed"
          : "failed_sign_ins",
    phone: row.phone,
    attempts: Number(row.attempts),
    last_at: row.last_at,
  }));

  const pending_sender_ids = Number(
    waiting.rows[0].pending_sender_ids
  );

  /*
    New accounts waiting for the admin to make them owners (each one
    is a notification): who, when they registered, and the pricing
    card they picked on the home page, if they did.
  */
  const waiting_people = (
    await db.query(`
      SELECT user_id, first_name, last_name, phone, created_at, requested_plan_months
      FROM users
      WHERE role = 'user'
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 10
    `)
  ).rows.map((person) => ({
    user_id: person.user_id,
    name:
      person.first_name === "New" && person.last_name === "User"
        ? null
        : `${person.first_name} ${person.last_name}`.trim(),
    phone: person.phone,
    registered_at: person.created_at,
    requested_plan_months: person.requested_plan_months,
  }));

  /*
    Kodi billing: landlords unpaid for 60 days or more, and M-Pesa
    payments that need the admin (a result that did not match, or
    money that could not be matched to a bill) in the last 30 days.
  */
  const billing_accounts = await list_billing_accounts();

  const long_unpaid = billing_accounts
    .filter((account) => account.days_overdue >= 60)
    .map((account) => ({
      owner_id: account.owner_id,
      name: `${account.first_name} ${account.last_name}`.trim(),
      days_overdue: account.days_overdue,
    }));

  const payment_problems = Number(
    (
      await db.query(`
        SELECT COUNT(*) AS count
        FROM audit_logs
        WHERE action IN ('SUBSCRIPTION_PAYMENT_RESULT_MISMATCH', 'SUBSCRIPTION_PAYMENT_UNAPPLIED', 'MPESA_CALLBACK_REFUSED')
          AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
      `)
    ).rows[0].count
  );

  const waiting_for_access = Number(
    waiting.rows[0].waiting_for_access
  );

  return {
    pending_sender_ids,
    waiting_for_access,
    waiting_people,
    security,
    long_unpaid,
    payment_problems,
    total:
      pending_sender_ids +
      waiting_for_access +
      security.length +
      long_unpaid.length +
      payment_problems,
  };
}

/*
  How the server is set up, for the admin to check. Only facts
  that are safe to show: never a key, a secret, a password or
  a database address.
*/
function get_system_status() {
  const public_url = process.env.PUBLIC_API_URL || "";
  let callback_host = null;

  try {
    callback_host = new URL(public_url).host;
  } catch {
    callback_host = null;
  }

  return {
    sms: {
      mode: process.env.SMS_MODE || "console",
      provider_account_set: Boolean(
        process.env.AFRICASTALKING_USERNAME &&
        process.env.AFRICASTALKING_API_KEY
      ),
      default_sender_id:
        process.env.AFRICASTALKING_SENDER_ID || null,
      cost_per_message:
        Number(process.env.SMS_COST_PER_MESSAGE) || 1.5,
    },

    sign_in: {
      code_expires_minutes:
        Number(process.env.OTP_EXPIRES_MINUTES) || 5,
      code_max_attempts:
        Number(process.env.OTP_MAX_ATTEMPTS) || 3,
      code_resend_seconds:
        Number(process.env.OTP_RESEND_SECONDS) || 60,
      admin_phone: mask_phone(process.env.ADMIN_PHONE),
    },

    payments: {
      callback_host,
      callback_is_https: public_url.startsWith("https://"),
    },

    files: {
      storage_set: Boolean(
        process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET
      ),
      bucket: process.env.R2_BUCKET || null,
    },

    server: {
      environment: process.env.NODE_ENV || "development",
      frontend_origin_restricted: Boolean(
        process.env.FRONTEND_URL
      ),
      time: new Date().toISOString(),
    },
  };
}

/*
  Rows for the audit log download, newest first, with the same
  filters as the screen. Capped so one export cannot exhaust
  the server.
*/
async function get_audit_export_rows(filters) {
  const { logs } = await list_audit_logs({
    ...filters,
    limit: 5000,
    offset: 0,
  });

  const when = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Nairobi",
  });

  return logs.map((log) => [
    when.format(new Date(log.created_at)),
    log.action,
    log.actor?.full_name || "System",
    log.actor?.role || "",
    log.account?.full_name || "",
    log.metadata?.by_admin ? "Yes" : "",
    log.entity_type
      ? `${log.entity_type}${log.entity_id ? ` ${log.entity_id}` : ""}`
      : "",
    log.metadata ? JSON.stringify(log.metadata) : "",
    log.ip_address || "",
  ]);
}

const audit_export_headers = [
  "When",
  "Action",
  "Person",
  "Role",
  "Owner account",
  "By admin",
  "Record",
  "Details",
  "IP address",
];

module.exports = {
  get_owner_detail,
  get_sms_usage,
  get_notifications,
  get_system_status,
  get_audit_export_rows,
  audit_export_headers,
};
