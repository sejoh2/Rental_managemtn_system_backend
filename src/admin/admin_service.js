const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

function full_name(first_name, last_name) {
  return [first_name, last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/*
  The whole audit trail, across every owner account.

  Each entry carries the person who acted (actor) and the
  owner account the action happened in (account). Automatic
  entries, such as monthly billing, have no actor.
*/
async function list_audit_logs(filters) {
  const conditions = [];
  const values = [];

  function add_condition(sql, value) {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length}`));
  }

  if (filters.owner_id) {
    add_condition(
      "audit_logs.owner_id = ?",
      filters.owner_id
    );
  }

  if (filters.user_id) {
    add_condition(
      "audit_logs.user_id = ?",
      filters.user_id
    );
  }

  if (filters.action) {
    add_condition(
      "audit_logs.action = ?",
      filters.action
    );
  }

  /*
    One entry, or everything recorded about one record. Used
    by the entry's own page.
  */
  if (filters.audit_log_id) {
    add_condition(
      "audit_logs.audit_log_id = ?",
      filters.audit_log_id
    );
  }

  if (filters.entity_type && filters.entity_id) {
    add_condition(
      "audit_logs.entity_type = ?",
      filters.entity_type
    );

    add_condition(
      "audit_logs.entity_id = ?",
      filters.entity_id
    );
  }

  /*
    Dates are the admin's calendar days in Kenya.
  */
  if (filters.from_date) {
    add_condition(
      "(audit_logs.created_at AT TIME ZONE 'Africa/Nairobi')::DATE >= ?::DATE",
      filters.from_date
    );
  }

  if (filters.to_date) {
    add_condition(
      "(audit_logs.created_at AT TIME ZONE 'Africa/Nairobi')::DATE <= ?::DATE",
      filters.to_date
    );
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const count_result = await db.query(
    `
      SELECT COUNT(*) AS total
      FROM audit_logs
      ${where}
    `,
    values
  );

  const result = await db.query(
    `
      SELECT
        audit_logs.*,

        actor.first_name AS actor_first_name,
        actor.last_name AS actor_last_name,
        actor.phone AS actor_phone,
        actor.role AS actor_role,

        account.first_name AS account_first_name,
        account.last_name AS account_last_name,
        account.phone AS account_phone

      FROM audit_logs

      LEFT JOIN users AS actor
        ON actor.user_id = audit_logs.user_id

      LEFT JOIN users AS account
        ON account.user_id = audit_logs.owner_id

      ${where}

      ORDER BY
        audit_logs.created_at DESC,
        audit_logs.audit_log_id DESC

      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, filters.limit, filters.offset]
  );

  return {
    total: Number(count_result.rows[0].total),

    logs: result.rows.map((row) => ({
      id: Number(row.audit_log_id),

      action: row.action,

      entity_type: row.entity_type,
      entity_id: row.entity_id
        ? Number(row.entity_id)
        : null,

      metadata: row.metadata || null,
      ip_address: row.ip_address,

      actor: row.user_id
        ? {
          user_id: Number(row.user_id),
          full_name: full_name(
            row.actor_first_name,
            row.actor_last_name
          ),
          phone: row.actor_phone,
          role: row.actor_role,
        }
        : null,

      account: row.owner_id
        ? {
          owner_id: Number(row.owner_id),
          full_name: full_name(
            row.account_first_name,
            row.account_last_name
          ),
          phone: row.account_phone,
        }
        : null,

      created_at: row.created_at,
    })),
  };
}

/*
  One audit entry in full, with the other entries about the
  same record (the same tenant, payment, property and so on),
  newest first, so the admin can follow what happened to it.
*/
async function get_audit_log(audit_log_id) {
  const { logs } = await list_audit_logs({
    audit_log_id,
    limit: 1,
    offset: 0,
  });

  const log = logs[0];

  if (!log) {
    const error = new Error("Audit entry not found.");

    error.status_code = 404;
    throw error;
  }

  let related = [];

  if (log.entity_type && log.entity_id) {
    const result = await list_audit_logs({
      entity_type: log.entity_type,
      entity_id: log.entity_id,
      limit: 30,
      offset: 0,
    });

    related = result.logs.filter(
      (item) => item.id !== log.id
    );
  }

  return { log, related };
}

/*
  The action names that exist in the log, for the filter list.
*/
async function list_audit_actions() {
  const result = await db.query(`
    SELECT DISTINCT action
    FROM audit_logs
    ORDER BY action
  `);

  return result.rows.map((row) => row.action);
}

const this_month_sql = `
  DATE_TRUNC(
    'month',
    CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
  ) AT TIME ZONE 'Africa/Nairobi'
`;

