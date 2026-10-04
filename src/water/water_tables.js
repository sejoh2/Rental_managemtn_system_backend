const db = require("../config/db");

async function init_water_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS water_meter_readings (
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

      tenant_id BIGINT
        REFERENCES tenants(id)
        ON DELETE SET NULL,

      billing_period DATE NOT NULL,

      meter_number VARCHAR(100) NOT NULL,

      previous_reading NUMERIC(14,3) NOT NULL
        CHECK (previous_reading >= 0),

      current_reading NUMERIC(14,3) NOT NULL
        CHECK (current_reading >= 0),

      units_used NUMERIC(14,3),

      rate_per_unit NUMERIC(12,2),

      bill_amount NUMERIC(12,2),

      meter_photo_url TEXT,

      notes TEXT,

      /*
        submitted: valid reading, bill created.
        flagged: requires owner correction/review.
        rejected: owner rejected it; no bill.
      */
      status VARCHAR(30) NOT NULL DEFAULT 'submitted'
        CHECK (
          status IN (
            'submitted',
            'flagged',
            'rejected'
          )
        ),

      flag_reason TEXT,

      reviewed_by BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      reviewed_at TIMESTAMPTZ,

      tenant_charge_id BIGINT UNIQUE
        REFERENCES tenant_charges(id)
        ON DELETE SET NULL,

      submitted_by BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      submitted_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(unit_id, billing_period)
    );

    CREATE INDEX IF NOT EXISTS
      idx_water_readings_property_period
      ON water_meter_readings(property_id, billing_period);

    CREATE INDEX IF NOT EXISTS
      idx_water_readings_unit_id
      ON water_meter_readings(unit_id);

    CREATE INDEX IF NOT EXISTS
      idx_water_readings_status
      ON water_meter_readings(status);

    DROP TRIGGER IF EXISTS
      update_water_meter_readings_updated_at
      ON water_meter_readings;

    CREATE TRIGGER
      update_water_meter_readings_updated_at
      BEFORE UPDATE ON water_meter_readings
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  console.log("[WATER] Tables initialized.");
}

module.exports = {
  init_water_tables,
};