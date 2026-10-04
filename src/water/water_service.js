const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

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

function calculate_due_date(property, billing_period) {
  const period = new Date(
    `${billing_period}T00:00:00.000Z`
  );

  let day = 1;

  if (property.water_billing_day === "same_as_rent") {
    const match = String(
      property.rent_due_day || ""
    ).match(/\d{1,2}/);

    day = match ? Number(match[0]) : 1;
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

async function create_water_charge(
  client,
  {
    tenant,
    property,
    billing_period,
    amount,
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
        amount_due
      )
      VALUES (
        $1,$2,$3,$4,
        'water',$5,$6,$7
      )
      ON CONFLICT (
        tenant_id,
        charge_type,
        billing_period
      )
      DO NOTHING
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
      ? ["vacant", "reserved", "occupied"]
      : ["vacant", "reserved"];

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
        AND billing_period < $2
        AND status = 'submitted'
      ORDER BY billing_period DESC
      LIMIT 1
    `,
    [unit_id, billing_period]
  );

  return result.rows[0] || null;
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

    const property = await ensure_owner_owns_property(
      client,
      owner.user_id,
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

    const previous =
      await get_latest_reading_for_unit(
        client,
        unit.id,
        billing_period
      );

    let previous_reading;

    if (previous) {
      previous_reading = Number(
        previous.current_reading
      );
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
          submitted_by
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17
        )
        RETURNING *
      `,
      [
        owner.user_id,
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
      },
      ip_address,
    });

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
        billing_period: reading.billing_period,
        amount: bill_amount,
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
    await ensure_owner_owns_property(
      client,
      owner.user_id,
      property_id
    );

    const result = await client.query(
      `
        SELECT
          water_meter_readings.*,
          tenants.full_name AS tenant_name,
          units.unit_number
        FROM water_meter_readings
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
        owner.user_id,
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
    await ensure_owner_owns_property(
      client,
      owner.user_id,
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
          ) AS flagged_readings
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
    };
  } finally {
    client.release();
  }
}

module.exports = {
  update_water_rules,
  submit_meter_reading,
  review_meter_reading,
  generate_fixed_monthly_bills,
  list_readings,
  get_water_stats,
};