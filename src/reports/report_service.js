const db = require("../config/db");

const {
  get_caretaker_property_access,
} = require(
  "../caretakers/caretaker_access_service"
);

function service_error(message, status_code = 400) {
  const error = new Error(message);

  error.status_code = status_code;

  return error;
}

function as_number(value) {
  return Number(value || 0);
}

function date_only(value) {
  if (!value) {
    return null;
  }

  return new Date(value)
    .toISOString()
    .slice(0, 10);
}

/*
  Today's date in Kenya, as 'YYYY-MM-DD'.
*/
function nairobi_today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
  }).format(new Date());
}


/*
  All report periods are inclusive:
  start_date <= data date <= end_date
*/
function resolve_period(period) {
  const today = nairobi_today();

  const [year, month] = today
    .split("-")
    .map(Number);

  /*
    First and last day of the month that is 'offset' months
    from this one.
  */
  const month_start = (offset) =>
    date_only(
      new Date(Date.UTC(year, month - 1 + offset, 1))
    );

  const month_end = (offset) =>
    date_only(
      new Date(Date.UTC(year, month + offset, 0))
    );

  const ranges = {
    this_month: [month_start(0), today],
    last_month: [month_start(-1), month_end(-1)],
    last_3_months: [month_start(-2), today],
    last_6_months: [month_start(-5), today],
    this_year: [
      date_only(new Date(Date.UTC(year, 0, 1))),
      today,
    ],
  };

  const [start_date, end_date] = ranges[period];

  return {
    key: period,
    start_date,
    end_date,
  };
}

function report_scope(user) {
  return {
    owner_id:
      user.role === "caretaker"
        ? Number(user.owner_id)
        : Number(user.user_id),

    is_caretaker: user.role === "caretaker",
  };
}

/*
  Owners may report on all their properties or one selected property.

  Caretakers may view reports only for their assigned property.
  They must include property_id in every reports request.
*/
async function ensure_report_access(
  client,
  user,
  property_id
) {
  const scope = report_scope(user);

  if (!scope.is_caretaker) {
    if (!property_id) {
      return scope;
    }

    const property = await client.query(
      `
        SELECT id
        FROM properties
        WHERE id = $1
          AND owner_id = $2
        LIMIT 1
      `,
      [
        property_id,
        scope.owner_id,
      ]
    );

    if (!property.rows[0]) {
      throw service_error(
        "Property not found or you do not have access to it.",
        404
      );
    }

    return {
      ...scope,
      property_id,
    };
  }

  if (!property_id) {
    throw service_error(
      "Caretakers must select their assigned property when viewing reports.",
      422
    );
  }

  await get_caretaker_property_access(
    client,
    user,
    property_id,
    "level_1"
  );

  return {
    ...scope,
    property_id,
  };
}

async function get_occupancy_summary(
  client,
  owner_id,
  property_id
) {
  const result = await client.query(
    `
      SELECT
        COUNT(units.id)
          FILTER (
            WHERE units.status <> 'inactive'
          ) AS total_units,

        COUNT(units.id)
          FILTER (
            WHERE units.status <> 'inactive'
              AND EXISTS (
                SELECT 1
                FROM tenants
                WHERE tenants.unit_id = units.id
                  AND tenants.status IN (
                    'active',
                    'notice_given'
                  )
              )
          ) AS occupied_units,

        COUNT(units.id)
          FILTER (
            WHERE units.status = 'vacant'
          ) AS vacant_units

      FROM units

      INNER JOIN properties
        ON properties.id = units.property_id

      WHERE properties.owner_id = $1
        AND properties.status <> 'archived'
        AND (
          $2::BIGINT IS NULL
          OR units.property_id = $2
        )
    `,
    [
      owner_id,
      property_id || null,
    ]
  );

  const row = result.rows[0];

  const total_units = Number(row.total_units);
  const occupied_units = Number(row.occupied_units);

  return {
    total_units,
    occupied_units,
    vacant_units: Number(row.vacant_units),

    occupancy_rate:
      total_units > 0
        ? Number(
          (
            (occupied_units / total_units) * 100
          ).toFixed(1)
        )
        : 0,
  };
}

