const db = require("../config/db");

async function init_unit_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS units (
      id record_id PRIMARY KEY DEFAULT new_id('unt'),

      property_id record_id NOT NULL
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
      water_deposit NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (water_deposit >= 0),

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
      DROP CONSTRAINT IF EXISTS units_water_deposit_check;

    ALTER TABLE units
      ADD CONSTRAINT units_water_deposit_check
      CHECK (water_deposit >= 0);

    ALTER TABLE units
      ALTER COLUMN water_deposit SET DEFAULT 0;

    ALTER TABLE units
      ADD COLUMN IF NOT EXISTS electricity_deposit
      NUMERIC(12,2)
      CHECK (
        electricity_deposit IS NULL
        OR electricity_deposit >= 0
      );

    /*
      How electricity is billed for the unit.
      'fixed_monthly' bills electricity_monthly_charge with rent
      each month (nothing when that amount is empty).
      'entered' bills the amount the owner types every month.
    */
    ALTER TABLE units
      ADD COLUMN IF NOT EXISTS electricity_billing_method
      VARCHAR(30) NOT NULL DEFAULT 'fixed_monthly';

    ALTER TABLE units
      DROP CONSTRAINT IF EXISTS
      units_electricity_billing_method_check;

    ALTER TABLE units
      ADD CONSTRAINT units_electricity_billing_method_check
      CHECK (
        electricity_billing_method IN (
          'fixed_monthly',
          'entered'
        )
      );
  `);

  /*
    A unit follows its property's water and electricity rules
    (decided 2026-10-27) unless the owner bills it differently:
    then *_billing_own is true, it keeps its own settings, and
    changing the property's rules leaves it alone.
  */
  await db.query(`
    ALTER TABLE units
      ADD COLUMN IF NOT EXISTS water_billing_own BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS electricity_billing_own BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  /*
    A unit's type is no longer limited to a fixed list: the
    owner can type their own, such as "Single room".
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE units
      DROP CONSTRAINT IF EXISTS units_unit_type_check;
  `);

  console.log("[UNITS] Units table initialized.");
}

module.exports = {
  init_unit_tables,
};