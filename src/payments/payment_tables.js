const db = require("../config/db");

async function init_payment_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_charges (
      id BIGSERIAL PRIMARY KEY,

      tenant_id BIGINT NOT NULL
        REFERENCES tenants(id)
        ON DELETE CASCADE,

      owner_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id BIGINT NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      unit_id BIGINT NOT NULL
        REFERENCES units(id)
        ON DELETE RESTRICT,

      charge_type VARCHAR(30) NOT NULL
        CHECK (
          charge_type IN (
            'rent_deposit',
            'water_deposit',
            'rent',
            'water',
            'electricity',
            'electricity_deposit'
          )
        ),

      /*
        Deposit charges use 1970-01-01.
        Recurring rent/water charges use the first day of their month.
      */
      billing_period DATE NOT NULL
        DEFAULT DATE '1970-01-01',

      due_date DATE NOT NULL,

      amount_due NUMERIC(12,2) NOT NULL
        CHECK (amount_due > 0),

      amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (
          amount_paid >= 0
          AND amount_paid <= amount_due
        ),

      status VARCHAR(30) NOT NULL DEFAULT 'open'
        CHECK (
          status IN ('open', 'partial', 'paid', 'void')
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(tenant_id, charge_type, billing_period)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      property_id BIGINT
        REFERENCES properties(id)
        ON DELETE SET NULL,

      unit_id BIGINT
        REFERENCES units(id)
        ON DELETE SET NULL,

      tenant_id BIGINT
        REFERENCES tenants(id)
        ON DELETE SET NULL,

      payment_account_id BIGINT
        REFERENCES payment_accounts(id)
        ON DELETE SET NULL,

      account_for VARCHAR(30)
        CHECK (
          account_for IN ('rent', 'water', 'electricity')
        ),

      amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

      payment_method VARCHAR(30) NOT NULL
        CHECK (
          payment_method IN (
            'mpesa',
            'cash',
            'bank',
            'other'
          )
        ),

      payment_source VARCHAR(30) NOT NULL
        CHECK (
          payment_source IN (
            'mpesa_c2b',
            'manual'
          )
        ),

      provider_transaction_id VARCHAR(150),

      payer_phone VARCHAR(20),

      reference VARCHAR(200),

      received_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      status VARCHAR(30) NOT NULL DEFAULT 'unmatched'
        CHECK (
          status IN (
            'unmatched',
            'matched',
            'reversed',
            'failed'
          )
        ),

      match_type VARCHAR(30)
        CHECK (
          match_type IN ('automatic', 'manual')
        ),

      unmatched_reason TEXT,

      provider_payload JSONB,

      recorded_by BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      matched_by BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      matched_at TIMESTAMPTZ,

      notes TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_allocations (
      id BIGSERIAL PRIMARY KEY,

      payment_id BIGINT NOT NULL
        REFERENCES payments(id)
        ON DELETE CASCADE,

      tenant_charge_id BIGINT NOT NULL
        REFERENCES tenant_charges(id)
        ON DELETE RESTRICT,

      amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(payment_id, tenant_charge_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_credits (
      id BIGSERIAL PRIMARY KEY,

      tenant_id BIGINT NOT NULL
        REFERENCES tenants(id)
        ON DELETE CASCADE,

      property_id BIGINT NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      source_payment_id BIGINT NOT NULL UNIQUE
        REFERENCES payments(id)
        ON DELETE CASCADE,

      original_amount NUMERIC(12,2) NOT NULL
        CHECK (original_amount > 0),

      remaining_amount NUMERIC(12,2) NOT NULL
        CHECK (
          remaining_amount >= 0
          AND remaining_amount <= original_amount
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_charges_tenant_id
      ON tenant_charges(tenant_id);

    CREATE INDEX IF NOT EXISTS idx_charges_open
      ON tenant_charges(tenant_id, status, due_date);

    CREATE INDEX IF NOT EXISTS idx_payments_owner_id
      ON payments(owner_id);

    CREATE INDEX IF NOT EXISTS idx_payments_property_id
      ON payments(property_id);

    CREATE INDEX IF NOT EXISTS idx_payments_tenant_id
      ON payments(tenant_id);

    CREATE INDEX IF NOT EXISTS idx_payments_status
      ON payments(status);

    CREATE INDEX IF NOT EXISTS idx_payments_received_at
      ON payments(received_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_mpesa_transaction
      ON payments(provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment_id
      ON payment_allocations(payment_id);

    CREATE INDEX IF NOT EXISTS idx_tenant_credits_tenant_id
      ON tenant_credits(tenant_id);

    DROP TRIGGER IF EXISTS update_tenant_charges_updated_at
      ON tenant_charges;

    CREATE TRIGGER update_tenant_charges_updated_at
      BEFORE UPDATE ON tenant_charges
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_payments_updated_at
      ON payments;

    CREATE TRIGGER update_payments_updated_at
      BEFORE UPDATE ON payments
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    /*
      Every new tenant automatically receives their deposit charges.
      No payment is required for the unit to become occupied.

      The first month's rent is created by the billing service,
      because it depends on the property's move-in billing rule.
    */
    CREATE OR REPLACE FUNCTION create_initial_tenant_charges()
    RETURNS TRIGGER AS
    $$
    BEGIN
      INSERT INTO tenant_charges (
        tenant_id,
        owner_id,
        property_id,
        unit_id,
        charge_type,
        billing_period,
        due_date,
        amount_due
      )
      VALUES
        (
          NEW.id,
          NEW.owner_id,
          NEW.property_id,
          NEW.unit_id,
          'rent_deposit',
          DATE '1970-01-01',
          NEW.move_in_date,
          NEW.rent_deposit_due
        ),
        (
          NEW.id,
          NEW.owner_id,
          NEW.property_id,
          NEW.unit_id,
          'water_deposit',
          DATE '1970-01-01',
          NEW.move_in_date,
          NEW.water_deposit_due
        )
      ON CONFLICT (tenant_id, charge_type, billing_period)
      DO NOTHING;

      RETURN NEW;
    END;
    $$
    LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS create_tenant_initial_charges
      ON tenants;

    CREATE TRIGGER create_tenant_initial_charges
      AFTER INSERT ON tenants
      FOR EACH ROW
      EXECUTE FUNCTION create_initial_tenant_charges();
  `);

  /*
    Creates charges for tenants already created before
    this Payments module was installed.
  */
  await db.query(`
    INSERT INTO tenant_charges (
      tenant_id,
      owner_id,
      property_id,
      unit_id,
      charge_type,
      billing_period,
      due_date,
      amount_due
    )
    SELECT
      id,
      owner_id,
      property_id,
      unit_id,
      'rent_deposit',
      DATE '1970-01-01',
      move_in_date,
      rent_deposit_due
    FROM tenants
    ON CONFLICT (tenant_id, charge_type, billing_period)
    DO NOTHING;

    INSERT INTO tenant_charges (
      tenant_id,
      owner_id,
      property_id,
      unit_id,
      charge_type,
      billing_period,
      due_date,
      amount_due
    )
    SELECT
      id,
      owner_id,
      property_id,
      unit_id,
      'water_deposit',
      DATE '1970-01-01',
      move_in_date,
      water_deposit_due
    FROM tenants
    ON CONFLICT (tenant_id, charge_type, billing_period)
    DO NOTHING;
  `);

  /*
    Upgrades for databases created before electricity billing.
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE tenant_charges
      DROP CONSTRAINT IF EXISTS tenant_charges_charge_type_check;

    ALTER TABLE tenant_charges
      ADD CONSTRAINT tenant_charges_charge_type_check
      CHECK (
        charge_type IN (
          'rent_deposit',
          'water_deposit',
          'rent',
          'water',
          'electricity',
          'electricity_deposit'
        )
      );

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS reversed_by BIGINT
      REFERENCES users(user_id)
      ON DELETE SET NULL;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS reverse_reason TEXT;

    ALTER TABLE payments
      DROP CONSTRAINT IF EXISTS payments_account_for_check;

    ALTER TABLE payments
      ADD CONSTRAINT payments_account_for_check
      CHECK (account_for IN ('rent', 'water', 'electricity'));
  `);

  console.log("[PAYMENTS] Payment tables initialized.");
}

module.exports = {
  init_payment_tables,
};