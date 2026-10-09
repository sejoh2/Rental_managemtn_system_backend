const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

/*
  Billing rules

  Monthly charges are rent, the unit's fixed electricity amount,
  and the unit's fixed water amount. Metered water is billed by
  the Water module when a meter reading is submitted.

  - On the 1st of each month (Nairobi time) every active or
    notice-given tenant is billed for that month.
  - Only the current month is ever created. Earlier months are
    never back-billed.
  - The move-in month and the move-out month follow the
    property's move_in_billing and move_out_billing settings.
  - A tenant can have only one charge of each type per month,
    so every function here is safe to run more than once.
*/

const BILLING_TIME_ZONE = "Africa/Nairobi";

/*
  Which charges a payment into each property account may settle,
  in the order they are settled.

  Electricity and water money, including their deposits, goes
  to its own account when the property has one. Otherwise those
  charges are settled through the rent account.
*/
const charge_priority_order_sql = `
  CASE charge_type
    WHEN 'rent_deposit' THEN 1
    WHEN 'water_deposit' THEN 2
    WHEN 'electricity_deposit' THEN 3
    WHEN 'rent' THEN 4
    WHEN 'electricity' THEN 5
    WHEN 'water' THEN 6
    ELSE 99
  END
`;

async function get_payable_charge_types(
  client,
  property_id,
  account_for
) {
  if (account_for === "water") {
    return ["water_deposit", "water"];
  }

  if (account_for === "electricity") {
    return ["electricity_deposit", "electricity"];
  }

  const result = await client.query(
    `
      SELECT account_for
      FROM payment_accounts
      WHERE property_id = $1
        AND status = 'active'
    `,
    [property_id]
  );

  const accounts = result.rows.map(
    (row) => row.account_for
  );

  const charge_types = [
    "rent_deposit",
    "rent",
  ];

  if (!accounts.includes("electricity")) {
    charge_types.push(
      "electricity_deposit",
      "electricity"
    );
  }

  if (!accounts.includes("water")) {
    charge_types.push("water_deposit", "water");
  }

  return charge_types;
}

/*
  The monthly amounts a tenant is billed, one row per charge type.
  Expects a preceding CTE named billable with the columns
  monthly_rent, electricity_monthly_charge, water_billing_method,
  water_fixed_monthly_bill and fraction.
*/
const monthly_amounts_sql = `
  SELECT
    billable.*,
    'rent' AS charge_type,
    ROUND(billable.monthly_rent * billable.fraction) AS amount
  FROM billable

  UNION ALL

  SELECT
    billable.*,
    'electricity',
    ROUND(
      billable.electricity_monthly_charge *
      billable.fraction
    )
  FROM billable
  WHERE billable.electricity_monthly_charge > 0

  UNION ALL

  SELECT
    billable.*,
    'water',
    ROUND(
      billable.water_fixed_monthly_bill *
      billable.fraction
    )
  FROM billable
  WHERE billable.water_billing_method = 'fixed_monthly'
    AND billable.water_fixed_monthly_bill > 0
`;

