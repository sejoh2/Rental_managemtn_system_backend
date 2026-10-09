const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const property_service = require(
  "../properties/property_service"
);

function service_error(message, status_code = 400) {
  const error = new Error(message);

  error.status_code = status_code;

  return error;
}

function split_full_name(full_name) {
  const parts = full_name
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    first_name: parts[0],
    last_name:
      parts.slice(1).join(" ") || "Owner",
  };
}

function public_owner_settings(user, settings) {
  return {
    profile: {
      user_id: Number(user.user_id),

      first_name: user.first_name,
      last_name: user.last_name,

      full_name: [
        user.first_name,
        user.last_name,
      ]
        .filter(Boolean)
        .join(" ")
        .trim(),

      phone: user.phone,
      email: user.email || null,

      role: user.role,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },

    defaults: {
      default_rent_due_day: Number(
        settings.default_rent_due_day
      ),
    },

    notifications: {
      notify_payment_received:
        settings.notify_payment_received,

      auto_rent_reminder:
        settings.auto_rent_reminder,

      remind_water_readings:
        settings.remind_water_readings,

      alert_suspicious_water:
        settings.alert_suspicious_water,

      weekly_collection_summary:
        settings.weekly_collection_summary,

      monthly_profit_report:
        settings.monthly_profit_report,
    },

    updated_at: settings.updated_at,
  };
}

async function ensure_owner_settings(
  client,
  owner_id
) {
  await client.query(
    `
      INSERT INTO owner_settings (owner_id)
      VALUES ($1)
      ON CONFLICT (owner_id)
      DO NOTHING
    `,
    [owner_id]
  );

  const result = await client.query(
    `
      SELECT *
      FROM owner_settings
      WHERE owner_id = $1
      LIMIT 1
    `,
    [owner_id]
  );

  return result.rows[0];
}

async function get_owner_or_throw(
  client,
  owner_id
) {
  const result = await client.query(
    `
      SELECT *
      FROM users
      WHERE user_id = $1
        AND role = 'owner'
        AND status = 'active'
      LIMIT 1
    `,
    [owner_id]
  );

  if (!result.rows[0]) {
    throw service_error(
      "Owner account not found or unavailable.",
      404
    );
  }

  return result.rows[0];
}

async function get_settings(owner) {
  const client = await db.get_client();

  try {
    const user = await get_owner_or_throw(
      client,
      owner.user_id
    );

    const settings = await ensure_owner_settings(
      client,
      owner.user_id
    );

    return public_owner_settings(user, settings);
  } finally {
    client.release();
  }
}

async function update_profile(
  owner,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    await get_owner_or_throw(
      client,
      owner.user_id
    );

    const fields = [];
    const values = [];

    if (data.full_name !== undefined) {
      const name = split_full_name(data.full_name);

      values.push(name.first_name);
      fields.push(
        `first_name = $${values.length}`
      );

      values.push(name.last_name);
      fields.push(
        `last_name = $${values.length}`
      );
    }

    if (data.email !== undefined) {
      values.push(
        data.email
          ? data.email.toLowerCase()
          : null
      );

      fields.push(
        `email = $${values.length}`
      );
    }

    values.push(owner.user_id);

    const result = await client.query(
      `
        UPDATE users
        SET ${fields.join(", ")}
        WHERE user_id = $${values.length}
          AND role = 'owner'
        RETURNING *
      `,
      values
    );

    const user = result.rows[0];

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "OWNER_PROFILE_UPDATED",
      entity_type: "user",
      entity_id: owner.user_id,
      metadata: {
        updated_fields: Object.keys(data),
      },
      ip_address,
    });

    const read_client = await db.get_client();

    try {
      const settings = await ensure_owner_settings(
        read_client,
        owner.user_id
      );

      return public_owner_settings(
        user,
        settings
      );
    } finally {
      read_client.release();
    }
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw service_error(
        "That email address is already used by another account.",
        409
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

async function update_defaults(
  owner,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const user = await get_owner_or_throw(
      client,
      owner.user_id
    );

    await ensure_owner_settings(
      client,
      owner.user_id
    );

    const result = await client.query(
      `
        UPDATE owner_settings
        SET default_rent_due_day = $1
        WHERE owner_id = $2
        RETURNING *
      `,
      [
        data.default_rent_due_day,
        owner.user_id,
      ]
    );

    const settings = result.rows[0];

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "OWNER_RENT_DEFAULT_UPDATED",
      entity_type: "owner_settings",
      entity_id: owner.user_id,
      metadata: {
        default_rent_due_day:
          data.default_rent_due_day,
      },
      ip_address,
    });

    return public_owner_settings(user, settings);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function update_notifications(
  owner,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const user = await get_owner_or_throw(
      client,
      owner.user_id
    );

    await ensure_owner_settings(
      client,
      owner.user_id
    );

    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(data)) {
      values.push(value);

      fields.push(
        `${key} = $${values.length}`
      );
    }

    values.push(owner.user_id);

    const result = await client.query(
      `
        UPDATE owner_settings
        SET ${fields.join(", ")}
        WHERE owner_id = $${values.length}
        RETURNING *
      `,
      values
    );

    const settings = result.rows[0];

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "OWNER_NOTIFICATION_PREFERENCES_UPDATED",
      entity_type: "owner_settings",
      entity_id: owner.user_id,
      metadata: {
        updated_preferences: Object.keys(data),
      },
      ip_address,
    });

    return public_owner_settings(user, settings);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Settings property context reuses the existing property service,
  then enriches it with unit and caretaker information.
