const db = require("../config/db");

async function init_caretaker_tables() {
  await db.query(`
    ALTER TABLE property_caretaker_assignments
      ADD COLUMN IF NOT EXISTS permission_level VARCHAR(30);

    UPDATE property_caretaker_assignments
    SET permission_level = 'level_1'
    WHERE permission_level IS NULL;

    ALTER TABLE property_caretaker_assignments
      ALTER COLUMN permission_level
      SET DEFAULT 'level_1';

    ALTER TABLE property_caretaker_assignments
      ALTER COLUMN permission_level
      SET NOT NULL;

    ALTER TABLE property_caretaker_assignments
      DROP CONSTRAINT IF EXISTS
        property_caretaker_assignments_permission_level_check;

    ALTER TABLE property_caretaker_assignments
      ADD CONSTRAINT
        property_caretaker_assignments_permission_level_check
      CHECK (
        permission_level IN ('level_1', 'level_2')
      );

    /*
      One active caretaker per property.
      Historical inactive assignments stay on record.
    */
    CREATE UNIQUE INDEX IF NOT EXISTS
      uq_one_active_caretaker_per_property
      ON property_caretaker_assignments(property_id)
      WHERE status = 'active';

        CREATE INDEX IF NOT EXISTS
      idx_caretaker_assignment_owner
      ON property_caretaker_assignments(
        owner_id,
        caretaker_id,
        status
      );
  `);

  /*
    Whether the owner lets this property's caretaker record
    payments handed to them. Off unless the owner turns it on.
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE property_caretaker_assignments
      ADD COLUMN IF NOT EXISTS can_record_payments BOOLEAN
        NOT NULL DEFAULT FALSE;
  `);

  /*
    What the owner lets the caretaker do in this property, one
    switch each. The day-to-day work is on for a new caretaker;
    managing tenants and recording payments are off.
    permission_level is kept in step for older code: level_2
    means "manages tenants". Safe to run again.
  */
  await db.query(`
    ALTER TABLE property_caretaker_assignments
      ADD COLUMN IF NOT EXISTS can_read_meters BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS can_enter_electricity BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS can_manage_maintenance BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS can_add_expenses BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS can_view_tenants BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS can_manage_tenants BOOLEAN NOT NULL DEFAULT FALSE;

    UPDATE property_caretaker_assignments
    SET can_manage_tenants = TRUE
    WHERE permission_level = 'level_2'
      AND can_manage_tenants = FALSE;

    UPDATE property_caretaker_assignments
    SET can_view_tenants = TRUE
    WHERE (can_manage_tenants OR can_record_payments)
      AND can_view_tenants = FALSE;

    ALTER TABLE property_caretaker_assignments
      DROP CONSTRAINT IF EXISTS
        property_caretaker_assignments_tenants_visible_check;

    ALTER TABLE property_caretaker_assignments
      ADD CONSTRAINT property_caretaker_assignments_tenants_visible_check
      CHECK (
        can_view_tenants
        OR NOT (can_manage_tenants OR can_record_payments)
      );
  `);

  console.log("[CARETAKERS] Tables initialized.");
}

module.exports = {
  init_caretaker_tables,
};