/*
  Uses any credit the tenant holds against their open charges.
  A credit is money from an earlier overpayment, so it follows
  the same account rules as the payment it came from.
*/
async function apply_tenant_credits(client, tenant_id) {
  const credits_result = await client.query(
    `
      SELECT
        tenant_credits.*,
        payments.account_for
      FROM tenant_credits
      INNER JOIN payments
        ON payments.id =
          tenant_credits.source_payment_id
      WHERE tenant_credits.tenant_id = $1
        AND tenant_credits.remaining_amount > 0
      ORDER BY
        tenant_credits.created_at ASC,
        tenant_credits.id ASC
      FOR UPDATE OF tenant_credits
    `,
    [tenant_id]
  );

  let total_applied = 0;

  for (const credit of credits_result.rows) {
    let remaining_amount = Number(
      credit.remaining_amount
    );

    const charge_types = await get_payable_charge_types(
      client,
      credit.property_id,
      credit.account_for
    );

    const charges_result = await client.query(
      `
        SELECT *
        FROM tenant_charges
        WHERE tenant_id = $1
          AND charge_type = ANY($2)
          AND status IN ('open', 'partial')
        ORDER BY
          ${charge_priority_order_sql},
          due_date ASC,
          id ASC
        FOR UPDATE
      `,
      [tenant_id, charge_types]
    );

    for (const charge of charges_result.rows) {
      if (remaining_amount <= 0) {
        break;
      }

      const outstanding =
        Number(charge.amount_due) -
        Number(charge.amount_paid);

      if (outstanding <= 0) {
        continue;
      }

      const allocated_amount = Math.min(
        remaining_amount,
        outstanding
      );

      await client.query(
        `
          INSERT INTO payment_allocations (
            payment_id,
            tenant_charge_id,
            amount
          )
          VALUES ($1,$2,$3)
          ON CONFLICT (payment_id, tenant_charge_id)
          DO UPDATE SET
            amount =
              payment_allocations.amount +
              EXCLUDED.amount
        `,
        [
          credit.source_payment_id,
          charge.id,
          allocated_amount,
        ]
      );

      await client.query(
        `
          UPDATE tenant_charges
          SET
            amount_paid = amount_paid + $1,
            status = CASE
              WHEN amount_paid + $1 >= amount_due
              THEN 'paid'
              ELSE 'partial'
            END
          WHERE id = $2
        `,
        [allocated_amount, charge.id]
      );

      remaining_amount -= allocated_amount;
      total_applied += allocated_amount;
    }

    if (
      remaining_amount !==
      Number(credit.remaining_amount)
    ) {
      await client.query(
        `
          UPDATE tenant_credits
          SET remaining_amount = $1
          WHERE id = $2
        `,
        [remaining_amount, credit.id]
      );
    }
  }

  return total_applied;
}

/*
  Bills a new tenant for their move-in month.

  prorated               rent x (days in month - move-in day)
                         / days in month
  full_month             the whole month
  free_until_next_month  nothing until the 1st

  Moving in on the 1st is always a full month.
  Deposits are created separately and are never pro-rated.
*/
async function create_move_in_charges(client, tenant_id) {
  const result = await client.query(
    `
      WITH billable AS (
        SELECT
          tenants.id AS tenant_id,
          tenants.owner_id,
          tenants.property_id,
          tenants.unit_id,
          tenants.move_in_date,
          tenants.monthly_rent,

          units.electricity_monthly_charge,
          units.water_billing_method,
          units.water_fixed_monthly_bill,

          DATE_TRUNC(
            'month',
            tenants.move_in_date
          )::DATE AS billing_period,

          CASE
            WHEN EXTRACT(
              DAY FROM tenants.move_in_date
            ) = 1
              THEN 1::NUMERIC

            WHEN properties.move_in_billing =
              'full_month'
              THEN 1::NUMERIC

            WHEN properties.move_in_billing =
              'free_until_next_month'
              THEN 0::NUMERIC

            ELSE (
              EXTRACT(
                DAY FROM (
                  DATE_TRUNC(
                    'month',
                    tenants.move_in_date
                  ) + INTERVAL '1 month - 1 day'
                )
              ) -
              EXTRACT(DAY FROM tenants.move_in_date)
            )::NUMERIC /
            EXTRACT(
              DAY FROM (
                DATE_TRUNC(
                  'month',
                  tenants.move_in_date
                ) + INTERVAL '1 month - 1 day'
              )
            )::NUMERIC
          END AS fraction

        FROM tenants

        INNER JOIN units
          ON units.id = tenants.unit_id

        INNER JOIN properties
          ON properties.id = tenants.property_id

        WHERE tenants.id = $1
      ),

      amounts AS (
        ${monthly_amounts_sql}
      )

      INSERT INTO tenant_charges (
        tenant_id,
        owner_id,
        property_id,
        unit_id,
        charge_type,
        billing_period,
        due_date,
        amount_due
      )
      SELECT
        tenant_id,
        owner_id,
        property_id,
        unit_id,
        charge_type,
        billing_period,
        move_in_date,
        amount
      FROM amounts
      WHERE amount > 0
      ON CONFLICT (
        tenant_id,
        charge_type,
        billing_period
      )
      DO NOTHING
      RETURNING *
    `,
    [tenant_id]
  );

  /*
    The rent and water deposits come from a database trigger.
    The electricity deposit is optional per unit, so it is
    added here only when the unit has one.
  */
  const deposit_result = await client.query(
    `
      INSERT INTO tenant_charges (
        tenant_id,
        owner_id,
        property_id,
        unit_id,
        charge_type,
        billing_period,
        due_date,
        amount_due
      )
      SELECT
        tenants.id,
        tenants.owner_id,
        tenants.property_id,
        tenants.unit_id,
        'electricity_deposit',
        DATE '1970-01-01',
        tenants.move_in_date,
        units.electricity_deposit
      FROM tenants
      INNER JOIN units
        ON units.id = tenants.unit_id
      WHERE tenants.id = $1
        AND units.electricity_deposit > 0
      ON CONFLICT (
        tenant_id,
        charge_type,
        billing_period
      )
      DO NOTHING
      RETURNING *
    `,
    [tenant_id]
  );

  return [
    ...deposit_result.rows,
    ...result.rows,
  ];
}