*/
async function get_property_settings(
  owner,
  property_id
) {
  const property =
    await property_service.get_property_by_id(
      owner,
      property_id
    );

  if (!property) {
    throw service_error(
      "Property not found or you do not have access to it.",
      404
    );
  }

  const result = await db.query(
    `
      SELECT
        COUNT(units.id)
          FILTER (
            WHERE units.status <> 'inactive'
          ) AS total_units,

        COUNT(units.id)
          FILTER (
            WHERE units.status = 'occupied'
          ) AS occupied_units,

        property_caretaker_assignments.caretaker_id,

        users.first_name AS caretaker_first_name,
        users.last_name AS caretaker_last_name,

        property_caretaker_assignments.permission_level
          AS caretaker_permission_level

      FROM properties

      LEFT JOIN units
        ON units.property_id = properties.id

      LEFT JOIN property_caretaker_assignments
        ON property_caretaker_assignments.property_id =
          properties.id
        AND property_caretaker_assignments.status =
          'active'

      LEFT JOIN users
        ON users.user_id =
          property_caretaker_assignments.caretaker_id

      WHERE properties.id = $1
        AND properties.owner_id = $2

      GROUP BY
        properties.id,
        property_caretaker_assignments.caretaker_id,
        users.first_name,
        users.last_name,
        property_caretaker_assignments.permission_level

      LIMIT 1
    `,
    [
      property_id,
      owner.user_id,
    ]
  );

  const row = result.rows[0];

  return {
    property,

    unit_summary: {
      total_units: Number(row.total_units),
      occupied_units: Number(row.occupied_units),
    },

    caretaker: row.caretaker_id
      ? {
        user_id: Number(row.caretaker_id),

        full_name: [
          row.caretaker_first_name,
          row.caretaker_last_name,
        ]
          .filter(Boolean)
          .join(" "),

        permission_level:
          row.caretaker_permission_level,
      }
      : null,
  };
}

/*
  An owner sees actions performed by:
  - the owner account
  - active or former caretakers tied to that owner

  This provides the Settings audit-log panel without exposing
  another owner’s actions.
*/
async function list_audit_logs(
  owner,
  filters
) {
  const result = await db.query(
    `
      SELECT
        audit_logs.*,

        users.first_name,
        users.last_name,
        users.role

      FROM audit_logs

      LEFT JOIN users
        ON users.user_id = audit_logs.user_id

      WHERE
        audit_logs.owner_id = $1
        OR audit_logs.user_id = $1

      ORDER BY audit_logs.created_at DESC
      LIMIT $2
    `,
    [
      owner.user_id,
      filters.limit,
    ]
  );

  return result.rows.map((row) => ({
    id: Number(row.audit_log_id),

    action: row.action,

    entity_type: row.entity_type,
    entity_id: row.entity_id
      ? Number(row.entity_id)
      : null,

    metadata: row.metadata || null,

    actor: row.user_id
      ? {
        user_id: Number(row.user_id),

        full_name: [
          row.first_name,
          row.last_name,
        ]
          .filter(Boolean)
          .join(" ")
          .trim(),

        role: row.role,
      }
      : null,

    created_at: row.created_at,
  }));
}

module.exports = {
  get_settings,
  update_profile,
  update_defaults,
  update_notifications,
  get_property_settings,
  list_audit_logs,
};