const db = require("../config/db");

/*
  Figures for the owner's Dashboard home, the "needs attention"
  list behind the bell, and the top-bar search.

  Money follows the same definitions as Reports and Expenses:
  rent collected is what payments settled against rent charges,
  plus deposit money used for rent at move-out. Months and days
  are in Kenyan time.
*/

const this_month_sql = `
  DATE_TRUNC(
    'month',
    CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
  )::DATE
`;

function service_error(message, status_code = 400) {
  const error = new Error(message);

  error.status_code = status_code;
  return error;
}

function as_number(value) {
  return Number(value || 0);
}

async function ensure_property(owner_id, property_id) {
  if (!property_id) {
    return;
  }

  const result = await db.query(
    `
      SELECT id
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status <> 'archived'
    `,
    [property_id, owner_id]
  );

  if (!result.rows[0]) {
    throw service_error(
      "Property not found or you do not have access to it.",
      404
    );
  }
}

/*
  Rent collected in each of the last six months, oldest first.
  The last entry is the current month.
*/
async function get_rent_by_month(values) {
  const result = await db.query(
    `
      WITH months AS (
        SELECT GENERATE_SERIES(
          ${this_month_sql} - INTERVAL '5 months',
          ${this_month_sql},
          INTERVAL '1 month'
        )::DATE AS month
      ),

      rent_money AS (
        SELECT
          DATE_TRUNC(
            'month',
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE AS month,
          payment_allocations.amount

        FROM payment_allocations

        INNER JOIN payments
          ON payments.id =
            payment_allocations.payment_id

        INNER JOIN tenant_charges
          ON tenant_charges.id =
            payment_allocations.tenant_charge_id

        WHERE payments.owner_id = $1
          AND payments.status = 'matched'
          AND tenant_charges.charge_type = 'rent'
          AND (
            $2::TEXT IS NULL
            OR payments.property_id = $2
          )

        UNION ALL

        SELECT
          DATE_TRUNC(
            'month',
            deposit_settlements.confirmed_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE,
          deposit_applications.amount

        FROM deposit_applications

        INNER JOIN deposit_settlements
          ON deposit_settlements.id =
            deposit_applications.settlement_id

        INNER JOIN tenant_charges
          ON tenant_charges.id =
            deposit_applications.tenant_charge_id

        WHERE deposit_settlements.owner_id = $1
          AND tenant_charges.charge_type = 'rent'
          AND (
            $2::TEXT IS NULL
            OR deposit_settlements.property_id = $2
          )
      )

      SELECT
        TO_CHAR(months.month, 'YYYY-MM') AS month,
        TO_CHAR(months.month, 'Mon') AS label,
        COALESCE(SUM(rent_money.amount), 0) AS amount

      FROM months

      LEFT JOIN rent_money
        ON rent_money.month = months.month

      GROUP BY months.month
      ORDER BY months.month
    `,
    values
  );

  return result.rows.map((row) => ({
    month: row.month,
    label: row.label,
    amount: as_number(row.amount),
  }));
}