/*
  Current arrears are not restricted to the selected period.
  An unpaid older bill is still an arrear today.
*/
async function get_arrears_by_property(
  client,
  owner_id,
  property_id
) {
  const result = await client.query(
    `
      SELECT
        properties.id AS property_id,
        properties.name AS property_name,

        COALESCE(
          SUM(
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          ) FILTER (
            WHERE tenants.status IN (
              'active',
              'notice_given'
            )
          ),
          0
        ) AS arrears_amount,

        COUNT(DISTINCT tenant_charges.tenant_id)
          FILTER (
            WHERE tenants.status IN (
              'active',
              'notice_given'
            )
          ) AS tenants_in_arrears,

        COALESCE(
          SUM(
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          ) FILTER (
            WHERE tenants.status NOT IN (
              'active',
              'notice_given'
            )
          ),
          0
        ) AS former_tenant_arrears,

        COUNT(DISTINCT tenant_charges.tenant_id)
          FILTER (
            WHERE tenants.status NOT IN (
              'active',
              'notice_given'
            )
          ) AS former_tenants_in_arrears

      FROM properties

      LEFT JOIN tenant_charges
        ON tenant_charges.property_id = properties.id
        AND tenant_charges.status IN (
          'open',
          'partial'
        )

      LEFT JOIN tenants
        ON tenants.id = tenant_charges.tenant_id

      WHERE properties.owner_id = $1
        AND properties.status <> 'archived'
        AND (
          $2::BIGINT IS NULL
          OR properties.id = $2
        )

      GROUP BY
        properties.id,
        properties.name

      ORDER BY
        arrears_amount DESC,
        properties.name ASC
    `,
    [
      owner_id,
      property_id || null,
    ]
  );

  return result.rows.map((row) => ({
    property_id: Number(row.property_id),
    property_name: row.property_name,

    /*
      Owed by tenants living there now.
    */
    arrears_amount: as_number(
      row.arrears_amount
    ),

    tenants_in_arrears: Number(
      row.tenants_in_arrears
    ),

    /*
      Still owed by tenants who have moved out.
    */
    former_tenant_arrears: as_number(
      row.former_tenant_arrears
    ),

    former_tenants_in_arrears: Number(
      row.former_tenants_in_arrears
    ),
  }));
}

/*
  Income is what payments actually settled, taken from their
  allocations: rent, water, electricity, service charges,
  repairs and move-out deductions. This is the same definition
  the Expenses page uses.

  Deposits are held for the tenant, so they are not income when
  they are paid. Deposit and credit money used for a tenant's
  bills at move-out becomes income on that day.
*/
async function get_collection_summary(
  client,
  owner_id,
  property_id,
  period
) {
  const result = await client.query(
    `
      WITH allocations AS (
        SELECT
          tenant_charges.charge_type,
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

          AND (
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE >= $2

          AND (
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE <= $3

          AND (
            $4::BIGINT IS NULL
            OR payments.property_id = $4
          )

        UNION ALL

        SELECT
          tenant_charges.charge_type,
          deposit_applications.amount

        FROM deposit_applications

        INNER JOIN deposit_settlements
          ON deposit_settlements.id =
            deposit_applications.settlement_id

        INNER JOIN tenant_charges
          ON tenant_charges.id =
            deposit_applications.tenant_charge_id

        WHERE deposit_settlements.owner_id = $1

          AND (
            deposit_settlements.confirmed_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE >= $2

          AND (
            deposit_settlements.confirmed_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE <= $3

          AND (
            $4::BIGINT IS NULL
            OR deposit_settlements.property_id = $4
          )
      )

      SELECT
        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'rent'
        ), 0) AS rent_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'water'
        ), 0) AS water_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'electricity'
        ), 0) AS electricity_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'service'
        ), 0) AS service_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type IN ('repair', 'deduction')
        ), 0) AS repairs_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'rent_deposit'
        ), 0) AS rent_deposits_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'water_deposit'
        ), 0) AS water_deposits_collected,

        COALESCE(SUM(amount) FILTER (
          WHERE charge_type = 'electricity_deposit'
        ), 0) AS electricity_deposits_collected
      FROM allocations
    `,
    [
      owner_id,
      period.start_date,
      period.end_date,
      property_id || null,
    ]
  );

  const row = result.rows[0];

  const collection = {
    rent_collected: as_number(row.rent_collected),
    water_collected: as_number(row.water_collected),

    electricity_collected: as_number(
      row.electricity_collected
    ),

    service_collected: as_number(
      row.service_collected
    ),

    /*
      Repairs charged to tenants and move-out deductions.
    */
    repairs_collected: as_number(
      row.repairs_collected
    ),

    rent_deposits_collected: as_number(
      row.rent_deposits_collected
    ),

    water_deposits_collected: as_number(
      row.water_deposits_collected
    ),

    electricity_deposits_collected: as_number(
      row.electricity_deposits_collected
    ),
  };

  return {
    ...collection,

    deposits_collected:
      collection.rent_deposits_collected +
      collection.water_deposits_collected +
      collection.electricity_deposits_collected,

    total_income:
      collection.rent_collected +
      collection.water_collected +
      collection.electricity_collected +
      collection.service_collected +
      collection.repairs_collected,
  };
}

