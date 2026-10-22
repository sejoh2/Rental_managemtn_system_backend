const fs = require("fs");
const path = require("path");

const db = require("../config/db");

const {
  CARETAKER_PERMISSIONS,
} = require("../caretakers/caretaker_access_service");

/*
  Phone notifications to caretakers, through Firebase Cloud
  Messaging (the caretaker app registers its push address after
  sign-in).

  Every notification goes through a small queue (push_outbox):
  - outside quiet hours, or when urgent, it is sent at once;
  - between 21:00 and 07:00 Nairobi time it waits until 07:00.
  A scheduler sends what is due every minute.

  The key is FIREBASE_SERVICE_ACCOUNT (the service account JSON,
  on Render) or the file firebase-service-account.json next to
  the backend (on the PC, never committed). Without either, push
  is off and nothing is queued.
*/

const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 7;
// Nairobi is UTC+3 all year (no daylight saving).
const NAIROBI_OFFSET_HOURS = 3;

let messaging = null;
let messaging_checked = false;

// Tests replace the sender: (message) -> { responses: [{ success, error }] }
let send_override = null;

function service_account() {
  const text = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (text && text.trim()) {
    return JSON.parse(text);
  }

  const file = path.join(__dirname, "..", "..", "firebase-service-account.json");

  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function get_messaging() {
  if (messaging_checked) return messaging;

  messaging_checked = true;

  try {
    const account = service_account();

    if (!account) {
      console.log("[PUSH] No Firebase key: phone notifications are off.");
      return null;
    }

    const admin = require("firebase-admin");
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(account) });

    messaging = app.messaging();
    console.log(`[PUSH] Phone notifications on (Firebase project ${account.project_id}).`);
  } catch (error) {
    console.error("[PUSH] The Firebase key could not be read:", error.message);
    messaging = null;
  }

  return messaging;
}

function push_enabled() {
  return Boolean(send_override || get_messaging());
}

/*
  Between 21:00 and 07:00 in Nairobi. -> null when not quiet, or
  the moment quiet hours end (07:00 Nairobi, as a Date).
*/
function quiet_until(now = new Date()) {
  const nairobi = new Date(now.getTime() + NAIROBI_OFFSET_HOURS * 3600 * 1000);
  const hour = nairobi.getUTCHours();

  if (hour < QUIET_FROM_HOUR && hour >= QUIET_UNTIL_HOUR) return null;

  const end = new Date(Date.UTC(
    nairobi.getUTCFullYear(),
    nairobi.getUTCMonth(),
    nairobi.getUTCDate() + (hour >= QUIET_FROM_HOUR ? 1 : 0),
    QUIET_UNTIL_HOUR - NAIROBI_OFFSET_HOURS
  ));

  return end;
}

/*
  Queues a notification for one person. Urgent ones skip quiet
  hours. data: small strings the app uses to open the right page.
*/
async function queue_push({ user_id, title, body, data = {}, urgent = false, now = new Date() }) {
  if (!push_enabled()) return null;

  const wait_until = urgent ? null : quiet_until(now);
  const result = await db.query(
    `
      INSERT INTO push_outbox (user_id, title, body, data, urgent, send_after)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6::TIMESTAMPTZ, CURRENT_TIMESTAMP))
      RETURNING id
    `,
    [user_id, title.slice(0, 120), body.slice(0, 300), data, urgent, wait_until]
  );

  if (!wait_until) {
    send_due_pushes().catch((error) => console.error("[PUSH] Sending failed:", error.message));
  }

  return Number(result.rows[0].id);
}

/*
  The property's caretaker, if they have the switch for this kind
  of work, gets the notification. Nothing for the person who did
  the thing themselves.
*/
async function notify_property_caretaker({
  property_id,
  permission,
  except_user_id = null,
  title,
  body,
  data,
  urgent = false,
}) {
  if (!push_enabled()) return null;

  if (!Object.prototype.hasOwnProperty.call(CARETAKER_PERMISSIONS, permission)) {
    throw new Error(`Unknown caretaker permission: ${permission}`);
  }

  const result = await db.query(
    `
      SELECT property_caretaker_assignments.caretaker_id
      FROM property_caretaker_assignments
      INNER JOIN users
        ON users.user_id = property_caretaker_assignments.caretaker_id
      WHERE property_caretaker_assignments.property_id = $1
        AND property_caretaker_assignments.status = 'active'
        AND property_caretaker_assignments.${permission}
        AND users.status = 'active'
      LIMIT 1
    `,
    [property_id]
  );

  const caretaker_id = result.rows[0]?.caretaker_id;

  if (!caretaker_id || String(caretaker_id) === String(except_user_id)) return null;

  return queue_push({
    user_id: caretaker_id,
    title,
    body,
    data: { ...data, property_id: String(property_id) },
    urgent,
  });
}

