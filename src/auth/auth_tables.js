const db = require("../config/db");

const {
  normalize_phone,
} = require("../utils/phone");

async function init_auth_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id record_id PRIMARY KEY DEFAULT new_id('usr'),

      first_name VARCHAR(100) NOT NULL DEFAULT 'New',
      last_name VARCHAR(100) NOT NULL DEFAULT 'User',

      phone VARCHAR(20) NOT NULL UNIQUE,

      role VARCHAR(30) NOT NULL DEFAULT 'user'
        CHECK (role IN ('admin', 'user', 'owner', 'caretaker')),

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'suspended')),

      owner_id record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      created_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      last_login_at TIMESTAMPTZ,
      deactivated_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT caretaker_requires_owner
        CHECK (
          (role = 'caretaker' AND owner_id IS NOT NULL)
          OR
          (role <> 'caretaker' AND owner_id IS NULL)
        )
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      otp_code_id record_id PRIMARY KEY DEFAULT new_id('otp'),

      user_id record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      phone VARCHAR(20) NOT NULL,

      purpose VARCHAR(30) NOT NULL DEFAULT 'login'
        CHECK (purpose IN ('login')),

      code_hash TEXT NOT NULL,

      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,

      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      refresh_token_id record_id PRIMARY KEY DEFAULT new_id('ses'),

      user_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      token_hash TEXT NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_log_id record_id PRIMARY KEY DEFAULT new_id('aud'),

      user_id record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      action VARCHAR(100) NOT NULL,

      entity_type VARCHAR(100),
      entity_id record_id,

      metadata JSONB,
      ip_address VARCHAR(100),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_phone
      ON users(phone);

    CREATE INDEX IF NOT EXISTS idx_users_role
      ON users(role);

    CREATE INDEX IF NOT EXISTS idx_users_owner_id
      ON users(owner_id);

    CREATE INDEX IF NOT EXISTS idx_otp_codes_phone
      ON otp_codes(phone);

    CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at
      ON otp_codes(expires_at);

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
      ON refresh_tokens(user_id);

    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
      ON audit_logs(user_id);

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
      ON audit_logs(created_at);

    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS
    $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$
    LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS update_users_updated_at ON users;

    CREATE TRIGGER update_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  /*
    Each audit entry records the owner account it belongs to,
    so an administrator can follow one account's history.
    Older entries are filled in from the acting user, or from
    the user an admin action was performed on.
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS owner_id record_id
      REFERENCES users(user_id)
      ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_audit_logs_owner_id
      ON audit_logs(owner_id);

    CREATE INDEX IF NOT EXISTS idx_audit_logs_action
      ON audit_logs(action);

    UPDATE audit_logs
    SET owner_id = CASE
      WHEN users.role = 'owner' THEN users.user_id
      ELSE users.owner_id
    END
    FROM users
    WHERE users.user_id = audit_logs.user_id
      AND audit_logs.owner_id IS NULL
      AND users.role IN ('owner', 'caretaker');

    UPDATE audit_logs
    SET owner_id = CASE
      WHEN users.role = 'owner' THEN users.user_id
      ELSE users.owner_id
    END
    FROM users
    WHERE users.user_id = audit_logs.entity_id
      AND audit_logs.owner_id IS NULL
      AND audit_logs.action IN (
        'USER_PROMOTED_TO_OWNER',
        'USER_ACTIVATED',
        'USER_DEACTIVATED'
      )
      AND users.role IN ('owner', 'caretaker');
  `);

  await seed_admin_user();

  console.log("[AUTH] Authentication tables initialized.");
}

async function seed_admin_user() {
  const phone = normalize_phone(process.env.ADMIN_PHONE);

  if (!phone) {
    throw new Error("ADMIN_PHONE is missing or invalid.");
  }

  await db.query(
    `
      INSERT INTO users (
        first_name,
        last_name,
        phone,
        role,
        status
      )
      VALUES ($1, $2, $3, 'admin', 'active')
      ON CONFLICT (phone)
      DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        role = 'admin',
        status = 'active'
    `,
    [
      process.env.ADMIN_FIRST_NAME || "System",
      process.env.ADMIN_LAST_NAME || "Admin",
      phone,
    ]
  );

  /*
    There is exactly one administrator: the number in
    ADMIN_PHONE. No screen or endpoint can make another one,
    and any other account found with the admin role (for
    example after ADMIN_PHONE was changed) loses it here and
    is signed out everywhere.
  */
  const removed = await db.query(
    `
      UPDATE users
      SET role = 'user'
      WHERE role = 'admin'
        AND phone <> $1
      RETURNING user_id, phone
    `,
    [phone]
  );

  for (const user of removed.rows) {
    await db.query(
      `
        UPDATE refresh_tokens
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
          AND revoked_at IS NULL
      `,
      [user.user_id]
    );

    await db.query(
      `
        INSERT INTO audit_logs (
          user_id,
          action,
          entity_type,
          entity_id,
          metadata
        )
        VALUES (NULL, 'ADMIN_ROLE_REMOVED', 'user', $1, $2)
      `,
      [
        user.user_id,
        JSON.stringify({
          phone: user.phone,
          reason: "Not the ADMIN_PHONE set on the server.",
        }),
      ]
    );

    console.warn(
      `[AUTH] Removed the admin role from user ${user.user_id}: only ADMIN_PHONE may be the administrator.`
    );
  }

  console.log("[AUTH] Administrator verified.");
}

module.exports = {
  init_auth_tables,
};