/*
  Creates the current month's charges for every tenant who
  moved in before this month and does not have them yet,
  then settles them from any credit the tenant holds.
*/
async function run_monthly_billing() {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        WITH period AS (
          SELECT DATE_TRUNC(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE $1
          )::DATE AS billing_period
        ),

        billable AS (
          SELECT
            tenants.id AS tenant_id,
            tenants.owner_id,
            tenants.property_id,
            tenants.unit_id,
            tenants.monthly_rent,

            units.electricity_monthly_charge,
            units.water_billing_method,
            units.water_fixed_monthly_bill,

            period.billing_period,

            (
              period.billing_period +
              (properties.rent_due_day - 1)
            )::DATE AS due_date,

            1::NUMERIC AS fraction

          FROM tenants

          INNER JOIN units
            ON units.id = tenants.unit_id

          INNER JOIN properties
            ON properties.id = tenants.property_id

          CROSS JOIN period

          WHERE tenants.status IN (
              'active',
              'notice_given'
            )
            AND properties.status = 'active'
            AND tenants.move_in_date <
              period.billing_period
        ),

        amounts AS (
          ${monthly_amounts_sql}
        )

        INSERT INTO tenant_charges (
          tenant_id,
          owner_id,
          property_id,
          unit_id,
          charge_type,
          billing_period,
          due_date,
          amount_due
        )
        SELECT
          tenant_id,
          owner_id,
          property_id,
          unit_id,
          charge_type,
          billing_period,
          due_date,
          amount
        FROM amounts
        WHERE amount > 0
        ON CONFLICT (
          tenant_id,
          charge_type,
          billing_period
        )
        DO NOTHING
        RETURNING
          tenant_id,
          owner_id,
          charge_type,
          amount_due,
          TO_CHAR(
            billing_period,
            'YYYY-MM-DD'
          ) AS billing_period
      `,
      [BILLING_TIME_ZONE]
    );

    const tenant_ids = [
      ...new Set(
        result.rows.map((row) => row.tenant_id)
      ),
    ];

    let credit_applied = 0;

    for (const tenant_id of tenant_ids) {
      credit_applied += await apply_tenant_credits(
        client,
        tenant_id
      );
    }

    await client.query("COMMIT");

    const summary = {
      billing_period:
        result.rows[0]?.billing_period || null,
      charges_created: result.rows.length,
      tenants_billed: tenant_ids.length,
      total_billed: result.rows.reduce(
        (total, row) =>
          total + Number(row.amount_due),
        0
      ),
      credit_applied,
    };

    /*
      One audit entry per owner account that was billed.
    */
    const owner_ids = [
      ...new Set(result.rows.map((row) => row.owner_id)),
    ];

    for (const owner_id of owner_ids) {
      const owner_rows = result.rows.filter(
        (row) => row.owner_id === owner_id
      );

      await log_audit({
        user_id: null,
        owner_id,
        action: "MONTHLY_BILLING_RUN",
        entity_type: "billing",
        metadata: {
          billing_period: summary.billing_period,
          charges_created: owner_rows.length,
          tenants_billed: new Set(
            owner_rows.map((row) => row.tenant_id)
          ).size,
          total_billed: owner_rows.reduce(
            (total, row) =>
              total + Number(row.amount_due),
            0
          ),
        },
      });
    }

    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Moves money that was paid towards a charge back to the
  tenant's credit, newest allocation first.
*/
async function release_charge_payments(
  client,
  charge,
  amount_to_release
) {
  let remaining_to_release = amount_to_release;

  const allocations_result = await client.query(
    `
      SELECT *
      FROM payment_allocations
      WHERE tenant_charge_id = $1
      ORDER BY id DESC
      FOR UPDATE
    `,
    [charge.id]
  );

  for (const allocation of allocations_result.rows) {
    if (remaining_to_release <= 0) {
      break;
    }

    const released_amount = Math.min(
      remaining_to_release,
      Number(allocation.amount)
    );

    if (released_amount >= Number(allocation.amount)) {
      await client.query(
        `
          DELETE FROM payment_allocations
          WHERE id = $1
        `,
        [allocation.id]
      );
    } else {
      await client.query(
        `
          UPDATE payment_allocations
          SET amount = amount - $1
          WHERE id = $2
        `,
        [released_amount, allocation.id]
      );
    }

    await client.query(
      `
        INSERT INTO tenant_credits (
          tenant_id,
          property_id,
          source_payment_id,
          original_amount,
          remaining_amount
        )
        VALUES ($1,$2,$3,$4,$4)
        ON CONFLICT (source_payment_id)
        DO UPDATE SET
          original_amount =
            tenant_credits.original_amount +
            EXCLUDED.original_amount,
          remaining_amount =
            tenant_credits.remaining_amount +
            EXCLUDED.remaining_amount
      `,
      [
        charge.tenant_id,
        charge.property_id,
        allocation.payment_id,
        released_amount,
      ]
    );

    remaining_to_release -= released_amount;
  }
}

/*
  Settles a tenant's monthly charges when they move out.

  - Charges for months after the move-out month are voided.
  - The move-out month is reduced to the days occupied when
    the property's move_out_billing is 'prorated':
    amount x move-out day / days in month.
    If the tenant also moved in that same month on a pro-rated
    basis, only the days between the two dates are billed.
  - Anything already paid above the reduced amount becomes
    tenant credit.

  move_out_date is a 'YYYY-MM-DD' string.
*/
async function adjust_move_out_charges(
  client,
  tenant_id,
  move_out_date
) {
  const context_result = await client.query(
    `
      SELECT
        tenants.monthly_rent,
        properties.move_in_billing,
        properties.move_out_billing,

        units.electricity_monthly_charge,
        units.water_billing_method,
        units.water_fixed_monthly_bill,

        TO_CHAR(
          DATE_TRUNC('month', $2::DATE),
          'YYYY-MM-DD'
        ) AS move_out_period,

        EXTRACT(DAY FROM $2::DATE)::INTEGER
          AS move_out_day,

        EXTRACT(
          DAY FROM (
            DATE_TRUNC('month', $2::DATE) +
            INTERVAL '1 month - 1 day'
          )
        )::INTEGER AS days_in_month,

        (
          DATE_TRUNC('month', tenants.move_in_date) =
          DATE_TRUNC('month', $2::DATE)
        ) AS moved_in_same_month,

        EXTRACT(
          DAY FROM tenants.move_in_date
        )::INTEGER AS move_in_day

      FROM tenants

      INNER JOIN units
        ON units.id = tenants.unit_id

      INNER JOIN properties
        ON properties.id = tenants.property_id

      WHERE tenants.id = $1
    `,
    [tenant_id, move_out_date]
  );

  const context = context_result.rows[0];

  const monthly_amounts = {
    rent: Number(context.monthly_rent),
    electricity: Number(
      context.electricity_monthly_charge || 0
    ),
  };

  if (context.water_billing_method === "fixed_monthly") {
    monthly_amounts.water = Number(
      context.water_fixed_monthly_bill || 0
    );
  }

  const first_billed_day =
    context.moved_in_same_month &&
    context.move_in_billing === "prorated" &&
    context.move_in_day !== 1
      ? context.move_in_day
      : 0;

  const occupied_days = Math.max(
    context.move_out_day - first_billed_day,
    0
  );

  const prorate_move_out_month =
    context.move_out_billing === "prorated" &&
    context.move_out_day < context.days_in_month;

  const charges_result = await client.query(
    `
      SELECT
        tenant_charges.*,
        (
          tenant_charges.billing_period > $3::DATE
        ) AS is_after_move_out
      FROM tenant_charges
      WHERE tenant_id = $1
        AND charge_type = ANY($2)
        AND billing_period >= $3::DATE
        AND status <> 'void'
      ORDER BY id
      FOR UPDATE
    `,
    [
      tenant_id,
      Object.keys(monthly_amounts),
      context.move_out_period,
    ]
  );

  const adjustments = [];

  for (const charge of charges_result.rows) {
    const amount_due = Number(charge.amount_due);
    const amount_paid = Number(charge.amount_paid);

    let target_amount = amount_due;

    if (charge.is_after_move_out) {
      target_amount = 0;
    } else if (prorate_move_out_month) {
      target_amount = Math.min(
        Math.round(
          (monthly_amounts[charge.charge_type] *
            occupied_days) /
            context.days_in_month
        ),
        amount_due
      );
    }

    if (target_amount >= amount_due) {
      continue;
    }

    const new_amount_paid = Math.min(
      amount_paid,
      target_amount
    );

    if (amount_paid > new_amount_paid) {
      await release_charge_payments(
        client,
        charge,
        amount_paid - new_amount_paid
      );
    }

    /*
      A charge cannot have a zero amount, so a charge that is
      no longer owed keeps its amount and is marked void.
    */
    await client.query(
      `
        UPDATE tenant_charges
        SET
          amount_due = $1,
          amount_paid = $2,
          status = $3
        WHERE id = $4
      `,
      [
        target_amount > 0 ? target_amount : amount_due,
        new_amount_paid,
        target_amount <= 0
          ? "void"
          : new_amount_paid >= target_amount
            ? "paid"
            : new_amount_paid > 0
              ? "partial"
              : "open",
        charge.id,
      ]
    );

    adjustments.push({
      charge_type: charge.charge_type,
      previous_amount: amount_due,
      amount: target_amount,
      credited_to_tenant: amount_paid - new_amount_paid,
    });
  }

  /*
    Money released above first settles anything the tenant
    still owes; only the remainder stays as credit.
  */
  if (adjustments.length) {
    await apply_tenant_credits(client, tenant_id);
  }

  return adjustments;
}

let scheduler_started = false;

async function run_scheduled_billing() {
  try {
    const summary = await run_monthly_billing();

    if (summary.charges_created > 0) {
      console.log(
        `[BILLING] Created ${summary.charges_created} charge(s) for ${summary.tenants_billed} tenant(s), period ${summary.billing_period}.`
      );
    }
  } catch (error) {
    console.error(
      "[BILLING] Monthly billing run failed:",
      error.message
    );
  }
}

/*
  Runs once at startup and then every hour, so a month's
  charges appear shortly after midnight on the 1st and are
  caught up if the server was off at that moment.
*/
function start_billing_scheduler() {
  if (scheduler_started) {
    return;
  }

  scheduler_started = true;

  const interval_ms =
    Number(process.env.BILLING_INTERVAL_MS) ||
    60 * 60 * 1000;

  run_scheduled_billing();

  setInterval(run_scheduled_billing, interval_ms);
}

module.exports = {
  charge_priority_order_sql,
  get_payable_charge_types,
  apply_tenant_credits,
  create_move_in_charges,
  run_monthly_billing,
  adjust_move_out_charges,
  start_billing_scheduler,
};
