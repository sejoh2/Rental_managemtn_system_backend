const db = require("../config/db");

const { sum_money } = require("../utils/money");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  bill_service_charges,
  release_charge_payments,
  apply_tenant_credits,
} = require("../billing/billing_service");

function public_service_charge(charge) {
  return {
    id: charge.id,

    owner_id: charge.owner_id,
    property_id: charge.property_id,

    name: charge.name,
    category: charge.category,
    frequency: charge.frequency,

    amount: Number(charge.amount),
    start_date: charge.start_date_text,

    status: charge.status,

    /*
      What every unit of the property pays for this charge.
      custom is true when the unit has its own amount.
    */
    unit_amounts: (charge.unit_amounts || []).map(
      (unit) => ({
        unit_id: unit.unit_id,
        unit_number: unit.unit_number,
        amount: Number(unit.amount),
        custom: unit.custom,
      })
    ),

    created_at: charge.created_at,
    updated_at: charge.updated_at,
  };
}

async function fetch_service_charges(
  owner_id,
  { property_id = null, service_charge_id = null }
) {
  const result = await db.query(
    `
      SELECT
        service_charges.*,

        TO_CHAR(
          service_charges.start_date,
          'YYYY-MM-DD'
        ) AS start_date_text,

        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'unit_id',
                units.id,

                'unit_number',
                units.unit_number,

                'amount',
                COALESCE(
                  service_charge_units.amount,
                  service_charges.amount
                ),

                'custom',
                service_charge_units.id IS NOT NULL
              )
              ORDER BY units.unit_number
            )
            FROM units
            LEFT JOIN service_charge_units
              ON service_charge_units.service_charge_id =
                service_charges.id
              AND service_charge_units.unit_id = units.id
            WHERE units.property_id =
              service_charges.property_id
              AND units.status <> 'inactive'
          ),
          '[]'::JSON
        ) AS unit_amounts

      FROM service_charges

      WHERE service_charges.owner_id = $1
        AND service_charges.status = 'active'

        AND (
          $2::TEXT IS NULL
          OR service_charges.property_id = $2
        )

        AND (
          $3::TEXT IS NULL
          OR service_charges.id = $3
        )

      ORDER BY
        service_charges.created_at ASC,
        service_charges.id ASC
    `,
    [owner_id, property_id, service_charge_id]
  );

  return result.rows.map(public_service_charge);
}

