const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

function public_request(request) {
  return {
    id: Number(request.id),

    owner_id: Number(request.owner_id),
    property_id: Number(request.property_id),

    property_name: request.property_name || null,

    unit_id: request.unit_id
      ? Number(request.unit_id)
      : null,

    unit_number: request.unit_number || null,

    title: request.title,
    description: request.description,
    category: request.category,
    priority: request.priority,
    status: request.status,

    reported_by: Number(request.reported_by),
    reporter_name: request.reporter_name || null,
    reporter_role: request.reporter_role,

    assigned_caretaker_id:
      request.assigned_caretaker_id
        ? Number(request.assigned_caretaker_id)
        : null,

    assigned_caretaker_name:
      request.assigned_caretaker_name || null,

    assigned_vendor_name:
      request.assigned_vendor_name,

    estimated_cost:
      request.estimated_cost === null
        ? null
        : Number(request.estimated_cost),

    actual_cost:
      request.actual_cost === null
        ? null
        : Number(request.actual_cost),

    resolution_notes: request.resolution_notes,
    resolved_at: request.resolved_at,

    cancelled_at: request.cancelled_at,
    cancellation_reason:
      request.cancellation_reason,

    created_at: request.created_at,
    updated_at: request.updated_at,
  };
}

function get_owner_id(user) {
  return user.role === "caretaker"
    ? Number(user.owner_id)
    : Number(user.user_id);
}

async function ensure_property_access(
  client,
  user,
  property_id
) {
  const owner_id = get_owner_id(user);

  if (user.role === "owner") {
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

  const result = await client.query(
    `
      SELECT properties.*
      FROM property_caretaker_assignments
      INNER JOIN properties
        ON properties.id =
          property_caretaker_assignments.property_id
      WHERE property_caretaker_assignments.property_id = $1
        AND property_caretaker_assignments.caretaker_id = $2
        AND property_caretaker_assignments.owner_id = $3
        AND property_caretaker_assignments.status = 'active'
        AND properties.status = 'active'
      LIMIT 1
    `,
    [
      property_id,
      user.user_id,
      owner_id,
    ]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "You are not assigned to this property."
    );

    error.status_code = 403;
    throw error;
  }

  return result.rows[0];
}

async function ensure_unit_belongs_to_property(
  client,
  unit_id,
  property_id
) {
  if (!unit_id) {
    return null;
  }

  const result = await client.query(
    `
      SELECT *
      FROM units
      WHERE id = $1
        AND property_id = $2
      LIMIT 1
    `,
    [unit_id, property_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Unit not found in this property."
    );

    error.status_code = 404;
    throw error;
  }

  return result.rows[0];
}

async function ensure_assigned_caretaker(
  client,
  owner_id,
  property_id,
  caretaker_id
) {
  if (!caretaker_id) {
    return null;
  }

  const result = await client.query(
    `
      SELECT users.*
      FROM property_caretaker_assignments
      INNER JOIN users
        ON users.user_id =
          property_caretaker_assignments.caretaker_id
      WHERE property_caretaker_assignments.owner_id = $1
        AND property_caretaker_assignments.property_id = $2
        AND property_caretaker_assignments.caretaker_id = $3
        AND property_caretaker_assignments.status = 'active'
        AND users.role = 'caretaker'
        AND users.status = 'active'
      LIMIT 1
    `,
    [
      owner_id,
      property_id,
      caretaker_id,
    ]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Caretaker is not actively assigned to this property."
    );

    error.status_code = 422;
    throw error;
  }

  return result.rows[0];
}

