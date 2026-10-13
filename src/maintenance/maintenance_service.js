const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  apply_tenant_credits,
} = require("../billing/billing_service");

const {
  send_single_sms,
} = require("../sms/sms_service");

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

    /*
      Whether the cost is charged to the tenant, and what was
      recorded once the request was resolved with a cost.
    */
    charge_to_tenant: Boolean(request.charge_to_tenant),

    /*
      'now' or 'move_out'. Only matters when the tenant pays.
    */
    charge_timing: request.charge_timing || "now",

    expense_id: request.expense_id
      ? Number(request.expense_id)
      : null,

    tenant_charge_id: request.tenant_charge_id
      ? Number(request.tenant_charge_id)
      : null,

    charged_tenant_id: request.charged_tenant_id
      ? Number(request.charged_tenant_id)
      : null,

    /*
      When the tenant was last sent an SMS about the charge;
      null if none was sent.
    */
    charge_sms_sent_at: request.charge_sms_sent_at || null,

    /*
      The tenant living in the unit now, if any.
    */
    unit_tenant_name: request.unit_tenant_name || null,

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

    if (data.charge_to_tenant && !unit) {
      const error = new Error(
        "This repair is not in a unit, so its cost cannot be charged to a tenant."
      );

      error.status_code = 422;
      throw error;
    }

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
          reporter_role,
          charge_to_tenant,
          charge_timing
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,
          $10,$11
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
        Boolean(data.charge_to_tenant),
        data.charge_timing || "now",
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
        charge_to_tenant: request.charge_to_tenant,
        charge_timing: request.charge_timing,
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

        (
          SELECT tenants.full_name
          FROM tenants
          WHERE tenants.unit_id =
            maintenance_requests.unit_id
            AND tenants.status IN (
              'active',
              'notice_given'
            )
          ORDER BY tenants.created_at DESC
          LIMIT 1
        ) AS unit_tenant_name,

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

        (
          SELECT tenants.full_name
          FROM tenants
          WHERE tenants.unit_id =
            maintenance_requests.unit_id
            AND tenants.status IN (
              'active',
              'notice_given'
            )
          ORDER BY tenants.created_at DESC
          LIMIT 1
        ) AS unit_tenant_name,

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

/*
  Runs when a request is resolved and has an actual cost that
  has not been recorded yet.

  - The cost is always recorded as a property expense.
  - If the owner ticked "charge to tenant", it is also charged
    to the tenant living in the unit. The tenant can pay it
    during their stay; anything unpaid is deducted from their
    deposit at move-out.

  Returns null when there is nothing to record.
*/
async function record_repair_cost(client, user, request) {
  if (
    request.status !== "resolved" ||
    !(Number(request.actual_cost) > 0) ||
    request.expense_id
  ) {
    return null;
  }

  const expense_result = await client.query(
    `
      INSERT INTO expenses (
        owner_id,
        property_id,
        category,
        amount,
        expense_date,
        notes,
        created_by,
        created_by_role,
        maintenance_request_id,
        unit_id
      )
      VALUES (
        $1,$2,
        'repairs_maintenance',
        $3,
        (
          CURRENT_TIMESTAMP
          AT TIME ZONE 'Africa/Nairobi'
        )::DATE,
        $4,$5,$6,$7,$8
      )
      RETURNING *
    `,
    [
      request.owner_id,
      request.property_id,
      request.actual_cost,
      `Repair: ${request.title}`,
      user.user_id,
      user.role,
      request.id,
      request.unit_id,
    ]
  );

  const expense = expense_result.rows[0];

  let tenant = null;
  let charge = null;

  const at_move_out =
    request.charge_timing === "move_out";

  if (request.charge_to_tenant) {
    const tenant_result = await client.query(
      `
        SELECT
          tenants.*,
          units.unit_number,
          properties.name AS property_name,
          properties.sms_sender_id
        FROM tenants
        INNER JOIN units
          ON units.id = tenants.unit_id
        INNER JOIN properties
          ON properties.id = tenants.property_id
        WHERE tenants.unit_id = $1
          AND tenants.status IN (
            'active',
            'notice_given'
          )
        ORDER BY tenants.created_at DESC
        LIMIT 1
      `,
      [request.unit_id]
    );

    tenant = tenant_result.rows[0];

    if (!tenant) {
      const error = new Error(
        "No tenant lives in this unit now, so the cost cannot be charged to a tenant. Untick \"charge to tenant\" and try again."
      );

      error.status_code = 422;
      throw error;
    }

    /*
      A repair is billed once, not for a month, so it uses the
      placeholder period 1970-01-01 like deposits do.
    */
    const charge_result = await client.query(
      `
        INSERT INTO tenant_charges (
          tenant_id,
          owner_id,
          property_id,
          unit_id,
          charge_type,
          billing_period,
          due_date,
          amount_due,
          description,
          source_id,
          status
        )
        VALUES (
          $1,$2,$3,$4,
          'repair',
          DATE '1970-01-01',
          (
            CURRENT_TIMESTAMP
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE,
          $5,$6,$7,$8
        )
        RETURNING *
      `,
      [
        tenant.id,
        tenant.owner_id,
        tenant.property_id,
        tenant.unit_id,
        request.actual_cost,
        `Repair: ${request.title}`.slice(0, 255),
        request.id,
        at_move_out ? "held" : "open",
      ]
    );

    charge = charge_result.rows[0];

    /*
      A repair kept for move-out is not paid from the tenant's
      credit or payments. It becomes payable when they move
      out, where the rent deposit covers it.
    */
    if (!at_move_out) {
      await apply_tenant_credits(client, tenant.id);
    }
  }

  await client.query(
    `
      UPDATE maintenance_requests
      SET
        expense_id = $1,
        tenant_charge_id = $2,
        charged_tenant_id = $3
      WHERE id = $4
    `,
    [
      expense.id,
      charge?.id || null,
      tenant?.id || null,
      request.id,
    ]
  );

  return { expense, tenant, charge };
}