async function ensure_owner_owns_property(
  client,
  owner_id,
  property_id
) {
  const result = await client.query(
    `
      SELECT id, name
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status = 'active'
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

function duplicate_name_error(error) {
  if (
    error.code === "23505" &&
    error.constraint ===
      "uq_service_charge_name_per_property"
  ) {
    const friendly_error = new Error(
      "This property already has a service charge with this name."
    );

    friendly_error.status_code = 409;
    return friendly_error;
  }

  return error;
}

/*
  Replaces the per-unit amounts of a charge. A unit whose
  amount equals the charge's own amount is not stored, so it
  keeps following that amount when it is changed later.
*/
async function save_unit_amounts(
  client,
  charge,
  unit_amounts
) {
  const unit_ids = [
    ...new Set(unit_amounts.map((item) => item.unit_id)),
  ];

  const units_result = await client.query(
    `
      SELECT id
      FROM units
      WHERE property_id = $1
        AND id = ANY($2)
    `,
    [charge.property_id, unit_ids]
  );

  if (units_result.rows.length !== unit_ids.length) {
    const error = new Error(
      "One or more units do not belong to this property."
    );

    error.status_code = 422;
    throw error;
  }

  await client.query(
    `
      DELETE FROM service_charge_units
      WHERE service_charge_id = $1
    `,
    [charge.id]
  );

  await client.query(
    `
      INSERT INTO service_charge_units (
        service_charge_id,
        unit_id,
        amount
      )
      SELECT
        $1::record_id,
        items.unit_id,
        items.amount
      FROM JSON_TO_RECORDSET($2::JSON)
        AS items (unit_id TEXT, amount NUMERIC)
      WHERE items.amount <> $3::NUMERIC
      ON CONFLICT (service_charge_id, unit_id)
      DO UPDATE SET amount = EXCLUDED.amount
    `,
    [
      charge.id,
      JSON.stringify(unit_amounts),
      charge.amount,
    ]
  );
}

async function list_service_charges(owner, property_id) {
  await ensure_owner_owns_property(
    db,
    owner.user_id,
    property_id
  );

  return fetch_service_charges(owner.user_id, {
    property_id,
  });
}

/*
  Adds the charge and bills the tenants living there now.

  A monthly charge is billed for the rest of this month under
  the property's move-in billing rule, then in full on the 1st
  of each month. A one-off charge is billed once, in full.
*/
async function create_service_charge(
  owner,
  property_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    await ensure_owner_owns_property(
      client,
      owner.user_id,
      property_id
    );

    const result = await client.query(
      `
        INSERT INTO service_charges (
          owner_id,
          property_id,
          name,
          category,
          frequency,
          amount,
          start_date,
          created_by
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          (
            CURRENT_TIMESTAMP
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE,
          $1
        )
        RETURNING *
      `,
      [
        owner.user_id,
        property_id,
        data.name,
        data.category,
        data.frequency,
        data.amount,
      ]
    );

    const charge = result.rows[0];

    await save_unit_amounts(
      client,
      charge,
      data.unit_amounts
    );

    /*
      The owner may let a monthly charge start with the next
      monthly billing run instead of billing the tenants who
      live there now for the rest of this month.
    */
    const wait_for_billing =
      charge.frequency === "monthly" &&
      data.first_billing === "next_billing";

    const billed = wait_for_billing
      ? []
      : await bill_service_charges(client, {
          service_charge_id: charge.id,
        });

    const tenant_ids = [
      ...new Set(billed.map((row) => row.tenant_id)),
    ];

    for (const tenant_id of tenant_ids) {
      await apply_tenant_credits(client, tenant_id);
    }

    await client.query("COMMIT");

    const billing = {
      tenants_billed: tenant_ids.length,
      total_billed: sum_money(
        billed.map((row) => row.amount_due)
      ),
    };

    await log_audit({
      user_id: owner.user_id,
      action: "SERVICE_CHARGE_ADDED",
      entity_type: "service_charge",
      entity_id: charge.id,
      metadata: {
        property_id,
        name: charge.name,
        category: charge.category,
        frequency: charge.frequency,
        amount: charge.amount,
        unit_amounts: data.unit_amounts,
        first_billing: wait_for_billing
          ? "next_billing"
          : "now",
        ...billing,
      },
      ip_address,
    });

    const [service_charge] = await fetch_service_charges(
      owner.user_id,
      { service_charge_id: charge.id }
    );

    return {
      ...service_charge,
      billing,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw duplicate_name_error(error);
  } finally {
    client.release();
  }
}

async function get_service_charge_row(
  client,
  owner_id,
  service_charge_id
) {
  const result = await client.query(
    `
      SELECT *
      FROM service_charges
      WHERE id = $1
        AND owner_id = $2
        AND status = 'active'
      FOR UPDATE
    `,
    [service_charge_id, owner_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Service charge not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  return result.rows[0];
}

/*
  New amounts apply to bills created from now on.
  Charges that tenants were already billed are not changed.
*/
async function update_service_charge(
  owner,
  service_charge_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const existing = await get_service_charge_row(
      client,
      owner.user_id,
      service_charge_id
    );

    const result = await client.query(
      `
        UPDATE service_charges
        SET
          name = COALESCE($1, name),
          category = COALESCE($2, category),
          amount = COALESCE($3, amount)
        WHERE id = $4
        RETURNING *
      `,
      [
        data.name ?? null,
        data.category ?? null,
        data.amount ?? null,
        existing.id,
      ]
    );

    const charge = result.rows[0];

    if (data.unit_amounts) {
      await save_unit_amounts(
        client,
        charge,
        data.unit_amounts
      );
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "SERVICE_CHARGE_UPDATED",
      entity_type: "service_charge",
      entity_id: charge.id,
      metadata: {
        property_id: charge.property_id,
        name: charge.name,
        updated_fields: Object.keys(data),
        previous_amount: existing.amount,
        amount: charge.amount,
        unit_amounts: data.unit_amounts,
      },
      ip_address,
    });

    const [service_charge] = await fetch_service_charges(
      owner.user_id,
      { service_charge_id: charge.id }
    );

    return service_charge;
  } catch (error) {
    await client.query("ROLLBACK");
    throw duplicate_name_error(error);
  } finally {
    client.release();
  }
}

/*
  Stops the charge from being billed again. What tenants were
  already billed stays on their accounts.
*/
/*
  The bills a service charge has made that can still be
  cancelled: not void, and not already settled from a deposit
  in a confirmed move-out reconciliation.
*/
const cancellable_bills_sql = `
  FROM tenant_charges
  WHERE tenant_charges.owner_id = $2
    AND tenant_charges.charge_type = 'service'
    AND tenant_charges.source_id = $1
    AND tenant_charges.status <> 'void'
    AND NOT EXISTS (
      SELECT 1
      FROM deposit_applications
      WHERE deposit_applications.tenant_charge_id =
        tenant_charges.id
    )
`;

/*
  What cancelling a service charge's bills would do, for the
  owner to read before choosing.
*/
async function get_billed_summary(owner, service_charge_id) {
  const result = await db.query(
    `
      SELECT
        COUNT(*) AS bills,
        COUNT(DISTINCT tenant_id) AS tenants,
        COALESCE(SUM(amount_due), 0) AS billed,
        COALESCE(SUM(amount_paid), 0) AS paid
      ${cancellable_bills_sql}
    `,
    [service_charge_id, owner.user_id]
  );

  const row = result.rows[0];

  return {
    bills: Number(row.bills),
    tenants: Number(row.tenants),
    billed: Number(row.billed),
    paid: Number(row.paid),
  };
}

/*
  Removes a service charge, so nobody is billed for it again.

  cancel_bills also undoes the bills it already made, for a
  charge added by mistake: each bill is marked void, and what a
  tenant had paid towards it goes back to them as credit, which
  then settles their other bills. A bill already settled from a
  deposit at move-out is left as it is.
*/
async function archive_service_charge(
  owner,
  service_charge_id,
  ip_address,
  cancel_bills = false
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        UPDATE service_charges
        SET
          status = 'archived',
          archived_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND owner_id = $2
          AND status = 'active'
        RETURNING *
      `,
      [service_charge_id, owner.user_id]
    );

    const charge = result.rows[0];

    if (!charge) {
      const error = new Error(
        "Service charge not found or you do not have access to it."
      );

      error.status_code = 404;
      throw error;
    }

    const cancelled = {
      bills: 0,
      billed: 0,
      returned_as_credit: 0,
    };

    if (cancel_bills) {
      const bills = await client.query(
        `
          SELECT tenant_charges.*
          ${cancellable_bills_sql}
          ORDER BY tenant_charges.id
          FOR UPDATE OF tenant_charges
        `,
        [charge.id, owner.user_id]
      );

      for (const bill of bills.rows) {
        const paid = Number(bill.amount_paid);

        if (paid > 0) {
          await release_charge_payments(client, bill, paid);
        }

        await client.query(
          `
            UPDATE tenant_charges
            SET
              amount_paid = 0,
              status = 'void'
            WHERE id = $1
          `,
          [bill.id]
        );

        cancelled.bills += 1;
        cancelled.billed += Number(bill.amount_due);
        cancelled.returned_as_credit += paid;
      }

      const tenant_ids = [
        ...new Set(bills.rows.map((bill) => bill.tenant_id)),
      ];

      for (const tenant_id of tenant_ids) {
        await apply_tenant_credits(client, tenant_id);
      }
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "SERVICE_CHARGE_REMOVED",
      entity_type: "service_charge",
      entity_id: charge.id,
      metadata: {
        property_id: charge.property_id,
        name: charge.name,
        frequency: charge.frequency,
        amount: charge.amount,
        bills_cancelled: cancelled.bills,
        amount_cancelled: cancelled.billed,
        returned_as_credit: cancelled.returned_as_credit,
      },
      ip_address,
    });

    return cancelled;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  list_service_charges,
  create_service_charge,
  update_service_charge,
  archive_service_charge,
  get_billed_summary,
};