async function get_water_summary(
  client,
  owner_id,
  property_id,
  period
) {
  const result = await client.query(
    `
      SELECT
        COALESCE(
          SUM(tenant_charges.amount_due),
          0
        ) AS water_billed,

        COALESCE(
          SUM(tenant_charges.amount_paid),
          0
        ) AS water_paid,

        COALESCE(
          SUM(
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          ),
          0
        ) AS water_outstanding,

        COUNT(*)
          FILTER (
            WHERE tenant_charges.status IN (
              'open',
              'partial'
            )
          ) AS open_water_bills,

        (
          SELECT COUNT(*)
          FROM water_meter_readings
          WHERE water_meter_readings.owner_id = $1

            AND water_meter_readings.billing_period >= $2
            AND water_meter_readings.billing_period <= $3

            AND (
              $4::BIGINT IS NULL
              OR water_meter_readings.property_id = $4
            )
        ) AS meter_readings_submitted,

        (
          SELECT COUNT(*)
          FROM water_meter_readings
          WHERE water_meter_readings.owner_id = $1

            AND water_meter_readings.billing_period >= $2
            AND water_meter_readings.billing_period <= $3

            AND water_meter_readings.status = 'flagged'

            AND (
              $4::BIGINT IS NULL
              OR water_meter_readings.property_id = $4
            )
        ) AS flagged_readings

      FROM tenant_charges

      WHERE tenant_charges.owner_id = $1
        AND tenant_charges.charge_type = 'water'
        AND tenant_charges.status <> 'void'

        AND tenant_charges.billing_period >= $2
        AND tenant_charges.billing_period <= $3

        AND (
          $4::BIGINT IS NULL
          OR tenant_charges.property_id = $4
        )
    `,
    [
      owner_id,
      period.start_date,
      period.end_date,
      property_id || null,
    ]
  );

  const row = result.rows[0];

  return {
    water_billed: as_number(row.water_billed),

    water_paid: as_number(row.water_paid),

    water_outstanding: as_number(
      row.water_outstanding
    ),

    open_water_bills: Number(
      row.open_water_bills
    ),

    meter_readings_submitted: Number(
      row.meter_readings_submitted
    ),

    flagged_readings: Number(
      row.flagged_readings
    ),
  };
}

