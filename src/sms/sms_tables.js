const db = require("../config/db");

const {
  init_sender_approval_tables,
} = require("./sender_approval_service");

async function init_sms_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sms_templates (
      id record_id PRIMARY KEY DEFAULT new_id('smt'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      name VARCHAR(120) NOT NULL,

      body TEXT NOT NULL
        CHECK (
          CHAR_LENGTH(body) BETWEEN 1 AND 1000
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(owner_id, name)
    );

    CREATE TABLE IF NOT EXISTS sms_broadcasts (
      id record_id PRIMARY KEY DEFAULT new_id('smb'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      template_id record_id
        REFERENCES sms_templates(id)
        ON DELETE SET NULL,

      /*
        Snapshot values ensure editing or deleting a template later
        never changes a historical or scheduled message.
      */
      template_name VARCHAR(120),
      message_template TEXT NOT NULL,

      recipient_group VARCHAR(50) NOT NULL
        CHECK (
          recipient_group IN (
            'all_active_tenants',
            'tenants_with_arrears',
            'tenants_with_credit_balance',
            'property',
            'specific_tenant'
          )
        ),

      property_id record_id
        REFERENCES properties(id)
        ON DELETE SET NULL,

      tenant_id record_id
        REFERENCES tenants(id)
        ON DELETE SET NULL,

      variables JSONB NOT NULL DEFAULT '{}'::JSONB,

      scheduled_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      status VARCHAR(30) NOT NULL DEFAULT 'scheduled'
        CHECK (
          status IN (
            'scheduled',
            'sending',
            'completed',
            'partially_failed',
            'cancelled'
          )
        ),

      cancelled_at TIMESTAMPTZ,
      cancelled_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sms_messages (
      id record_id PRIMARY KEY DEFAULT new_id('sms'),

      broadcast_id record_id NOT NULL
        REFERENCES sms_broadcasts(id)
        ON DELETE CASCADE,

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id
        REFERENCES properties(id)
        ON DELETE SET NULL,

      tenant_id record_id
        REFERENCES tenants(id)
        ON DELETE SET NULL,

      tenant_name VARCHAR(200) NOT NULL,
      unit_number VARCHAR(100),

      recipient_phone VARCHAR(20) NOT NULL,
      sender_id VARCHAR(50),

      template_name VARCHAR(120),

      /*
        The final personalised message sent to this tenant.
      */
      message TEXT NOT NULL,

      estimated_cost NUMERIC(12,2) NOT NULL DEFAULT 0,

      status VARCHAR(30) NOT NULL DEFAULT 'queued'
        CHECK (
          status IN (
            'queued',
            'accepted',
            'failed',
            'cancelled'
          )
        ),

      retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (retry_count >= 0),

      provider VARCHAR(50),
      provider_response JSONB,
      provider_error TEXT,

      accepted_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(broadcast_id, tenant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sms_templates_owner
      ON sms_templates(owner_id);

    CREATE INDEX IF NOT EXISTS idx_sms_broadcasts_owner_status
      ON sms_broadcasts(owner_id, status, scheduled_at);

    CREATE INDEX IF NOT EXISTS idx_sms_messages_owner_created
      ON sms_messages(owner_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sms_messages_broadcast_status
      ON sms_messages(broadcast_id, status);

    CREATE INDEX IF NOT EXISTS idx_sms_messages_tenant
      ON sms_messages(tenant_id);

    DROP TRIGGER IF EXISTS update_sms_templates_updated_at
      ON sms_templates;

    CREATE TRIGGER update_sms_templates_updated_at
      BEFORE UPDATE ON sms_templates
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_sms_broadcasts_updated_at
      ON sms_broadcasts;

    CREATE TRIGGER update_sms_broadcasts_updated_at
      BEFORE UPDATE ON sms_broadcasts
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_sms_messages_updated_at
      ON sms_messages;

    CREATE TRIGGER update_sms_messages_updated_at
      BEFORE UPDATE ON sms_messages
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  /*
    Upgrades. Every statement is safe to run again.

    - A message no longer has to belong to a broadcast, so single
      messages the system sends (a repair charge notice) are kept
      in the same history.
    - A scheduled broadcast's messages are written when it is
      sent, not when it is scheduled, so balances and recipients
      are those of the sending day. messages_created_at is set
      once that has happened.
    - sms_template_seeds remembers which owners already received
      the starter templates, so deleted ones do not come back.
  */
  await db.query(`
    ALTER TABLE sms_messages
      ALTER COLUMN broadcast_id DROP NOT NULL;

    ALTER TABLE sms_broadcasts
      ADD COLUMN IF NOT EXISTS messages_created_at TIMESTAMPTZ;

    UPDATE sms_broadcasts
    SET messages_created_at = created_at
    WHERE messages_created_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM sms_messages
        WHERE sms_messages.broadcast_id = sms_broadcasts.id
      );

    CREATE TABLE IF NOT EXISTS sms_template_seeds (
      owner_id record_id PRIMARY KEY
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await init_sender_approval_tables();

  console.log("[SMS] SMS Centre tables initialized.");
}

module.exports = {
  init_sms_tables,
};