/*
  Audit entries for a recorded repair cost. The tenant is not
  told automatically: the SMS about the charge is sent by hand
  with send_repair_charge_sms.
*/
async function announce_repair_cost(
  user,
  request,
  repair,
  ip_address
) {
  if (!repair) {
    return;
  }

  await log_audit({
    user_id: user.user_id,
    action: "EXPENSE_RECORDED",
    entity_type: "expense",
    entity_id: repair.expense.id,
    metadata: {
      property_id: request.property_id,
      category: repair.expense.category,
      amount: repair.expense.amount,
      maintenance_request_id: request.id,
      created_by_role: user.role,
    },
    ip_address,
  });

  if (!repair.charge) {
    return;
  }

  await log_audit({
    user_id: user.user_id,
    action: "REPAIR_CHARGED_TO_TENANT",
    entity_type: "tenant",
    entity_id: repair.tenant.id,
    metadata: {
      property_id: request.property_id,
      maintenance_request_id: request.id,
      title: request.title,
      amount: repair.charge.amount_due,
    },
    ip_address,
  });
}

/*
  Sends the tenant an SMS about a repair that was charged to
  them. It is sent only when the owner or caretaker asks, and
  may be sent again. The message is kept in the SMS centre
  history.
*/
async function send_repair_charge_sms(
  user,
  request_id,
  ip_address
) {
  const client = await db.get_client();

  let request;
  let tenant;
  let charge;

  try {
    request = await get_request_row(
      client,
      user,
      request_id
    );

    if (
      !request.tenant_charge_id ||
      !request.charged_tenant_id
    ) {
      const error = new Error(
        "This repair was not charged to a tenant, so there is nothing to tell them."
      );

      error.status_code = 400;
      throw error;
    }

    const tenant_result = await client.query(
      `
        SELECT
          tenants.*,
          units.unit_number,
          properties.name AS property_name,
          properties.sms_sender_id
        FROM tenants
        INNER JOIN units
          ON units.id = tenants.unit_id
        INNER JOIN properties
          ON properties.id = tenants.property_id
        WHERE tenants.id = $1
      `,
      [request.charged_tenant_id]
    );

    tenant = tenant_result.rows[0];

    const charge_result = await client.query(
      `
        SELECT *
        FROM tenant_charges
        WHERE id = $1
      `,
      [request.tenant_charge_id]
    );

    charge = charge_result.rows[0];
  } finally {
    client.release();
  }

  const amount = Number(
    charge.amount_due
  ).toLocaleString("en-KE");

  const sms = await send_single_sms({
    owner_id: request.owner_id,
    property_id: request.property_id,
    tenant,
    template_name: "Repair charge",
    message: `Dear ${tenant.full_name.split(" ")[0]}, a repair at House ${tenant.unit_number} (${request.title}) has been charged to your account: KES ${amount}. ${
      charge.status === "held"
        ? "It will be deducted from your deposit when you move out."
        : "Please include it in your next payment."
    } ${tenant.property_name}`,
  });

  if (sms.status === "accepted") {
    await db.query(
      `
        UPDATE maintenance_requests
        SET charge_sms_sent_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [request.id]
    );
  }

  await log_audit({
    user_id: user.user_id,
    action: "REPAIR_CHARGE_SMS_SENT",
    entity_type: "tenant",
    entity_id: tenant.id,
    metadata: {
      property_id: request.property_id,
      maintenance_request_id: request.id,
      title: request.title,
      amount: charge.amount_due,
      sms:
        sms.status === "accepted"
          ? "sent"
          : `failed: ${sms.provider_error}`,
    },
    ip_address,
  });

  if (sms.status !== "accepted") {
    const error = new Error(
      `The SMS could not be sent: ${sms.provider_error}`
    );

    error.status_code = 502;
    throw error;
  }

  return get_request_by_id(user, request.id);
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

    /*
      A caretaker may do everything the owner can here, for
      requests in a property they are assigned to. That access
      was checked when the request was loaded above.
    */
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

    if (data.charge_to_tenant && !existing.unit_id) {
      const error = new Error(
        "This repair is not in a unit, so its cost cannot be charged to a tenant."
      );

      error.status_code = 422;
      throw error;
    }

    /*
      Once the cost is recorded as an expense it is fixed.
    */
    if (
      existing.expense_id &&
      ((data.actual_cost !== undefined &&
        Number(data.actual_cost) !==
          Number(existing.actual_cost)) ||
        (data.charge_to_tenant !== undefined &&
          data.charge_to_tenant !==
            existing.charge_to_tenant) ||
        (data.charge_timing !== undefined &&
          data.charge_timing !==
            existing.charge_timing))
    ) {
      const error = new Error(
        "The cost of this repair has already been recorded as an expense, so it can no longer be changed here."
      );

      error.status_code = 400;
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

          charge_to_tenant = COALESCE(
            $16::BOOLEAN,
            charge_to_tenant
          ),

          charge_timing = COALESCE(
            $17::VARCHAR,
            charge_timing
          ),

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

        data.charge_to_tenant ?? null,

        data.charge_timing ?? null,
      ]
    );

    const updated = result.rows[0];

    const repair = await record_repair_cost(
      client,
      user,
      updated
    );

    await client.query("COMMIT");

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

    await announce_repair_cost(
      user,
      updated,
      repair,
      ip_address
    );

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
  send_repair_charge_sms,
  get_status_counts,
};