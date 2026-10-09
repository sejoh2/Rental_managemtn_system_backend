const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

function public_unit(unit) {
  return {
    id: Number(unit.id),
    property_id: Number(unit.property_id),

    unit_number: unit.unit_number,
    unit_type: unit.unit_type,
    block_or_floor: unit.block_or_floor,

    monthly_rent: Number(unit.monthly_rent),
    rent_deposit: Number(unit.rent_deposit),

    /*
      Set by the owner. Zero means no water deposit.
    */
    water_deposit: Number(unit.water_deposit),

    water_billing_method:
      unit.water_billing_method,

    water_fixed_monthly_bill:
      unit.water_fixed_monthly_bill === null
        ? null
        : Number(unit.water_fixed_monthly_bill),

    water_rate_per_unit:
      unit.water_rate_per_unit === null
        ? null
        : Number(unit.water_rate_per_unit),

    water_meter_number: unit.water_meter_number,

    /*
      Optional fixed amount billed with rent each month.
      null means electricity is not billed for this unit.
    */
    electricity_monthly_charge:
      Number(unit.electricity_monthly_charge) > 0
        ? Number(unit.electricity_monthly_charge)
        : null,

    /*
      Optional one-off deposit charged in full at move-in.
    */
    electricity_deposit:
      Number(unit.electricity_deposit) > 0
        ? Number(unit.electricity_deposit)
        : null,

    status: unit.status,

    /*
      The active tenant and what they currently owe, so the
      Units page can show occupancy and arrears per house.
    */
    current_tenant: unit.current_tenant_id
      ? {
        tenant_id: Number(unit.current_tenant_id),
        full_name: unit.current_tenant_name,
        status: unit.current_tenant_status,
        balance: Number(unit.current_tenant_balance),
      }
      : null,

    created_at: unit.created_at,
    updated_at: unit.updated_at,
  };
}

const unit_overview_select = `
  SELECT
    units.*,
    current_tenant.tenant_id AS current_tenant_id,
    current_tenant.full_name AS current_tenant_name,
    current_tenant.status AS current_tenant_status,
    current_tenant.balance AS current_tenant_balance
  FROM units
  LEFT JOIN LATERAL (
    SELECT
      tenants.id AS tenant_id,
      tenants.full_name,
      tenants.status,
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
      ) AS balance
    FROM tenants
    WHERE tenants.unit_id = units.id
      AND tenants.status IN (
        'active',
        'notice_given'
      )
    ORDER BY tenants.created_at DESC
    LIMIT 1
  ) AS current_tenant ON TRUE
`;

async function load_public_unit(unit_id) {
  const result = await db.query(
    `
      ${unit_overview_select}
      WHERE units.id = $1
    `,
    [unit_id]
  );

  return public_unit(result.rows[0]);
}

/*
  Archived units keep their number, so the message covers
  both active and archived units.
*/
function throw_unit_number_conflict(error) {
  if (
    error.code === "23505" &&
    error.constraint === "units_property_id_unit_number_key"
  ) {
    const friendly_error = new Error(
      "This property already has a unit with that number, either active or archived."
    );

    friendly_error.status_code = 409;
    throw friendly_error;
  }

  throw error;
}