async function get_expense_summary(
  client,
  owner_id,
  property_id,
  period
) {
  const result = await client.query(
    `
      SELECT
        COALESCE(SUM(expenses.amount), 0)
          AS total_expenses,

        COUNT(expenses.id)
          AS expense_count

      FROM expenses

      WHERE expenses.owner_id = $1
        AND expenses.status = 'recorded'

        AND expenses.expense_date >= $2
        AND expenses.expense_date <= $3

        AND (
          $4::BIGINT IS NULL
          OR expenses.property_id = $4
        )
    `,
    [
      owner_id,
      period.start_date,
      period.end_date,
      property_id || null,
    ]
  );

  return {
    total_expenses: as_number(
      result.rows[0].total_expenses
    ),

    expense_count: Number(
      result.rows[0].expense_count
    ),
  };
}

/*
  SMS Centre must be initialized before Reports.
  It reads the real individual SMS records, not an estimate.
*/
async function get_sms_usage(
  client,
  owner_id,
  property_id,
  period
) {
  const result = await client.query(
    `
      SELECT
        COUNT(*) AS total_messages,

        COUNT(*)
          FILTER (
            WHERE sms_messages.status = 'accepted'
          ) AS accepted_messages,

        COUNT(*)
          FILTER (
            WHERE sms_messages.status = 'failed'
          ) AS failed_messages,

        COUNT(*)
          FILTER (
            WHERE sms_messages.status = 'queued'
          ) AS queued_messages,

        COALESCE(
          SUM(sms_messages.estimated_cost)
            FILTER (
              WHERE sms_messages.status = 'accepted'
            ),
          0
        ) AS sms_cost

      FROM sms_messages

      WHERE sms_messages.owner_id = $1
        AND sms_messages.status <> 'cancelled'

        AND (
          sms_messages.created_at
          AT TIME ZONE 'Africa/Nairobi'
        )::DATE >= $2

        AND (
          sms_messages.created_at
          AT TIME ZONE 'Africa/Nairobi'
        )::DATE <= $3

        AND (
          $4::BIGINT IS NULL
          OR sms_messages.property_id = $4
        )
    `,
    [
      owner_id,
      period.start_date,
      period.end_date,
      property_id || null,
    ]
  );

  const row = result.rows[0];

  const total_messages = Number(
    row.total_messages
  );

  const accepted_messages = Number(
    row.accepted_messages
  );

  return {
    total_messages,
    accepted_messages,

    failed_messages: Number(
      row.failed_messages
    ),

    queued_messages: Number(
      row.queued_messages
    ),

    delivery_rate:
      total_messages > 0
        ? Number(
          (
            (accepted_messages / total_messages) *
            100
          ).toFixed(1)
        )
        : 0,

    sms_cost: as_number(row.sms_cost),
  };
}

