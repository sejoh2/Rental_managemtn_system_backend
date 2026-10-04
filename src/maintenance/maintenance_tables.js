const db = require("../config/db");

async function init_maintenance_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS maintenance_requests (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id BIGINT NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      /*
        NULL means a common-area issue:
        gate, compound, drainage, corridor, etc.
      */
      unit_id BIGINT
        REFERENCES units(id)
        ON DELETE SET NULL,

      title VARCHAR(255) NOT NULL,
      description TEXT,

      category VARCHAR(50) NOT NULL DEFAULT 'other'
        CHECK (
          category IN (
            'plumbing',
            'electrical',
            'water',
            'structural',
            'security',
            'cleaning',
            'appliance',
            'other'
          )
        ),

      priority VARCHAR(30) NOT NULL DEFAULT 'normal'
        CHECK (
          priority IN (
            'low',
            'normal',
            'high',
            'urgent'
          )
        ),

      status VARCHAR(30) NOT NULL DEFAULT 'reported'
        CHECK (
          status IN (
            'reported',
            'in_progress',
            'resolved',
            'cancelled'
          )
        ),

      reported_by BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE RESTRICT,

      reporter_role VARCHAR(30) NOT NULL
        CHECK (
          reporter_role IN ('owner', 'caretaker')
        ),

      assigned_caretaker_id BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      assigned_vendor_name VARCHAR(255),

      estimated_cost NUMERIC(12,2)
        CHECK (
          estimated_cost IS NULL
          OR estimated_cost >= 0
        ),

      actual_cost NUMERIC(12,2)
        CHECK (
          actual_cost IS NULL
          OR actual_cost >= 0
        ),

      resolution_notes TEXT,

      resolved_at TIMESTAMPTZ,

      cancelled_at TIMESTAMPTZ,

      cancellation_reason TEXT,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS
      idx_maintenance_owner_status
      ON maintenance_requests(
        owner_id,
        status,
        created_at DESC
      );

    CREATE INDEX IF NOT EXISTS
      idx_maintenance_property_status
      ON maintenance_requests(
        property_id,
        status,
        created_at DESC
      );

    CREATE INDEX IF NOT EXISTS
      idx_maintenance_unit_id
      ON maintenance_requests(unit_id);

    CREATE INDEX IF NOT EXISTS
      idx_maintenance_assigned_caretaker
      ON maintenance_requests(
        assigned_caretaker_id,
        status
      );

    DROP TRIGGER IF EXISTS
      update_maintenance_requests_updated_at
      ON maintenance_requests;

    CREATE TRIGGER
      update_maintenance_requests_updated_at
      BEFORE UPDATE ON maintenance_requests
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  console.log("[MAINTENANCE] Tables initialized.");
}

module.exports = {
  init_maintenance_tables,
};