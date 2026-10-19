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

  /*
    When a request is resolved with a cost, the cost is recorded
    as an expense. If the owner ticked charge_to_tenant, it is
    also charged to the tenant living in the unit.
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS charge_to_tenant BOOLEAN
      NOT NULL DEFAULT FALSE;

    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS expense_id BIGINT
      REFERENCES expenses(id)
      ON DELETE SET NULL;

    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS tenant_charge_id BIGINT
      REFERENCES tenant_charges(id)
      ON DELETE SET NULL;

    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS charged_tenant_id BIGINT
      REFERENCES tenants(id)
      ON DELETE SET NULL;

    /*
      How a tenant pays a repair charged to them: 'now' (from
      their credit or next payment) or 'move_out' (deducted
      from the deposit when they leave).
    */
    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS charge_timing VARCHAR(20)
      NOT NULL DEFAULT 'now';

    ALTER TABLE maintenance_requests
      DROP CONSTRAINT IF EXISTS
        maintenance_requests_charge_timing_check;

    ALTER TABLE maintenance_requests
      ADD CONSTRAINT maintenance_requests_charge_timing_check
      CHECK (charge_timing IN ('now', 'move_out'));

    /*
      When the tenant was last sent an SMS about the charge.
      It is sent by hand, never automatically.
    */
    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS charge_sms_sent_at TIMESTAMPTZ;
  `);

  /*
    What is new for someone, until they open it:
    caretaker_notice  'reported' (the owner reported it) or
                      'assigned' (the owner gave it to the
                      caretaker), for the property's caretaker
                      in the phone app.
    owner_notice      'done' (the caretaker marked it done), for
                      the owner's bell.
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS caretaker_notice VARCHAR(20);

    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS caretaker_notice_at TIMESTAMPTZ;

    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS owner_notice VARCHAR(20);

    ALTER TABLE maintenance_requests
      ADD COLUMN IF NOT EXISTS owner_notice_at TIMESTAMPTZ;

    ALTER TABLE maintenance_requests
      DROP CONSTRAINT IF EXISTS
        maintenance_requests_caretaker_notice_check;

    ALTER TABLE maintenance_requests
      ADD CONSTRAINT maintenance_requests_caretaker_notice_check
      CHECK (caretaker_notice IN ('reported', 'assigned'));

    ALTER TABLE maintenance_requests
      DROP CONSTRAINT IF EXISTS
        maintenance_requests_owner_notice_check;

    ALTER TABLE maintenance_requests
      ADD CONSTRAINT maintenance_requests_owner_notice_check
      CHECK (owner_notice IN ('done'));

    CREATE INDEX IF NOT EXISTS
      idx_maintenance_caretaker_notice
      ON maintenance_requests(property_id)
      WHERE caretaker_notice IS NOT NULL;

    CREATE INDEX IF NOT EXISTS
      idx_maintenance_owner_notice
      ON maintenance_requests(owner_id)
      WHERE owner_notice IS NOT NULL;
  `);

  console.log("[MAINTENANCE] Tables initialized.");
}

module.exports = {
  init_maintenance_tables,
};