/*
  The per-tenant lines an exported report lists under its
  totals. Only loaded for exports.
*/
async function get_report_details(
  client,
  owner_id,
  property_id,
  period
) {
  const values = [
    owner_id,
    period.start_date,
    period.end_date,
    property_id || null,
  ];

  const rent = await client.query(
    `
      SELECT
        properties.name AS property_name,
        units.unit_number,
        tenants.full_name,

        tenants.status IN (
          'active',
          'notice_given'
        ) AS is_current,

        SUM(tenant_charges.amount_due) AS billed,
        SUM(tenant_charges.amount_paid) AS paid

      FROM tenant_charges

      INNER JOIN tenants
        ON tenants.id = tenant_charges.tenant_id

      INNER JOIN units
        ON units.id = tenant_charges.unit_id

      INNER JOIN properties
        ON properties.id = tenant_charges.property_id

      WHERE tenant_charges.owner_id = $1
        AND tenant_charges.charge_type = 'rent'
        AND tenant_charges.status <> 'void'
        AND tenant_charges.billing_period >= $2
        AND tenant_charges.billing_period <= $3
        AND properties.status <> 'archived'
        AND (
          $4::BIGINT IS NULL
          OR tenant_charges.property_id = $4
        )

      GROUP BY
        properties.name,
        units.unit_number,
        tenants.id,
        tenants.full_name,
        tenants.status

      ORDER BY
        properties.name,
        units.unit_number,
        tenants.full_name
    `,
    values
  );

  const water = await client.query(
    `
      SELECT
        properties.name AS property_name,
        units.unit_number,
        tenants.full_name,

        TO_CHAR(
          tenant_charges.billing_period,
          'Mon YYYY'
        ) AS month,

        tenant_charges.amount_due AS billed,
        tenant_charges.amount_paid AS paid

      FROM tenant_charges

      INNER JOIN tenants
        ON tenants.id = tenant_charges.tenant_id

      INNER JOIN units
        ON units.id = tenant_charges.unit_id

      INNER JOIN properties
        ON properties.id = tenant_charges.property_id

      WHERE tenant_charges.owner_id = $1
        AND tenant_charges.charge_type = 'water'
        AND tenant_charges.status <> 'void'
        AND tenant_charges.billing_period >= $2
        AND tenant_charges.billing_period <= $3
        AND properties.status <> 'archived'
        AND (
          $4::BIGINT IS NULL
          OR tenant_charges.property_id = $4
        )

      ORDER BY
        properties.name,
        units.unit_number,
        tenant_charges.billing_period
    `,
    values
  );

  /*
    Like the arrears totals, this is what is owed today,
    whatever period was chosen.
  */
  const arrears = await client.query(
    `
      SELECT
        properties.name AS property_name,
        units.unit_number,
        tenants.full_name,

        tenants.status IN (
          'active',
          'notice_given'
        ) AS is_current,

        SUM(
          tenant_charges.amount_due -
          tenant_charges.amount_paid
        ) AS balance,

        TO_CHAR(
          MIN(tenant_charges.due_date),
          'YYYY-MM-DD'
        ) AS oldest_due_date

      FROM tenant_charges

      INNER JOIN tenants
        ON tenants.id = tenant_charges.tenant_id

      INNER JOIN units
        ON units.id = tenant_charges.unit_id

      INNER JOIN properties
        ON properties.id = tenant_charges.property_id

      WHERE tenant_charges.owner_id = $1
        AND tenant_charges.status IN (
          'open',
          'partial'
        )
        AND properties.status <> 'archived'
        AND (
          $2::BIGINT IS NULL
          OR tenant_charges.property_id = $2
        )

      GROUP BY
        properties.name,
        units.unit_number,
        tenants.id,
        tenants.full_name,
        tenants.status

      ORDER BY
        is_current DESC,
        balance DESC
    `,
    [owner_id, property_id || null]
  );

  const amounts = (row) => ({
    ...row,
    billed: as_number(row.billed),
    paid: as_number(row.paid),
  });

  return {
    rent: rent.rows.map(amounts),
    water: water.rows.map(amounts),

    arrears: arrears.rows.map((row) => ({
      ...row,
      balance: as_number(row.balance),
    })),
  };
}

/*
  options.details adds the per-tenant lines used by exports.
*/
async function get_dashboard_report(
  user,
  filters,
  options = {}
) {
  const client = await db.get_client();

  try {
    const access = await ensure_report_access(
      client,
      user,
      filters.property_id
    );

    const period = resolve_period(filters.period);

    let property_name = null;

    if (access.property_id) {
      const property = await client.query(
        `
          SELECT name
          FROM properties
          WHERE id = $1
        `,
        [access.property_id]
      );

      property_name = property.rows[0]?.name || null;
    }

    /*
      One after the other: they share this one connection.
    */
    const occupancy = await get_occupancy_summary(
      client,
      access.owner_id,
      access.property_id
    );

    const arrears_by_property =
      await get_arrears_by_property(
        client,
        access.owner_id,
        access.property_id
      );

    const collection = await get_collection_summary(
      client,
      access.owner_id,
      access.property_id,
      period
    );

    const water = await get_water_summary(
      client,
      access.owner_id,
      access.property_id,
      period
    );

    const expenses = await get_expense_summary(
      client,
      access.owner_id,
      access.property_id,
      period
    );

    const sms = await get_sms_usage(
      client,
      access.owner_id,
      access.property_id,
      period
    );

    const details = options.details
      ? await get_report_details(
          client,
          access.owner_id,
          access.property_id,
          period
        )
      : undefined;

    const sum = (field) =>
      arrears_by_property.reduce(
        (total, item) => total + item[field],
        0
      );

    return {
      property_id:
        access.property_id || null,

      property_name,

      period,

      occupancy,

      arrears: {
        /*
          Owed by tenants living there now, and separately
          what tenants who moved out still owe.
        */
        total_arrears: sum("arrears_amount"),
        total_former_arrears: sum(
          "former_tenant_arrears"
        ),
        by_property: arrears_by_property,
      },

      collection,

      water,

      expenses: {
        ...expenses,

        /*
          Deposits are excluded from operational profit.
        */
        net_operating_income:
          collection.total_income -
          expenses.total_expenses,
      },

      sms,

      details,
    };
  } finally {
    client.release();
  }
}

