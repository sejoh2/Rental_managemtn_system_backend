const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  normalize_phone,
} = require("../utils/phone");

function service_error(message, status_code = 400) {
  const error = new Error(message);
  error.status_code = status_code;
  return error;
}

/*
  "Joseph Mwangi Kamau" -> Joseph / Kamau. One word leaves the
  last name empty.
*/
function split_name(full_name) {
  const parts = full_name.trim().split(/\s+/);

  return {
    first_name: parts[0],
    last_name:
      parts.length > 1 ? parts[parts.length - 1] : "",
  };
}

function valid_phone_or_throw(phone_input) {
  const phone = normalize_phone(phone_input);

  if (!phone) {
    throw service_error(
      "Enter a valid Kenyan mobile phone number.",
      422
    );
  }

  return phone;
}

async function ensure_phone_is_free(phone, except_user_id) {
  const result = await db.query(
    `
      SELECT user_id, first_name, last_name, role
      FROM users
      WHERE phone = $1
        AND user_id <> $2
    `,
    [phone, except_user_id || 0]
  );

  const taken = result.rows[0];

  if (taken) {
    throw service_error(
      `This phone number already belongs to ${taken.first_name} ${taken.last_name} (${taken.role}).`.replace(
        /\s+\(/,
        " ("
      ),
      409
    );
  }
}

/*
  Signs a person out everywhere. Used when their phone number
  or role changes.
*/
async function revoke_sessions(user_id) {
  await db.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
        AND revoked_at IS NULL
    `,
    [user_id]
  );
}

/*
  The admin adds an owner by name and phone number. The person
  then signs in with that number; nothing is sent to them.
*/
async function create_owner({
  admin_user,
  data,
  ip_address,
}) {
  const phone = valid_phone_or_throw(data.phone);

  await ensure_phone_is_free(phone);

  const name = split_name(data.full_name);

  const result = await db.query(
    `
      INSERT INTO users (
        first_name,
        last_name,
        phone,
        role,
        status,
        created_by
      )
      VALUES ($1, $2, $3, 'owner', 'active', $4)
      RETURNING *
    `,
    [
      name.first_name,
      name.last_name,
      phone,
      admin_user.user_id,
    ]
  );

  const user = result.rows[0];

  await log_audit({
    user_id: admin_user.user_id,
    owner_id: user.user_id,
    action: "USER_CREATED",
    entity_type: "user",
    entity_id: user.user_id,
    metadata: {
      phone: user.phone,
      role: "owner",
      name: `${user.first_name} ${user.last_name}`.trim(),
    },
    ip_address,
  });

  return public_user(user);
}

/*
  Changes a person's name or phone number. The administrator's
  own account is set on the server at deployment and cannot be
  changed from here.
*/
async function update_user({
  admin_user,
  target_user_id,
  data,
  ip_address,
}) {
  const user = await get_user_by_id(target_user_id);

  if (!user) {
    throw service_error("User not found.", 404);
  }

  if (user.role === "admin") {
    throw service_error(
      "The administrator account is set on the server and cannot be changed here.",
      403
    );
  }

  const changes = {};

  if (data.full_name !== undefined) {
    const name = split_name(data.full_name);

    if (
      name.first_name !== user.first_name ||
      name.last_name !== user.last_name
    ) {
      changes.first_name = name.first_name;
      changes.last_name = name.last_name;
    }
  }

  if (data.phone !== undefined) {
    const phone = valid_phone_or_throw(data.phone);

    if (phone !== user.phone) {
      await ensure_phone_is_free(phone, user.user_id);
      changes.phone = phone;
    }
  }

  const fields = Object.keys(changes);

  if (!fields.length) {
    return public_user(user);
  }

  const result = await db.query(
    `
      UPDATE users
      SET ${fields
        .map((field, index) => `${field} = $${index + 1}`)
        .join(", ")}
      WHERE user_id = $${fields.length + 1}
      RETURNING *
    `,
    [...fields.map((field) => changes[field]), user.user_id]
  );

  /*
    The old number must stop working at once.
  */
  if (changes.phone) {
    await revoke_sessions(user.user_id);
  }

  await log_audit({
    user_id: admin_user.user_id,
    owner_id:
      user.role === "owner"
        ? user.user_id
        : user.owner_id || null,
    action: "USER_UPDATED",
    entity_type: "user",
    entity_id: user.user_id,
    metadata: {
      updated_fields: fields,
      previous_phone: changes.phone ? user.phone : undefined,
      new_phone: changes.phone,
    },
    ip_address,
  });

  return public_user(result.rows[0]);
}

/*
  Turns an owner back into a normal user. Refused while the
  owner still has properties, because their tenants, bills and
  payments would be left with nobody able to manage them;
  deactivate such an account instead.
*/
async function demote_owner({
  admin_user,
  target_user_id,
  ip_address,
}) {
  const user = await get_user_by_id(target_user_id);

  if (!user) {
    throw service_error("User not found.", 404);
  }

  if (user.role !== "owner") {
    throw service_error(
      "Only an owner can be turned back into a normal user."
    );
  }

  const properties = await db.query(
    `
      SELECT COUNT(*) AS total
      FROM properties
      WHERE owner_id = $1
        AND status <> 'archived'
    `,
    [user.user_id]
  );

  if (Number(properties.rows[0].total) > 0) {
    throw service_error(
      "This owner still has properties. Deactivate the account instead, which stops them signing in and keeps their records.",
      409
    );
  }

  const result = await db.query(
    `
      UPDATE users
      SET role = 'user'
      WHERE user_id = $1
        AND role = 'owner'
      RETURNING *
    `,
    [user.user_id]
  );

  await revoke_sessions(user.user_id);

  await log_audit({
    user_id: admin_user.user_id,
    owner_id: user.user_id,
    action: "USER_DEMOTED_TO_USER",
    entity_type: "user",
    entity_id: user.user_id,
    metadata: {
      phone: user.phone,
      previous_role: "owner",
      new_role: "user",
    },
    ip_address,
  });

  return public_user(result.rows[0]);
}

function public_user(user) {
  return {
    user_id: Number(user.user_id),
    first_name: user.first_name,
    last_name: user.last_name,
    phone: user.phone,
    role: user.role,
    owner_id: user.owner_id
      ? Number(user.owner_id)
      : null,
    status: user.status,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

async function get_user_by_id(user_id) {
  const result = await db.query(
    `
      SELECT *
      FROM users
      WHERE user_id = $1
    `,
    [user_id]
  );

  return result.rows[0] || null;
}

async function list_users() {
  const result = await db.query(`
    SELECT *
    FROM users
    ORDER BY created_at DESC
  `);

  return result.rows.map(public_user);
}

async function promote_to_owner({
  admin_user,
  target_user_id,
  ip_address,
}) {
  if (admin_user.user_id === target_user_id) {
    const error = new Error(
      "An administrator cannot promote their own account."
    );

    error.status_code = 400;
    throw error;
  }

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        SELECT *
        FROM users
        WHERE user_id = $1
        FOR UPDATE
      `,
      [target_user_id]
    );

    const user = result.rows[0];

    if (!user) {
      const error = new Error("User not found.");
      error.status_code = 404;
      throw error;
    }

    if (user.status !== "active") {
      const error = new Error(
        "Only an active user can be promoted to owner."
      );

      error.status_code = 400;
      throw error;
    }

    if (user.role !== "user") {
      const error = new Error(
        "Only a normal user can be promoted to owner."
      );

      error.status_code = 400;
      throw error;
    }

    const updated_result = await client.query(
      `
        UPDATE users
        SET
          role = 'owner',
          owner_id = NULL,
          created_by = $1
        WHERE user_id = $2
        RETURNING *
      `,
      [admin_user.user_id, target_user_id]
    );

    await client.query("COMMIT");

    const promoted_user = updated_result.rows[0];

    await log_audit({
      user_id: admin_user.user_id,
      owner_id: promoted_user.user_id,
      action: "USER_PROMOTED_TO_OWNER",
      entity_type: "user",
      entity_id: promoted_user.user_id,
      metadata: {
        phone: promoted_user.phone,
        previous_role: "user",
        new_role: "owner",
      },
      ip_address,
    });

    return public_user(promoted_user);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deactivate_user({
  admin_user,
  target_user_id,
  ip_address,
}) {
  if (admin_user.user_id === target_user_id) {
    const error = new Error(
      "You cannot deactivate your own administrator account."
    );

    error.status_code = 400;
    throw error;
  }

  const result = await db.query(
    `
      UPDATE users
      SET
        status = 'inactive',
        deactivated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
        AND status = 'active'
      RETURNING *
    `,
    [target_user_id]
  );

  const user = result.rows[0];

  if (!user) {
    const error = new Error(
      "User was not found or is already inactive."
    );

    error.status_code = 404;
    throw error;
  }

  /*
    Revokes every active session immediately.
  */
  await db.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
        AND revoked_at IS NULL
    `,
    [target_user_id]
  );

  await log_audit({
    user_id: admin_user.user_id,
    owner_id:
      user.role === "owner"
        ? user.user_id
        : user.owner_id || null,
    action: "USER_DEACTIVATED",
    entity_type: "user",
    entity_id: user.user_id,
    metadata: {
      phone: user.phone,
      role: user.role,
    },
    ip_address,
  });

  return public_user(user);
}

async function activate_user({
  admin_user,
  target_user_id,
  ip_address,
}) {
  const result = await db.query(
    `
      UPDATE users
      SET
        status = 'active',
        deactivated_at = NULL
      WHERE user_id = $1
        AND status IN ('inactive', 'suspended')
      RETURNING *
    `,
    [target_user_id]
  );

  const user = result.rows[0];

  if (!user) {
    const error = new Error(
      "User was not found or is already active."
    );

    error.status_code = 404;
    throw error;
  }

  await log_audit({
    user_id: admin_user.user_id,
    owner_id:
      user.role === "owner"
        ? user.user_id
        : user.owner_id || null,
    action: "USER_ACTIVATED",
    entity_type: "user",
    entity_id: user.user_id,
    metadata: {
      phone: user.phone,
      role: user.role,
    },
    ip_address,
  });

  return public_user(user);
}

module.exports = {
  create_owner,
  update_user,
  demote_owner,
  list_users,
  get_user_by_id,
  promote_to_owner,
  deactivate_user,
  activate_user,
};