async function get_home(owner, filters) {
  const owner_id = owner.user_id;
  const property_id = filters.property_id || null;

  await ensure_property(owner_id, property_id);

  const values = [owner_id, property_id];

  const rent_by_month = await get_rent_by_month(values);

  const collected = rent_by_month[5].amount;
  const collected_last_month = rent_by_month[4].amount;

  /*
    Rent that tenants living there now still owe.
  */
  const outstanding = await db.query(
    `
      SELECT
        COALESCE(
          SUM(
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          ),
          0
        ) AS amount,

        COUNT(DISTINCT tenant_charges.unit_id) AS units

      FROM tenant_charges

      INNER JOIN tenants
        ON tenants.id = tenant_charges.tenant_id

      INNER JOIN properties
        ON properties.id = tenant_charges.property_id

      WHERE tenant_charges.owner_id = $1
        AND tenant_charges.charge_type = 'rent'
        AND tenant_charges.status IN ('open', 'partial')
        AND tenants.status IN ('active', 'notice_given')
        AND properties.status <> 'archived'
        AND (
          $2::TEXT IS NULL
          OR tenant_charges.property_id = $2
        )
    `,
    values
  );

  const occupancy = await db.query(
    `
      SELECT
        COUNT(units.id) AS total_units,

        COUNT(units.id) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM tenants
            WHERE tenants.unit_id = units.id
              AND tenants.status IN (
                'active',
                'notice_given'
              )
          )
        ) AS occupied_units

      FROM units

      INNER JOIN properties
        ON properties.id = units.property_id

      WHERE properties.owner_id = $1
        AND properties.status <> 'archived'
        AND units.status <> 'inactive'
        AND (
          $2::TEXT IS NULL
          OR units.property_id = $2
        )
    `,
    values
  );

  const unmatched = await db.query(
    `
      SELECT
        id,
        amount,
        payment_method,
        payer_phone,
        reference,
        provider_transaction_id,
        unmatched_reason,
        received_at,
        COUNT(*) OVER () AS total

      FROM payments

      WHERE owner_id = $1
        AND status = 'unmatched'
        AND (
          $2::TEXT IS NULL
          OR property_id = $2
        )

      ORDER BY received_at DESC
      LIMIT 3
    `,
    values
  );

  /*
    Water bills for this month, and the metered units with a
    tenant whose reading for this month is still missing.
  */
  const water = await db.query(
    `
      SELECT
        (
          SELECT COALESCE(SUM(amount_due), 0)
          FROM tenant_charges
          WHERE owner_id = $1
            AND charge_type = 'water'
            AND status <> 'void'
            AND billing_period = ${this_month_sql}
            AND ($2::TEXT IS NULL OR property_id = $2)
        ) AS billed,

        (
          SELECT COALESCE(SUM(amount_paid), 0)
          FROM tenant_charges
          WHERE owner_id = $1
            AND charge_type = 'water'
            AND status <> 'void'
            AND billing_period = ${this_month_sql}
            AND ($2::TEXT IS NULL OR property_id = $2)
        ) AS collected,

        (
          SELECT COALESCE(SUM(units_used), 0)
          FROM water_meter_readings
          WHERE owner_id = $1
            AND status = 'submitted'
            AND billing_period = ${this_month_sql}
            AND ($2::TEXT IS NULL OR property_id = $2)
        ) AS units_used,

        (
          SELECT COUNT(*)
          FROM units
          INNER JOIN properties
            ON properties.id = units.property_id
          WHERE properties.owner_id = $1
            AND properties.status = 'active'
            AND units.status = 'occupied'
            AND units.water_billing_method =
              'per_unit_metered'
            AND ($2::TEXT IS NULL OR units.property_id = $2)
            AND NOT EXISTS (
              SELECT 1
              FROM water_meter_readings
              WHERE water_meter_readings.unit_id = units.id
                AND water_meter_readings.billing_period =
                  ${this_month_sql}
                AND water_meter_readings.status <> 'rejected'
            )
        ) AS readings_pending
    `,
    values
  );

  /*
    The latest things that happened, of four kinds.
  */
  const activity = await db.query(
    `
      SELECT *
      FROM (
        SELECT
          'payment' AS type,
          tenants.full_name AS name,
          properties.name AS property_name,
          units.unit_number,
          payments.amount,
          NULL::TEXT AS detail,
          payments.received_at AS happened_at
        FROM payments
        INNER JOIN tenants
          ON tenants.id = payments.tenant_id
        INNER JOIN properties
          ON properties.id = payments.property_id
        LEFT JOIN units
          ON units.id = payments.unit_id
        WHERE payments.owner_id = $1
          AND payments.status = 'matched'
          AND ($2::TEXT IS NULL OR payments.property_id = $2)

        UNION ALL

        SELECT
          'water_reading',
          tenants.full_name,
          properties.name,
          units.unit_number,
          NULL::NUMERIC,
          CASE
            WHEN water_meter_readings.status = 'flagged'
              THEN 'Flagged for review'
            ELSE CONCAT(
              TRIM(TO_CHAR(
                water_meter_readings.units_used,
                'FM999999990.###'
              ), '.'),
              ' units'
            )
          END,
          water_meter_readings.submitted_at
        FROM water_meter_readings
        INNER JOIN properties
          ON properties.id =
            water_meter_readings.property_id
        INNER JOIN units
          ON units.id = water_meter_readings.unit_id
        LEFT JOIN tenants
          ON tenants.id = water_meter_readings.tenant_id
        WHERE water_meter_readings.owner_id = $1
          AND water_meter_readings.status <> 'rejected'
          AND (
            $2::TEXT IS NULL
            OR water_meter_readings.property_id = $2
          )

        UNION ALL

        SELECT
          'maintenance',
          CONCAT(users.first_name, ' ', users.last_name),
          properties.name,
          units.unit_number,
          NULL::NUMERIC,
          maintenance_requests.title,
          maintenance_requests.created_at
        FROM maintenance_requests
        INNER JOIN properties
          ON properties.id =
            maintenance_requests.property_id
        INNER JOIN users
          ON users.user_id =
            maintenance_requests.reported_by
        LEFT JOIN units
          ON units.id = maintenance_requests.unit_id
        WHERE maintenance_requests.owner_id = $1
          AND (
            $2::TEXT IS NULL
            OR maintenance_requests.property_id = $2
          )

        UNION ALL

        SELECT
          'tenant_added',
          tenants.full_name,
          properties.name,
          units.unit_number,
          NULL::NUMERIC,
          NULL::TEXT,
          tenants.created_at
        FROM tenants
        INNER JOIN properties
          ON properties.id = tenants.property_id
        INNER JOIN units
          ON units.id = tenants.unit_id
        WHERE tenants.owner_id = $1
          AND ($2::TEXT IS NULL OR tenants.property_id = $2)
      ) AS events

      ORDER BY happened_at DESC
      LIMIT 8
    `,
    values
  );

  const total_units = Number(
    occupancy.rows[0].total_units
  );

  const occupied_units = Number(
    occupancy.rows[0].occupied_units
  );

  const billed = as_number(water.rows[0].billed);
  const water_collected = as_number(
    water.rows[0].collected
  );

  return {
    property_id,

    rent: {
      collected,
      collected_last_month,

      /*
        null when there was nothing last month to compare with.
      */
      change_percent:
        collected_last_month > 0
          ? Number(
              (
                ((collected - collected_last_month) /
                  collected_last_month) *
                100
              ).toFixed(1)
            )
          : null,

      outstanding: as_number(
        outstanding.rows[0].amount
      ),

      units_in_arrears: Number(
        outstanding.rows[0].units
      ),
    },

    occupancy: {
      total_units,
      occupied_units,

      occupancy_rate:
        total_units > 0
          ? Number(
              (
                (occupied_units / total_units) *
                100
              ).toFixed(1)
            )
          : 0,
    },

    unmatched_payments: {
      count: Number(unmatched.rows[0]?.total || 0),

      latest: unmatched.rows.map((row) => ({
        id: row.id,
        amount: as_number(row.amount),
        payment_method: row.payment_method,
        payer_phone: row.payer_phone,
        reference:
          row.provider_transaction_id || row.reference,
        unmatched_reason: row.unmatched_reason,
        received_at: row.received_at,
      })),
    },

    water: {
      billed,
      collected: water_collected,
      outstanding: billed - water_collected,

      units_used: as_number(water.rows[0].units_used),

      readings_pending: Number(
        water.rows[0].readings_pending
      ),
    },

    rent_by_month,

    activity: activity.rows.map((row) => ({
      type: row.type,
      name: (row.name || "").trim() || null,
      property_name: row.property_name,
      unit_number: row.unit_number,
      amount:
        row.amount === null
          ? null
          : as_number(row.amount),
      detail: row.detail,
      happened_at: row.happened_at,
    })),
  };
}

