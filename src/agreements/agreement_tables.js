const db = require("../config/db");

async function init_agreement_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS agreement_templates (
      id record_id PRIMARY KEY DEFAULT new_id('agt'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      /*
        NULL means the owner's default template.
        A value means this template overrides the default
        for one specific property.
      */
      property_id record_id
        REFERENCES properties(id)
        ON DELETE CASCADE,

      name VARCHAR(150) NOT NULL,

      content TEXT NOT NULL,

      notice_period_days INTEGER NOT NULL DEFAULT 30
        CHECK (
          notice_period_days >= 1
          AND notice_period_days <= 365
        ),

      version INTEGER NOT NULL DEFAULT 1
        CHECK (version >= 1),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(owner_id, property_id)
    );

    /*
      PostgreSQL considers NULL values distinct in a normal
      UNIQUE constraint, so this ensures one owner default.
    */
    CREATE UNIQUE INDEX IF NOT EXISTS
      uq_default_agreement_template_per_owner
      ON agreement_templates(owner_id)
      WHERE property_id IS NULL;

    CREATE TABLE IF NOT EXISTS agreements (
      id record_id PRIMARY KEY DEFAULT new_id('agr'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      unit_id record_id NOT NULL
        REFERENCES units(id)
        ON DELETE RESTRICT,

      tenant_id record_id NOT NULL UNIQUE
        REFERENCES tenants(id)
        ON DELETE CASCADE,

      /*
        Kept for traceability only. The actual template content
        is also snapshotted below so later template edits do not
        change historical agreements.
      */
      template_id record_id
        REFERENCES agreement_templates(id)
        ON DELETE SET NULL,

      template_name VARCHAR(150) NOT NULL,

      template_version INTEGER NOT NULL,

      template_content TEXT NOT NULL,

      rendered_content TEXT NOT NULL,

      status VARCHAR(30) NOT NULL
        DEFAULT 'awaiting_signature'
        CHECK (
          status IN (
            'awaiting_signature',
            'signed'
          )
        ),

      signed_at DATE,

      signed_notes TEXT,

      generated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS
      idx_agreement_templates_owner_id
      ON agreement_templates(owner_id);

    CREATE INDEX IF NOT EXISTS
      idx_agreement_templates_property_id
      ON agreement_templates(property_id);

    CREATE INDEX IF NOT EXISTS
      idx_agreements_owner_id
      ON agreements(owner_id);

    CREATE INDEX IF NOT EXISTS
      idx_agreements_property_id
      ON agreements(property_id);

    CREATE INDEX IF NOT EXISTS
      idx_agreements_tenant_id
      ON agreements(tenant_id);

    CREATE INDEX IF NOT EXISTS
      idx_agreements_status
      ON agreements(status);

    DROP TRIGGER IF EXISTS
      update_agreement_templates_updated_at
      ON agreement_templates;

    CREATE TRIGGER
      update_agreement_templates_updated_at
      BEFORE UPDATE ON agreement_templates
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS
      update_agreements_updated_at
      ON agreements;

    CREATE TRIGGER
      update_agreements_updated_at
      BEFORE UPDATE ON agreements
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  console.log("[AGREEMENTS] Tables initialized.");
}

module.exports = {
  init_agreement_tables,
};