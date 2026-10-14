const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const db = require("../config/db");

/*
  An account created by OTP is called "New User" until the
  person gives their own name.
*/
function needs_name(user) {
  const first_name = (user.first_name || "").trim();
  const last_name = (user.last_name || "").trim();

  return (
    !first_name ||
    (first_name === "New" && last_name === "User")
  );
}

function public_user(user) {
  return {
    user_id: user.user_id,
    first_name: user.first_name,
    last_name: user.last_name,
    needs_name: needs_name(user),
    phone: user.phone,
    role: user.role,
    owner_id: user.owner_id || null,
    status: user.status,
    created_at: user.created_at,
  };
}

/*
  Every token says which system issued it and which one it is
  for. A token made by another installation (development,
  staging, another database) is refused even if it was signed
  with the same secret. Production runs with NODE_ENV set to
  "production", so its tokens differ from development's by
  default; JWT_AUDIENCE overrides it.
*/
const ISSUER = process.env.JWT_ISSUER || "rental-api";

function audience() {
  return (
    process.env.JWT_AUDIENCE ||
    `rental-app-${process.env.NODE_ENV || "development"}`
  );
}

function verify_options() {
  return {
    issuer: ISSUER,
    audience: audience(),
    algorithms: ["HS256"],
  };
}

/*
  A sign-in session is one row of refresh_tokens. Both tokens
  carry its ID (sid), and every request checks that the
  session still exists and has not been ended, so signing out
  takes effect at once.
*/
function create_access_token(user, session_id) {
  return jwt.sign(
    {
      user_id: user.user_id,
      role: user.role,
      owner_id: user.owner_id || null,
      type: "access",
      sid: String(session_id),
    },
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "15m",
      issuer: ISSUER,
      audience: audience(),
    }
  );
}

/*
  The administrator's session is deliberately short. The web
  app keeps it only in the browser tab it was opened in, so
  closing the tab signs the admin out; this limit makes sure a
  session that was left behind cannot be renewed for long.
*/
function create_refresh_token(user, session_id) {
  return jwt.sign(
    {
      user_id: user.user_id,
      type: "refresh",
      sid: String(session_id),
    },
    process.env.JWT_REFRESH_SECRET,
    {
      issuer: ISSUER,
      audience: audience(),
      /*
        A new random ID each time, so a renewed token is never
        the same text as the one it replaces.
      */
      jwtid: crypto.randomUUID(),
      expiresIn:
        user.role === "admin"
          ? process.env.ADMIN_REFRESH_TOKEN_EXPIRES_IN || "12h"
          : process.env.REFRESH_TOKEN_EXPIRES_IN || "30d",
    }
  );
}

/*
  Refresh tokens are long random signed strings, so a fast
  one-way hash is enough to store them safely, and it lets the
  database find a token by its hash.
*/
function hash_token(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function expiry_of(token) {
  return new Date(jwt.decode(token).exp * 1000);
}

/*
  Starts a new sign-in session.
*/
async function issue_tokens(user) {
  const id_result = await db.query(
    `
      SELECT nextval(
        pg_get_serial_sequence(
          'refresh_tokens',
          'refresh_token_id'
        )
      ) AS id
    `
  );

  const session_id = id_result.rows[0].id;
  const refresh_token = create_refresh_token(user, session_id);

  await db.query(
    `
      INSERT INTO refresh_tokens (
        refresh_token_id,
        user_id,
        token_hash,
        expires_at
      )
      VALUES ($1,$2,$3,$4)
    `,
    [
      session_id,
      user.user_id,
      hash_token(refresh_token),
      expiry_of(refresh_token),
    ]
  );

  return {
    access_token: create_access_token(user, session_id),
    refresh_token,
  };
}

/*
  Renews a session: the refresh token is swapped for a new one
  in the same session, in one step, so the same refresh token
  can never be used twice. Returns null when the token was
  already used, the session was ended, or it has run out.
*/
async function renew_session(user, session_id, old_refresh_token) {
  const refresh_token = create_refresh_token(user, session_id);

  const result = await db.query(
    `
      UPDATE refresh_tokens
      SET
        token_hash = $1,
        expires_at = $2
      WHERE refresh_token_id = $3
        AND user_id = $4
        AND token_hash = $5
        AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      RETURNING refresh_token_id
    `,
    [
      hash_token(refresh_token),
      expiry_of(refresh_token),
      session_id,
      user.user_id,
      hash_token(old_refresh_token),
    ]
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    access_token: create_access_token(user, session_id),
    refresh_token,
  };
}

/*
  Ends the session this refresh token belongs to.
  -> true when a session was ended.
*/
async function end_session(user_id, session_id, refresh_token) {
  const result = await db.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE refresh_token_id = $1
        AND user_id = $2
        AND token_hash = $3
        AND revoked_at IS NULL
      RETURNING refresh_token_id
    `,
    [session_id, user_id, hash_token(refresh_token)]
  );

  return Boolean(result.rows[0]);
}

function verify_access_token(token) {
  return jwt.verify(
    token,
    process.env.JWT_ACCESS_SECRET,
    verify_options()
  );
}

function verify_refresh_token(token) {
  return jwt.verify(
    token,
    process.env.JWT_REFRESH_SECRET,
    verify_options()
  );
}

module.exports = {
  needs_name,
  public_user,
  issue_tokens,
  renew_session,
  end_session,
  verify_access_token,
  verify_refresh_token,
};