/*
  What is waiting for the owner, for the bell in the top bar.
*/
async function get_attention(owner) {
  const result = await db.query(
    `
      SELECT
        (
          SELECT COUNT(*)
          FROM payments
          WHERE owner_id = $1
            AND status = 'unmatched'
        ) AS unmatched_payments,

        (
          SELECT COUNT(*)
          FROM water_meter_readings
          WHERE owner_id = $1
            AND status = 'flagged'
        ) AS flagged_readings,

        (
          SELECT COUNT(*)
          FROM sms_messages
          WHERE owner_id = $1
            AND status = 'failed'
        ) AS failed_sms,

        (
          SELECT COUNT(*)
          FROM maintenance_requests
          WHERE owner_id = $1
            AND status IN ('reported', 'in_progress')
        ) AS open_maintenance,

        (
          SELECT COUNT(*)
          FROM maintenance_requests
          WHERE owner_id = $1
            AND owner_notice = 'done'
        ) AS repairs_done
    `,
    [owner.user_id]
  );

  const row = result.rows[0];

  const counts = {
    unmatched_payments: Number(row.unmatched_payments),
    flagged_readings: Number(row.flagged_readings),
    failed_sms: Number(row.failed_sms),
    open_maintenance: Number(row.open_maintenance),
    // Marked done by the caretaker, not yet seen by the owner.
    repairs_done: Number(row.repairs_done),
  };

  return {
    ...counts,

    total: Object.values(counts).reduce(
      (total, count) => total + count,
      0
    ),
  };
}

