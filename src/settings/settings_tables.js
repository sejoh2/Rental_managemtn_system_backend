const db = require("../config/db");

async function init_settings_tables() {
  await db.query(`
    /*
      Email is optional and is not used for authentication.
      Phone + OTP remains the only sign-in method.
    */
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(255);

    CREATE UNIQUE INDEX IF NOT EXISTS
      uq_users_email_case_insensitive
    ON users (LOWER(email))
    WHERE email IS NOT NULL;

    /*
      One preferences/defaults row per owner.
      Caretakers, ordinary users, and administrators do not have
      owner settings.
    */
    CREATE TABLE IF NOT EXISTS owner_settings (
      owner_id record_id PRIMARY KEY
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      default_rent_due_day SMALLINT NOT NULL DEFAULT 5
        CHECK (
          default_rent_due_day >= 1
          AND default_rent_due_day <= 31
        ),

      notify_payment_received BOOLEAN NOT NULL DEFAULT true,

      auto_rent_reminder BOOLEAN NOT NULL DEFAULT true,

      remind_water_readings BOOLEAN NOT NULL DEFAULT true,

      alert_suspicious_water BOOLEAN NOT NULL DEFAULT false,

      weekly_collection_summary BOOLEAN NOT NULL DEFAULT true,

      monthly_profit_report BOOLEAN NOT NULL DEFAULT false,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    DROP TRIGGER IF EXISTS update_owner_settings_updated_at
      ON owner_settings;

    CREATE TRIGGER update_owner_settings_updated_at
      BEFORE UPDATE ON owner_settings
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  console.log("[SETTINGS] Settings tables initialized.");
}

module.exports = {
  init_settings_tables,
};