async function create_request(
  user,
  property_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const property = await ensure_property_access(
      client,
      user,
      property_id
    );

    const unit = await ensure_unit_belongs_to_property(
      client,
      data.unit_id,
      property_id
    );

    const owner_id = get_owner_id(user);

    const result = await client.query(
      `
        INSERT INTO maintenance_requests (
          owner_id,
          property_id,
          unit_id,
          title,
          description,
          category,
          priority,
          reported_by,
          reporter_role
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9
        )
        RETURNING *
      `,
      [
        owner_id,
        property.id,
        unit?.id || null,
        data.title,
        data.description || null,
        data.category,
        data.priority,
        user.user_id,
        user.role,
      ]
    );

    await client.query("COMMIT");

    const request = result.rows[0];

    await log_audit({
      user_id: user.user_id,
      action: "MAINTENANCE_REPORTED",
      entity_type: "maintenance_request",
      entity_id: request.id,
      metadata: {
        property_id,
        unit_id: unit?.id || null,
        category: request.category,
        priority: request.priority,
        reporter_role: user.role,
      },
      ip_address,
    });

    return public_request({
      ...request,
      property_name: property.name,
      unit_number: unit?.unit_number || null,
      reporter_name: [
        user.first_name,
        user.last_name,
      ]
        .filter(Boolean)
        .join(" "),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_request_row(
  client,
  user,
  request_id,
  lock = false
) {
  const owner_id = get_owner_id(user);

  const result = await client.query(
    `
      SELECT
        maintenance_requests.*,
        properties.name AS property_name,
        units.unit_number,

        CONCAT(
          reporter.first_name,
          ' ',
          reporter.last_name
        ) AS reporter_name,

        CONCAT(
          assigned_caretaker.first_name,
          ' ',
          assigned_caretaker.last_name
        ) AS assigned_caretaker_name

      FROM maintenance_requests

      INNER JOIN properties
        ON properties.id =
          maintenance_requests.property_id

      LEFT JOIN units
        ON units.id =
          maintenance_requests.unit_id

      INNER JOIN users AS reporter
        ON reporter.user_id =
          maintenance_requests.reported_by

      LEFT JOIN users AS assigned_caretaker
        ON assigned_caretaker.user_id =
          maintenance_requests.assigned_caretaker_id

      WHERE maintenance_requests.id = $1
        AND maintenance_requests.owner_id = $2
      ${lock ? "FOR UPDATE OF maintenance_requests" : ""}
      LIMIT 1
    `,
    [request_id, owner_id]
  );

  const request = result.rows[0];

  if (!request) {
    const error = new Error(
      "Maintenance request not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  if (user.role === "caretaker") {
    await ensure_property_access(
      client,
      user,
      request.property_id
    );
  }

  return request;
}

async function get_request_by_id(
  user,
  request_id
) {
  const client = await db.get_client();

  try {
    const request = await get_request_row(
      client,
      user,
      request_id
    );

    return public_request(request);
  } finally {
    client.release();
  }
}

async function list_requests(user, filters) {
  const owner_id = get_owner_id(user);

  const result = await db.query(
    `
      SELECT
        maintenance_requests.*,
        properties.name AS property_name,
        units.unit_number,

        CONCAT(
          reporter.first_name,
          ' ',
          reporter.last_name
        ) AS reporter_name,

        CONCAT(
          assigned_caretaker.first_name,
          ' ',
          assigned_caretaker.last_name
        ) AS assigned_caretaker_name

      FROM maintenance_requests

      INNER JOIN properties
        ON properties.id =
          maintenance_requests.property_id

      LEFT JOIN units
        ON units.id =
          maintenance_requests.unit_id

      INNER JOIN users AS reporter
        ON reporter.user_id =
          maintenance_requests.reported_by

      LEFT JOIN users AS assigned_caretaker
        ON assigned_caretaker.user_id =
          maintenance_requests.assigned_caretaker_id

      WHERE maintenance_requests.owner_id = $1

        AND (
          $2::BIGINT IS NULL
          OR maintenance_requests.property_id = $2
        )

        AND (
          $3::BIGINT IS NULL
          OR maintenance_requests.unit_id = $3
        )

        AND (
          $4::VARCHAR IS NULL
          OR maintenance_requests.status = $4
        )

        AND (
          $5::VARCHAR IS NULL
          OR maintenance_requests.priority = $5
        )

        AND (
          $6::BIGINT IS NULL
          OR EXISTS (
            SELECT 1
            FROM property_caretaker_assignments
            WHERE property_caretaker_assignments.property_id =
              maintenance_requests.property_id
              AND property_caretaker_assignments.caretaker_id = $6
              AND property_caretaker_assignments.status = 'active'
          )
        )

      ORDER BY
        CASE maintenance_requests.priority
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          ELSE 4
        END,
        maintenance_requests.created_at DESC
    `,
    [
      owner_id,
      filters.property_id || null,
      filters.unit_id || null,
      filters.status || null,
      filters.priority || null,
      user.role === "caretaker"
        ? user.user_id
        : null,
    ]
  );

  return result.rows.map(public_request);
}

async function update_request(
  user,
  request_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const existing = await get_request_row(
      client,
      user,
      request_id,
      true
    );

    const is_owner = user.role === "owner";

    /*
      Caretakers can only update requests they reported
      or requests explicitly assigned to them.
    */
    if (
      !is_owner &&
      Number(existing.reported_by) !==
        Number(user.user_id) &&
      Number(existing.assigned_caretaker_id) !==
        Number(user.user_id)
    ) {
      const error = new Error(
        "You can only update maintenance requests you reported or that are assigned to you."
      );

      error.status_code = 403;
      throw error;
    }

    if (!is_owner) {
      const forbidden_fields = [
        "assigned_caretaker_id",
        "assigned_vendor_name",
        "estimated_cost",
        "actual_cost",
        "cancellation_reason",
      ];

      const attempted = forbidden_fields.find(
        (field) =>
          Object.prototype.hasOwnProperty.call(
            data,
            field
          )
      );

      if (attempted) {
        const error = new Error(
          "Only the property owner can assign workers, costs, or cancel maintenance requests."
        );

        error.status_code = 403;
        throw error;
      }

      if (
        data.status &&
        !["in_progress", "resolved"].includes(
          data.status
        )
      ) {
        const error = new Error(
          "Caretakers can only move a request to in progress or resolved."
        );

        error.status_code = 403;
        throw error;
      }
    }

    if (
      data.assigned_caretaker_id !== undefined &&
      data.assigned_caretaker_id !== null
    ) {
      await ensure_assigned_caretaker(
        client,
        existing.owner_id,
        existing.property_id,
        data.assigned_caretaker_id
      );
    }

    if (
      data.status === "resolved" &&
      existing.status === "cancelled"
    ) {
      const error = new Error(
        "A cancelled maintenance request cannot be resolved."
      );

      error.status_code = 400;
      throw error;
    }

    if (
      data.status === "cancelled" &&
      existing.status === "resolved"
    ) {
      const error = new Error(
        "A resolved maintenance request cannot be cancelled."
      );

      error.status_code = 400;
      throw error;
    }

    if (
      data.status === "cancelled" &&
      !data.cancellation_reason
    ) {
      const error = new Error(
        "cancellation_reason is required when cancelling a request."
      );

      error.status_code = 422;
      throw error;
    }

    const result = await client.query(
      `
        UPDATE maintenance_requests
        SET
          status = COALESCE($1, status),

          priority = COALESCE($2, priority),

          assigned_caretaker_id =
            CASE
              WHEN $3::BOOLEAN
              THEN $4
              ELSE assigned_caretaker_id
            END,

          assigned_vendor_name =
            CASE
              WHEN $5::BOOLEAN
              THEN $6
              ELSE assigned_vendor_name
            END,

          estimated_cost =
            CASE
              WHEN $7::BOOLEAN
              THEN $8
              ELSE estimated_cost
            END,

          actual_cost =
            CASE
              WHEN $9::BOOLEAN
              THEN $10
              ELSE actual_cost
            END,

          resolution_notes =
            CASE
              WHEN $11::BOOLEAN
              THEN $12
              ELSE resolution_notes
            END,

          cancellation_reason =
            CASE
              WHEN $13::BOOLEAN
              THEN $14
              ELSE cancellation_reason
            END,

          resolved_at = CASE
            WHEN $1 = 'resolved'
            THEN CURRENT_TIMESTAMP
            ELSE resolved_at
          END,

          cancelled_at = CASE
            WHEN $1 = 'cancelled'
            THEN CURRENT_TIMESTAMP
            ELSE cancelled_at
          END

        WHERE id = $15
        RETURNING *
      `,
      [
        data.status || null,
        data.priority || null,

        Object.prototype.hasOwnProperty.call(
          data,
          "assigned_caretaker_id"
        ),
        data.assigned_caretaker_id ?? null,

        Object.prototype.hasOwnProperty.call(
          data,
          "assigned_vendor_name"
        ),
        data.assigned_vendor_name ?? null,

        Object.prototype.hasOwnProperty.call(
          data,
          "estimated_cost"
        ),
        data.estimated_cost ?? null,

        Object.prototype.hasOwnProperty.call(
          data,
          "actual_cost"
        ),
        data.actual_cost ?? null,

        Object.prototype.hasOwnProperty.call(
          data,
          "resolution_notes"
        ),
        data.resolution_notes ?? null,

        Object.prototype.hasOwnProperty.call(
          data,
          "cancellation_reason"
        ),
        data.cancellation_reason ?? null,

        existing.id,
      ]
    );

    await client.query("COMMIT");

    const updated = result.rows[0];

    await log_audit({
      user_id: user.user_id,
      action: "MAINTENANCE_UPDATED",
      entity_type: "maintenance_request",
      entity_id: updated.id,
      metadata: {
        updated_fields: Object.keys(data),
        status: updated.status,
      },
      ip_address,
    });

    return get_request_by_id(user, updated.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_status_counts(user) {
  const owner_id = get_owner_id(user);

  const result = await db.query(
    `
      SELECT
        COUNT(*) AS all_count,

        COUNT(*) FILTER (
          WHERE status = 'reported'
        ) AS reported_count,

        COUNT(*) FILTER (
          WHERE status = 'in_progress'
        ) AS in_progress_count,

        COUNT(*) FILTER (
          WHERE status = 'resolved'
        ) AS resolved_count

      FROM maintenance_requests

      WHERE owner_id = $1

        AND (
          $2::BIGINT IS NULL
          OR EXISTS (
            SELECT 1
            FROM property_caretaker_assignments
            WHERE property_caretaker_assignments.property_id =
              maintenance_requests.property_id
              AND property_caretaker_assignments.caretaker_id = $2
              AND property_caretaker_assignments.status = 'active'
          )
        )
    `,
    [
      owner_id,
      user.role === "caretaker"
        ? user.user_id
        : null,
    ]
  );

  const counts = result.rows[0];

  return {
    all: Number(counts.all_count),
    reported: Number(counts.reported_count),
    in_progress: Number(
      counts.in_progress_count
    ),
    resolved: Number(counts.resolved_count),
  };
}

module.exports = {
  create_request,
  get_request_by_id,
  list_requests,
  update_request,
  get_status_counts,
};