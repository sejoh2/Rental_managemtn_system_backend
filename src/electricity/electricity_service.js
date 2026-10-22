const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  apply_tenant_credits,
} = require("../billing/billing_service");

const {
  get_caretaker_property_access,
} = require("../caretakers/caretaker_access_service");

/*
  Electricity for units whose electricity_billing_method is
  'entered': the owner types the amount for each unit every
  month, and the tenant living there is billed exactly that.
  Units on a fixed monthly amount are billed with rent by the
  billing service instead.
*/

function service_error(message, status_code = 400) {
  const error = new Error(message);

  error.status_code = status_code;
  return error;
}

/*
  The owner of the property, or a caretaker assigned to it.
*/
async function ensure_property_access(
  client,
  user,
  property_id
) {
  const owner_id =
    user.role === "caretaker"
      ? user.owner_id
      : user.user_id;

  if (user.role === "caretaker") {
    await get_caretaker_property_access(
      client,
      user,
      property_id,
      "can_enter_electricity"
    );
  }

  const result = await client.query(
    `
      SELECT
        id,
        name,
        rent_due_day,

        TO_CHAR(
          DATE_TRUNC(
            'month',
            CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'
          ),
          'YYYY-MM'
        ) AS current_period

      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status = 'active'
    `,
    [property_id, owner_id]
  );

  if (!result.rows[0]) {
    throw service_error(
      "Property not found or you do not have access to it.",
      404
    );
  }

  return result.rows[0];
}

/*
  Every unit billed by entered amount, with the tenant living
  there and that month's bill if one was entered already.
  period is 'YYYY-MM'.
*/
async function load_bills(client, property_id, period) {
  const result = await client.query(
    `
      SELECT
        units.id AS unit_id,
        units.unit_number,

        tenants.id AS tenant_id,
        tenants.owner_id,
        tenants.full_name AS tenant_name,

        TO_CHAR(
          DATE_TRUNC('month', tenants.move_in_date),
          'YYYY-MM'
        ) AS move_in_period,

        tenant_charges.id AS charge_id,
        tenant_charges.amount_due,
        tenant_charges.amount_paid,
        tenant_charges.status AS charge_status

      FROM units

      LEFT JOIN LATERAL (
        SELECT *
        FROM tenants
        WHERE tenants.unit_id = units.id
          AND tenants.status IN (
            'active',
            'notice_given'
          )
        ORDER BY tenants.created_at DESC
        LIMIT 1
      ) AS tenants ON TRUE

      LEFT JOIN tenant_charges
        ON tenant_charges.tenant_id = tenants.id
        AND tenant_charges.charge_type = 'electricity'
        AND tenant_charges.billing_period =
          ($2 || '-01')::DATE

      WHERE units.property_id = $1
        AND units.status <> 'inactive'
        AND units.electricity_billing_method = 'entered'

      ORDER BY
        units.block_or_floor NULLS LAST,
        units.unit_number ASC
    `,
    [property_id, period]
  );

  return result.rows;
}

function public_bill(row) {
  const billed =
    row.charge_id && row.charge_status !== "void";

  return {
    unit_id: Number(row.unit_id),
    unit_number: row.unit_number,

    tenant_id: row.tenant_id
      ? Number(row.tenant_id)
      : null,

    tenant_name: row.tenant_name || null,

    /*
      null until an amount has been entered for the month.
    */
    amount: billed ? Number(row.amount_due) : null,

    amount_paid: billed ? Number(row.amount_paid) : 0,

    status: billed ? row.charge_status : null,
  };
}

async function list_bills(owner, property_id, period) {
  const property = await ensure_property_access(
    db,
    owner,
    property_id
  );

  const month = period || property.current_period;

  const rows = await load_bills(db, property_id, month);

  return {
    period: month,
    bills: rows.map(public_bill),
  };
}

async function save_bills(
  owner,
  property_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const property = await ensure_property_access(
      client,
      owner,
      property_id
    );

    if (data.period > property.current_period) {
      throw service_error(
        "Electricity cannot be billed for a month that has not started.",
        422
      );
    }

    const rows = await load_bills(
      client,
      property_id,
      data.period
    );

    const saved = [];
    const tenant_ids = new Set();

    for (const bill of data.bills) {
      const row = rows.find(
        (item) => Number(item.unit_id) === bill.unit_id
      );

      if (!row) {
        throw service_error(
          "One of the units is not in this property, or its electricity is not billed by entered amount.",
          422
        );
      }

      const billed =
        row.charge_id && row.charge_status !== "void";

      if (!row.tenant_id) {
        if (bill.amount > 0) {
          throw service_error(
            `House ${row.unit_number} has no tenant to bill.`,
            422
          );
        }

        continue;
      }

      if (
        bill.amount > 0 &&
        data.period < row.move_in_period
      ) {
        throw service_error(
          `${row.tenant_name} had not moved in to House ${row.unit_number} in that month.`,
          422
        );
      }

      const amount_paid = billed
        ? Number(row.amount_paid)
        : 0;

      if (bill.amount < amount_paid) {
        throw service_error(
          `House ${row.unit_number} has already paid KES ${amount_paid} towards this bill, so it cannot be lower than that.`,
          422
        );
      }

      if (
        billed &&
        Number(row.amount_due) === bill.amount
      ) {
        continue;
      }

      if (!billed && bill.amount === 0) {
        continue;
      }

      if (row.charge_id && bill.amount === 0) {
        /*
          A charge cannot have a zero amount, so a bill that
          is taken back keeps its amount and is marked void.
        */
        await client.query(
          `
            UPDATE tenant_charges
            SET status = 'void'
            WHERE id = $1
          `,
          [row.charge_id]
        );
      } else if (row.charge_id) {
        await client.query(
          `
            UPDATE tenant_charges
            SET
              amount_due = $1,
              amount_paid = $2,
              status = CASE
                WHEN $2::NUMERIC >= $1::NUMERIC THEN 'paid'
                WHEN $2::NUMERIC > 0 THEN 'partial'
                ELSE 'open'
              END
            WHERE id = $3
          `,
          [bill.amount, amount_paid, row.charge_id]
        );
      } else {
        await client.query(
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
            VALUES (
              $1,$2,$3,$4,
              'electricity',
              ($5 || '-01')::DATE,
              GREATEST(
                ($5 || '-01')::DATE + ($6::INTEGER - 1),
                (
                  CURRENT_TIMESTAMP
                  AT TIME ZONE 'Africa/Nairobi'
                )::DATE
              ),
              $7
            )
          `,
          [
            row.tenant_id,
            row.owner_id,
            property_id,
            row.unit_id,
            data.period,
            property.rent_due_day,
            bill.amount,
          ]
        );
      }

      tenant_ids.add(row.tenant_id);

      saved.push({
        unit_number: row.unit_number,
        tenant_id: Number(row.tenant_id),
        previous_amount: billed
          ? Number(row.amount_due)
          : null,
        amount: bill.amount,
      });
    }

    for (const tenant_id of tenant_ids) {
      await apply_tenant_credits(client, tenant_id);
    }

    await client.query("COMMIT");

    if (saved.length) {
      await log_audit({
        user_id: owner.user_id,
        action: "ELECTRICITY_BILLS_ENTERED",
        entity_type: "property",
        entity_id: property_id,
        metadata: {
          period: data.period,
          bills: saved,
          total: saved.reduce(
            (total, bill) => total + bill.amount,
            0
          ),
        },
        ip_address,
      });
    }

    const result = await list_bills(
      owner,
      property_id,
      data.period
    );

    return {
      ...result,
      bills_saved: saved.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  list_bills,
  save_bills,
};
