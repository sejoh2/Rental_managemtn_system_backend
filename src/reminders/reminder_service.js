const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  send_single_sms,
} = require("../sms/sms_service");

const {
  effective_sender_sql,
} = require("../sms/sender_approval_service");

/*
  Automatic payment reminders, switched on per property by the
  owner. Nothing here runs for a property that has them off.

  before  sent a chosen number of days before the property's
          rent due day (0 means on the day), at a chosen hour,
          to each tenant who owes anything at that moment. The
          message carries everything they owe.
  late    sent a chosen number of days after the due day, to
          each tenant who still has an unpaid bill that is
          past its due date.

  A tenant who owes nothing is never sent one. Each reminder
  is recorded, so a tenant gets it once even if the server
  restarts.
*/
const days_before_choices = [0, 1, 2, 3, 5, 7];
const late_days_choices = [1, 2, 3, 5, 7, 14];

function service_error(message, status_code = 400) {
  const error = new Error(message);
  error.status_code = status_code;
  return error;
}

async function init_reminder_tables() {
  await db.query(`
    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN
      NOT NULL DEFAULT FALSE;

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS reminder_days_before INTEGER[]
      NOT NULL DEFAULT '{3}';

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS reminder_hour SMALLINT
      NOT NULL DEFAULT 8;

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS late_notice_enabled BOOLEAN
      NOT NULL DEFAULT FALSE;

    ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS late_notice_days_after SMALLINT
      NOT NULL DEFAULT 3;

    CREATE TABLE IF NOT EXISTS sms_auto_reminders (
      id record_id PRIMARY KEY DEFAULT new_id('sar'),

      tenant_id record_id NOT NULL
        REFERENCES tenants(id)
        ON DELETE CASCADE,

      property_id record_id NOT NULL
        REFERENCES properties(id)
        ON DELETE CASCADE,

      kind VARCHAR(20) NOT NULL
        CHECK (kind IN ('before', 'late')),

      due_date DATE NOT NULL,
      offset_days SMALLINT NOT NULL,

      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(20),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      UNIQUE (tenant_id, kind, due_date, offset_days)
    );
  `);

  console.log("[REMINDERS] Tables initialized.");
}

function public_reminders(property) {
  return {
    enabled: Boolean(property.reminders_enabled),
    days_before: (property.reminder_days_before || [3])
      .map(Number)
      .sort((a, b) => b - a),
    hour: Number(property.reminder_hour ?? 8),
    late_enabled: Boolean(property.late_notice_enabled),
    late_days_after: Number(
      property.late_notice_days_after ?? 3
    ),
  };
}

async function get_property_or_throw(owner, property_id) {
  const result = await db.query(
    `
      SELECT *
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status <> 'archived'
    `,
    [property_id, owner.user_id]
  );

  if (!result.rows[0]) {
    throw service_error("Property not found.", 404);
  }

  return result.rows[0];
}

async function get_reminder_settings(owner, property_id) {
  return public_reminders(
    await get_property_or_throw(owner, property_id)
  );
}

async function update_reminder_settings(
  owner,
  property_id,
  data,
  ip_address
) {
  const property = await get_property_or_throw(
    owner,
    property_id
  );

  const result = await db.query(
    `
      UPDATE properties
      SET
        reminders_enabled = $1,
        reminder_days_before = $2::INTEGER[],
        reminder_hour = $3,
        late_notice_enabled = $4,
        late_notice_days_after = $5
      WHERE id = $6
      RETURNING *
    `,
    [
      data.enabled,
      [...new Set(data.days_before)],
      data.hour,
      data.late_enabled,
      data.late_days_after,
      property.id,
    ]
  );

  const settings = public_reminders(result.rows[0]);

  await log_audit({
    user_id: owner.user_id,
    action: "PAYMENT_REMINDERS_UPDATED",
    entity_type: "property",
    entity_id: property.id,
    metadata: {
      property_name: property.name,
      ...settings,
    },
    ip_address,
  });

  return settings;
}

/* ---------- dates, all as calendar days in Kenya ---------- */

