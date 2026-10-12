const db = require("../config/db");

async function init_service_charge_tables() {
  await db.query(`
    /*
      A cost the owner passes on to tenants, such as garbage,
      security or cleaning.

      'monthly' is billed with rent every month.
      'once' is billed a single time to each tenant: to everyone
      living there when it is added, and to each new tenant when
      they move in.
    */
    CREATE TABLE IF NOT EXISTS service_charges (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id BIGINT NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      name VARCHAR(100) NOT NULL,

      /*
        The expense category this charge recovers, so Expenses
        can compare what was spent with what tenants were charged.
      */
      category VARCHAR(50) NOT NULL
        CHECK (
          category IN (
            'repairs_maintenance',
            'security',
            'garbage',
            'cleaning',
            'utilities',
            'other'
          )
        ),

      frequency VARCHAR(20) NOT NULL
        CHECK (frequency IN ('monthly', 'once')),

      /*
        Billed to every unit that has no amount of its own
        in service_charge_units.
      */
      amount NUMERIC(12,2) NOT NULL
        CHECK (amount >= 0),

      /*
        The day the charge was added. Tenants already living
        there are billed from this day, following the
        property's move-in billing rule.
      */
      start_date DATE NOT NULL,

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),

      archived_at TIMESTAMPTZ,

      created_by BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    /*
      A unit that pays a different amount from the charge's
      own amount. Zero means the unit is not charged.
    */
    CREATE TABLE IF NOT EXISTS service_charge_units (
      id BIGSERIAL PRIMARY KEY,

      service_charge_id BIGINT NOT NULL
        REFERENCES service_charges(id)
        ON DELETE CASCADE,

      unit_id BIGINT NOT NULL
        REFERENCES units(id)
        ON DELETE CASCADE,

      amount NUMERIC(12,2) NOT NULL
        CHECK (amount >= 0),

      UNIQUE(service_charge_id, unit_id)
    );

    CREATE INDEX IF NOT EXISTS
      idx_service_charges_property
      ON service_charges(property_id, status);

    CREATE UNIQUE INDEX IF NOT EXISTS
      uq_service_charge_name_per_property
      ON service_charges(property_id, LOWER(name))
      WHERE status = 'active';

    DROP TRIGGER IF EXISTS
      update_service_charges_updated_at
      ON service_charges;

    CREATE TRIGGER
      update_service_charges_updated_at
      BEFORE UPDATE ON service_charges
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  console.log("[SERVICE CHARGES] Tables initialized.");
}

module.exports = {
  init_service_charge_tables,
};
