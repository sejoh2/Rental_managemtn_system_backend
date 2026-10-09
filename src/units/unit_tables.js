const db = require("../config/db");

async function init_unit_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS units (
      id BIGSERIAL PRIMARY KEY,

      property_id BIGINT NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      unit_number VARCHAR(100) NOT NULL,

      unit_type VARCHAR(50) NOT NULL
        DEFAULT 'other'
        CHECK (
          unit_type IN (
            'bedsitter',
            'studio',
            'one_bedroom',
            'two_bedroom',
            'three_bedroom',
            'shop',
            'office',
            'other'
          )
        ),

      block_or_floor VARCHAR(100),

      monthly_rent NUMERIC(12,2) NOT NULL
        CHECK (monthly_rent > 0),

      rent_deposit NUMERIC(12,2) NOT NULL
        CHECK (rent_deposit >= 0),

      /*
        Water deposit is a fixed business rule.
        It is charged later to a tenant during move-in.
      */
      water_deposit NUMERIC(12,2) NOT NULL DEFAULT 2000
        CHECK (water_deposit = 2000),

      water_billing_method VARCHAR(50) NOT NULL
        CHECK (
          water_billing_method IN (
            'fixed_monthly',
            'per_unit_metered',
            'included_in_rent'
          )
        ),

      /*
        Used only for fixed_monthly billing.
      */
      water_fixed_monthly_bill NUMERIC(12,2)
        CHECK (
          water_fixed_monthly_bill IS NULL
          OR water_fixed_monthly_bill >= 0
        ),

      /*
        Used only for per_unit_metered billing.
      */
      water_rate_per_unit NUMERIC(12,2)
        CHECK (
          water_rate_per_unit IS NULL
          OR water_rate_per_unit >= 0
        ),

      water_meter_number VARCHAR(100),

      status VARCHAR(30) NOT NULL DEFAULT 'vacant'
        CHECK (
          status IN (
            'vacant',
            'occupied',
            'reserved',
            'maintenance',
            'inactive'
          )
        ),

      archived_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(property_id, unit_number)
    );

    CREATE INDEX IF NOT EXISTS idx_units_property_id
      ON units(property_id);

    CREATE INDEX IF NOT EXISTS idx_units_status
      ON units(status);

    CREATE INDEX IF NOT EXISTS idx_units_water_meter_number
      ON units(water_meter_number);

    DROP TRIGGER IF EXISTS update_units_updated_at
      ON units;

    CREATE TRIGGER update_units_updated_at
      BEFORE UPDATE ON units
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  /*
    Optional fixed electricity amount billed with rent each month.
    NULL or 0 means electricity is not billed for the unit.
  */
  await db.query(`
    ALTER TABLE units
      ADD COLUMN IF NOT EXISTS electricity_monthly_charge
      NUMERIC(12,2)
      CHECK (
        electricity_monthly_charge IS NULL
        OR electricity_monthly_charge >= 0
      );

    ALTER TABLE units
      ADD COLUMN IF NOT EXISTS electricity_deposit
      NUMERIC(12,2)
      CHECK (
        electricity_deposit IS NULL
        OR electricity_deposit >= 0
      );
  `);

  console.log("[UNITS] Units table initialized.");
}

module.exports = {
  init_unit_tables,
};