function to_utc(date_text) {
  const [year, month, day] = date_text.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, day));
}

function to_text(date) {
  return date.toISOString().slice(0, 10);
}

function add_days(date_text, days) {
  const date = to_utc(date_text);

  date.setUTCDate(date.getUTCDate() + days);

  return to_text(date);
}

/*
  The property's due date in the month before, the month of and
  the month after the given day. A reminder for a due date
  early in a month can fall in the month before it.
*/
function due_dates_near(today, due_day) {
  const [year, month] = today.split("-").map(Number);

  return [-1, 0, 1].map((shift) =>
    to_text(new Date(Date.UTC(year, month - 1 + shift, due_day)))
  );
}

function long_date(date_text) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(to_utc(date_text));
}

function money_text(amount) {
  return Number(amount).toLocaleString("en-KE", {
    maximumFractionDigits: 2,
  });
}

function reminder_message(kind, offset_days, tenant, due_date) {
  const name = tenant.full_name.split(" ")[0];
  const balance = money_text(tenant.balance);

  if (kind === "late") {
    return `Dear ${name}, your balance of KES ${balance} for House ${tenant.unit_number} was due on ${long_date(due_date)} and is still unpaid. Kindly settle it. ${tenant.property_name}`;
  }

  return offset_days === 0
    ? `Dear ${name}, your balance for House ${tenant.unit_number} is KES ${balance} and is due today. ${tenant.property_name}`
    : `Dear ${name}, your balance for House ${tenant.unit_number} is KES ${balance}. Kindly pay by ${long_date(due_date)}. ${tenant.property_name}`;
}

/*
  Which reminders a property owes its tenants today.
  -> [{ kind, offset_days, due_date }]
*/
function reminders_due_today(property, today) {
  const settings = public_reminders(property);
  const due = [];

  for (const due_date of due_dates_near(
    today,
    Number(property.rent_due_day)
  )) {
    if (settings.enabled) {
      for (const days of settings.days_before) {
        if (add_days(due_date, -days) === today) {
          due.push({
            kind: "before",
            offset_days: days,
            due_date,
          });
        }
      }
    }

    if (
      settings.late_enabled &&
      add_days(due_date, settings.late_days_after) === today
    ) {
      due.push({
        kind: "late",
        offset_days: settings.late_days_after,
        due_date,
      });
    }
  }

  return due;
}

/*
  Tenants of a property who should get this reminder and have
  not had it yet. For a late notice only a bill past its due
  date counts as a reason, but the message still carries
  everything the tenant owes.
*/
async function find_tenants_to_remind(property, reminder, today) {
  const result = await db.query(
    `
      SELECT
        tenants.id,
        tenants.full_name,
        tenants.payment_phone,
        units.unit_number,
        properties.name AS property_name,
        ${effective_sender_sql} AS sms_sender_id,
        owed.balance,
        owed.overdue

      FROM tenants

      INNER JOIN units
        ON units.id = tenants.unit_id

      INNER JOIN properties
        ON properties.id = tenants.property_id

      CROSS JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(amount_due - amount_paid),
            0
          ) AS balance,

          COALESCE(
            SUM(amount_due - amount_paid)
              FILTER (WHERE due_date <= $5::DATE),
            0
          ) AS overdue
        FROM tenant_charges
        WHERE tenant_charges.tenant_id = tenants.id
          AND tenant_charges.status IN ('open', 'partial')
      ) AS owed

      WHERE tenants.property_id = $1
        AND tenants.status IN ('active', 'notice_given')
        AND owed.balance > 0
        AND ($2 <> 'late' OR owed.overdue > 0)

        AND NOT EXISTS (
          SELECT 1
          FROM sms_auto_reminders
          WHERE sms_auto_reminders.tenant_id = tenants.id
            AND sms_auto_reminders.kind = $2
            AND sms_auto_reminders.due_date = $3::DATE
            AND sms_auto_reminders.offset_days = $4
        )

      ORDER BY units.unit_number
    `,
    [
      property.id,
      reminder.kind,
      reminder.due_date,
      reminder.offset_days,
      today,
    ]
  );

  return result.rows;
}

