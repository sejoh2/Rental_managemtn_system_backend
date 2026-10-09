const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

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
  list_users,
  get_user_by_id,
  promote_to_owner,
  deactivate_user,
  activate_user,
};