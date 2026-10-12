const db = require("../config/db");

const {
  send_single_sms,
} = require("../sms/sms_service");

/*
  The two water notifications an owner can switch on in
  Settings > Notifications:

  alert_suspicious_water  the owner gets an SMS when a meter
                          reading is flagged (lower than the
                          previous one).
  remind_water_readings   on the property's water billing day,
                          its caretaker gets an SMS if readings
                          for the month are still missing.

  Both go through the SMS centre history. Neither may ever stop
  the action that triggered it, so failures are only logged.
*/

/*
  Called after a flagged reading is saved.
*/
async function alert_flagged_reading({
  owner_id,
  property,
  unit_number,
  previous_reading,
  current_reading,
}) {
  try {
    const result = await db.query(
      `
        SELECT
          users.first_name,
          users.last_name,
          users.phone,

          COALESCE(
            owner_settings.alert_suspicious_water,
            FALSE
          ) AS enabled

        FROM users

        LEFT JOIN owner_settings
          ON owner_settings.owner_id = users.user_id

        WHERE users.user_id = $1
      `,
      [owner_id]
    );

    const owner = result.rows[0];

    if (!owner?.enabled || !owner.phone) {
      return;
    }

    await send_single_sms({
      owner_id,
      property_id: property.id,
      tenant: {
        id: null,
        full_name:
          [owner.first_name, owner.last_name]
            .filter(Boolean)
            .join(" ") || "Owner",
        unit_number,
        payment_phone: owner.phone,
        sms_sender_id: property.sms_sender_id,
      },
      template_name: "Flagged reading alert",
      message: `Kodi: the water reading for House ${unit_number} at ${property.name} was flagged. It is ${current_reading}, lower than the previous reading of ${previous_reading}. Please review it under Water billing.`,
    });
  } catch (error) {
    console.error(
      "[WATER] Flagged reading alert failed:",
      error.message
    );
  }
}

/*
  The day of the month a property's water is billed, following
  its water_billing_day rule.
*/
function water_billing_day(property, days_in_month) {
  if (property.water_billing_day === "same_as_rent") {
    return Number(property.rent_due_day) || 1;
  }

  if (
    property.water_billing_day === "last_day_of_month"
  ) {
    return days_in_month;
  }

  const match = String(
    property.water_billing_day || ""
  ).match(/\d{1,2}/);

  return Math.min(
    Math.max(match ? Number(match[0]) : 1, 1),
    days_in_month
  );
}

/*
  Sends each caretaker one reminder per property per month, on
  the property's water billing day, when readings are missing.
  Nothing is sent before 8 AM Kenyan time.
*/
async function send_reading_reminders() {
  const clock = await db.query(
    `
      SELECT
        EXTRACT(HOUR FROM local_now)::INTEGER AS hour,
        EXTRACT(DAY FROM local_now)::INTEGER AS day,

        EXTRACT(
          DAY FROM (
            DATE_TRUNC('month', local_now) +
            INTERVAL '1 month - 1 day'
          )
        )::INTEGER AS days_in_month,

        TO_CHAR(
          DATE_TRUNC('month', local_now),
          'YYYY-MM-DD'
        ) AS period,

        TO_CHAR(local_now, 'FMMonth YYYY') AS month_name

      FROM (
        SELECT
          CURRENT_TIMESTAMP
          AT TIME ZONE 'Africa/Nairobi' AS local_now
      ) AS now
    `
  );

  const now = clock.rows[0];

  if (now.hour < 8) {
    return 0;
  }

  const result = await db.query(
    `
      SELECT
        properties.id,
        properties.owner_id,
        properties.name,
        properties.rent_due_day,
        properties.water_billing_day,
        properties.sms_sender_id,

        caretakers.user_id AS caretaker_id,
        caretakers.first_name,
        caretakers.last_name,
        caretakers.phone,

        (
          SELECT COUNT(*)
          FROM units
          WHERE units.property_id = properties.id
            AND units.status = 'occupied'
            AND units.water_billing_method =
              'per_unit_metered'
            AND NOT EXISTS (
              SELECT 1
              FROM water_meter_readings
              WHERE water_meter_readings.unit_id = units.id
                AND water_meter_readings.billing_period =
                  $1::DATE
                AND water_meter_readings.status <> 'rejected'
            )
        ) AS pending

      FROM properties

      INNER JOIN property_caretaker_assignments
        ON property_caretaker_assignments.property_id =
          properties.id
        AND property_caretaker_assignments.status = 'active'

      INNER JOIN users AS caretakers
        ON caretakers.user_id =
          property_caretaker_assignments.caretaker_id
        AND caretakers.status = 'active'

      LEFT JOIN owner_settings
        ON owner_settings.owner_id = properties.owner_id

      WHERE properties.status = 'active'

        AND COALESCE(
          owner_settings.remind_water_readings,
          TRUE
        )

        AND NOT EXISTS (
          SELECT 1
          FROM water_reading_reminders
          WHERE water_reading_reminders.property_id =
            properties.id
            AND water_reading_reminders.billing_period =
              $1::DATE
        )
    `,
    [now.period]
  );

  let sent = 0;

  for (const property of result.rows) {
    const pending = Number(property.pending);

    if (
      pending === 0 ||
      water_billing_day(property, now.days_in_month) !==
        now.day
    ) {
      continue;
    }

    /*
      Recorded first, so a caretaker is never reminded twice
      for the same month even if two runs overlap.
    */
    const claimed = await db.query(
      `
        INSERT INTO water_reading_reminders (
          property_id,
          billing_period,
          caretaker_id,
          pending_units
        )
        VALUES ($1, $2::DATE, $3, $4)
        ON CONFLICT (property_id, billing_period)
        DO NOTHING
        RETURNING property_id
      `,
      [
        property.id,
        now.period,
        property.caretaker_id,
        pending,
      ]
    );

    if (!claimed.rows[0]) {
      continue;
    }

    await send_single_sms({
      owner_id: property.owner_id,
      property_id: property.id,
      tenant: {
        id: null,
        full_name:
          [property.first_name, property.last_name]
            .filter(Boolean)
            .join(" ") || "Caretaker",
        unit_number: null,
        payment_phone: property.phone,
        sms_sender_id: property.sms_sender_id,
      },
      template_name: "Water reading reminder",
      message: `Kodi: ${pending} water meter ${
        pending === 1 ? "reading is" : "readings are"
      } still missing at ${property.name} for ${
        now.month_name
      }. Please submit ${
        pending === 1 ? "it" : "them"
      } today.`,
    });

    sent += 1;
  }

  return sent;
}

let scheduler_started = false;

/*
  Checks once an hour, so a reminder goes out on the billing
  day even if the server was off at 8 AM.
*/
function start_water_reminder_scheduler() {
  if (scheduler_started) {
    return;
  }

  scheduler_started = true;

  const run = () => {
    send_reading_reminders().catch((error) => {
      console.error(
        "[WATER] Reading reminders failed:",
        error.message
      );
    });
  };

  run();

  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = {
  alert_flagged_reading,
  send_reading_reminders,
  start_water_reminder_scheduler,
};
