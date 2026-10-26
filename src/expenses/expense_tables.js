const db = require("../config/db");

async function init_expense_tables() {
  await db.query(`
    /*
      This will also be reused by the later Caretakers module.
      An active caretaker may only operate on assigned properties.
    */
    CREATE TABLE IF NOT EXISTS property_caretaker_assignments (
      id record_id PRIMARY KEY DEFAULT new_id('cta'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      caretaker_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

      assigned_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      unassigned_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(property_id, caretaker_id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id record_id PRIMARY KEY DEFAULT new_id('exp'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

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

      amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

      expense_date DATE NOT NULL,

      notes TEXT,

      /*
        A URL/reference only for now.
        Actual file upload is added later.
      */
      receipt_url TEXT,

      status VARCHAR(30) NOT NULL DEFAULT 'recorded'
        CHECK (status IN ('recorded', 'void')),

      void_reason TEXT,

      voided_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      voided_at TIMESTAMPTZ,

      created_by record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE RESTRICT,

      created_by_role VARCHAR(30) NOT NULL
        CHECK (
          created_by_role IN ('owner', 'caretaker')
        ),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS
      idx_caretaker_assignments_property
      ON property_caretaker_assignments(
        property_id,
        caretaker_id,
        status
      );

    CREATE INDEX IF NOT EXISTS
      idx_expenses_owner_date
      ON expenses(owner_id, expense_date DESC);

    CREATE INDEX IF NOT EXISTS
      idx_expenses_property_date
      ON expenses(property_id, expense_date DESC);

    CREATE INDEX IF NOT EXISTS
      idx_expenses_status
      ON expenses(status);

    DROP TRIGGER IF EXISTS
      update_property_caretaker_assignments_updated_at
      ON property_caretaker_assignments;

    CREATE TRIGGER
      update_property_caretaker_assignments_updated_at
      BEFORE UPDATE ON property_caretaker_assignments
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS
      update_expenses_updated_at
      ON expenses;

    CREATE TRIGGER
      update_expenses_updated_at
      BEFORE UPDATE ON expenses
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  /*
    An expense created from a resolved maintenance request
    points back to it, and to the unit that was repaired.
    Safe to run again.
  */
  await db.query(`
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS maintenance_request_id record_id;

    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS unit_id record_id
      REFERENCES units(id)
      ON DELETE SET NULL;
  `);

  console.log("[EXPENSES] Tables initialized.");
}

module.exports = {
  init_expense_tables,
};