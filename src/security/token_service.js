const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

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

function create_access_token(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      role: user.role,
      owner_id: user.owner_id || null,
      type: "access",
    },
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "15m",
    }
  );
}

/*
  The administrator's session is deliberately short. The web
  app keeps it only in the browser tab it was opened in, so
  closing the tab signs the admin out; this limit makes sure a
  session that was left behind cannot be renewed for long.
*/
function create_refresh_token(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      type: "refresh",
    },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn:
        user.role === "admin"
          ? process.env.ADMIN_REFRESH_TOKEN_EXPIRES_IN || "12h"
          : process.env.REFRESH_TOKEN_EXPIRES_IN || "30d",
    }
  );
}

async function issue_tokens(user) {
  const access_token = create_access_token(user);
  const refresh_token = create_refresh_token(user);

  const decoded = jwt.decode(refresh_token);

  await db.query(
    `
      INSERT INTO refresh_tokens (
        user_id,
        token_hash,
        expires_at
      )
      VALUES ($1,$2,$3)
    `,
    [
      user.user_id,
      await bcrypt.hash(refresh_token, 12),
      new Date(decoded.exp * 1000),
    ]
  );

  return {
    access_token,
    refresh_token,
  };
}

function verify_access_token(token) {
  return jwt.verify(
    token,
    process.env.JWT_ACCESS_SECRET
  );
}

function verify_refresh_token(token) {
  return jwt.verify(
    token,
    process.env.JWT_REFRESH_SECRET
  );
}

module.exports = {
  needs_name,
  public_user,
  issue_tokens,
  verify_access_token,
  verify_refresh_token,
};