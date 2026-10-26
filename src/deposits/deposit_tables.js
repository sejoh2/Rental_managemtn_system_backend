const db = require("../config/db");

async function init_deposit_tables() {
  await db.query(`
    /*
      The result of reconciling a tenant's deposits after they
      move out: what was held, what it covered, and what is
      refunded to the tenant or still owed by them.
      One per tenant. It is final once confirmed.
    */
    CREATE TABLE IF NOT EXISTS deposit_settlements (
      id record_id PRIMARY KEY DEFAULT new_id('dst'),

      tenant_id record_id NOT NULL UNIQUE
        REFERENCES tenants(id)
        ON DELETE CASCADE,

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      deposits_held NUMERIC(12,2) NOT NULL DEFAULT 0,
      credit_held NUMERIC(12,2) NOT NULL DEFAULT 0,
      deductions_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      applied_to_bills NUMERIC(12,2) NOT NULL DEFAULT 0,

      refund_due NUMERIC(12,2) NOT NULL DEFAULT 0,
      tenant_owes NUMERIC(12,2) NOT NULL DEFAULT 0,

      /*
        The figures shown to the owner when they confirmed.
      */
      breakdown JSONB NOT NULL DEFAULT '{}'::JSONB,

      confirmed_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      confirmed_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      /*
        Filled in when the owner pays the refund to the tenant.
      */
      refund_paid_on DATE,
      refund_method VARCHAR(30)
        CHECK (
          refund_method IS NULL
          OR refund_method IN (
            'mpesa',
            'cash',
            'bank',
            'other'
          )
        ),
      refund_reference VARCHAR(200),
      refund_recorded_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,
      refund_recorded_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    /*
      Deposit or credit money used to pay one of the tenant's
      bills. This is when that money becomes income.
    */
    CREATE TABLE IF NOT EXISTS deposit_applications (
      id record_id PRIMARY KEY DEFAULT new_id('dap'),

      settlement_id record_id NOT NULL
        REFERENCES deposit_settlements(id)
        ON DELETE CASCADE,

      tenant_charge_id record_id NOT NULL
        REFERENCES tenant_charges(id)
        ON DELETE RESTRICT,

      source VARCHAR(30) NOT NULL
        CHECK (
          source IN (
            'rent_deposit',
            'water_deposit',
            'electricity_deposit',
            'credit'
          )
        ),

      amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS
      idx_deposit_settlements_owner
      ON deposit_settlements(owner_id, confirmed_at DESC);

    CREATE INDEX IF NOT EXISTS
      idx_deposit_applications_settlement
      ON deposit_applications(settlement_id);
  `);

  console.log("[DEPOSITS] Tables initialized.");
}

module.exports = {
  init_deposit_tables,
};
