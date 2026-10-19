const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  alert_flagged_reading,
} = require("./water_notification_service");

const {
  apply_tenant_credits,
  release_charge_payments,
} = require("../billing/billing_service");

const {
  get_caretaker_property_access,
} = require("../caretakers/caretaker_access_service");

function first_day_of_month(value) {
  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    const error = new Error(
      "Billing period must be a valid date."
    );

    error.status_code = 422;
    throw error;
  }

  return date.toISOString().slice(0, 7) + "-01";
}

function public_reading(reading) {
  return {
    id: Number(reading.id),
    owner_id: Number(reading.owner_id),
    property_id: Number(reading.property_id),
    unit_id: Number(reading.unit_id),
    tenant_id: reading.tenant_id
      ? Number(reading.tenant_id)
      : null,

    tenant_name: reading.tenant_name || null,
    unit_number: reading.unit_number || null,

    billing_period: reading.billing_period,
    meter_number: reading.meter_number,

    /*
      A second reading taken when the tenant moved out.
    */
    is_final: Boolean(reading.is_final),

    previous_reading: Number(
      reading.previous_reading
    ),

    current_reading: Number(
      reading.current_reading
    ),

    units_used:
      reading.units_used === null
        ? null
        : Number(reading.units_used),

    rate_per_unit:
      reading.rate_per_unit === null
        ? null
        : Number(reading.rate_per_unit),

    bill_amount:
      reading.bill_amount === null
        ? null
        : Number(reading.bill_amount),

    meter_photo_url: reading.meter_photo_url,
    notes: reading.notes,

    status: reading.status,
    flag_reason: reading.flag_reason,

    tenant_charge_id: reading.tenant_charge_id
      ? Number(reading.tenant_charge_id)
      : null,

    /*
      Whether the bill this reading produced has been paid:
      open, partial, paid, or void. Present on list responses.
    */
    bill_status: reading.bill_status || null,

    /*
      Whether the reading can still be edited or cancelled:
      it is submitted and its bill was not settled from a
      deposit at move-out. Present on list responses.
    */
    can_edit: Boolean(reading.can_edit),

    bill_amount_paid:
      reading.bill_amount_paid == null
        ? null
        : Number(reading.bill_amount_paid),

    reviewed_at: reading.reviewed_at,
    submitted_at: reading.submitted_at,
    created_at: reading.created_at,
    updated_at: reading.updated_at,
  };
}

