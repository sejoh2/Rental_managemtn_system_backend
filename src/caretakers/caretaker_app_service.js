const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

/*
  The properties a caretaker looks after, with what they may do
  in each. This is where the caretaker app starts.
*/
async function list_my_properties(caretaker) {
  const result = await db.query(
    `
      SELECT
        properties.id,
        properties.name,
        properties.location,
        properties.rent_due_day,
        properties.water_billing_method,
        properties.water_rate_per_unit,
        properties.water_fixed_fee,
        properties.move_in_billing,
        property_caretaker_assignments.permission_level,
        property_caretaker_assignments.can_record_payments,

        (
          SELECT COUNT(*)
          FROM units
          WHERE units.property_id = properties.id
            AND units.status <> 'inactive'
        ) AS total_units,

        (
          SELECT COUNT(*)
          FROM units
          WHERE units.property_id = properties.id
            AND units.status = 'occupied'
        ) AS occupied_units

      FROM property_caretaker_assignments
      INNER JOIN properties
        ON properties.id =
          property_caretaker_assignments.property_id
      WHERE property_caretaker_assignments.caretaker_id = $1
        AND property_caretaker_assignments.owner_id = $2
        AND property_caretaker_assignments.status = 'active'
        AND properties.status = 'active'
      ORDER BY properties.name
    `,
    [caretaker.user_id, caretaker.owner_id]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    location: row.location,
    rent_due_day: row.rent_due_day,
    water_billing_method: row.water_billing_method,
    water_rate_per_unit:
      row.water_rate_per_unit === null
        ? null
        : Number(row.water_rate_per_unit),
    water_fixed_fee:
      row.water_fixed_fee === null
        ? null
        : Number(row.water_fixed_fee),
    // How the first month's rent is billed when a tenant moves in mid-month.
    move_in_billing: row.move_in_billing,
    total_units: Number(row.total_units),
    occupied_units: Number(row.occupied_units),

    /*
      What this caretaker may do in this property.
    */
    permission_level: row.permission_level,
    can_manage_tenants: row.permission_level === "level_2",
    can_record_payments: row.can_record_payments === true,
  }));
}

/*
  The owner allows, or stops allowing, a property's caretaker
  to record payments handed to them (cash, cheque, bank).
*/
async function set_payment_permission(
  owner,
  property_id,
  allowed,
  ip_address
) {
  const result = await db.query(
    `
      UPDATE property_caretaker_assignments
      SET can_record_payments = $1
      WHERE property_id = $2
        AND owner_id = $3
        AND status = 'active'
      RETURNING id, caretaker_id, can_record_payments
    `,
    [allowed, property_id, owner.user_id]
  );

  const assignment = result.rows[0];

  if (!assignment) {
    const error = new Error(
      "This property has no caretaker, or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  await log_audit({
    user_id: owner.user_id,
    action: "CARETAKER_PAYMENT_PERMISSION_CHANGED",
    entity_type: "caretaker_assignment",
    entity_id: assignment.id,
    metadata: {
      caretaker_id: Number(assignment.caretaker_id),
      property_id,
      can_record_payments: assignment.can_record_payments,
    },
    ip_address,
  });

  return {
    assignment_id: Number(assignment.id),
    property_id,
    caretaker_id: Number(assignment.caretaker_id),
    can_record_payments: assignment.can_record_payments,
  };
}

module.exports = {
  list_my_properties,
  set_payment_permission,
};
