const db = require("../config/db");

/*
  push_devices  the caretaker app's push address on each phone,
                for the person signed in there.
  push_outbox   every phone notification, sent at once or held
                until quiet hours end (see push_service.js).
  Safe to run again.
*/
async function init_push_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      token TEXT NOT NULL UNIQUE,

      platform VARCHAR(20) NOT NULL DEFAULT 'android'
        CHECK (platform IN ('android', 'ios')),

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_push_devices_user
      ON push_devices(user_id);

    CREATE TABLE IF NOT EXISTS push_outbox (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      title VARCHAR(120) NOT NULL,
      body VARCHAR(300) NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::JSONB,
      urgent BOOLEAN NOT NULL DEFAULT FALSE,

      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'no_device')),

      send_after TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_push_outbox_due
      ON push_outbox(send_after)
      WHERE status = 'pending';

    -- A notification left "sending" by a server that stopped is sent again.
    UPDATE push_outbox
    SET status = 'pending'
    WHERE status = 'sending';
  `);

  console.log("[PUSH] Tables initialized.");
}

module.exports = {
  init_push_tables,
};
