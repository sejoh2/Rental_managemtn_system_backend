const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

/*
  An owner may enter their own SMS sender ID on a property. It
  is used only after the system admin has approved it; until
  then, and if it is rejected, that property's messages go out
  from the platform's default sender.

  A sender ID is approved once per owner: every property of
  that owner using it follows the same decision.
  properties.sms_sender_status mirrors the decision so the
  sending queries stay simple.

  Use inside a query that has the properties table.
*/
const effective_sender_sql = `
  CASE
    WHEN properties.sms_sender_status = 'approved'
    THEN properties.sms_sender_id
  END
`;

function service_error(message, status_code = 400) {
  const error = new Error(message);
  error.status_code = status_code;
  return error;
}

/*
  Safe to run again. A sender ID entered before approvals
  existed starts as pending.
*/
async function init_sender_approval_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sms_sender_approvals (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      sender_id VARCHAR(50) NOT NULL,

      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (
          status IN ('pending', 'approved', 'rejected')
        ),

      note TEXT,

      requested_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      reviewed_by BIGINT
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      reviewed_at TIMESTAMPTZ,

      UNIQUE (owner_id, sender_id)
    );

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS sms_sender_status VARCHAR(20);

    INSERT INTO sms_sender_approvals (owner_id, sender_id)
    SELECT DISTINCT owner_id, sms_sender_id
    FROM properties
    WHERE COALESCE(sms_sender_id, '') <> ''
    ON CONFLICT (owner_id, sender_id) DO NOTHING;

    UPDATE properties
    SET sms_sender_status = sms_sender_approvals.status
    FROM sms_sender_approvals
    WHERE sms_sender_approvals.owner_id = properties.owner_id
      AND sms_sender_approvals.sender_id =
        properties.sms_sender_id
      AND properties.sms_sender_status IS DISTINCT FROM
        sms_sender_approvals.status;

    UPDATE properties
    SET sms_sender_status = NULL
    WHERE COALESCE(sms_sender_id, '') = ''
      AND sms_sender_status IS NOT NULL;
  `);
}

/*
  Call after a property's sender ID is saved. A sender ID the
  owner has not used before becomes a request for the admin.
*/
async function sync_property_sender(
  owner_id,
  property_id,
  ip_address
) {
  const property = await db.query(
    `
      SELECT name, sms_sender_id
      FROM properties
      WHERE id = $1
        AND owner_id = $2
    `,
    [property_id, owner_id]
  );

  const sender_id = property.rows[0]?.sms_sender_id;

  if (!sender_id) {
    await db.query(
      `
        UPDATE properties
        SET sms_sender_status = NULL
        WHERE id = $1
          AND owner_id = $2
      `,
      [property_id, owner_id]
    );

    return null;
  }

  const approval = await db.query(
    `
      INSERT INTO sms_sender_approvals (owner_id, sender_id)
      VALUES ($1, $2)
      ON CONFLICT (owner_id, sender_id)
      DO UPDATE SET sender_id = EXCLUDED.sender_id
      RETURNING status, (xmax = 0) AS is_new
    `,
    [owner_id, sender_id]
  );

  const { status, is_new } = approval.rows[0];

  await db.query(
    `
      UPDATE properties
      SET sms_sender_status = $1
      WHERE id = $2
        AND owner_id = $3
    `,
    [status, property_id, owner_id]
  );

  if (is_new) {
    await log_audit({
      user_id: owner_id,
      owner_id,
      action: "SMS_SENDER_ID_REQUESTED",
      entity_type: "property",
      entity_id: property_id,
      metadata: {
        sender_id,
        property_name: property.rows[0].name,
      },
      ip_address,
    });
  }

  return status;
}

/*
  Every sender ID owners have entered, newest request first,
  with the properties that use it.
*/
async function list_sender_requests() {
  const result = await db.query(`
    SELECT
      sms_sender_approvals.*,

      owners.first_name AS owner_first_name,
      owners.last_name AS owner_last_name,
      owners.phone AS owner_phone,

      COALESCE(
        (
          SELECT ARRAY_AGG(properties.name ORDER BY properties.name)
          FROM properties
          WHERE properties.owner_id =
            sms_sender_approvals.owner_id
            AND properties.sms_sender_id =
              sms_sender_approvals.sender_id
            AND properties.status <> 'archived'
        ),
        ARRAY[]::VARCHAR[]
      ) AS property_names

    FROM sms_sender_approvals

    INNER JOIN users AS owners
      ON owners.user_id = sms_sender_approvals.owner_id

    ORDER BY
      (sms_sender_approvals.status = 'pending') DESC,
      sms_sender_approvals.requested_at DESC
  `);

  return result.rows.map((row) => ({
    id: Number(row.id),
    owner_id: Number(row.owner_id),

    owner_name: [
      row.owner_first_name,
      row.owner_last_name,
    ]
      .filter(Boolean)
      .join(" "),

    owner_phone: row.owner_phone,
    sender_id: row.sender_id,
    status: row.status,
    note: row.note,
    property_names: row.property_names,
    requested_at: row.requested_at,
    reviewed_at: row.reviewed_at,
  }));
}

/*
  The admin's decision. It can be changed later, for example
  when Africa's Talking approves a sender ID that was rejected
  here earlier.
*/
async function review_sender_request(
  admin,
  request_id,
  { decision, note = null },
  ip_address
) {
  const result = await db.query(
    `
      UPDATE sms_sender_approvals
      SET
        status = $1,
        note = $2,
        reviewed_by = $3,
        reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `,
    [decision, note, admin.user_id, request_id]
  );

  const approval = result.rows[0];

  if (!approval) {
    throw service_error(
      "Sender ID request not found.",
      404
    );
  }

  await db.query(
    `
      UPDATE properties
      SET sms_sender_status = $1
      WHERE owner_id = $2
        AND sms_sender_id = $3
    `,
    [decision, approval.owner_id, approval.sender_id]
  );

  await log_audit({
    user_id: admin.user_id,
    owner_id: approval.owner_id,
    action:
      decision === "approved"
        ? "SMS_SENDER_ID_APPROVED"
        : "SMS_SENDER_ID_REJECTED",
    entity_type: "sms_sender_approval",
    entity_id: approval.id,
    metadata: {
      sender_id: approval.sender_id,
      note,
    },
    ip_address,
  });

  const [request] = (await list_sender_requests()).filter(
    (item) => item.id === Number(approval.id)
  );

  return request;
}

module.exports = {
  effective_sender_sql,
  init_sender_approval_tables,
  sync_property_sender,
  list_sender_requests,
  review_sender_request,
};
