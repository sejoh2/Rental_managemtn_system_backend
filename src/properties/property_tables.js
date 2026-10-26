const db = require("../config/db");

async function init_property_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id record_id PRIMARY KEY DEFAULT new_id('prp'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      caretaker_id record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      created_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      name VARCHAR(255) NOT NULL,
      location VARCHAR(255) NOT NULL,

      property_type VARCHAR(50) NOT NULL
        DEFAULT 'apartment_block'
        CHECK (
          property_type IN (
            'apartment_block',
            'bedsitters',
            'mixed_use',
            'single_rooms'
          )
        ),

      expected_units INTEGER NOT NULL DEFAULT 0
        CHECK (expected_units >= 0),

      /*
        Day of the month, 1 to 28, so it exists in every month.
      */
      rent_due_day INTEGER NOT NULL DEFAULT 5
        CHECK (rent_due_day BETWEEN 1 AND 28),

      /*
        How the first and last month of a tenancy are billed
        when the tenant moves in or out part-way through.
      */
      move_in_billing VARCHAR(30) NOT NULL
        DEFAULT 'prorated'
        CHECK (
          move_in_billing IN (
            'prorated',
            'full_month',
            'free_until_next_month'
          )
        ),

      move_out_billing VARCHAR(30) NOT NULL
        DEFAULT 'prorated'
        CHECK (
          move_out_billing IN (
            'prorated',
            'full_month'
          )
        ),

      water_billing_method VARCHAR(50) NOT NULL
        DEFAULT 'per_unit_metered'
        CHECK (
          water_billing_method IN (
            'per_unit_metered',
            'fixed_monthly',
            'included_in_rent'
          )
        ),

      water_rate_per_unit NUMERIC(12,2) NOT NULL DEFAULT 100
        CHECK (water_rate_per_unit >= 0),

      water_fixed_fee NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (water_fixed_fee >= 0),

      water_billing_day VARCHAR(50)
        NOT NULL DEFAULT 'same_as_rent',

      water_reading_due_days INTEGER
        NOT NULL DEFAULT 3
        CHECK (water_reading_due_days >= 0),

      water_missed_reading_action VARCHAR(50)
        NOT NULL DEFAULT 'carry_forward',

      sms_sender_id VARCHAR(50),

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'archived')),

      archived_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(owner_id, name)
    );

    CREATE TABLE IF NOT EXISTS payment_accounts (
      id record_id PRIMARY KEY DEFAULT new_id('pac'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      account_for VARCHAR(30) NOT NULL
        CHECK (account_for IN ('rent', 'water', 'electricity', 'service')),

      provider_code VARCHAR(30) NOT NULL
        CHECK (provider_code = 'mpesa'),

      account_type VARCHAR(30) NOT NULL
        CHECK (account_type IN ('paybill', 'till')),

      display_name VARCHAR(100),
      account_name VARCHAR(150),

      label VARCHAR(150) NOT NULL,
      business_number VARCHAR(100) NOT NULL,

      connection_status VARCHAR(30) NOT NULL
        DEFAULT 'connected'
        CHECK (
          connection_status IN (
            'not_connected',
            'connecting',
            'connected',
            'failed'
          )
        ),

      connection_error TEXT,

      callback_registered_at TIMESTAMPTZ,
      last_connection_test_at TIMESTAMPTZ,

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(property_id, account_for)
    );

    CREATE TABLE IF NOT EXISTS provider_credentials (
      id record_id PRIMARY KEY DEFAULT new_id('pcr'),

      payment_account_id record_id NOT NULL UNIQUE
        REFERENCES payment_accounts(id)
        ON DELETE CASCADE,

      provider_code VARCHAR(30) NOT NULL
        CHECK (provider_code = 'mpesa'),

      environment VARCHAR(30) NOT NULL
        CHECK (environment IN ('sandbox', 'production')),

      encrypted_credentials TEXT NOT NULL,

      connection_status VARCHAR(30) NOT NULL
        DEFAULT 'connected'
        CHECK (
          connection_status IN (
            'not_connected',
            'connecting',
            'connected',
            'failed'
          )
        ),

      last_connected_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    /*
      Created when an owner clicks Connect in the Add Property modal.
      Secrets are encrypted and expire quickly if property creation
      is abandoned.
    */
    CREATE TABLE IF NOT EXISTS property_connection_checks (
      id record_id PRIMARY KEY DEFAULT new_id('chk'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      account_for VARCHAR(30) NOT NULL
        CHECK (account_for IN ('rent', 'water', 'electricity', 'service')),

      provider_code VARCHAR(30) NOT NULL
        CHECK (provider_code = 'mpesa'),

      account_type VARCHAR(30) NOT NULL
        CHECK (account_type IN ('paybill', 'till')),

      business_number VARCHAR(100) NOT NULL,
      display_name VARCHAR(100),
      account_name VARCHAR(150),

      environment VARCHAR(30) NOT NULL
        CHECK (environment IN ('sandbox', 'production')),

      encrypted_credentials TEXT NOT NULL,

      status VARCHAR(30) NOT NULL DEFAULT 'validated'
        CHECK (status IN ('validated', 'used', 'expired', 'failed')),

      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mpesa_c2b_callback_events (
      id record_id PRIMARY KEY DEFAULT new_id('mce'),

      event_type VARCHAR(30) NOT NULL
        CHECK (event_type IN ('validation', 'confirmation')),

      business_number VARCHAR(100),

      payload JSONB NOT NULL,

      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_properties_owner_id
      ON properties(owner_id);

    CREATE INDEX IF NOT EXISTS idx_payment_accounts_property_id
      ON payment_accounts(property_id);

    CREATE INDEX IF NOT EXISTS idx_connection_checks_owner_id
      ON property_connection_checks(owner_id);

    CREATE INDEX IF NOT EXISTS idx_connection_checks_expires_at
      ON property_connection_checks(expires_at);

    CREATE INDEX IF NOT EXISTS idx_c2b_events_business_number
      ON mpesa_c2b_callback_events(business_number);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_mpesa_business_number
      ON payment_accounts(business_number)
      WHERE status = 'active';

    DROP TRIGGER IF EXISTS update_properties_updated_at
      ON properties;

    CREATE TRIGGER update_properties_updated_at
      BEFORE UPDATE ON properties
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_payment_accounts_updated_at
      ON payment_accounts;

    CREATE TRIGGER update_payment_accounts_updated_at
      BEFORE UPDATE ON payment_accounts
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_provider_credentials_updated_at
      ON provider_credentials;

    CREATE TRIGGER update_provider_credentials_updated_at
      BEFORE UPDATE ON provider_credentials
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  /*
    Upgrades for databases created before monthly billing,
    numeric rent due days, electricity accounts, and service
    charge accounts existed.
    Every statement is safe to run again.
  */
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'properties'
          AND column_name = 'rent_due_day'
          AND data_type <> 'integer'
      ) THEN
        ALTER TABLE properties
          ALTER COLUMN rent_due_day DROP DEFAULT;

        ALTER TABLE properties
          ALTER COLUMN rent_due_day TYPE INTEGER
          USING LEAST(
            GREATEST(
              COALESCE(
                SUBSTRING(
                  rent_due_day FROM '[0-9]{1,2}'
                )::INTEGER,
                5
              ),
              1
            ),
            28
          );

        ALTER TABLE properties
          ALTER COLUMN rent_due_day SET DEFAULT 5;
      END IF;
    END
    $$;

    ALTER TABLE properties
      DROP CONSTRAINT IF EXISTS properties_rent_due_day_check;

    ALTER TABLE properties
      ADD CONSTRAINT properties_rent_due_day_check
      CHECK (rent_due_day BETWEEN 1 AND 28);

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS move_in_billing VARCHAR(30)
      NOT NULL DEFAULT 'prorated';

    ALTER TABLE properties
      DROP CONSTRAINT IF EXISTS properties_move_in_billing_check;

    ALTER TABLE properties
      ADD CONSTRAINT properties_move_in_billing_check
      CHECK (
        move_in_billing IN (
          'prorated',
          'full_month',
          'free_until_next_month'
        )
      );

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS move_out_billing VARCHAR(30)
      NOT NULL DEFAULT 'prorated';

    ALTER TABLE properties
      DROP CONSTRAINT IF EXISTS properties_move_out_billing_check;

    ALTER TABLE properties
      ADD CONSTRAINT properties_move_out_billing_check
      CHECK (
        move_out_billing IN (
          'prorated',
          'full_month'
        )
      );

    -- The secret in the account's M-Pesa notice address (encrypted).
    ALTER TABLE payment_accounts
      ADD COLUMN IF NOT EXISTS c2b_callback_token_encrypted TEXT;

    ALTER TABLE payment_accounts
      DROP CONSTRAINT IF EXISTS payment_accounts_account_for_check;

    ALTER TABLE payment_accounts
      ADD CONSTRAINT payment_accounts_account_for_check
      CHECK (account_for IN ('rent', 'water', 'electricity', 'service'));

    ALTER TABLE property_connection_checks
      DROP CONSTRAINT IF EXISTS property_connection_checks_account_for_check;

    ALTER TABLE property_connection_checks
      ADD CONSTRAINT property_connection_checks_account_for_check
      CHECK (account_for IN ('rent', 'water', 'electricity', 'service'));

    /*
      The account tenants pay service charges and repairs into:
      the rent, water or electricity account, or a separate
      'service' account of their own.
    */
    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS service_charge_account VARCHAR(30)
      NOT NULL DEFAULT 'rent';

    ALTER TABLE properties
      DROP CONSTRAINT IF EXISTS
      properties_service_charge_account_check;

    ALTER TABLE properties
      ADD CONSTRAINT properties_service_charge_account_check
      CHECK (
        service_charge_account IN (
          'rent',
          'water',
          'electricity',
          'service'
        )
      );
  `);

  console.log("[PROPERTIES] Tables initialized.");
}

module.exports = {
  init_property_tables,
};