/*
  Tenants by name, phone, ID or house number, and payments by
  M-Pesa code or reference.
*/
async function search(owner, text) {
  const pattern = `%${text.replace(/[%_\\]/g, "\\$&")}%`;

  /*
    A phone typed as 0712... is stored as +254712..., so it is
    matched without the leading zero.
  */
  const digits = text
    .replace(/\D/g, "")
    .replace(/^0/, "");

  const phone_pattern =
    digits.length >= 3 ? `%${digits}%` : null;

  const tenants = await db.query(
    `
      SELECT
        tenants.id,
        tenants.full_name,
        tenants.payment_phone,
        tenants.status,
        properties.name AS property_name,
        units.unit_number

      FROM tenants

      INNER JOIN properties
        ON properties.id = tenants.property_id

      INNER JOIN units
        ON units.id = tenants.unit_id

      WHERE tenants.owner_id = $1
        AND properties.status <> 'archived'
        AND (
          tenants.full_name ILIKE $2
          OR units.unit_number ILIKE $2
          OR tenants.national_id ILIKE $2
          OR (
            $3::TEXT IS NOT NULL
            AND tenants.payment_phone ILIKE $3
          )
        )

      ORDER BY
        tenants.status IN (
          'active',
          'notice_given'
        ) DESC,
        tenants.full_name ASC

      LIMIT 6
    `,
    [owner.user_id, pattern, phone_pattern]
  );

  const payments = await db.query(
    `
      SELECT
        payments.id,
        payments.amount,
        payments.status,
        payments.received_at,
        payments.provider_transaction_id,
        payments.reference,
        tenants.full_name AS tenant_name

      FROM payments

      LEFT JOIN tenants
        ON tenants.id = payments.tenant_id

      WHERE payments.owner_id = $1
        AND (
          payments.provider_transaction_id ILIKE $2
          OR payments.reference ILIKE $2
        )

      ORDER BY payments.received_at DESC
      LIMIT 5
    `,
    [owner.user_id, pattern]
  );

  return {
    tenants: tenants.rows.map((row) => ({
      id: row.id,
      full_name: row.full_name,
      phone: row.payment_phone,
      status: row.status,
      property_name: row.property_name,
      unit_number: row.unit_number,
    })),

    payments: payments.rows.map((row) => ({
      id: row.id,
      amount: as_number(row.amount),
      status: row.status,
      received_at: row.received_at,
      reference:
        row.provider_transaction_id || row.reference,
      tenant_name: row.tenant_name,
    })),
  };
}

module.exports = {
  get_home,
  get_attention,
  search,
};
