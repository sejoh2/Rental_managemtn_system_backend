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

  console.log("[CARETAKERS] Tables initialized.");
}

module.exports = {
  init_caretaker_tables,
};