/*
  Sends every reminder that is due at this moment. Runs once
  an hour; "now" can be given for a test.
*/
async function run_payment_reminders(now = null) {
  const clock = now
    ? { rows: [now] }
    : await db.query(`
        SELECT
          TO_CHAR(
            CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi',
            'YYYY-MM-DD'
          ) AS today,
          EXTRACT(
            HOUR FROM CURRENT_TIMESTAMP
            AT TIME ZONE 'Africa/Nairobi'
          )::INTEGER AS hour
      `);

  const { today, hour } = clock.rows[0];

  /*
    From the chosen hour until the end of that day, so a
    reminder still goes out if the server was off at the hour.
  */
  const properties = await db.query(
    `
      SELECT *
      FROM properties
      WHERE status = 'active'
        AND (reminders_enabled OR late_notice_enabled)
        AND reminder_hour <= $1
      ORDER BY id
    `,
    [hour]
  );

  const summary = [];

  for (const property of properties.rows) {
    for (const reminder of reminders_due_today(property, today)) {
      const tenants = await find_tenants_to_remind(
        property,
        reminder,
        today
      );

      let sent = 0;
      let failed = 0;

      for (const tenant of tenants) {
        /*
          Recorded first, so two runs at the same moment cannot
          both send it.
        */
        const claim = await db.query(
          `
            INSERT INTO sms_auto_reminders (
              tenant_id,
              property_id,
              kind,
              due_date,
              offset_days,
              balance
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (
              tenant_id,
              kind,
              due_date,
              offset_days
            )
            DO NOTHING
            RETURNING id
          `,
          [
            tenant.id,
            property.id,
            reminder.kind,
            reminder.due_date,
            reminder.offset_days,
            tenant.balance,
          ]
        );

        if (!claim.rows[0]) {
          continue;
        }

        const sms = await send_single_sms({
          owner_id: property.owner_id,
          property_id: property.id,
          tenant,
          template_name:
            reminder.kind === "late"
              ? "Late payment notice (automatic)"
              : "Payment reminder (automatic)",
          message: reminder_message(
            reminder.kind,
            reminder.offset_days,
            tenant,
            reminder.due_date
          ),
        });

        await db.query(
          `
            UPDATE sms_auto_reminders
            SET status = $1
            WHERE id = $2
          `,
          [sms.status, claim.rows[0].id]
        );

        if (sms.status === "accepted") {
          sent += 1;
        } else {
          failed += 1;
        }
      }

      if (sent + failed > 0) {
        await log_audit({
          owner_id: property.owner_id,
          action:
            reminder.kind === "late"
              ? "AUTO_LATE_NOTICES_SENT"
              : "AUTO_PAYMENT_REMINDERS_SENT",
          entity_type: "property",
          entity_id: property.id,
          metadata: {
            property_name: property.name,
            due_date: reminder.due_date,
            days:
              reminder.kind === "late"
                ? `${reminder.offset_days} after`
                : `${reminder.offset_days} before`,
            sent,
            failed,
          },
        });

        summary.push({
          property_id: property.id,
          ...reminder,
          sent,
          failed,
        });
      }
    }
  }

  return summary;
}

let scheduler_started = false;

/*
  Checks once an hour, and once at startup.
*/
function start_payment_reminder_scheduler() {
  if (scheduler_started) {
    return;
  }

  scheduler_started = true;

  const run = () => {
    run_payment_reminders().catch((error) => {
      console.error(
        "[REMINDERS] Payment reminders failed:",
        error.message
      );
    });
  };

  run();

  setInterval(run, 60 * 60 * 1000).unref();

  console.log("[REMINDERS] Payment reminder scheduler started.");
}

module.exports = {
  days_before_choices,
  late_days_choices,
  init_reminder_tables,
  get_reminder_settings,
  update_reminder_settings,
  reminders_due_today,
  run_payment_reminders,
  start_payment_reminder_scheduler,
};