async function ensure_owner_owns_property(
  owner_id,
  property_id,
  client = db
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

  const property = result.rows[0];

  if (!property) {
    const error = new Error(
      "Property not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  return property;
}

async function get_unit_row_for_owner(
  owner_id,
  unit_id,
  client = db
) {
  const result = await client.query(
    `
      SELECT units.*
      FROM units
      INNER JOIN properties
        ON properties.id = units.property_id
      WHERE units.id = $1
        AND properties.owner_id = $2
    `,
    [unit_id, owner_id]
  );

  const unit = result.rows[0];

  if (!unit) {
    const error = new Error(
      "Unit not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  return unit;
}

function validate_final_water_configuration(unit) {
  if (
    unit.water_billing_method === "fixed_monthly" &&
    (!unit.water_fixed_monthly_bill ||
      Number(unit.water_fixed_monthly_bill) <= 0)
  ) {
    const error = new Error(
      "A fixed monthly water bill must be greater than zero."
    );

    error.status_code = 422;
    throw error;
  }

  if (
    unit.water_billing_method === "per_unit_metered" &&
    (!unit.water_rate_per_unit ||
      Number(unit.water_rate_per_unit) <= 0)
  ) {
    const error = new Error(
      "Water rate per unit must be greater than zero."
    );

    error.status_code = 422;
    throw error;
  }

  if (
    unit.water_billing_method === "per_unit_metered" &&
    !unit.water_meter_number
  ) {
    const error = new Error(
      "A water meter number is required for metered billing."
    );

    error.status_code = 422;
    throw error;
  }
}

async function create_unit(
  owner,
  property_id,
  data,
  ip_address
) {
  await ensure_owner_owns_property(
    owner.user_id,
    property_id
  );

  const result = await db.query(
    `
      INSERT INTO units (
        property_id,
        unit_number,
        unit_type,
        block_or_floor,
        monthly_rent,
        rent_deposit,
        water_deposit,
        water_billing_method,
        water_fixed_monthly_bill,
        water_rate_per_unit,
        water_meter_number,
        status,
        electricity_monthly_charge,
        electricity_deposit
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$14,$7,$8,$9,$10,$11,$12,$13
      )
      RETURNING *
    `,
    [
      property_id,
      data.unit_number,
      data.unit_type,
      data.block_or_floor || null,
      data.monthly_rent,
      data.rent_deposit,
      data.water_billing_method,

      data.water_billing_method === "fixed_monthly"
        ? data.water_fixed_monthly_bill
        : null,

      data.water_billing_method === "per_unit_metered"
        ? data.water_rate_per_unit
        : null,

      data.water_billing_method === "per_unit_metered"
        ? data.water_meter_number
        : null,

      data.status,

      data.electricity_monthly_charge || null,
      data.electricity_deposit || null,

      data.water_deposit || 0,
    ]
  ).catch(throw_unit_number_conflict);

  const unit = result.rows[0];

  await log_audit({
    user_id: owner.user_id,
    action: "UNIT_CREATED",
    entity_type: "unit",
    entity_id: unit.id,
    metadata: {
      property_id,
      unit_number: unit.unit_number,
      monthly_rent: unit.monthly_rent,
      rent_deposit: unit.rent_deposit,
      water_deposit: unit.water_deposit,
      water_billing_method:
        unit.water_billing_method,
    },
    ip_address,
  });

  return load_public_unit(unit.id);
}

async function list_property_units(owner, property_id) {
  await ensure_owner_owns_property(
    owner.user_id,
    property_id
  );

  const result = await db.query(
    `
      ${unit_overview_select}
      WHERE units.property_id = $1
        AND units.status != 'inactive'
      ORDER BY
        units.block_or_floor NULLS LAST,
        units.unit_number ASC
    `,
    [property_id]
  );

  return result.rows.map(public_unit);
}

async function get_unit_by_id(owner, unit_id) {
  const unit = await get_unit_row_for_owner(
    owner.user_id,
    unit_id
  );

  if (unit.status === "inactive") {
    const error = new Error("Unit not found.");

    error.status_code = 404;
    throw error;
  }

  return load_public_unit(unit.id);
}

async function update_unit(
  owner,
  unit_id,
  data,
  ip_address
) {
  const existing = await get_unit_row_for_owner(
    owner.user_id,
    unit_id
  );

  if (existing.status === "inactive") {
    const error = new Error(
      "Archived units cannot be updated."
    );

    error.status_code = 400;
    throw error;
  }

  const merged_unit = {
    ...existing,
    ...data,
  };

  /*
    Occupied is managed only by the upcoming tenant move-in flow.
  */
  if (data.status === "occupied") {
    const error = new Error(
      "Unit occupancy is managed when a tenant moves in."
    );

    error.status_code = 400;
    throw error;
  }

  /*
    A tenant still lives in an occupied unit, so its status
    can only change through the tenant move-out flow.
  */
  if (
    existing.status === "occupied" &&
    data.status !== undefined &&
    data.status !== "occupied"
  ) {
    const error = new Error(
      "This unit is occupied. Move the tenant out before changing its status."
    );

    error.status_code = 400;
    throw error;
  }

  validate_final_water_configuration(merged_unit);

  /*
    A rent change on an occupied unit is copied to the tenant
    living there in the same statement, so the two can never
    disagree. Charges that were already billed are not changed;
    the new rent applies to rent billed from now on.
  */
  const result = await db.query(
    `
      WITH updated_unit AS (
      UPDATE units
      SET
        unit_number = COALESCE($1, unit_number),
        unit_type = COALESCE($2, unit_type),
        block_or_floor = $3,
        monthly_rent = COALESCE($4, monthly_rent),
        rent_deposit = COALESCE($5, rent_deposit),

        water_billing_method =
          COALESCE($6, water_billing_method),

        water_fixed_monthly_bill = $7,
        water_rate_per_unit = $8,
        water_meter_number = $9,

        status = COALESCE($10, status),

        electricity_monthly_charge = CASE
          WHEN $12::BOOLEAN THEN $13::NUMERIC
          ELSE electricity_monthly_charge
        END,

        electricity_deposit = CASE
          WHEN $14::BOOLEAN THEN $15::NUMERIC
          ELSE electricity_deposit
        END,

        water_deposit = COALESCE($16, water_deposit)
      WHERE id = $11
      RETURNING *
      ),

      synced_tenant AS (
        UPDATE tenants
        SET monthly_rent = updated_unit.monthly_rent
        FROM updated_unit
        WHERE tenants.unit_id = updated_unit.id
          AND tenants.status IN (
            'active',
            'notice_given'
          )
          AND tenants.monthly_rent <>
            updated_unit.monthly_rent
        RETURNING tenants.id
      )

      SELECT
        updated_unit.*,
        (
          SELECT id
          FROM synced_tenant
          LIMIT 1
        ) AS rent_synced_tenant_id
      FROM updated_unit
    `,
    [
      data.unit_number ?? null,
      data.unit_type ?? null,

      Object.prototype.hasOwnProperty.call(
        data,
        "block_or_floor"
      )
        ? data.block_or_floor
        : existing.block_or_floor,

      data.monthly_rent ?? null,
      data.rent_deposit ?? null,

      data.water_billing_method ?? null,

      merged_unit.water_billing_method === "fixed_monthly"
        ? merged_unit.water_fixed_monthly_bill
        : null,

      merged_unit.water_billing_method === "per_unit_metered"
        ? merged_unit.water_rate_per_unit
        : null,

      merged_unit.water_billing_method === "per_unit_metered"
        ? merged_unit.water_meter_number
        : null,

      data.status ?? null,

      unit_id,

      Object.prototype.hasOwnProperty.call(
        data,
        "electricity_monthly_charge"
      ),

      data.electricity_monthly_charge || null,

      Object.prototype.hasOwnProperty.call(
        data,
        "electricity_deposit"
      ),

      data.electricity_deposit || null,

      data.water_deposit ?? null,
    ]
  ).catch(throw_unit_number_conflict);

  const unit = result.rows[0];

  await log_audit({
    user_id: owner.user_id,
    action: "UNIT_UPDATED",
    entity_type: "unit",
    entity_id: unit.id,
    metadata: data,
    ip_address,
  });

  if (unit.rent_synced_tenant_id) {
    await log_audit({
      user_id: owner.user_id,
      action: "TENANT_RENT_CHANGED",
      entity_type: "tenant",
      entity_id: unit.rent_synced_tenant_id,
      metadata: {
        unit_id: unit.id,
        unit_number: unit.unit_number,
        previous_monthly_rent: Number(
          existing.monthly_rent
        ),
        monthly_rent: Number(unit.monthly_rent),
      },
      ip_address,
    });
  }

  return load_public_unit(unit.id);
}

async function archive_unit(
  owner,
  unit_id,
  ip_address
) {
  const unit = await get_unit_row_for_owner(
    owner.user_id,
    unit_id
  );

  if (unit.status === "occupied") {
    const error = new Error(
      "An occupied unit cannot be archived. Move out the tenant first."
    );

    error.status_code = 400;
    throw error;
  }

  if (unit.status === "inactive") {
    const error = new Error(
      "This unit is already archived."
    );

    error.status_code = 400;
    throw error;
  }

  await db.query(
    `
      UPDATE units
      SET
        status = 'inactive',
        archived_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [unit_id]
  );

  await log_audit({
    user_id: owner.user_id,
    action: "UNIT_ARCHIVED",
    entity_type: "unit",
    entity_id: unit_id,
    metadata: {
      property_id: unit.property_id,
      unit_number: unit.unit_number,
    },
    ip_address,
  });
}

module.exports = {
  create_unit,
  list_property_units,
  get_unit_by_id,
  update_unit,
  archive_unit,
};