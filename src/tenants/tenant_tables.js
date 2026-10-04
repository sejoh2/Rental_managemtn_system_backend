const db = require("../config/db");

async function init_tenant_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id BIGINT NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      unit_id BIGINT NOT NULL
        REFERENCES units(id)
        ON DELETE RESTRICT,

      full_name VARCHAR(200) NOT NULL,

      /*
        This is the primary automatic payment-matching identity.
        It is normalized to +2547XXXXXXXX format.
      */
      payment_phone VARCHAR(20) NOT NULL,

      email VARCHAR(255),
      national_id VARCHAR(100),

      move_in_date DATE NOT NULL,

      /*
        These values are copied from the unit at move-in.
        They are not supplied by the owner when adding a tenant.
      */
      monthly_rent NUMERIC(12,2) NOT NULL
        CHECK (monthly_rent > 0),

      rent_deposit_due NUMERIC(12,2) NOT NULL
        CHECK (rent_deposit_due >= 0),

      water_deposit_due NUMERIC(12,2) NOT NULL DEFAULT 2000
        CHECK (water_deposit_due = 2000),

      /*
        Used later for bank / water payment matching.
        Example: A101-WANJIKU
      */
      water_payment_reference VARCHAR(150) NOT NULL,

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (
          status IN (
            'active',
            'notice_given',
            'moved_out',
            'inactive'
          )
        ),

      notice_date DATE,

      moved_out_at TIMESTAMPTZ,
      move_out_date DATE,
      move_out_reason TEXT,

      /*
        Informational only for now.
        Actual refund payments are implemented later in Payments.
      */
      deposit_refund_decision VARCHAR(30)
        CHECK (
          deposit_refund_decision IS NULL
          OR deposit_refund_decision IN (
            'full_refund',
            'partial_refund',
            'no_refund'
          )
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    /*
      A unit can have one current tenant only.
      Moved-out tenant records remain for history.
    */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_tenant_per_unit
      ON tenants(unit_id)
      WHERE status IN ('active', 'notice_given');

    /*
      Prevents ambiguous automatic M-Pesa matching within a property.
      The same phone can exist in different properties.
    */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_payment_phone_per_property
      ON tenants(property_id, payment_phone)
      WHERE status IN ('active', 'notice_given');

    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_water_reference_per_property
      ON tenants(property_id, water_payment_reference)
      WHERE status IN ('active', 'notice_given');

    CREATE INDEX IF NOT EXISTS idx_tenants_owner_id
      ON tenants(owner_id);

    CREATE INDEX IF NOT EXISTS idx_tenants_property_id
      ON tenants(property_id);

    CREATE INDEX IF NOT EXISTS idx_tenants_unit_id
      ON tenants(unit_id);

    CREATE INDEX IF NOT EXISTS idx_tenants_payment_phone
      ON tenants(payment_phone);

    CREATE INDEX IF NOT EXISTS idx_tenants_status
      ON tenants(status);

    DROP TRIGGER IF EXISTS update_tenants_updated_at
      ON tenants;

    CREATE TRIGGER update_tenants_updated_at
      BEFORE UPDATE ON tenants
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  console.log("[TENANTS] Tenants table initialized.");
}

module.exports = {
  init_tenant_tables,
};