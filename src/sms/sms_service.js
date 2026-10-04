const db = require("../config/db");

const {
  send_sms,
} = require("../utils/sms_provider");

function get_sms_cost() {
  const cost = Number(
    process.env.SMS_COST_PER_MESSAGE || 1.5
  );

  return Number.isFinite(cost) && cost >= 0
    ? cost
    : 1.5;
}

function as_number(value) {
  return Number(value || 0);
}

function service_error(message, status_code = 400) {
  const error = new Error(message);
  error.status_code = status_code;
  return error;
}

function to_date_string(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function month_name(value) {
  const date = value
    ? new Date(value)
    : new Date();

  return new Intl.DateTimeFormat("en-KE", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function days_overdue(due_date) {
  if (!due_date) {
    return 0;
  }

  const due = new Date(
    `${to_date_string(due_date)}T00:00:00`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const difference = today.getTime() - due.getTime();

  return difference > 0
    ? Math.floor(difference / 86400000)
    : 0;
}

function format_money(value) {
  return as_number(value).toFixed(2);
}

function render_message(template, tenant, variables = {}) {
  const values = {
    name: tenant.full_name || "",
    house: tenant.unit_number || "",
    balance: format_money(tenant.balance),
    amount: format_money(tenant.balance),
    month: month_name(),
    due_date: to_date_string(tenant.next_due_date),
    days_overdue: String(
      days_overdue(tenant.next_due_date)
    ),
    property: tenant.property_name || "",
    ...variables,
  };

  return template.replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (match, key) => {
      if (
        values[key] === undefined ||
        values[key] === null
      ) {
        return "";
      }

      return String(values[key]);
    }
  );
}

function public_template(template) {
  return {
    id: Number(template.id),
    owner_id: Number(template.owner_id),
    name: template.name,
    body: template.body,
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

function public_broadcast(broadcast) {
  return {
    id: Number(broadcast.id),
    owner_id: Number(broadcast.owner_id),

    template_id: broadcast.template_id
      ? Number(broadcast.template_id)
      : null,

    template_name: broadcast.template_name,
    message_template: broadcast.message_template,

    recipient_group: broadcast.recipient_group,

    property_id: broadcast.property_id
      ? Number(broadcast.property_id)
      : null,

    tenant_id: broadcast.tenant_id
      ? Number(broadcast.tenant_id)
      : null,

    variables: broadcast.variables || {},

    scheduled_at: broadcast.scheduled_at,
    status: broadcast.status,

    recipient_count: Number(
      broadcast.recipient_count || 0
    ),

    accepted_count: Number(
      broadcast.accepted_count || 0
    ),

    failed_count: Number(
      broadcast.failed_count || 0
    ),

    cancelled_at: broadcast.cancelled_at,
    created_at: broadcast.created_at,
    updated_at: broadcast.updated_at,
  };
}

function public_message(message) {
  return {
    id: Number(message.id),

    broadcast_id: Number(message.broadcast_id),

    property_id: message.property_id
      ? Number(message.property_id)
      : null,

    property_name: message.property_name || null,

    tenant_id: message.tenant_id
      ? Number(message.tenant_id)
      : null,

    tenant_name: message.tenant_name,
    unit_number: message.unit_number || null,

    recipient_phone: message.recipient_phone,
    sender_id: message.sender_id || null,

    template_name: message.template_name || null,
    message: message.message,

    estimated_cost: as_number(message.estimated_cost),

    /*
      accepted means Africa's Talking/console accepted the send request.
      A later provider delivery-report webhook can upgrade this to
      delivered if desired.
    */
    status: message.status,
    retry_count: Number(message.retry_count || 0),

    provider: message.provider || null,
    provider_error: message.provider_error || null,

    accepted_at: message.accepted_at,
    sent_at: message.sent_at,
    created_at: message.created_at,
    updated_at: message.updated_at,
  };
}

/*
  All recipient selection comes from real tenant charges and credits.

  arrears:
    Sum of unpaid tenant_charges with status open/partial > 0.

  credit:
    Sum of remaining tenant_credits > 0.
*/
async function find_recipients(
  client,
  owner_id,
  target
) {
  const conditions = [
    "tenants.owner_id = $1",
    "tenants.status = 'active'",
    "properties.status = 'active'",
  ];

  const values = [owner_id];

  if (target.recipient_group === "property") {
    values.push(target.property_id);

    conditions.push(
      `tenants.property_id = $${values.length}`
    );
  }

  if (target.recipient_group === "specific_tenant") {
    values.push(target.tenant_id);

    conditions.push(
      `tenants.id = $${values.length}`
    );
  }

  if (
    target.recipient_group ===
    "tenants_with_arrears"
  ) {
    conditions.push("financials.balance > 0");
  }

  if (
    target.recipient_group ===
    "tenants_with_credit_balance"
  ) {
    conditions.push("financials.credit_balance > 0");
  }

  const result = await client.query(
    `
      SELECT
        tenants.id,
        tenants.full_name,
        tenants.payment_phone,
        tenants.property_id,
        tenants.unit_id,

        units.unit_number,

        properties.name AS property_name,
        properties.sms_sender_id,

        financials.balance,
        financials.credit_balance,
        financials.next_due_date

      FROM tenants

      INNER JOIN units
        ON units.id = tenants.unit_id

      INNER JOIN properties
        ON properties.id = tenants.property_id

      CROSS JOIN LATERAL (
        SELECT
          COALESCE(
            (
              SELECT SUM(
                tenant_charges.amount_due -
                tenant_charges.amount_paid
              )
              FROM tenant_charges
              WHERE tenant_charges.tenant_id = tenants.id
                AND tenant_charges.status IN (
                  'open',
                  'partial'
                )
            ),
            0
          ) AS balance,

          COALESCE(
            (
              SELECT SUM(
                tenant_credits.remaining_amount
              )
              FROM tenant_credits
              WHERE tenant_credits.tenant_id = tenants.id
                AND tenant_credits.remaining_amount > 0
            ),
            0
          ) AS credit_balance,

          (
            SELECT MIN(tenant_charges.due_date)
            FROM tenant_charges
            WHERE tenant_charges.tenant_id = tenants.id
              AND tenant_charges.status IN (
                'open',
                'partial'
              )
          ) AS next_due_date
      ) AS financials

      WHERE ${conditions.join(" AND ")}

      ORDER BY
        properties.name ASC,
        units.unit_number ASC,
        tenants.full_name ASC
    `,
    values
  );

  if (
    target.recipient_group === "property" &&
    !result.rows.length
  ) {
    const property = await client.query(
      `
        SELECT id
        FROM properties
        WHERE id = $1
          AND owner_id = $2
        LIMIT 1
      `,
      [
        target.property_id,
        owner_id,
      ]
    );

    if (!property.rows[0]) {
      throw service_error(
        "Property not found or you do not have access to it.",
        404
      );
    }
  }

  if (
    target.recipient_group === "specific_tenant" &&
    !result.rows.length
  ) {
    const tenant = await client.query(
      `
        SELECT id
        FROM tenants
        WHERE id = $1
          AND owner_id = $2
        LIMIT 1
      `,
      [
        target.tenant_id,
        owner_id,
      ]
    );

    if (!tenant.rows[0]) {
      throw service_error(
        "Tenant not found or you do not have access to them.",
        404
      );
    }

    throw service_error(
      "This tenant is not active and cannot receive a broadcast.",
      422
    );
  }

  return result.rows;
}

async function get_template_or_throw(
  client,
  owner_id,
  template_id
) {
  const result = await client.query(
    `
      SELECT *
      FROM sms_templates
      WHERE id = $1
        AND owner_id = $2
      LIMIT 1
    `,
    [
      template_id,
      owner_id,
    ]
  );

  if (!result.rows[0]) {
    throw service_error(
      "SMS template not found or you do not have access to it.",
      404
    );
  }

  return result.rows[0];
}

async function get_broadcast_with_counts(
  client,
  owner_id,
  broadcast_id
) {
  const result = await client.query(
    `
      SELECT
        sms_broadcasts.*,

        COUNT(sms_messages.id) AS recipient_count,

        COUNT(sms_messages.id)
          FILTER (
            WHERE sms_messages.status = 'accepted'
          ) AS accepted_count,

        COUNT(sms_messages.id)
          FILTER (
            WHERE sms_messages.status = 'failed'
          ) AS failed_count

      FROM sms_broadcasts

      LEFT JOIN sms_messages
        ON sms_messages.broadcast_id =
          sms_broadcasts.id

      WHERE sms_broadcasts.id = $1
        AND sms_broadcasts.owner_id = $2

      GROUP BY sms_broadcasts.id
      LIMIT 1
    `,
    [
      broadcast_id,
      owner_id,
    ]
  );

  if (!result.rows[0]) {
    throw service_error(
      "SMS broadcast not found or you do not have access to it.",
      404
    );
  }

  return result.rows[0];
}

async function create_template(owner, data) {
  const result = await db.query(
    `
      INSERT INTO sms_templates (
        owner_id,
        name,
        body
      )
      VALUES ($1, $2, $3)
      RETURNING *
    `,
    [
      owner.user_id,
      data.name,
      data.body,
    ]
  );

  return public_template(result.rows[0]);
}

async function list_templates(owner) {
  const result = await db.query(
    `
      SELECT *
      FROM sms_templates
      WHERE owner_id = $1
      ORDER BY
        updated_at DESC,
        name ASC
    `,
    [owner.user_id]
  );

  return result.rows.map(public_template);
}

async function update_template(
  owner,
  template_id,
  data
) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) {
    values.push(data.name);
    fields.push(`name = $${values.length}`);
  }

  if (data.body !== undefined) {
    values.push(data.body);
    fields.push(`body = $${values.length}`);
  }

  values.push(template_id);
  values.push(owner.user_id);

  try {
    const result = await db.query(
      `
        UPDATE sms_templates
        SET ${fields.join(", ")}
        WHERE id = $${values.length - 1}
          AND owner_id = $${values.length}
        RETURNING *
      `,
      values
    );

    if (!result.rows[0]) {
      throw service_error(
        "SMS template not found or you do not have access to it.",
        404
      );
    }

    return public_template(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      throw service_error(
        "You already have an SMS template with this name.",
        409
      );
    }

    throw error;
  }
}

async function delete_template(owner, template_id) {
  const result = await db.query(
    `
      DELETE FROM sms_templates
      WHERE id = $1
        AND owner_id = $2
      RETURNING id
    `,
    [
      template_id,
      owner.user_id,
    ]
  );

  if (!result.rows[0]) {
    throw service_error(
      "SMS template not found or you do not have access to it.",
      404
    );
  }
}

async function estimate_recipients(owner, target) {
  const client = await db.get_client();

  try {
    const recipients = await find_recipients(
      client,
      owner.user_id,
      target
    );

    const cost_per_message = get_sms_cost();

    return {
      recipient_group: target.recipient_group,

      property_id: target.property_id || null,
      tenant_id: target.tenant_id || null,

      recipient_count: recipients.length,
      cost_per_message,

      estimated_cost:
        Number(
          (
            recipients.length *
            cost_per_message
          ).toFixed(2)
        ),

      /*
        Useful for a frontend preview, but never expose phone numbers
        in the estimate endpoint.
      */
      recipients: recipients.map((tenant) => ({
        tenant_id: Number(tenant.id),
        tenant_name: tenant.full_name,
        unit_number: tenant.unit_number,
        property_name: tenant.property_name,
        balance: as_number(tenant.balance),
        credit_balance: as_number(
          tenant.credit_balance
        ),
      })),
    };
  } finally {
    client.release();
  }
}

async function create_broadcast(owner, data) {
  const client = await db.get_client();

  let broadcast_id;
  let send_now = false;

  try {
    await client.query("BEGIN");

    let template = null;

    if (data.template_id) {
      template = await get_template_or_throw(
        client,
        owner.user_id,
        data.template_id
      );
    }

    const message_template =
      data.message ||
      template?.body;

    if (!message_template) {
      throw service_error(
        "Provide a message or select an SMS template.",
        422
      );
    }

    const scheduled_at = data.send_at
      ? new Date(data.send_at)
      : new Date();

    const recipients = await find_recipients(
      client,
      owner.user_id,
      data
    );

    if (!recipients.length) {
      throw service_error(
        "No active tenants match this recipient selection.",
        422
      );
    }

    const broadcast_result = await client.query(
      `
        INSERT INTO sms_broadcasts (
          owner_id,
          template_id,
          template_name,
          message_template,
          recipient_group,
          property_id,
          tenant_id,
          variables,
          scheduled_at,
          status
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,'scheduled'
        )
        RETURNING *
      `,
      [
        owner.user_id,
        template?.id || null,
        template?.name || null,
        message_template,
        data.recipient_group,
        data.property_id || null,
        data.tenant_id || null,
        data.variables || {},
        scheduled_at,
      ]
    );

    const broadcast = broadcast_result.rows[0];
    const estimated_cost = get_sms_cost();

    for (const tenant of recipients) {
      const message = render_message(
        message_template,
        tenant,
        data.variables || {}
      );

      await client.query(
        `
          INSERT INTO sms_messages (
            broadcast_id,
            owner_id,
            property_id,
            tenant_id,
            tenant_name,
            unit_number,
            recipient_phone,
            sender_id,
            template_name,
            message,
            estimated_cost,
            status
          )
          VALUES (
            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,'queued'
          )
        `,
        [
          broadcast.id,
          owner.user_id,
          tenant.property_id,
          tenant.id,
          tenant.full_name,
          tenant.unit_number,
          tenant.payment_phone,
          tenant.sms_sender_id || null,
          template?.name || null,
          message,
          estimated_cost,
        ]
      );
    }

    await client.query("COMMIT");

    broadcast_id = Number(broadcast.id);
    send_now = !data.send_at;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  /*
    Do not make the browser wait for every provider request.
    The message rows already exist and can be viewed immediately.
  */
  if (send_now) {
    setImmediate(() => {
      dispatch_broadcast(
        broadcast_id,
        owner.user_id
      ).catch((error) => {
        console.error(
          "[SMS] Immediate broadcast failed:",
          error.message
        );
      });
    });
  }

  const read_client = await db.get_client();

  try {
    const broadcast = await get_broadcast_with_counts(
      read_client,
      owner.user_id,
      broadcast_id
    );

    return public_broadcast(broadcast);
  } finally {
    read_client.release();
  }
}

async function dispatch_broadcast(
  broadcast_id,
  owner_id
) {
  const client = await db.get_client();

  let broadcast;

  try {
    await client.query("BEGIN");

    const claim = await client.query(
      `
        UPDATE sms_broadcasts
        SET status = 'sending'
        WHERE id = $1
          AND owner_id = $2
          AND status IN (
            'scheduled',
            'partially_failed'
          )
          AND scheduled_at <= CURRENT_TIMESTAMP
        RETURNING *
      `,
      [
        broadcast_id,
        owner_id,
      ]
    );

    broadcast = claim.rows[0];

    if (!broadcast) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const messages = await db.query(
    `
      SELECT *
      FROM sms_messages
      WHERE broadcast_id = $1
        AND owner_id = $2
        AND status = 'queued'
      ORDER BY id ASC
    `,
    [
      broadcast_id,
      owner_id,
    ]
  );

  for (const message of messages.rows) {
    try {
      const result = await send_sms({
        phone: message.recipient_phone,
        message: message.message,
        sender_id: message.sender_id,
      });

      await db.query(
        `
          UPDATE sms_messages
          SET
            status = 'accepted',
            provider = $1,
            provider_response = $2::JSONB,
            provider_error = NULL,
            accepted_at = CURRENT_TIMESTAMP,
            sent_at = CURRENT_TIMESTAMP
          WHERE id = $3
            AND status = 'queued'
        `,
        [
          result.provider,
          JSON.stringify(result.response || {}),
          message.id,
        ]
      );
    } catch (error) {
      await db.query(
        `
          UPDATE sms_messages
          SET
            status = 'failed',
            retry_count = retry_count + 1,
            provider_error = $1
          WHERE id = $2
            AND status = 'queued'
        `,
        [
          String(error.message || "SMS provider failed.")
            .slice(0, 5000),
          message.id,
        ]
      );
    }
  }

  const summary = await db.query(
    `
      SELECT
        COUNT(*) AS total_count,

        COUNT(*)
          FILTER (
            WHERE status = 'failed'
          ) AS failed_count,

        COUNT(*)
          FILTER (
            WHERE status = 'queued'
          ) AS queued_count

      FROM sms_messages
      WHERE broadcast_id = $1
    `,
    [broadcast_id]
  );

  const totals = summary.rows[0];

  const next_status =
    Number(totals.queued_count) > 0
      ? "sending"
      : Number(totals.failed_count) > 0
        ? "partially_failed"
        : "completed";

  await db.query(
    `
      UPDATE sms_broadcasts
      SET status = $1
      WHERE id = $2
    `,
    [
      next_status,
      broadcast_id,
    ]
  );
}

async function dispatch_due_broadcasts() {
  const result = await db.query(
    `
      SELECT id, owner_id
      FROM sms_broadcasts
      WHERE status IN (
        'scheduled',
        'partially_failed'
      )
        AND scheduled_at <= CURRENT_TIMESTAMP
      ORDER BY scheduled_at ASC
      LIMIT 20
    `
  );

  for (const broadcast of result.rows) {
    try {
      await dispatch_broadcast(
        Number(broadcast.id),
        Number(broadcast.owner_id)
      );
    } catch (error) {
      console.error(
        `[SMS] Scheduled broadcast ${broadcast.id} failed:`,
        error.message
      );
    }
  }
}

let scheduler_started = false;

function start_sms_scheduler() {
  if (scheduler_started) {
    return;
  }

  scheduler_started = true;

  const interval = Number(
    process.env.SMS_SCHEDULER_INTERVAL_MS || 60000
  );

  const safe_interval =
    Number.isFinite(interval) && interval >= 10000
      ? interval
      : 60000;

  setInterval(() => {
    dispatch_due_broadcasts().catch((error) => {
      console.error(
        "[SMS] Scheduler error:",
        error.message
      );
    });
  }, safe_interval).unref();

  console.log(
    `[SMS] Scheduler started. Checking every ${safe_interval}ms.`
  );
}

async function list_broadcasts(owner, filters) {
  const result = await db.query(
    `
      SELECT
        sms_broadcasts.*,

        COUNT(sms_messages.id) AS recipient_count,

        COUNT(sms_messages.id)
          FILTER (
            WHERE sms_messages.status = 'accepted'
          ) AS accepted_count,

        COUNT(sms_messages.id)
          FILTER (
            WHERE sms_messages.status = 'failed'
          ) AS failed_count

      FROM sms_broadcasts

      LEFT JOIN sms_messages
        ON sms_messages.broadcast_id =
          sms_broadcasts.id

      WHERE sms_broadcasts.owner_id = $1

        AND (
          $2::VARCHAR IS NULL
          OR sms_broadcasts.status = $2
        )

      GROUP BY sms_broadcasts.id

      ORDER BY
        sms_broadcasts.scheduled_at DESC

      LIMIT $3
    `,
    [
      owner.user_id,
      filters.status || null,
      filters.limit,
    ]
  );

  return result.rows.map(public_broadcast);
}

async function list_messages(owner, filters) {
  const result = await db.query(
    `
      SELECT
        sms_messages.*,
        properties.name AS property_name

      FROM sms_messages

      LEFT JOIN properties
        ON properties.id = sms_messages.property_id

      WHERE sms_messages.owner_id = $1

        AND (
          $2::BIGINT IS NULL
          OR sms_messages.property_id = $2
        )

        AND (
          $3::BIGINT IS NULL
          OR sms_messages.tenant_id = $3
        )

        AND (
          $4::VARCHAR IS NULL
          OR sms_messages.status = $4
        )

      ORDER BY
        sms_messages.created_at DESC

      LIMIT $5
    `,
    [
      owner.user_id,
      filters.property_id || null,
      filters.tenant_id || null,
      filters.status || null,
      filters.limit,
    ]
  );

  return result.rows.map(public_message);
}

async function get_sms_stats(owner) {
  const result = await db.query(
    `
      WITH month_messages AS (
        SELECT *
        FROM sms_messages
        WHERE owner_id = $1
          AND created_at >= DATE_TRUNC(
            'month',
            CURRENT_TIMESTAMP
          )
      )

      SELECT
        COUNT(*) AS sent_this_month,

        COALESCE(
          SUM(estimated_cost)
            FILTER (
              WHERE status = 'accepted'
            ),
          0
        ) AS accepted_cost,

        COUNT(*)
          FILTER (
            WHERE status = 'accepted'
          ) AS accepted_count,

        COUNT(*)
          FILTER (
            WHERE status = 'failed'
          ) AS failed_count,

        (
          SELECT COUNT(*)
          FROM sms_broadcasts
          WHERE owner_id = $1
            AND status = 'scheduled'
            AND scheduled_at > CURRENT_TIMESTAMP
        ) AS scheduled_count
      FROM month_messages
    `,
    [owner.user_id]
  );

  const row = result.rows[0];

  const sent_this_month = Number(
    row.sent_this_month
  );

  const accepted_count = Number(
    row.accepted_count
  );

  return {
    sent_this_month,
    accepted_count,

    accepted_percentage:
      sent_this_month > 0
        ? Number(
          (
            (accepted_count / sent_this_month) *
            100
          ).toFixed(1)
        )
        : 0,

    failed_count: Number(row.failed_count),

    scheduled_count: Number(
      row.scheduled_count
    ),

    accepted_cost: as_number(
      row.accepted_cost
    ),

    cost_per_message: get_sms_cost(),
  };
}

async function cancel_broadcast(
  owner,
  broadcast_id
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        UPDATE sms_broadcasts
        SET
          status = 'cancelled',
          cancelled_at = CURRENT_TIMESTAMP,
          cancelled_by = $1
        WHERE id = $2
          AND owner_id = $1
          AND status = 'scheduled'
        RETURNING *
      `,
      [
        owner.user_id,
        broadcast_id,
      ]
    );

    if (!result.rows[0]) {
      throw service_error(
        "Only a scheduled SMS broadcast can be cancelled.",
        400
      );
    }

    await client.query(
      `
        UPDATE sms_messages
        SET status = 'cancelled'
        WHERE broadcast_id = $1
          AND status = 'queued'
      `,
      [broadcast_id]
    );

    await client.query("COMMIT");

    return public_broadcast({
      ...result.rows[0],
      recipient_count: 0,
      accepted_count: 0,
      failed_count: 0,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function retry_message(
  owner,
  message_id
) {
  const result = await db.query(
    `
      UPDATE sms_messages
      SET
        status = 'queued',
        provider_error = NULL
      WHERE id = $1
        AND owner_id = $2
        AND status = 'failed'
      RETURNING broadcast_id
    `,
    [
      message_id,
      owner.user_id,
    ]
  );

  if (!result.rows[0]) {
    throw service_error(
      "Only a failed SMS message can be retried.",
      400
    );
  }

  const broadcast_id = Number(
    result.rows[0].broadcast_id
  );

  await db.query(
    `
      UPDATE sms_broadcasts
      SET
        status = 'partially_failed',
        scheduled_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND owner_id = $2
    `,
    [
      broadcast_id,
      owner.user_id,
    ]
  );

  setImmediate(() => {
    dispatch_broadcast(
      broadcast_id,
      owner.user_id
    ).catch((error) => {
      console.error(
        `[SMS] Retry failed for message ${message_id}:`,
        error.message
      );
    });
  });
}

module.exports = {
  create_template,
  list_templates,
  update_template,
  delete_template,

  estimate_recipients,
  create_broadcast,
  list_broadcasts,
  list_messages,
  get_sms_stats,

  cancel_broadcast,
  retry_message,

  start_sms_scheduler,
};