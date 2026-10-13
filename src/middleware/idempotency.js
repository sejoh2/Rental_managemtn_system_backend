const db = require("../config/db");

/*
  Sending twice must not save twice.

  The caretaker app keeps what was entered without a connection
  and sends it later, and a dropped connection can leave it
  unsure whether the server received something. Each thing it
  saves therefore carries its own key in the Idempotency-Key
  header. The first request with a key is carried out and its
  answer is kept; a repeat with the same key gets that same
  answer back and changes nothing.

  A key belongs to the signed-in user. A request without the
  header behaves exactly as before.
*/
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

/*
  A request still marked as running after this long was cut
  off by a restart; the key is then free to be used again.
*/
const STALE_SECONDS = 120;
const KEEP_DAYS = 30;

async function init_idempotency_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      user_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      key VARCHAR(100) NOT NULL,

      method VARCHAR(10) NOT NULL,
      path VARCHAR(500) NOT NULL,

      /*
        Empty while the request is still running.
      */
      status_code INTEGER,
      response JSONB,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (user_id, key)
    );
  `);

  await db.query(
    `
      DELETE FROM idempotency_keys
      WHERE created_at <
        CURRENT_TIMESTAMP - ($1 || ' days')::INTERVAL
    `,
    [String(KEEP_DAYS)]
  );

  console.log("[IDEMPOTENCY] Table initialized.");
}

function forget(user_id, key) {
  return db
    .query(
      `
        DELETE FROM idempotency_keys
        WHERE user_id = $1
          AND key = $2
          AND status_code IS NULL
      `,
      [user_id, key]
    )
    .catch(() => {});
}

/*
  Called by authenticate once the user is known. user_id is the
  person who signed in (the caretaker, or the admin inside an
  owner's account), not the account they act in.
*/
async function idempotency(req, res, user_id) {
  const key = req.headers["idempotency-key"];

  /*
    A path can pass through authenticate twice (two routers);
    the key is handled once.
  */
  if (
    !key ||
    req.idempotency_checked ||
    !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
  ) {
    return true;
  }

  req.idempotency_checked = true;

  if (!KEY_PATTERN.test(key)) {
    res.status(422).json({
      success: false,
      error:
        "The Idempotency-Key header must be 16 to 100 letters, digits, hyphens or underscores.",
    });

    return false;
  }

  const path = String(req.originalUrl).slice(0, 500);

  await db.query(
    `
      DELETE FROM idempotency_keys
      WHERE user_id = $1
        AND key = $2
        AND status_code IS NULL
        AND created_at <
          CURRENT_TIMESTAMP - ($3 || ' seconds')::INTERVAL
    `,
    [user_id, key, String(STALE_SECONDS)]
  );

  const claimed = await db.query(
    `
      INSERT INTO idempotency_keys (
        user_id,
        key,
        method,
        path
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING key
    `,
    [user_id, key, req.method, path]
  );

  if (!claimed.rows[0]) {
    const earlier = (
      await db.query(
        `
          SELECT method, path, status_code, response
          FROM idempotency_keys
          WHERE user_id = $1
            AND key = $2
        `,
        [user_id, key]
      )
    ).rows[0];

    if (
      earlier &&
      (earlier.method !== req.method || earlier.path !== path)
    ) {
      res.status(422).json({
        success: false,
        error:
          "This Idempotency-Key was already used for a different request.",
      });

      return false;
    }

    if (earlier && earlier.status_code !== null) {
      res.set("Idempotent-Replay", "true");
      res.status(earlier.status_code).json(earlier.response);

      return false;
    }

    res.status(409).json({
      success: false,
      error:
        "This request is still being carried out. Try again in a moment.",
    });

    return false;
  }

  /*
    Keep the answer when the request succeeds. When it is
    refused or fails, the key is freed: nothing was saved, so
    the same thing may be sent again after it is corrected.
  */
  const send_json = res.json.bind(res);
  let kept = false;

  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      kept = true;

      db.query(
        `
          UPDATE idempotency_keys
          SET
            status_code = $1,
            response = $2::JSONB
          WHERE user_id = $3
            AND key = $4
        `,
        [res.statusCode, JSON.stringify(body), user_id, key]
      ).catch((error) => {
        console.error(
          "[IDEMPOTENCY] The answer could not be kept:",
          error.message
        );
      });
    }

    return send_json(body);
  };

  res.on("close", () => {
    if (!kept) {
      forget(user_id, key);
    }
  });

  return true;
}

module.exports = {
  init_idempotency_tables,
  idempotency,
};