/*
  The whole platform at a glance, and one row per owner
  account. Money is what payments were matched this month,
  in Kenyan time.
*/
async function get_overview() {
  const owners = await db.query(`
    SELECT
      users.user_id,
      users.first_name,
      users.last_name,
      users.phone,
      users.status,
      users.last_login_at,
      users.created_at,

      (
        SELECT COUNT(*)
        FROM properties
        WHERE properties.owner_id = users.user_id
          AND properties.status <> 'archived'
      ) AS properties,

      (
        SELECT COUNT(*)
        FROM units
        INNER JOIN properties
          ON properties.id = units.property_id
        WHERE properties.owner_id = users.user_id
          AND properties.status <> 'archived'
          AND units.archived_at IS NULL
      ) AS units,

      (
        SELECT COUNT(*)
        FROM tenants
        WHERE tenants.owner_id = users.user_id
          AND tenants.status IN (
            'active',
            'notice_given'
          )
      ) AS tenants,

      (
        SELECT COUNT(*)
        FROM users AS caretakers
        WHERE caretakers.owner_id = users.user_id
          AND caretakers.role = 'caretaker'
          AND caretakers.status = 'active'
      ) AS caretakers,

      (
        SELECT COALESCE(SUM(payments.amount), 0)
        FROM payments
        WHERE payments.owner_id = users.user_id
          AND payments.status = 'matched'
          AND payments.received_at >= ${this_month_sql}
      ) AS collected_this_month,

      (
        SELECT COUNT(*)
        FROM sms_messages
        WHERE sms_messages.owner_id = users.user_id
          AND sms_messages.status = 'accepted'
          AND sms_messages.created_at >= ${this_month_sql}
      ) AS sms_this_month,

      (
        SELECT COALESCE(SUM(sms_messages.estimated_cost), 0)
        FROM sms_messages
        WHERE sms_messages.owner_id = users.user_id
          AND sms_messages.status = 'accepted'
          AND sms_messages.created_at >= ${this_month_sql}
      ) AS sms_cost_this_month

    FROM users
    WHERE users.role = 'owner'
    ORDER BY
      users.first_name,
      users.last_name,
      users.user_id
  `);

  const accounts = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE role = 'admin') AS admins,
      COUNT(*) FILTER (WHERE role = 'caretaker') AS caretakers,
      COUNT(*) FILTER (WHERE role = 'user') AS waiting_for_access,
      COUNT(*) FILTER (
        WHERE created_at >= ${this_month_sql}
      ) AS joined_this_month
    FROM users
  `);

  const rows = owners.rows.map((row) => ({
    user_id: Number(row.user_id),
    name: full_name(row.first_name, row.last_name),
    phone: row.phone,
    status: row.status,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    properties: Number(row.properties),
    units: Number(row.units),
    tenants: Number(row.tenants),
    caretakers: Number(row.caretakers),
    collected_this_month: Number(
      row.collected_this_month
    ),
    sms_this_month: Number(row.sms_this_month),
    sms_cost_this_month: Number(
      row.sms_cost_this_month
    ),
  }));

  const total = (field) =>
    rows.reduce((sum, row) => sum + row[field], 0);

  const counts = accounts.rows[0];

  return {
    totals: {
      owners: rows.length,
      properties: total("properties"),
      units: total("units"),
      tenants: total("tenants"),
      caretakers: Number(counts.caretakers),
      admins: Number(counts.admins),
      waiting_for_access: Number(
        counts.waiting_for_access
      ),
      joined_this_month: Number(
        counts.joined_this_month
      ),
      collected_this_month: total(
        "collected_this_month"
      ),
      sms_this_month: total("sms_this_month"),
      sms_cost_this_month: total(
        "sms_cost_this_month"
      ),
    },

    owners: rows,
  };
}

/*
  Records that an admin opened an owner's account. What the
  admin does inside it is audited action by action.
*/
async function open_owner_account(
  admin,
  owner_id,
  ip_address
) {
  const result = await db.query(
    `
      SELECT
        user_id,
        first_name,
        last_name,
        phone,
        status
      FROM users
      WHERE user_id = $1
        AND role = 'owner'
    `,
    [owner_id]
  );

  const owner = result.rows[0];

  if (!owner) {
    const error = new Error("Owner account not found.");

    error.status_code = 404;
    throw error;
  }

  await log_audit({
    user_id: admin.user_id,
    owner_id: owner.user_id,
    action: "ADMIN_OPENED_ACCOUNT",
    entity_type: "user",
    entity_id: owner.user_id,
    ip_address,
  });

  return {
    user_id: Number(owner.user_id),
    name: full_name(owner.first_name, owner.last_name),
    phone: owner.phone,
    status: owner.status,
  };
}

module.exports = {
  get_overview,
  open_owner_account,
  list_audit_logs,
  get_audit_log,
  list_audit_actions,
};
