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
      Always returned so the frontend can show the
      KES 2,000 fixed water deposit requirement.
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

    status: unit.status,

    created_at: unit.created_at,
    updated_at: unit.updated_at,
  };
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
        status
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,2000,$7,$8,$9,$10,$11
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
    ]
  );

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

  return public_unit(unit);
}

async function list_property_units(owner, property_id) {
  await ensure_owner_owns_property(
    owner.user_id,
    property_id
  );

  const result = await db.query(
    `
      SELECT *
      FROM units
      WHERE property_id = $1
        AND status != 'inactive'
      ORDER BY
        block_or_floor NULLS LAST,
        unit_number ASC
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

  return public_unit(unit);
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

  validate_final_water_configuration(merged_unit);

  const result = await db.query(
    `
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

        status = COALESCE($10, status)
      WHERE id = $11
      RETURNING *
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
    ]
  );

  const unit = result.rows[0];

  await log_audit({
    user_id: owner.user_id,
    action: "UNIT_UPDATED",
    entity_type: "unit",
    entity_id: unit.id,
    metadata: data,
    ip_address,
  });

  return public_unit(unit);
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