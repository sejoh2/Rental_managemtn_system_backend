const db = require("../config/db");

const {
  assert_can_send_sms,
} = require("../subscriptions/subscription_access");

const {
  send_sms,
} = require("../utils/sms_provider");

const {
  effective_sender_sql,
} = require("./sender_approval_service");

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

const month_names = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/*
  "2026-10-05" -> "5 Oct 2026".
  The date arrives as text from SQL, so no time zone can move
  it to the day before.
*/
function format_date(value) {
  if (!value) {
    return "";
  }

  const [year, month, day] = String(value)
    .split("-")
    .map(Number);

  return `${day} ${month_names[month - 1]} ${year}`;
}

function month_name() {
  return new Intl.DateTimeFormat("en-KE", {
    month: "long",
    year: "numeric",
    timeZone: "Africa/Nairobi",
  }).format(new Date());
}

/*
  How many SMS a message is billed as: one up to 160
  characters, then one per 153.
*/
function sms_parts(message) {
  return message.length <= 160
    ? 1
    : Math.ceil(message.length / 153);
}

function format_money(value) {
  return as_number(value).toLocaleString("en-KE", {
    maximumFractionDigits: 2,
  });
}

function render_message(template, tenant, variables = {}) {
  const values = {
    name: tenant.full_name || "",
    house: tenant.unit_number || "",
    balance: format_money(tenant.balance),
    amount: format_money(tenant.balance),
    month: month_name(),
    due_date: format_date(tenant.next_due_date),
    days_overdue: String(tenant.days_overdue || 0),
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

/*
  Placeholders that quote what a tenant owes. A message using
  any of them is a payment reminder.
*/
const money_placeholders = [
  "balance",
  "amount",
  "due_date",
  "days_overdue",
];

function asks_for_money(template, variables) {
  const given = variables || {};

  return money_placeholders.some(
    (key) =>
      given[key] === undefined &&
      template.includes(`{${key}}`)
  );
}

/*
  A tenant who owes nothing does not get a payment reminder,
  so nobody is asked to pay KES 0 by a blank date. Any other
  message goes to everyone selected.
*/
function leave_out_settled(
  recipients,
  template,
  variables
) {
  if (!asks_for_money(template, variables)) {
    return recipients;
  }

  return recipients.filter(
    (tenant) => as_number(tenant.balance) > 0
  );
}

function public_template(template) {
  return {
    id: template.id,
    owner_id: template.owner_id,
    name: template.name,
    body: template.body,
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

function public_broadcast(broadcast) {
  return {
    id: broadcast.id,
    owner_id: broadcast.owner_id,

    template_id: broadcast.template_id || null,

    template_name: broadcast.template_name,
    message_template: broadcast.message_template,

    recipient_group: broadcast.recipient_group,

    property_id: broadcast.property_id || null,

    tenant_id: broadcast.tenant_id || null,

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
    id: message.id,

    /*
      null for a single message sent outside a broadcast.
    */
    broadcast_id: message.broadcast_id || null,

    property_id: message.property_id || null,

    property_name: message.property_name || null,

    tenant_id: message.tenant_id || null,

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
    "tenants.status IN ('active', 'notice_given')",
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
        ${effective_sender_sql} AS sms_sender_id,

        financials.balance,
        financials.credit_balance,
        financials.next_due_date,
        financials.days_overdue

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
            SELECT TO_CHAR(
              MIN(tenant_charges.due_date),
              'YYYY-MM-DD'
            )
            FROM tenant_charges
            WHERE tenant_charges.tenant_id = tenants.id
              AND tenant_charges.status IN (
                'open',
                'partial'
              )
          ) AS next_due_date,

          (
            SELECT GREATEST(
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'Africa/Nairobi'
              )::DATE - MIN(tenant_charges.due_date),
              0
            )
            FROM tenant_charges
            WHERE tenant_charges.tenant_id = tenants.id
              AND tenant_charges.status IN (
                'open',
                'partial'
              )
          ) AS days_overdue
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

const starter_templates = [
  [
    "Balance reminder",
    "Dear {name}, your balance for House {house} is KES {balance}. Kindly pay by {due_date}. {property}",
  ],
  [
    "Late payment warning",
    "Dear {name}, your payment of KES {balance} for House {house} is {days_overdue} days overdue. Please pay today. {property}",
  ],
  [
    "Water bill reminder",
    "Dear {name}, your water bill for House {house} is ready. Your total balance is KES {balance}, due {due_date}. {property}",
  ],
  [
    "General notice",
    "Dear {name}, please note: (write your notice here). {property}",
  ],
];

/*
  Gives an owner the starter templates the first time their
  templates are listed. It runs once per owner, so a starter
  template they delete does not come back.
*/
async function add_starter_templates(owner_id) {
  const seed = await db.query(
    `
      INSERT INTO sms_template_seeds (owner_id)
      VALUES ($1)
      ON CONFLICT (owner_id)
      DO NOTHING
      RETURNING owner_id
    `,
    [owner_id]
  );

  if (!seed.rows[0]) {
    return;
  }

  for (const [name, body] of starter_templates) {
    await db.query(
      `
        INSERT INTO sms_templates (
          owner_id,
          name,
          body
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (owner_id, name)
        DO NOTHING
      `,
      [owner_id, name, body]
    );
  }
}

async function list_templates(owner) {
  await add_starter_templates(owner.user_id);

  const result = await db.query(
    `
      SELECT *
      FROM sms_templates
      WHERE owner_id = $1
      ORDER BY
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
        tenant_id: tenant.id,
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

/*
  Writes one personalised message per recipient, with what
  each tenant owes at this moment.
*/
async function create_messages(
  client,
  broadcast,
  recipients
) {
  const cost_per_message = get_sms_cost();

  for (const tenant of recipients) {
    const message = render_message(
      broadcast.message_template,
      tenant,
      broadcast.variables || {}
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
        broadcast.owner_id,
        tenant.property_id,
        tenant.id,
        tenant.full_name,
        tenant.unit_number,
        tenant.payment_phone,
        tenant.sms_sender_id || null,
        broadcast.template_name || null,
        message,
        sms_parts(message) * cost_per_message,
      ]
    );
  }

  await client.query(
    `
      UPDATE sms_broadcasts
      SET messages_created_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [broadcast.id]
  );
}

/*
  A broadcast sent now gets its messages straight away.

  A scheduled broadcast only stores who it is for. Its
  recipients and their balances are worked out when it is
  sent, so a tenant who pays in between is not reminded, and
  one who falls behind is.
*/
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

    send_now = !data.send_at;

    /*
      A broadcast sent now is stamped with the database's own
      clock, so it is due at once even if this server's clock
      runs ahead of the database's.
    */
    const scheduled_at = data.send_at
      ? new Date(data.send_at)
      : null;

    /*
      Also checks that the property or tenant belongs to
      this owner.
    */
    const selected = await find_recipients(
      client,
      owner.user_id,
      data
    );

    const recipients = leave_out_settled(
      selected,
      message_template,
      data.variables
    );

    if (send_now && !selected.length) {
      throw service_error(
        "No tenants match this recipient selection.",
        422
      );
    }

    if (send_now && !recipients.length) {
      throw service_error(
        selected.length === 1
          ? `${selected[0].full_name} owes nothing, so this reminder was not sent.`
          : "None of these tenants owes anything, so this reminder was not sent.",
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
          $6,$7,$8,
          COALESCE(
            $9::TIMESTAMPTZ,
            CURRENT_TIMESTAMP
          ),
          'scheduled'
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

    if (send_now) {
      await create_messages(
        client,
        broadcast,
        recipients
      );
    }

    await client.query("COMMIT");

    broadcast_id = broadcast.id;
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

/*
  Works out a scheduled broadcast's recipients at the moment
  it is sent. If nobody matches any more, or a reminder finds
  that nobody owes anything, it gets no messages and simply
  completes.
*/
async function prepare_scheduled_messages(broadcast) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    let recipients = [];

    try {
      recipients = await find_recipients(
        client,
        broadcast.owner_id,
        {
          recipient_group: broadcast.recipient_group,
          property_id: broadcast.property_id,
          tenant_id: broadcast.tenant_id,
        }
      );
    } catch (error) {
      /*
        The property or tenant it was for is no longer there.
      */
      if (!error.status_code) {
        throw error;
      }
    }

    await create_messages(
      client,
      broadcast,
      leave_out_settled(
        recipients,
        broadcast.message_template,
        broadcast.variables
      )
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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

  if (!broadcast.messages_created_at) {
    await prepare_scheduled_messages(broadcast);
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
      await assert_can_send_sms(message.owner_id);

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
        broadcast.id,
        broadcast.owner_id
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
          $2::record_id IS NULL
          OR sms_messages.property_id = $2
        )

        AND (
          $3::record_id IS NULL
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
          AND status <> 'cancelled'
          AND created_at >= (
            DATE_TRUNC(
              'month',
              CURRENT_TIMESTAMP
              AT TIME ZONE 'Africa/Nairobi'
            )
            AT TIME ZONE 'Africa/Nairobi'
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
        ) AS scheduled_count,

        (
          SELECT MIN(scheduled_at)
          FROM sms_broadcasts
          WHERE owner_id = $1
            AND status = 'scheduled'
            AND scheduled_at > CURRENT_TIMESTAMP
        ) AS next_scheduled_at
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

    next_scheduled_at: row.next_scheduled_at,

    accepted_cost: as_number(
      row.accepted_cost
    ),

    cost_per_message: get_sms_cost(),

    /*
      'console' means messages are printed in the backend
      terminal and do not reach any phone.
    */
    sms_mode: process.env.SMS_MODE || "console",
  };
}

/*
  Changes a broadcast that is still waiting for its time: the
  message, who it goes to, or when. Once the sending has
  started it can no longer be changed.
*/
async function update_broadcast(
  owner,
  broadcast_id,
  data
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const existing_result = await client.query(
      `
        SELECT *
        FROM sms_broadcasts
        WHERE id = $1
          AND owner_id = $2
        FOR UPDATE
      `,
      [broadcast_id, owner.user_id]
    );

    const existing = existing_result.rows[0];

    if (!existing) {
      throw service_error(
        "SMS broadcast not found or you do not have access to it.",
        404
      );
    }

    if (
      existing.status !== "scheduled" ||
      existing.messages_created_at ||
      new Date(existing.scheduled_at) <= new Date()
    ) {
      throw service_error(
        "This broadcast has already been sent or cancelled, so it can no longer be changed.",
        409
      );
    }

    if (!data.send_at) {
      throw service_error(
        "Choose the date and time to send it.",
        422
      );
    }

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

    /*
      Checks that the property or tenant belongs to this owner.
    */
    await find_recipients(client, owner.user_id, data);

    await client.query(
      `
        UPDATE sms_broadcasts
        SET
          template_id = $1,
          template_name = $2,
          message_template = $3,
          recipient_group = $4,
          property_id = $5,
          tenant_id = $6,
          scheduled_at = $7::TIMESTAMPTZ
        WHERE id = $8
      `,
      [
        template?.id || null,
        template?.name || null,
        message_template,
        data.recipient_group,
        data.property_id || null,
        data.tenant_id || null,
        new Date(data.send_at),
        existing.id,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const read_client = await db.get_client();

  try {
    return public_broadcast(
      await get_broadcast_with_counts(
        read_client,
        owner.user_id,
        broadcast_id
      )
    );
  } finally {
    read_client.release();
  }
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

/*
  Sends one stored message through the provider and records
  whether it was accepted.
*/
async function deliver_message(message) {
  try {
    // Nothing is sent for an account that is read-only (Kodi bill unpaid).
    await assert_can_send_sms(message.owner_id);

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
      `,
      [
        result.provider,
        JSON.stringify(result.response || {}),
        message.id,
      ]
    );

    return { status: "accepted", provider_error: null };
  } catch (error) {
    const provider_error = String(
      error.message || "SMS provider failed."
    ).slice(0, 5000);

    await db.query(
      `
        UPDATE sms_messages
        SET
          status = 'failed',
          retry_count = retry_count + 1,
          provider_error = $1
        WHERE id = $2
      `,
      [provider_error, message.id]
    );

    return { status: "failed", provider_error };
  }
}

/*
  A single message the system sends to one tenant outside a
  broadcast, such as a repair charge notice. It is kept in the
  same history, so the owner can see it and retry it.

  tenant needs id, full_name, unit_number, payment_phone and
  sms_sender_id. Returns { status, provider_error }; it never
  throws for a provider failure.
*/
async function send_single_sms({
  owner_id,
  property_id,
  tenant,
  template_name,
  message,
}) {
  const result = await db.query(
    `
      INSERT INTO sms_messages (
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
        'queued'
      )
      RETURNING *
    `,
    [
      owner_id,
      property_id,
      tenant.id,
      tenant.full_name,
      tenant.unit_number,
      tenant.payment_phone,
      tenant.sms_sender_id || null,
      template_name,
      message,
      sms_parts(message) * get_sms_cost(),
    ]
  );

  return deliver_message(result.rows[0]);
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
      RETURNING *
    `,
    [
      message_id,
      owner.user_id,
    ]
  );

  const message = result.rows[0];

  if (!message) {
    throw service_error(
      "Only a failed SMS message can be retried.",
      400
    );
  }

  /*
    A single message is sent again on its own.
  */
  if (!message.broadcast_id) {
    setImmediate(() => {
      deliver_message(message).catch((error) => {
        console.error(
          `[SMS] Retry failed for message ${message_id}:`,
          error.message
        );
      });
    });

    return;
  }

  const broadcast_id = message.broadcast_id;

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

  update_broadcast,
  cancel_broadcast,
  retry_message,

  send_single_sms,
  dispatch_due_broadcasts,

  start_sms_scheduler,
};