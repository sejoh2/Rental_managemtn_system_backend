const db = require("../config/db");

/*
  Kodi's own analytics, kept in Kodi's database only: no third
  party sees it.

  analytics_events  every visit, click, step and error, for 90
                    days. Visitors are a random number per browser;
                    no names, phones, IP addresses or typed text.
  analytics_daily   the daily totals, kept for good, made from the
                    events before they are removed.
  Safe to run again.
*/
async function init_analytics_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id record_id PRIMARY KEY DEFAULT new_id('ane'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      visitor_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,

      -- Signed in: who, and as what (owner, caretaker, user).
      user_id record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,
      role VARCHAR(20),

      kind VARCHAR(10) NOT NULL
        CHECK (kind IN ('page', 'click', 'step', 'error', 'leave')),

      -- The page, with IDs replaced: /dashboard/tenants/:id
      path VARCHAR(200) NOT NULL,
      -- The button or link, the step, or the error.
      name VARCHAR(120),

      -- Where the visit came from (google, whatsapp, ...), and the screen size.
      source VARCHAR(40),
      device VARCHAR(10),

      -- Time on the page, for "leave".
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_events_time
      ON analytics_events(occurred_at);

    CREATE INDEX IF NOT EXISTS idx_analytics_events_session
      ON analytics_events(session_id, occurred_at);

    CREATE TABLE IF NOT EXISTS analytics_daily (
      day DATE NOT NULL,
      kind VARCHAR(10) NOT NULL,
      path VARCHAR(200) NOT NULL DEFAULT '',
      name VARCHAR(120) NOT NULL DEFAULT '',
      source VARCHAR(40) NOT NULL DEFAULT '',
      device VARCHAR(10) NOT NULL DEFAULT '',
      role VARCHAR(20) NOT NULL DEFAULT '',
      events INTEGER NOT NULL,
      visitors INTEGER NOT NULL,
      PRIMARY KEY (day, kind, path, name, source, device, role)
    );

    -- The days already totalled, so a day is never counted twice.
    CREATE TABLE IF NOT EXISTS analytics_rollups (
      day DATE PRIMARY KEY,
      done_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("[ANALYTICS] Tables initialized.");
}

module.exports = {
  init_analytics_tables,
};
