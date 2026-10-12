const bcrypt = require("bcryptjs");

const db = require("../config/db");

const {
  normalize_phone,
  mask_phone,
} = require("../utils/phone");

const { generate_otp } = require("../utils/otp");

const { send_sms } = require("../utils/sms_provider");

const token_service = require("../security/token_service");

const {
  log_audit,
} = require("../audit/audit_service");

async function get_user_by_id(user_id) {
  const result = await db.query(
    `
      SELECT *
      FROM users
      WHERE user_id = $1
    `,
    [user_id]
  );

  return result.rows[0] || null;
}

async function get_user_by_phone(phone, client = db) {
  const result = await client.query(
    `
      SELECT *
      FROM users
      WHERE phone = $1
    `,
    [phone]
  );

  return result.rows[0] || null;
}

async function create_standard_user(phone, client) {
  const result = await client.query(
    `
      INSERT INTO users (
        phone,
        role,
        status
      )
      VALUES ($1, 'user', 'active')
      ON CONFLICT (phone)
      DO UPDATE SET phone = EXCLUDED.phone
      RETURNING *
    `,
    [phone]
  );

  return result.rows[0];
}

async function request_otp(phone_input, ip_address) {
  const phone = normalize_phone(phone_input);

  if (!phone) {
    throw new Error("Enter a valid Kenyan mobile phone number.");
  }

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    /*
      Prevents two simultaneous OTP requests for the same number.
    */
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [phone]
    );

    const existing_user = await get_user_by_phone(phone, client);

    if (
      existing_user &&
      existing_user.status !== "active"
    ) {
      throw new Error(
        "This account is not currently allowed to sign in."
      );
    }

    const resend_seconds =
      Number(process.env.OTP_RESEND_SECONDS) || 60;

    const recent_otp = await client.query(
      `
        SELECT otp_code_id
        FROM otp_codes
        WHERE phone = $1
          AND purpose = 'login'
          AND used_at IS NULL
          AND created_at >
            CURRENT_TIMESTAMP - ($2 || ' seconds')::INTERVAL
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [phone, resend_seconds]
    );

    if (recent_otp.rows.length) {
      throw new Error(
        `Please wait ${resend_seconds} seconds before requesting another code.`
      );
    }

    await client.query(
      `
        UPDATE otp_codes
        SET used_at = CURRENT_TIMESTAMP
        WHERE phone = $1
          AND purpose = 'login'
          AND used_at IS NULL
      `,
      [phone]
    );

    const otp = generate_otp(6);

    await client.query(
      `
        INSERT INTO otp_codes (
          user_id,
          phone,
          purpose,
          code_hash,
          max_attempts,
          expires_at
        )
        VALUES (
          $1,
          $2,
          'login',
          $3,
          $4,
          CURRENT_TIMESTAMP + ($5 || ' minutes')::INTERVAL
        )
      `,
      [
        existing_user?.user_id || null,
        phone,
        await bcrypt.hash(otp, 12),
        Number(process.env.OTP_MAX_ATTEMPTS) || 3,
        Number(process.env.OTP_EXPIRES_MINUTES) || 5,
      ]
    );

    await client.query("COMMIT");

    try {
      await send_sms({
        phone,
        message:
          `Your Kodi verification code is ${otp}. ` +
          `It expires in ${process.env.OTP_EXPIRES_MINUTES || 5} minutes. ` +
          "Do not share this code.",
      });
    } catch (sms_error) {
      await db.query(
        `
          UPDATE otp_codes
          SET used_at = CURRENT_TIMESTAMP
          WHERE phone = $1
            AND purpose = 'login'
            AND used_at IS NULL
        `,
        [phone]
      );

      throw new Error(
        "We could not send the verification code. Please try again."
      );
    }

    await log_audit({
      user_id: existing_user?.user_id || null,
      action: "OTP_REQUESTED",
      entity_type: "authentication",
      metadata: { phone },
      ip_address,
    });

    return {
      message: `Verification code sent to ${mask_phone(phone)}.`,
      expires_in_seconds:
        (Number(process.env.OTP_EXPIRES_MINUTES) || 5) * 60,
      resend_in_seconds:
        Number(process.env.OTP_RESEND_SECONDS) || 60,
      max_attempts:
        Number(process.env.OTP_MAX_ATTEMPTS) || 3,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verify_otp(phone_input, code, ip_address) {
  const phone = normalize_phone(phone_input);

  if (!phone) {
    throw new Error("Invalid phone number or verification code.");
  }

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const otp_result = await client.query(
      `
        SELECT *
        FROM otp_codes
        WHERE phone = $1
          AND purpose = 'login'
          AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [phone]
    );

    const otp_record = otp_result.rows[0];

    if (!otp_record) {
      throw new Error("Invalid or expired verification code.");
    }

    if (new Date(otp_record.expires_at) <= new Date()) {
      await client.query(
        `
          UPDATE otp_codes
          SET used_at = CURRENT_TIMESTAMP
          WHERE otp_code_id = $1
        `,
        [otp_record.otp_code_id]
      );

      /*
        Failed-verification bookkeeping must survive the error,
        so it is committed before throwing. The ROLLBACK in the
        catch block is then a harmless no-op.
      */
      await client.query("COMMIT");

      throw new Error("Invalid or expired verification code.");
    }

    if (otp_record.attempts >= otp_record.max_attempts) {
      await client.query(
        `
          UPDATE otp_codes
          SET used_at = CURRENT_TIMESTAMP
          WHERE otp_code_id = $1
        `,
        [otp_record.otp_code_id]
      );

      await client.query("COMMIT");

      const error = new Error(
        "Too many failed attempts. Request a new verification code."
      );

      error.attempts_remaining = 0;
      throw error;
    }

    const matches = await bcrypt.compare(
      code,
      otp_record.code_hash
    );

    if (!matches) {
      /*
        The code is retired on the last allowed attempt, so it
        cannot be guessed any further.
      */
      const attempt_result = await client.query(
        `
          UPDATE otp_codes
          SET
            attempts = attempts + 1,
            used_at = CASE
              WHEN attempts + 1 >= max_attempts
              THEN CURRENT_TIMESTAMP
              ELSE used_at
            END
          WHERE otp_code_id = $1
          RETURNING attempts, max_attempts
        `,
        [otp_record.otp_code_id]
      );

      await client.query("COMMIT");

      const attempts_remaining = Math.max(
        attempt_result.rows[0].max_attempts -
          attempt_result.rows[0].attempts,
        0
      );

      const error = new Error(
        attempts_remaining > 0
          ? "Invalid or expired verification code."
          : "Too many failed attempts. Request a new verification code."
      );

      await log_audit({
        user_id: otp_record.user_id || null,
        action: "LOGIN_FAILED",
        entity_type: "authentication",
        metadata: {
          phone,
          attempts_remaining,
        },
        ip_address,
      });

      error.attempts_remaining = attempts_remaining;
      throw error;
    }

    let user = await get_user_by_phone(phone, client);

    /*
      A person becomes a standard user only after proving
      that they own the phone number by entering the OTP.
    */
    if (!user) {
      user = await create_standard_user(phone, client);
    }

    if (user.status !== "active") {
      throw new Error(
        "This account is not currently allowed to sign in."
      );
    }

    await client.query(
      `
        UPDATE otp_codes
        SET
          user_id = $1,
          used_at = CURRENT_TIMESTAMP
        WHERE otp_code_id = $2
      `,
      [user.user_id, otp_record.otp_code_id]
    );

    await client.query(
      `
        UPDATE users
        SET last_login_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
      `,
      [user.user_id]
    );

    await client.query("COMMIT");

    user = await get_user_by_id(user.user_id);

    const tokens = await token_service.issue_tokens(user);

    await log_audit({
      user_id: user.user_id,
      action: "LOGIN_SUCCESS",
      entity_type: "authentication",
      entity_id: user.user_id,
      metadata: { role: user.role },
      ip_address,
    });

    return {
      user: token_service.public_user(user),
      ...tokens,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function refresh(refresh_token) {
  const decoded =
    token_service.verify_refresh_token(refresh_token);

  if (decoded.type !== "refresh") {
    throw new Error("Invalid refresh token.");
  }

  const user = await get_user_by_id(decoded.user_id);

  if (!user || user.status !== "active") {
    throw new Error("Invalid refresh token.");
  }

  const result = await db.query(
    `
      SELECT *
      FROM refresh_tokens
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC
    `,
    [user.user_id]
  );

  const stored_token = [];

  for (const token of result.rows) {
    if (
      await bcrypt.compare(
        refresh_token,
        token.token_hash
      )
    ) {
      stored_token.push(token);
      break;
    }
  }

  if (!stored_token[0]) {
    throw new Error("Invalid refresh token.");
  }

  await db.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE refresh_token_id = $1
    `,
    [stored_token[0].refresh_token_id]
  );

  return {
    user: token_service.public_user(user),
    ...(await token_service.issue_tokens(user)),
  };
}

async function logout(refresh_token, ip_address) {
  try {
    const decoded =
      token_service.verify_refresh_token(refresh_token);

    const result = await db.query(
      `
        SELECT *
        FROM refresh_tokens
        WHERE user_id = $1
          AND revoked_at IS NULL
      `,
      [decoded.user_id]
    );

    for (const token of result.rows) {
      if (
        await bcrypt.compare(
          refresh_token,
          token.token_hash
        )
      ) {
        await db.query(
          `
            UPDATE refresh_tokens
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE refresh_token_id = $1
          `,
          [token.refresh_token_id]
        );

        await log_audit({
          user_id: decoded.user_id,
          action: "LOGOUT",
          entity_type: "authentication",
          entity_id: decoded.user_id,
          ip_address,
        });

        break;
      }
    }
  } catch {
    /*
      Logout is intentionally idempotent.
      A bad/expired token still gets a successful logout response.
    */
  }
}

/*
  Saves the name a person gives after their first sign-in.
  The first word is the first name and the rest is the last
  name; one word leaves the last name empty.
*/
async function set_name(user, full_name, ip_address) {
  if (!token_service.needs_name(user)) {
    const error = new Error(
      "Your name is already set."
    );

    error.status_code = 409;
    throw error;
  }

  const parts = full_name
    .trim()
    .split(/\s+/);

  const first_name = parts[0];
  const last_name = parts.slice(1).join(" ");

  const result = await db.query(
    `
      UPDATE users
      SET
        first_name = $1,
        last_name = $2
      WHERE user_id = $3
      RETURNING *
    `,
    [
      first_name,
      last_name,
      user.user_id,
    ]
  );

  await log_audit({
    user_id: user.user_id,
    action: "PROFILE_NAME_SET",
    entity_type: "user",
    entity_id: user.user_id,
    metadata: {
      first_name,
      last_name,
    },
    ip_address,
  });

  return token_service.public_user(result.rows[0]);
}

module.exports = {
  set_name,
  get_user_by_id,
  request_otp,
  verify_otp,
  refresh,
  logout,
};