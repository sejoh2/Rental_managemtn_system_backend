const db = require("../config/db");

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

module.exports = {
  list_audit_logs,
  list_audit_actions,
};