async function get_tenant_statement(
  user,
  tenant_id,
  filters
) {
  const client = await db.get_client();

  try {
    const scope = report_scope(user);

    const tenant_result = await client.query(
      `
        SELECT
          tenants.*,

          properties.name AS property_name,

          units.unit_number

        FROM tenants

        INNER JOIN properties
          ON properties.id = tenants.property_id

        INNER JOIN units
          ON units.id = tenants.unit_id

        WHERE tenants.id = $1
          AND tenants.owner_id = $2

        LIMIT 1
      `,
      [
        tenant_id,
        scope.owner_id,
      ]
    );

    const tenant = tenant_result.rows[0];

    if (!tenant) {
      throw service_error(
        "Tenant not found or you do not have access to them.",
        404
      );
    }

    if (scope.is_caretaker) {
      await get_caretaker_property_access(
        client,
        user,
        tenant.property_id,
        "level_1"
      );
    }

    const period = resolve_period(filters.period);

    /*
      Include charges created in the selected period, plus every
      outstanding charge even if it began in an earlier period.
      This prevents old unpaid deposits/rent disappearing from a statement.
    */
    const charges_result = await client.query(
      `
        SELECT
          tenant_charges.*,

          TO_CHAR(
            tenant_charges.billing_period,
            'YYYY-MM-DD'
          ) AS billing_period_text,

          TO_CHAR(
            tenant_charges.due_date,
            'YYYY-MM-DD'
          ) AS due_date_text,

          (
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          ) AS balance

        FROM tenant_charges

        WHERE tenant_charges.tenant_id = $1

          AND (
            (
              (
                tenant_charges.created_at
                AT TIME ZONE 'Africa/Nairobi'
              )::DATE >= $2
              AND (
                tenant_charges.created_at
                AT TIME ZONE 'Africa/Nairobi'
              )::DATE <= $3
            )

            OR tenant_charges.status IN (
              'open',
              'partial'
            )
          )

        ORDER BY
          tenant_charges.due_date ASC,
          tenant_charges.id ASC
      `,
      [
        tenant_id,
        period.start_date,
        period.end_date,
      ]
    );

    const payments_result = await client.query(
      `
        SELECT
          payments.*,

          TO_CHAR(
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi',
            'YYYY-MM-DD'
          ) AS received_on,

          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'charge_type',
                tenant_charges.charge_type,

                'description',
                tenant_charges.description,

                'billing_period',
                tenant_charges.billing_period,

                'amount',
                payment_allocations.amount
              )
              ORDER BY payment_allocations.id
            ) FILTER (
              WHERE payment_allocations.id IS NOT NULL
            ),
            '[]'::JSON
          ) AS applied_to

        FROM payments

        LEFT JOIN payment_allocations
          ON payment_allocations.payment_id =
            payments.id

        LEFT JOIN tenant_charges
          ON tenant_charges.id =
            payment_allocations.tenant_charge_id

        WHERE payments.tenant_id = $1
          AND payments.status = 'matched'

          AND (
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE >= $2

          AND (
            payments.received_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE <= $3

        GROUP BY payments.id

        ORDER BY
          payments.received_at ASC,
          payments.id ASC
      `,
      [
        tenant_id,
        period.start_date,
        period.end_date,
      ]
    );

    const balances_result = await client.query(
      `
        SELECT
          COALESCE(
            SUM(
              tenant_charges.amount_due -
              tenant_charges.amount_paid
            ),
            0
          ) AS outstanding_balance,

          COALESCE(
            (
              SELECT SUM(tenant_credits.remaining_amount)
              FROM tenant_credits
              WHERE tenant_credits.tenant_id = $1
                AND tenant_credits.remaining_amount > 0
            ),
            0
          ) AS credit_balance

        FROM tenant_charges

        WHERE tenant_charges.tenant_id = $1
          AND tenant_charges.status IN (
            'open',
            'partial'
          )
      `,
      [tenant_id]
    );

    const balance = balances_result.rows[0];

    /*
      Present once the tenant has moved out and their deposits
      were reconciled.
    */
    const settlement_result = await client.query(
      `
        SELECT
          deposit_settlements.*,

          TO_CHAR(
            confirmed_at AT TIME ZONE 'Africa/Nairobi',
            'YYYY-MM-DD'
          ) AS confirmed_on,

          TO_CHAR(
            refund_paid_on,
            'YYYY-MM-DD'
          ) AS refund_paid_on_text

        FROM deposit_settlements
        WHERE tenant_id = $1
      `,
      [tenant_id]
    );

    const settlement = settlement_result.rows[0];

    return {
      tenant: {
        id: Number(tenant.id),

        owner_id: Number(tenant.owner_id),

        property_id: Number(tenant.property_id),
        property_name: tenant.property_name,

        unit_id: Number(tenant.unit_id),
        unit_number: tenant.unit_number,

        full_name: tenant.full_name,
        payment_phone: tenant.payment_phone,

        email: tenant.email,

        move_in_date: tenant.move_in_date,
        status: tenant.status,
      },

      period,

      charges: charges_result.rows.map((charge) => ({
        id: Number(charge.id),

        charge_type: charge.charge_type,
        description: charge.description,
        billing_period: charge.billing_period,
        due_date: charge.due_date,

        /*
          The same two dates as plain 'YYYY-MM-DD' text.
        */
        billing_period_text: charge.billing_period_text,
        due_date_text: charge.due_date_text,

        amount_due: as_number(
          charge.amount_due
        ),

        amount_paid: as_number(
          charge.amount_paid
        ),

        balance: as_number(charge.balance),
        status: charge.status,

        created_at: charge.created_at,
      })),

      payments: payments_result.rows.map((payment) => ({
        id: Number(payment.id),

        amount: as_number(payment.amount),

        payment_method: payment.payment_method,
        payment_source: payment.payment_source,

        provider_transaction_id:
          payment.provider_transaction_id,

        reference: payment.reference,

        received_at: payment.received_at,

        /*
          The Kenyan day it was received, as 'YYYY-MM-DD'.
        */
        received_on: payment.received_on,

        applied_to: payment.applied_to || [],
      })),

      outstanding_balance: as_number(
        balance.outstanding_balance
      ),

      credit_balance: as_number(
        balance.credit_balance
      ),

      deposit_settlement: settlement
        ? {
            deposits_held: as_number(
              settlement.deposits_held
            ),
            credit_held: as_number(
              settlement.credit_held
            ),
            deductions_total: as_number(
              settlement.deductions_total
            ),
            applied_to_bills: as_number(
              settlement.applied_to_bills
            ),
            refund_due: as_number(
              settlement.refund_due
            ),
            tenant_owes: as_number(
              settlement.tenant_owes
            ),
            confirmed_on: settlement.confirmed_on,
            refund_paid_on:
              settlement.refund_paid_on_text,
            refund_method: settlement.refund_method,
            refund_reference:
              settlement.refund_reference,
          }
        : null,
    };
  } finally {
    client.release();
  }
}

module.exports = {
  get_dashboard_report,
  get_tenant_statement,
};