async function ensure_owner_owns_property(
  client,
  owner_id,
  property_id
) {
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

/*
  Readings may be handled by the owner or by a caretaker
  assigned to the property. Returns the property and the
  owner account it belongs to.
*/
async function ensure_property_access(
  client,
  user,
  property_id
) {
  let owner_id = user.user_id;

  if (user.role === "caretaker") {
    await get_caretaker_property_access(
      client,
      user,
      property_id
    );

    owner_id = user.owner_id;
  }

  const property = await ensure_owner_owns_property(
    client,
    owner_id,
    property_id
  );

  return {
    property,
    owner_id: Number(owner_id),
  };
}

function calculate_due_date(property, billing_period) {
  const period = new Date(
    `${billing_period}T00:00:00.000Z`
  );

  let day = 1;

  if (property.water_billing_day === "same_as_rent") {
    day = Number(property.rent_due_day) || 1;
  } else if (
    property.water_billing_day ===
    "last_day_of_month"
  ) {
    return new Date(
      Date.UTC(
        period.getUTCFullYear(),
        period.getUTCMonth() + 1,
        0
      )
    )
      .toISOString()
      .slice(0, 10);
  } else {
    const match = String(
      property.water_billing_day || ""
    ).match(/\d{1,2}/);

    day = match ? Number(match[0]) : 1;
  }

  const last_day = new Date(
    Date.UTC(
      period.getUTCFullYear(),
      period.getUTCMonth() + 1,
      0
    )
  ).getUTCDate();

  return new Date(
    Date.UTC(
      period.getUTCFullYear(),
      period.getUTCMonth(),
      Math.min(Math.max(day, 1), last_day)
    )
  )
    .toISOString()
    .slice(0, 10);
}

/*
  A tenant normally has one water bill a month. additional is
  for a final reading: the tenant is billed again, separately,
  for the units used since their earlier reading that month.
*/
async function create_water_charge(
  client,
  {
    tenant,
    property,
    billing_period,
    amount,
    additional = false,
  }
) {
  const result = await client.query(
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
        source_id,
        description
      )
      VALUES (
        $1,$2,$3,$4,
        'water',$5,$6,$7,
        CASE
          WHEN $8::BOOLEAN THEN (
            SELECT COALESCE(MAX(source_id), 0) + 1
            FROM tenant_charges
            WHERE tenant_id = $1
              AND charge_type = 'water'
              AND billing_period = $5::DATE
          )
          ELSE 0
        END,
        CASE
          WHEN $8::BOOLEAN THEN 'Water, final reading'
        END
      )
      ON CONFLICT (
        tenant_id,
        charge_type,
        billing_period,
        source_id
      )
      DO UPDATE SET
        amount_due = EXCLUDED.amount_due,
        due_date = EXCLUDED.due_date,
        status = 'open'
      WHERE tenant_charges.status = 'void'
        AND tenant_charges.amount_paid = 0
      RETURNING *
    `,
    [
      tenant.id,
      tenant.owner_id,
      tenant.property_id,
      tenant.unit_id,
      billing_period,
      calculate_due_date(
        property,
        billing_period
      ),
      amount,
      additional,
    ]
  );

  return result.rows[0] || null;
}

async function update_water_rules(
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

    const property_result = await client.query(
      `
        UPDATE properties
        SET
          water_billing_method = $1,
          water_rate_per_unit = $2,
          water_fixed_fee = $3,
          water_billing_day = $4,
          water_reading_due_days = $5,
          water_missed_reading_action = $6
        WHERE id = $7
          AND owner_id = $8
        RETURNING *
      `,
      [
        data.water_billing_method,
        data.water_rate_per_unit || 0,
        data.water_fixed_fee || 0,
        data.water_billing_day,
        data.water_reading_due_days,
        data.water_missed_reading_action,
        property_id,
        owner.user_id,
      ]
    );

    /*
      Existing occupied tenants should not be changed
      accidentally. Set apply_to_occupied_units true only
      when the owner deliberately wants to change them.
    */
    const unit_statuses = data.apply_to_occupied_units
      ? ["vacant", "occupied"]
      : ["vacant"];

    await client.query(
      `
        UPDATE units
        SET
          water_billing_method = $1,
          water_rate_per_unit = CASE
            WHEN $1 = 'per_unit_metered'
            THEN $2
            ELSE NULL
          END,
          water_fixed_monthly_bill = CASE
            WHEN $1 = 'fixed_monthly'
            THEN $3
            ELSE NULL
          END
        WHERE property_id = $4
          AND status = ANY($5)
      `,
      [
        data.water_billing_method,
        data.water_rate_per_unit || null,
        data.water_fixed_fee || null,
        property_id,
        unit_statuses,
      ]
    );

    await client.query("COMMIT");

    const property = property_result.rows[0];

    await log_audit({
      user_id: owner.user_id,
      action: "PROPERTY_WATER_BILLING_RULES_UPDATED",
      entity_type: "property",
      entity_id: property.id,
      metadata: {
        water_billing_method:
          property.water_billing_method,
        apply_to_occupied_units:
          data.apply_to_occupied_units,
      },
      ip_address,
    });

    return {
      property_id: Number(property.id),
      water_billing_method:
        property.water_billing_method,
      water_rate_per_unit: Number(
        property.water_rate_per_unit
      ),
      water_fixed_fee: Number(
        property.water_fixed_fee
      ),
      water_billing_day:
        property.water_billing_day,
      water_reading_due_days: Number(
        property.water_reading_due_days
      ),
      water_missed_reading_action:
        property.water_missed_reading_action,
      apply_to_occupied_units:
        data.apply_to_occupied_units,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_latest_reading_for_unit(
  client,
  unit_id,
  billing_period
) {
  const result = await client.query(
    `
      SELECT *
      FROM water_meter_readings
      WHERE unit_id = $1
        AND billing_period <= $2
        AND status = 'submitted'
      ORDER BY
        billing_period DESC,
        id DESC
      LIMIT 1
    `,
    [unit_id, billing_period]
  );

  return result.rows[0] || null;
}

/*
  Corrects a reading that was typed in wrongly, and its bill
  with it.

  Any submitted reading can be edited, as long as it stays in
  line with the readings around it: the previous reading
  cannot go below the reading before it, the current reading
  cannot be below the previous one, and it cannot go above
  where the next reading of the unit starts.

  The bill follows the new figures at the rate it was billed
  at. If the tenant had paid more than the new bill, the excess
  goes back to them as credit, which then settles their other
  bills; if the new bill is higher, the difference is owed.
*/
async function edit_meter_reading(
  owner,
  reading_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const reading_result = await client.query(
      `
        SELECT
          water_meter_readings.*,
          TO_CHAR(
            water_meter_readings.billing_period,
            'YYYY-MM-DD'
          ) AS billing_period_text
        FROM water_meter_readings
        WHERE id = $1
          AND owner_id = $2
        FOR UPDATE
      `,
      [reading_id, owner.user_id]
    );

    const reading = reading_result.rows[0];

    if (!reading) {
      const error = new Error(
        "Water meter reading not found."
      );

      error.status_code = 404;
      throw error;
    }

    if (reading.status !== "submitted") {
      const error = new Error(
        reading.status === "flagged"
          ? "This reading is flagged. Use Correct reading to fix it."
          : "A rejected reading cannot be edited. Record a new reading instead."
      );

      error.status_code = 400;
      throw error;
    }

    /*
      The reading after this one, if there is one, starts from
      a figure that this reading must not pass.
    */
    const next_result = await client.query(
      `
        SELECT previous_reading
        FROM water_meter_readings
        WHERE unit_id = $1
          AND id <> $2
          AND status <> 'rejected'
          AND (
            billing_period > $3::DATE
            OR (billing_period = $3::DATE AND id > $2)
          )
        ORDER BY
          billing_period ASC,
          id ASC
        LIMIT 1
      `,
      [
        reading.unit_id,
        reading.id,
        reading.billing_period_text,
      ]
    );

    const next_starts_from = next_result.rows[0]
      ? Number(next_result.rows[0].previous_reading)
      : null;

    const before_result = await client.query(
      `
        SELECT current_reading
        FROM water_meter_readings
        WHERE unit_id = $1
          AND id <> $2
          AND status = 'submitted'
          AND (
            billing_period < $3::DATE
            OR (billing_period = $3::DATE AND id < $2)
          )
        ORDER BY
          billing_period DESC,
          id DESC
        LIMIT 1
      `,
      [
        reading.unit_id,
        reading.id,
        reading.billing_period_text,
      ]
    );

    const last_recorded = before_result.rows[0]
      ? Number(before_result.rows[0].current_reading)
      : null;

    const previous_reading =
      data.previous_reading !== undefined
        ? Number(data.previous_reading)
        : Number(reading.previous_reading);

    const current_reading =
      data.current_reading !== undefined
        ? Number(data.current_reading)
        : Number(reading.current_reading);

    if (
      last_recorded !== null &&
      previous_reading < last_recorded
    ) {
      const error = new Error(
        `The previous reading cannot be lower than ${last_recorded}, the reading recorded before this one.`
      );

      error.status_code = 422;
      throw error;
    }

    if (current_reading < previous_reading) {
      const error = new Error(
        "The current reading cannot be lower than the previous reading."
      );

      error.status_code = 422;
      throw error;
    }

    if (
      next_starts_from !== null &&
      current_reading > next_starts_from
    ) {
      const error = new Error(
        `The current reading cannot be higher than ${next_starts_from}, where the next reading of this unit starts. Edit that reading first.`
      );

      error.status_code = 422;
      throw error;
    }

    const units_used = current_reading - previous_reading;
    const rate_per_unit = Number(reading.rate_per_unit);

    const bill_amount = Number(
      (units_used * rate_per_unit).toFixed(2)
    );

    let charge = null;
    let credit_returned = 0;

    if (reading.tenant_charge_id) {
      const charge_result = await client.query(
        `
          SELECT *
          FROM tenant_charges
          WHERE id = $1
          FOR UPDATE
        `,
        [reading.tenant_charge_id]
      );

      charge = charge_result.rows[0] || null;
    }

    if (charge) {
      const settled = await client.query(
        `
          SELECT 1
          FROM deposit_applications
          WHERE tenant_charge_id = $1
          LIMIT 1
        `,
        [charge.id]
      );

      if (settled.rows[0]) {
        const error = new Error(
          "This bill was settled from the tenant's deposit when they moved out. Reopen their deposit reconciliation first."
        );

        error.status_code = 409;
        throw error;
      }

      const paid =
        charge.status === "void"
          ? 0
          : Number(charge.amount_paid);

      const new_paid = Math.min(paid, bill_amount);

      if (paid > new_paid) {
        await release_charge_payments(
          client,
          charge,
          paid - new_paid
        );

        credit_returned = Number(
          (paid - new_paid).toFixed(2)
        );
      }

      if (bill_amount <= 0) {
        /*
          A charge cannot have a zero amount, so a bill that
          is no longer owed keeps its amount and is void.
        */
        await client.query(
          `
            UPDATE tenant_charges
            SET
              amount_paid = 0,
              status = 'void'
            WHERE id = $1
          `,
          [charge.id]
        );
      } else {
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
          [bill_amount, new_paid, charge.id]
        );
      }
    }

    await client.query(
      `
        UPDATE water_meter_readings
        SET
          previous_reading = $1,
          current_reading = $2,
          units_used = $3,
          bill_amount = $4,
          notes = COALESCE($5, notes)
        WHERE id = $6
      `,
      [
        previous_reading,
        current_reading,
        units_used,
        bill_amount,
        data.notes ?? null,
        reading.id,
      ]
    );

    /*
      Credit that came back, or credit the tenant already
      held, settles what is now owed.
    */
    if (reading.tenant_id) {
      await apply_tenant_credits(client, reading.tenant_id);
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "WATER_METER_READING_EDITED",
      entity_type: "water_meter_reading",
      entity_id: reading.id,
      metadata: {
        property_id: Number(reading.property_id),
        unit_id: Number(reading.unit_id),
        tenant_id: reading.tenant_id
          ? Number(reading.tenant_id)
          : null,
        billing_period: reading.billing_period_text,
        was: {
          previous_reading: Number(reading.previous_reading),
          current_reading: Number(reading.current_reading),
          bill_amount: Number(reading.bill_amount),
        },
        now: {
          previous_reading,
          current_reading,
          bill_amount,
        },
        returned_as_credit: credit_returned,
      },
      ip_address,
    });

    const updated = await db.query(
      `
        SELECT
          water_meter_readings.*,
          tenants.full_name AS tenant_name,
          units.unit_number,
          tenant_charges.status AS bill_status,
          tenant_charges.amount_paid AS bill_amount_paid,
          TRUE AS can_edit
        FROM water_meter_readings
        LEFT JOIN tenant_charges
          ON tenant_charges.id =
            water_meter_readings.tenant_charge_id
        LEFT JOIN tenants
          ON tenants.id = water_meter_readings.tenant_id
        INNER JOIN units
          ON units.id = water_meter_readings.unit_id
        WHERE water_meter_readings.id = $1
      `,
      [reading.id]
    );

    return {
      ...public_reading(updated.rows[0]),
      returned_as_credit: credit_returned,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Cancels a reading that should not have been recorded, and
  its bill. What the tenant had paid towards the bill goes back
  to them as credit. The reading stays on the list as rejected,
  and a new one can then be recorded in its place.
*/
async function cancel_meter_reading(
  owner,
  reading_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const reading_result = await client.query(
      `
        SELECT
          water_meter_readings.*,
          TO_CHAR(
            water_meter_readings.billing_period,
            'YYYY-MM-DD'
          ) AS billing_period_text
        FROM water_meter_readings
        WHERE id = $1
          AND owner_id = $2
        FOR UPDATE
      `,
      [reading_id, owner.user_id]
    );

    const reading = reading_result.rows[0];

    if (!reading) {
      const error = new Error(
        "Water meter reading not found."
      );

      error.status_code = 404;
      throw error;
    }

    if (reading.status !== "submitted") {
      const error = new Error(
        reading.status === "flagged"
          ? "This reading is flagged. Use Correct reading to fix or reject it."
          : "This reading has already been cancelled."
      );

      error.status_code = 400;
      throw error;
    }

    let credit_returned = 0;

    if (reading.tenant_charge_id) {
      const charge_result = await client.query(
        `
          SELECT *
          FROM tenant_charges
          WHERE id = $1
          FOR UPDATE
        `,
        [reading.tenant_charge_id]
      );

      const charge = charge_result.rows[0];

      if (charge) {
        const settled = await client.query(
          `
            SELECT 1
            FROM deposit_applications
            WHERE tenant_charge_id = $1
            LIMIT 1
          `,
          [charge.id]
        );

        if (settled.rows[0]) {
          const error = new Error(
            "This bill was settled from the tenant's deposit when they moved out. Reopen their deposit reconciliation first."
          );

          error.status_code = 409;
          throw error;
        }

        const paid =
          charge.status === "void"
            ? 0
            : Number(charge.amount_paid);

        if (paid > 0) {
          await release_charge_payments(client, charge, paid);
          credit_returned = paid;
        }

        await client.query(
          `
            UPDATE tenant_charges
            SET
              amount_paid = 0,
              status = 'void'
            WHERE id = $1
          `,
          [charge.id]
        );
      }
    }

    await client.query(
      `
        UPDATE water_meter_readings
        SET
          status = 'rejected',
          tenant_charge_id = NULL,
          notes = $1,
          reviewed_by = $2,
          reviewed_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `,
      [
        `Cancelled: ${data.reason}`,
        owner.user_id,
        reading.id,
      ]
    );

    if (reading.tenant_id) {
      await apply_tenant_credits(client, reading.tenant_id);
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "WATER_METER_READING_CANCELLED",
      entity_type: "water_meter_reading",
      entity_id: reading.id,
      metadata: {
        property_id: Number(reading.property_id),
        unit_id: Number(reading.unit_id),
        tenant_id: reading.tenant_id
          ? Number(reading.tenant_id)
          : null,
        billing_period: reading.billing_period_text,
        previous_reading: Number(reading.previous_reading),
        current_reading: Number(reading.current_reading),
        bill_amount: Number(reading.bill_amount),
        tenant_charge_id: reading.tenant_charge_id
          ? Number(reading.tenant_charge_id)
          : null,
        returned_as_credit: credit_returned,
        reason: data.reason,
      },
      ip_address,
    });

    return {
      id: Number(reading.id),
      status: "rejected",
      returned_as_credit: credit_returned,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_previous_reading(
  owner,
  property_id,
  unit_id,
  billing_period_input
) {
  const billing_period = first_day_of_month(
    billing_period_input
  );

  const client = await db.get_client();

  try {
    await ensure_property_access(
      client,
      owner,
      property_id
    );

    const unit = await client.query(
      `
        SELECT id
        FROM units
        WHERE id = $1
          AND property_id = $2
      `,
      [unit_id, property_id]
    );

    if (!unit.rows[0]) {
      const error = new Error(
        "Unit not found in this property."
      );

      error.status_code = 404;
      throw error;
    }

    const previous = await get_latest_reading_for_unit(
      client,
      unit_id,
      billing_period
    );

    return {
      /*
        null when the unit has never been read.
      */
      previous_reading: previous
        ? Number(previous.current_reading)
        : null,
    };
  } finally {
    client.release();
  }
}

async function submit_meter_reading(
  owner,
  property_id,
  unit_id,
  data,
  ip_address
) {
  const billing_period = first_day_of_month(
    data.billing_period
  );

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const { property, owner_id } =
      await ensure_property_access(
        client,
        owner,
        property_id
      );

    const context_result = await client.query(
      `
        SELECT
          units.*,
          tenants.id AS tenant_id,
          tenants.owner_id AS tenant_owner_id,
          tenants.property_id AS tenant_property_id,
          tenants.unit_id AS tenant_unit_id,
          tenants.full_name AS tenant_name
        FROM units
        LEFT JOIN tenants
          ON tenants.unit_id = units.id
          AND tenants.status IN (
            'active',
            'notice_given'
          )
        WHERE units.id = $1
          AND units.property_id = $2
        FOR UPDATE OF units
      `,
      [unit_id, property_id]
    );

    const unit = context_result.rows[0];

    if (!unit) {
      const error = new Error(
        "Unit not found in this property."
      );

      error.status_code = 404;
      throw error;
    }

    if (
      unit.water_billing_method !==
      "per_unit_metered"
    ) {
      const error = new Error(
        "Meter readings can only be submitted for per-unit metered units."
      );

      error.status_code = 400;
      throw error;
    }

    if (!unit.tenant_id) {
      const error = new Error(
        "A meter reading can only be billed when the unit has an active tenant."
      );

      error.status_code = 400;
      throw error;
    }

    /*
      Each tenant is read once a month. A unit that changed
      tenant in the month is read again for the new tenant, and
      a tenant who is moving out may have one final reading on
      top of their ordinary one.
    */
    const this_month = await client.query(
      `
        SELECT id, is_final
        FROM water_meter_readings
        WHERE unit_id = $1
          AND billing_period = $2
          AND tenant_id = $3
          AND status <> 'rejected'
      `,
      [unit.id, billing_period, unit.tenant_id]
    );

    if (data.final_reading) {
      if (!this_month.rows.length) {
        const error = new Error(
          `${unit.tenant_name} has no reading for this month yet, so record this as an ordinary reading.`
        );

        error.status_code = 422;
        throw error;
      }

      if (this_month.rows.some((row) => row.is_final)) {
        const error = new Error(
          `A final reading has already been recorded for ${unit.tenant_name} this month.`
        );

        error.status_code = 409;
        throw error;
      }
    } else if (this_month.rows.length) {
      const error = new Error(
        `${unit.tenant_name} already has a reading for this month. If they are moving out, record a final reading to bill what they have used since.`
      );

      error.status_code = 409;
      throw error;
    }

    const previous =
      await get_latest_reading_for_unit(
        client,
        unit.id,
        billing_period
      );

    let previous_reading;

    /*
      The meter cannot have gone backwards since it was last
      read, so the previous reading starts from the unit's last
      recorded reading. It may be set higher, for water used
      while the unit stood empty, but never lower.
    */
    const last_recorded = previous
      ? Number(previous.current_reading)
      : null;

    if (
      previous &&
      data.previous_reading !== undefined &&
      Number(data.previous_reading) < last_recorded
    ) {
      const error = new Error(
        `The previous reading cannot be lower than ${last_recorded}, the last reading recorded for this unit.`
      );

      error.status_code = 422;
      throw error;
    }

    if (previous) {
      previous_reading =
        data.previous_reading !== undefined
          ? Number(data.previous_reading)
          : last_recorded;
    } else if (
      data.previous_reading !== undefined
    ) {
      previous_reading = Number(
        data.previous_reading
      );
    } else {
      const error = new Error(
        "previous_reading is required for this unit's first meter reading."
      );

      error.status_code = 422;
      throw error;
    }

    const current_reading = Number(
      data.current_reading
    );

    const suspicious =
      current_reading < previous_reading;

    const units_used = suspicious
      ? null
      : current_reading - previous_reading;

    const rate_per_unit = suspicious
      ? null
      : Number(unit.water_rate_per_unit);

    const bill_amount = suspicious
      ? null
      : Number(
        (units_used * rate_per_unit).toFixed(2)
      );

    let charge = null;

    if (!suspicious) {
      charge = await create_water_charge(
        client,
        {
          tenant: {
            id: unit.tenant_id,
            owner_id: unit.tenant_owner_id,
            property_id: unit.tenant_property_id,
            unit_id: unit.tenant_unit_id,
          },
          property,
          billing_period,
          amount: bill_amount,
          additional: data.final_reading,
        }
      );

      /*
        A water charge could already exist if this billing
        period was billed in another flow.
      */
      if (!charge) {
        const error = new Error(
          "A water bill already exists for this tenant and billing period."
        );

        error.status_code = 409;
        throw error;
      }
    }

    /*
      A reading of this tenant that was rejected is replaced by
      the new one.
    */
    await client.query(
      `
        DELETE FROM water_meter_readings
        WHERE unit_id = $1
          AND billing_period = $2
          AND tenant_id = $3
          AND status = 'rejected'
      `,
      [unit.id, billing_period, unit.tenant_id]
    );

    const reading_result = await client.query(
      `
        INSERT INTO water_meter_readings (
          owner_id,
          property_id,
          unit_id,
          tenant_id,
          billing_period,
          meter_number,
          previous_reading,
          current_reading,
          units_used,
          rate_per_unit,
          bill_amount,
          meter_photo_url,
          notes,
          status,
          flag_reason,
          tenant_charge_id,
          submitted_by,
          is_final
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,
          $18
        )
        RETURNING *
      `,
      [
        owner_id,
        property_id,
        unit.id,
        unit.tenant_id,
        billing_period,
        unit.water_meter_number,
        previous_reading,
        current_reading,
        units_used,
        rate_per_unit,
        bill_amount,
        data.meter_photo_url || null,
        data.notes || null,
        suspicious ? "flagged" : "submitted",
        suspicious
          ? "Current reading is lower than the previous reading."
          : null,
        charge?.id || null,
        owner.user_id,
        Boolean(data.final_reading),
      ]
    );

    await client.query("COMMIT");

    const reading = reading_result.rows[0];

    await log_audit({
      user_id: owner.user_id,
      action: suspicious
        ? "WATER_METER_READING_FLAGGED"
        : "WATER_METER_READING_SUBMITTED",
      entity_type: "water_meter_reading",
      entity_id: reading.id,
      metadata: {
        property_id,
        unit_id: unit.id,
        tenant_id: unit.tenant_id,
        billing_period,
        bill_amount,
        final_reading: Boolean(data.final_reading),
        previous_reading,

        /*
          Set when the owner raised the previous reading above
          the unit's last recorded one.
        */
        previous_reading_raised_from:
          last_recorded !== null &&
          previous_reading > last_recorded
            ? last_recorded
            : undefined,
      },
      ip_address,
    });

    /*
      Tells the owner by SMS, if they switched that alert on.
    */
    if (suspicious) {
      await alert_flagged_reading({
        owner_id,
        property,
        unit_number: unit.unit_number,
        previous_reading,
        current_reading,
      });
    }

    return public_reading({
      ...reading,
      tenant_name: unit.tenant_name,
      unit_number: unit.unit_number,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if (
      error.code === "23505" &&
      error.constraint ===
        "water_meter_readings_unit_id_billing_period_key"
    ) {
      const duplicate_error = new Error(
        "A meter reading already exists for this unit and billing period."
      );

      duplicate_error.status_code = 409;
      throw duplicate_error;
    }

    throw error;
  } finally {
    client.release();
  }
}

async function review_meter_reading(
  owner,
  reading_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        SELECT
          water_meter_readings.*,
          TO_CHAR(
            water_meter_readings.billing_period,
            'YYYY-MM-DD'
          ) AS billing_period_text,
          properties.rent_due_day,
          properties.water_billing_day
        FROM water_meter_readings
        INNER JOIN properties
          ON properties.id =
            water_meter_readings.property_id
        WHERE water_meter_readings.id = $1
          AND water_meter_readings.owner_id = $2
        FOR UPDATE
      `,
      [reading_id, owner.user_id]
    );

    const reading = result.rows[0];

    if (!reading) {
      const error = new Error(
        "Water meter reading not found."
      );

      error.status_code = 404;
      throw error;
    }

    if (reading.status !== "flagged") {
      const error = new Error(
        "Only flagged meter readings can be reviewed."
      );

      error.status_code = 400;
      throw error;
    }

    if (data.action === "reject") {
      const updated = await client.query(
        `
          UPDATE water_meter_readings
          SET
            status = 'rejected',
            notes = COALESCE($1, notes),
            reviewed_by = $2,
            reviewed_at = CURRENT_TIMESTAMP
          WHERE id = $3
          RETURNING *
        `,
        [
          data.notes || null,
          owner.user_id,
          reading.id,
        ]
      );

      await client.query("COMMIT");

      await log_audit({
        user_id: owner.user_id,
        action: "WATER_METER_READING_REJECTED",
        entity_type: "water_meter_reading",
        entity_id: reading.id,
        metadata: {
          unit_id: reading.unit_id,
          tenant_id: reading.tenant_id,
          notes: data.notes || null,
        },
        ip_address,
      });

      return public_reading(updated.rows[0]);
    }

    if (
      data.corrected_current_reading === undefined
    ) {
      const error = new Error(
        "corrected_current_reading is required when approving a flagged reading."
      );

      error.status_code = 422;
      throw error;
    }

    const corrected_current_reading = Number(
      data.corrected_current_reading
    );

    if (
      corrected_current_reading <
      Number(reading.previous_reading)
    ) {
      const error = new Error(
        "Corrected reading cannot be lower than the previous reading."
      );

      error.status_code = 422;
      throw error;
    }

    const unit_result = await client.query(
      `
        SELECT *
        FROM units
        WHERE id = $1
      `,
      [reading.unit_id]
    );

    const unit = unit_result.rows[0];

    const units_used =
      corrected_current_reading -
      Number(reading.previous_reading);

    const bill_amount = Number(
      (
        units_used *
        Number(unit.water_rate_per_unit)
      ).toFixed(2)
    );

    const charge = await create_water_charge(
      client,
      {
        tenant: {
          id: reading.tenant_id,
          owner_id: reading.owner_id,
          property_id: reading.property_id,
          unit_id: reading.unit_id,
        },
        property: reading,
        /*
          The due-date calculation expects a 'YYYY-MM-DD'
          string, not the Date object the column comes back as.
        */
        billing_period: reading.billing_period_text,
        amount: bill_amount,
        additional: Boolean(reading.is_final),
      }
    );

    if (!charge) {
      const error = new Error(
        "A water bill already exists for this tenant and billing period."
      );

      error.status_code = 409;
      throw error;
    }

    const updated_result = await client.query(
      `
        UPDATE water_meter_readings
        SET
          current_reading = $1,
          units_used = $2,
          rate_per_unit = $3,
          bill_amount = $4,
          status = 'submitted',
          flag_reason = NULL,
          notes = COALESCE($5, notes),
          reviewed_by = $6,
          reviewed_at = CURRENT_TIMESTAMP,
          tenant_charge_id = $7
        WHERE id = $8
        RETURNING *
      `,
      [
        corrected_current_reading,
        units_used,
        unit.water_rate_per_unit,
        bill_amount,
        data.notes || null,
        owner.user_id,
        charge.id,
        reading.id,
      ]
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "WATER_METER_READING_APPROVED",
      entity_type: "water_meter_reading",
      entity_id: reading.id,
      metadata: {
        bill_amount,
        tenant_charge_id: charge.id,
      },
      ip_address,
    });

    return public_reading(updated_result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function generate_fixed_monthly_bills(
  owner,
  property_id,
  data,
  ip_address
) {
  const billing_period = first_day_of_month(
    data.billing_period
  );

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const property = await ensure_owner_owns_property(
      client,
      owner.user_id,
      property_id
    );

    const tenants_result = await client.query(
      `
        SELECT
          tenants.id,
          tenants.owner_id,
          tenants.property_id,
          tenants.unit_id,
          tenants.full_name,
          units.unit_number,
          units.water_fixed_monthly_bill
        FROM tenants
        INNER JOIN units
          ON units.id = tenants.unit_id
        WHERE tenants.property_id = $1
          AND tenants.owner_id = $2
          AND tenants.status IN (
            'active',
            'notice_given'
          )
          AND units.water_billing_method =
            'fixed_monthly'
        FOR UPDATE OF tenants
      `,
      [property_id, owner.user_id]
    );

    const created = [];
    const skipped = [];

    for (const tenant of tenants_result.rows) {
      const amount = Number(
        tenant.water_fixed_monthly_bill
      );

      if (!Number.isFinite(amount) || amount <= 0) {
        skipped.push({
          tenant_id: Number(tenant.id),
          unit_number: tenant.unit_number,
          reason:
            "Unit has no valid fixed monthly water amount.",
        });

        continue;
      }

      const charge = await create_water_charge(
        client,
        {
          tenant,
          property,
          billing_period,
          amount,
        }
      );

      if (charge) {
        created.push({
          tenant_id: Number(tenant.id),
          unit_number: tenant.unit_number,
          tenant_charge_id: Number(charge.id),
          amount: Number(charge.amount_due),
        });
      } else {
        skipped.push({
          tenant_id: Number(tenant.id),
          unit_number: tenant.unit_number,
          reason:
            "Water bill already exists for this billing period.",
        });
      }
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "FIXED_MONTHLY_WATER_BILLS_GENERATED",
      entity_type: "property",
      entity_id: property_id,
      metadata: {
        billing_period,
        created_count: created.length,
        skipped_count: skipped.length,
      },
      ip_address,
    });

    return {
      property_id,
      billing_period,
      created,
      skipped,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function list_readings(
  owner,
  property_id,
  filters
) {
  const client = await db.get_client();

  try {
    const { owner_id } = await ensure_property_access(
      client,
      owner,
      property_id
    );

    const result = await client.query(
      `
        SELECT
          water_meter_readings.*,
          tenants.full_name AS tenant_name,
          units.unit_number,
          tenant_charges.status AS bill_status,
          tenant_charges.amount_paid AS bill_amount_paid,

          (
            water_meter_readings.status = 'submitted'

            AND NOT EXISTS (
              SELECT 1
              FROM deposit_applications
              WHERE deposit_applications.tenant_charge_id =
                water_meter_readings.tenant_charge_id
            )
          ) AS can_edit
        FROM water_meter_readings
        LEFT JOIN tenant_charges
          ON tenant_charges.id =
            water_meter_readings.tenant_charge_id
        LEFT JOIN tenants
          ON tenants.id =
            water_meter_readings.tenant_id
        INNER JOIN units
          ON units.id =
            water_meter_readings.unit_id
        WHERE water_meter_readings.owner_id = $1
          AND water_meter_readings.property_id = $2
          AND (
            $3::DATE IS NULL
            OR water_meter_readings.billing_period = $3
          )
          AND (
            $4::VARCHAR IS NULL
            OR water_meter_readings.status = $4
          )
        ORDER BY
          water_meter_readings.billing_period DESC,
          water_meter_readings.submitted_at DESC
      `,
      [
        owner_id,
        property_id,
        filters.billing_period
          ? first_day_of_month(
            filters.billing_period
          )
          : null,
        filters.status || null,
      ]
    );

    return result.rows.map(public_reading);
  } finally {
    client.release();
  }
}

async function get_water_stats(
  owner,
  property_id,
  billing_period
) {
  const client = await db.get_client();

  try {
    await ensure_property_access(
      client,
      owner,
      property_id
    );

    const period = billing_period
      ? first_day_of_month(billing_period)
      : new Date().toISOString().slice(0, 7) + "-01";

    const result = await client.query(
      `
        SELECT
          COALESCE(SUM(
            tenant_charges.amount_due
          ), 0) AS total_billed,

          COALESCE(SUM(
            tenant_charges.amount_paid
          ), 0) AS total_collected,

          COALESCE(SUM(
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          ), 0) AS outstanding,

          COUNT(*) FILTER (
            WHERE tenant_charges.status IN (
              'open',
              'partial'
            )
          ) AS open_bills,

          (
            SELECT COUNT(*)
            FROM water_meter_readings
            WHERE property_id = $1
              AND billing_period = $2
              AND status = 'flagged'
          ) AS flagged_readings,

          /*
            Metered, occupied units still waiting for this
            month's reading. A rejected reading does not count
            as received.
          */
          (
            SELECT COUNT(*)
            FROM units
            WHERE units.property_id = $1
              AND units.water_billing_method =
                'per_unit_metered'
              AND units.status = 'occupied'
              AND NOT EXISTS (
                SELECT 1
                FROM water_meter_readings
                WHERE water_meter_readings.unit_id = units.id
                  AND water_meter_readings.billing_period = $2
                  AND water_meter_readings.status <> 'rejected'
              )
          ) AS pending_readings
        FROM tenant_charges
        WHERE property_id = $1
          AND charge_type = 'water'
          AND billing_period = $2
      `,
      [property_id, period]
    );

    const stats = result.rows[0];

    return {
      property_id,
      billing_period: period,
      total_billed: Number(stats.total_billed),
      total_collected: Number(
        stats.total_collected
      ),
      outstanding: Number(stats.outstanding),
      open_bills: Number(stats.open_bills),
      flagged_readings: Number(
        stats.flagged_readings
      ),
      pending_readings: Number(
        stats.pending_readings
      ),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  update_water_rules,
  get_previous_reading,
  edit_meter_reading,
  cancel_meter_reading,
  submit_meter_reading,
  review_meter_reading,
  generate_fixed_monthly_bills,
  list_readings,
  get_water_stats,
};