// The push addresses Firebase no longer knows: the app was removed or signed out elsewhere.
const GONE = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

async function send_message(message) {
  if (send_override) return send_override(message);

  return get_messaging().sendEachForMulticast(message);
}

/*
  Sends what is due. Each row is claimed first, so two servers
  never send the same notification twice.
*/
async function send_due_pushes() {
  if (!push_enabled()) return { sent: 0 };

  const claimed = await db.query(
    `
      UPDATE push_outbox
      SET status = 'sending',
        attempts = attempts + 1
      WHERE id IN (
        SELECT id
        FROM push_outbox
        WHERE status = 'pending'
          AND send_after <= CURRENT_TIMESTAMP
        ORDER BY send_after
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `
  );

  let sent = 0;

  for (const row of claimed.rows) {
    const devices = await db.query(
      "SELECT token FROM push_devices WHERE user_id = $1",
      [row.user_id]
    );
    const tokens = devices.rows.map((device) => device.token);

    if (!tokens.length) {
      await db.query(
        "UPDATE push_outbox SET status = 'no_device', sent_at = CURRENT_TIMESTAMP WHERE id = $1",
        [row.id]
      );
      continue;
    }

    try {
      const data = Object.fromEntries(
        Object.entries(row.data || {}).map(([key, value]) => [key, String(value)])
      );
      const answer = await send_message({
        tokens,
        notification: { title: row.title, body: row.body },
        data,
        android: { priority: "high" },
      });

      const gone = [];

      answer.responses.forEach((response, index) => {
        if (!response.success && GONE.has(response.error?.code)) gone.push(tokens[index]);
      });

      if (gone.length) {
        await db.query("DELETE FROM push_devices WHERE token = ANY($1::TEXT[])", [gone]);
      }

      const delivered = answer.responses.some((response) => response.success);

      await db.query(
        `
          UPDATE push_outbox
          SET status = $2,
            sent_at = CURRENT_TIMESTAMP,
            last_error = $3
          WHERE id = $1
        `,
        [
          row.id,
          delivered ? "sent" : "failed",
          delivered ? null : String(answer.responses[0]?.error?.message || "Not delivered").slice(0, 500),
        ]
      );

      if (delivered) sent += 1;
    } catch (error) {
      // Tried again on the next round, up to 3 times.
      await db.query(
        `
          UPDATE push_outbox
          SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
            send_after = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
            last_error = $2
          WHERE id = $1
        `,
        [row.id, String(error.message).slice(0, 500)]
      );
    }
  }

  return { sent };
}

/*
  The caretaker app's push address, kept for the person signed in.
  A phone that changes hands moves its address to the new person.
*/
async function register_device(user, token, platform) {
  await db.query(
    `
      INSERT INTO push_devices (user_id, token, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        last_seen_at = CURRENT_TIMESTAMP
    `,
    [user.user_id, token, platform]
  );

  return { registered: true };
}

async function unregister_device(user, token) {
  const result = await db.query(
    "DELETE FROM push_devices WHERE user_id = $1 AND token = $2",
    [user.user_id, token]
  );

  return { removed: result.rowCount };
}

let scheduler_started = false;

function start_push_scheduler() {
  if (scheduler_started) return;

  scheduler_started = true;

  setInterval(() => {
    send_due_pushes().catch((error) => {
      console.error("[PUSH] Scheduler error:", error.message);
    });
  }, 60 * 1000).unref();
}

module.exports = {
  quiet_until,
  queue_push,
  notify_property_caretaker,
  send_due_pushes,
  register_device,
  unregister_device,
  start_push_scheduler,
  push_enabled,
  set_sender_for_tests: (sender) => {
    send_override = sender;
  },
};
