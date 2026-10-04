const db = require("../config/db");

const {
  normalize_phone,
} = require("../utils/phone");

async function init_auth_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGSERIAL PRIMARY KEY,

      first_name VARCHAR(100) NOT NULL DEFAULT 'New',
      last_name VARCHAR(100) NOT NULL DEFAULT 'User',

      phone VARCHAR(20) NOT NULL UNIQUE,

      role VARCHAR(30) NOT NULL DEFAULT 'user'
        CHECK (role IN ('admin', 'user', 'owner', 'caretaker')),

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'suspended')),

      owner_id BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      created_by BIGINT
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
      otp_code_id BIGSERIAL PRIMARY KEY,

      user_id BIGINT
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
      refresh_token_id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      token_hash TEXT NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_log_id BIGSERIAL PRIMARY KEY,

      user_id BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      action VARCHAR(100) NOT NULL,

      entity_type VARCHAR(100),
      entity_id BIGINT,

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

  console.log("[AUTH] Administrator verified.");
}

module.exports = {
  init_auth_tables,
};