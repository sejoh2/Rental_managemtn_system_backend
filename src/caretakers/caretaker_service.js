const db = require("../config/db");

const {
  normalize_phone,
} = require("../utils/phone");

const {
  log_audit,
} = require("../audit/audit_service");

function permission_label(level) {
  return level === "level_2"
    ? "Level 2 · Add tenants"
    : "Level 1 · View, readings & reports";
}

function public_caretaker(row) {
  return {
    caretaker_id: Number(row.caretaker_id),

    first_name: row.first_name,
    last_name: row.last_name,

    full_name: [
      row.first_name,
      row.last_name,
    ].filter(Boolean).join(" "),

    phone: row.phone,

    property_id: Number(row.property_id),
    property_name: row.property_name || null,

    assignment_id: Number(row.assignment_id),

    permission_level: row.permission_level,
    permission_label: permission_label(
      row.permission_level
    ),
    can_record_payments: row.can_record_payments === true,

    assignment_status: row.assignment_status,
    user_status: row.user_status,

    status:
      row.assignment_status === "active" &&
      row.user_status === "active"
        ? "active"
        : "inactive",

    assigned_at: row.assigned_at,
    unassigned_at: row.unassigned_at,
  };
}

async function ensure_owner_property(
  client,
  owner_id,
  property_id
) {
  const result = await client.query(
    `
      SELECT *
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status = 'active'
      LIMIT 1
    `,
    [property_id, owner_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Property not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  return result.rows[0];
}

async function get_caretaker_row(
  client,
  owner_id,
  caretaker_id
) {
  const result = await client.query(
    `
      SELECT *
      FROM users
      WHERE user_id = $1
        AND owner_id = $2
        AND role = 'caretaker'
      LIMIT 1
    `,
    [caretaker_id, owner_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Caretaker not found or you do not have access to them."
    );

    error.status_code = 404;
    throw error;
  }

  return result.rows[0];
}

async function assign_caretaker(
  owner,
  property_id,
  data,
  ip_address
) {
  const phone = normalize_phone(data.phone);

  if (!phone) {
    const error = new Error(
      "Phone number must be a valid Kenyan mobile number."
    );

    error.status_code = 422;
    throw error;
  }

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const property = await ensure_owner_property(
      client,
      owner.user_id,
      property_id
    );

    const user_result = await client.query(
      `
        SELECT *
        FROM users
        WHERE phone = $1
        FOR UPDATE
      `,
      [phone]
    );

    let user = user_result.rows[0];

    /*
      An owner may add a caretaker whose number has never
      signed in. The account is created here, inside this
      owner-only request, and the caretaker later proves they
      hold the number through the normal OTP sign-in.
      No public endpoint can create a caretaker.
    */
    if (!user) {
      const created_user_result = await client.query(
        `
          INSERT INTO users (
            phone,
            role,
            status
          )
          VALUES ($1, 'user', 'active')
          RETURNING *
        `,
        [phone]
      );

      user = created_user_result.rows[0];
    }

    const is_own_caretaker =
      user.role === "caretaker" &&
      Number(user.owner_id) === Number(owner.user_id);

    /*
      Removing a caretaker from their last property makes the
      account inactive, so the owner must be able to assign
      that same caretaker again. A caretaker the owner has
      suspended can be assigned too, and stays suspended.
    */
    const can_be_assigned =
      user.status === "active" || is_own_caretaker;

    if (!can_be_assigned) {
      const error = new Error(
        "Only an active user can become a caretaker."
      );

      error.status_code = 400;
      throw error;
    }

    if (
      user.role !== "user" &&
      !(
        user.role === "caretaker" &&
        Number(user.owner_id) ===
          Number(owner.user_id)
      )
    ) {
      const error = new Error(
        "Only a normal user can be made a caretaker."
      );

      error.status_code = 400;
      throw error;
    }

    const caretaker_result = await client.query(
      `
        UPDATE users
        SET
          first_name = $1,
          last_name = $2,
          role = 'caretaker',
          owner_id = $3,
          created_by = $3,
          status = CASE
            WHEN status = 'suspended' THEN 'suspended'
            ELSE 'active'
          END,
          deactivated_at = CASE
            WHEN status = 'suspended' THEN deactivated_at
            ELSE NULL
          END
        WHERE user_id = $4
        RETURNING *
      `,
      [
        data.first_name,
        data.last_name,
        owner.user_id,
        user.user_id,
      ]
    );

    const caretaker = caretaker_result.rows[0];

    /*
      Replacing a caretaker removes only property access.
      Their old readings, expenses, and reports remain.
    */
    await client.query(
      `
        UPDATE property_caretaker_assignments
        SET
          status = 'inactive',
          unassigned_at = CURRENT_TIMESTAMP
        WHERE property_id = $1
          AND status = 'active'
          AND caretaker_id <> $2
      `,
      [
        property_id,
        caretaker.user_id,
      ]
    );

    const assignment_result = await client.query(
      `
        INSERT INTO property_caretaker_assignments (
          owner_id,
          property_id,
          caretaker_id,
          permission_level,
          status,
          assigned_at,
          unassigned_at
        )
        VALUES (
          $1,$2,$3,$4,
          'active',
          CURRENT_TIMESTAMP,
          NULL
        )
        ON CONFLICT (property_id, caretaker_id)
        DO UPDATE SET
          permission_level =
            EXCLUDED.permission_level,
          can_record_payments = FALSE,
          status = 'active',
          assigned_at = CURRENT_TIMESTAMP,
          unassigned_at = NULL
        RETURNING *
      `,
      [
        owner.user_id,
        property_id,
        caretaker.user_id,
        data.permission_level,
      ]
    );

    await client.query("COMMIT");

    const assignment = assignment_result.rows[0];

    await log_audit({
      user_id: owner.user_id,
      action: "CARETAKER_ASSIGNED",
      entity_type: "caretaker_assignment",
      entity_id: assignment.id,
      metadata: {
        caretaker_id: caretaker.user_id,
        property_id,
        permission_level:
          assignment.permission_level,
      },
      ip_address,
    });

    return public_caretaker({
      caretaker_id: caretaker.user_id,
      first_name: caretaker.first_name,
      last_name: caretaker.last_name,
      phone: caretaker.phone,

      property_id,
      property_name: property.name,

      assignment_id: assignment.id,
      permission_level:
        assignment.permission_level,

      assignment_status: assignment.status,
      user_status: caretaker.status,

      assigned_at: assignment.assigned_at,
      unassigned_at: assignment.unassigned_at,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function list_caretakers(owner) {
  const result = await db.query(
    `
      SELECT
        users.user_id AS caretaker_id,
        users.first_name,
        users.last_name,
        users.phone,
        users.status AS user_status,

        property_caretaker_assignments.id
          AS assignment_id,

        property_caretaker_assignments.property_id,
        properties.name AS property_name,

        property_caretaker_assignments.permission_level,
        property_caretaker_assignments.can_record_payments,

        property_caretaker_assignments.status
          AS assignment_status,

        property_caretaker_assignments.assigned_at,
        property_caretaker_assignments.unassigned_at

      FROM property_caretaker_assignments

      INNER JOIN users
        ON users.user_id =
          property_caretaker_assignments.caretaker_id

      INNER JOIN properties
        ON properties.id =
          property_caretaker_assignments.property_id

      WHERE property_caretaker_assignments.owner_id = $1
        AND users.role = 'caretaker'

      ORDER BY
        property_caretaker_assignments.status ASC,
        properties.name ASC
    `,
    [owner.user_id]
  );

  return result.rows.map(public_caretaker);
}

async function get_caretaker(owner, caretaker_id) {
  const client = await db.get_client();

  try {
    const caretaker = await get_caretaker_row(
      client,
      owner.user_id,
      caretaker_id
    );

    const assignments_result = await client.query(
      `
        SELECT
          property_caretaker_assignments.*,
          properties.name AS property_name
        FROM property_caretaker_assignments
        INNER JOIN properties
          ON properties.id =
            property_caretaker_assignments.property_id
        WHERE property_caretaker_assignments.owner_id = $1
          AND property_caretaker_assignments.caretaker_id = $2
        ORDER BY
          property_caretaker_assignments.status ASC,
          properties.name ASC
      `,
      [owner.user_id, caretaker_id]
    );

    const activity_result = await client.query(
      `
        SELECT
          (
            SELECT COUNT(*)
            FROM water_meter_readings
            WHERE submitted_by = $1
              AND submitted_at >
                CURRENT_TIMESTAMP - INTERVAL '30 days'
          ) AS water_readings,

          (
            SELECT COUNT(*)
            FROM maintenance_requests
            WHERE reported_by = $1
              AND created_at >
                CURRENT_TIMESTAMP - INTERVAL '30 days'
          ) AS maintenance_reports,

          (
            SELECT COUNT(*)
            FROM expenses
            WHERE created_by = $1
              AND created_at >
                CURRENT_TIMESTAMP - INTERVAL '30 days'
          ) AS expenses_recorded
      `,
      [caretaker_id]
    );

    return {
      caretaker: {
        caretaker_id: Number(caretaker.user_id),
        first_name: caretaker.first_name,
        last_name: caretaker.last_name,
        full_name: [
          caretaker.first_name,
          caretaker.last_name,
        ].join(" "),
        phone: caretaker.phone,
        status: caretaker.status,
      },

      assignments: assignments_result.rows.map(
        (assignment) => ({
          assignment_id: Number(assignment.id),
          property_id: Number(
            assignment.property_id
          ),
          property_name: assignment.property_name,
          permission_level:
            assignment.permission_level,
          permission_label: permission_label(
            assignment.permission_level
          ),
          status: assignment.status,
        })
      ),

      activity_last_30_days: {
        water_readings: Number(
          activity_result.rows[0].water_readings
        ),
        maintenance_reports: Number(
          activity_result.rows[0]
            .maintenance_reports
        ),
        expenses_recorded: Number(
          activity_result.rows[0]
            .expenses_recorded
        ),
      },
    };
  } finally {
    client.release();
  }
}

async function update_property_caretaker(
  owner,
  property_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    await ensure_owner_property(
      client,
      owner.user_id,
      property_id
    );

    const assignment_result = await client.query(
      `
        SELECT *
        FROM property_caretaker_assignments
        WHERE owner_id = $1
          AND property_id = $2
          AND status = 'active'
        FOR UPDATE
      `,
      [owner.user_id, property_id]
    );

    const assignment = assignment_result.rows[0];

    if (!assignment) {
      const error = new Error(
        "This property does not have an active caretaker."
      );

      error.status_code = 404;
      throw error;
    }

    const caretaker = await get_caretaker_row(
      client,
      owner.user_id,
      assignment.caretaker_id
    );

    if (
      data.first_name !== undefined ||
      data.last_name !== undefined
    ) {
      await client.query(
        `
          UPDATE users
          SET
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name)
          WHERE user_id = $3
        `,
        [
          data.first_name || null,
          data.last_name || null,
          caretaker.user_id,
        ]
      );
    }

    if (data.status === "inactive") {
      await client.query(
        `
          UPDATE property_caretaker_assignments
          SET
            status = 'inactive',
            unassigned_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        [assignment.id]
      );

      /*
        A caretaker with no active property is immediately
        unable to authenticate.
      */
      await client.query(
        `
          UPDATE users
          SET
            status = 'inactive',
            deactivated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1
            AND status <> 'suspended'
            AND NOT EXISTS (
              SELECT 1
              FROM property_caretaker_assignments
              WHERE caretaker_id = $1
                AND status = 'active'
            )
        `,
        [caretaker.user_id]
      );
    } else {
      await client.query(
        `
          UPDATE property_caretaker_assignments
          SET
            permission_level = COALESCE(
              $1,
              permission_level
            ),
            status = 'active',
            unassigned_at = NULL
          WHERE id = $2
        `,
        [
          data.permission_level || null,
          assignment.id,
        ]
      );

      await client.query(
        `
          UPDATE users
          SET
            status = 'active',
            deactivated_at = NULL
          WHERE user_id = $1
            AND status <> 'suspended'
        `,
        [caretaker.user_id]
      );
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "CARETAKER_UPDATED",
      entity_type: "caretaker_assignment",
      entity_id: assignment.id,
      metadata: {
        property_id,
        caretaker_id: caretaker.user_id,
        updated_fields: Object.keys(data),
      },
      ip_address,
    });

    return get_caretaker(
      owner,
      caretaker.user_id
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Changes the caretaker's own details, for all their properties:
  name, phone number and whether they may sign in.

  suspended  the caretaker cannot sign in, but keeps their
             properties, so they can be reactivated later.
  active     lifts a suspension.

  The phone number is how a caretaker signs in, so changing it
  changes what they sign in with. Their history stays with them.
*/
async function update_caretaker(
  owner,
  caretaker_id,
  data,
  ip_address
) {
  let phone = null;

  if (data.phone !== undefined) {
    phone = normalize_phone(data.phone);

    if (!phone) {
      const error = new Error(
        "Phone number must be a valid Kenyan mobile number."
      );

      error.status_code = 422;
      throw error;
    }
  }

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const caretaker = await get_caretaker_row(
      client,
      owner.user_id,
      caretaker_id
    );

    let status = caretaker.status;

    if (data.status === "suspended") {
      status = "suspended";
    }

    if (
      data.status === "active" &&
      caretaker.status === "suspended"
    ) {
      /*
        A caretaker with no property left stays unable to
        sign in until they are assigned to one again.
      */
      const assignment_result = await client.query(
        `
          SELECT 1
          FROM property_caretaker_assignments
          WHERE caretaker_id = $1
            AND status = 'active'
          LIMIT 1
        `,
        [caretaker.user_id]
      );

      status = assignment_result.rows[0]
        ? "active"
        : "inactive";
    }

    await client.query(
      `
        UPDATE users
        SET
          first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          phone = COALESCE($3, phone),
          status = $4::VARCHAR,
          deactivated_at = CASE
            WHEN $4::VARCHAR = 'active' THEN NULL
            ELSE COALESCE(
              deactivated_at,
              CURRENT_TIMESTAMP
            )
          END
        WHERE user_id = $5
      `,
      [
        data.first_name || null,
        data.last_name || null,
        phone,
        status,
        caretaker.user_id,
      ]
    );

    /*
      A suspended caretaker, or one whose number changed, has
      to sign in again.
    */
    if (
      status === "suspended" ||
      (phone && phone !== caretaker.phone)
    ) {
      await client.query(
        `
          UPDATE refresh_tokens
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = $1
            AND revoked_at IS NULL
        `,
        [caretaker.user_id]
      );
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action:
        status === caretaker.status
          ? "CARETAKER_DETAILS_UPDATED"
          : status === "suspended"
            ? "CARETAKER_SUSPENDED"
            : "CARETAKER_REACTIVATED",
      entity_type: "caretaker",
      entity_id: caretaker.user_id,
      metadata: {
        updated_fields: Object.keys(data),
        previous_phone:
          phone && phone !== caretaker.phone
            ? caretaker.phone
            : undefined,
        phone: phone || undefined,
        status,
      },
      ip_address,
    });

    return get_caretaker(owner, caretaker.user_id);
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      const duplicate_error = new Error(
        "This phone number already belongs to another user."
      );

      duplicate_error.status_code = 409;
      throw duplicate_error;
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  update_caretaker,
  assign_caretaker,
  list_caretakers,
  get_caretaker,
  update_property_caretaker,
};