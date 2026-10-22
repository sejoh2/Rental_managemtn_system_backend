/*
  What the owner lets a property's caretaker do, one switch each,
  set per property. The words name the thing in refusals.
*/
const CARETAKER_PERMISSIONS = {
  can_read_meters: "meter readings",
  can_enter_electricity: "electricity bills",
  can_manage_maintenance: "maintenance",
  can_add_expenses: "expenses",
  can_view_tenants: "tenants",
  can_manage_tenants: "adding or changing tenants",
  can_record_payments: "recording payments",
};

/*
  A new caretaker may do the day-to-day work; managing tenants
  and taking money are turned on by the owner.
*/
const DEFAULT_PERMISSIONS = {
  can_read_meters: true,
  can_enter_electricity: true,
  can_manage_maintenance: true,
  can_add_expenses: true,
  can_view_tenants: true,
  can_manage_tenants: false,
  can_record_payments: false,
};

/*
  The old names still used in places: "level_1" is any assigned
  caretaker, "level_2" one who manages tenants.
*/
const OLD_LEVELS = {
  level_1: null,
  level_2: "can_manage_tenants",
};

function permission_needed(required) {
  if (Object.prototype.hasOwnProperty.call(OLD_LEVELS, required)) {
    return OLD_LEVELS[required];
  }

  if (Object.prototype.hasOwnProperty.call(CARETAKER_PERMISSIONS, required)) {
    return required;
  }

  throw new Error(`Unknown caretaker permission: ${required}`);
}

/*
  The assignment's switches, as the API shows them.
*/
function caretaker_permissions(assignment) {
  return Object.fromEntries(
    Object.keys(CARETAKER_PERMISSIONS).map((key) => [
      key,
      assignment[key] === true,
    ])
  );
}

/*
  The switches after a change. Managing tenants and recording
  payments both need the tenants to be visible, so they turn
  "view tenants" on with them.
*/
function merge_permissions(current, changes = {}) {
  const merged = { ...DEFAULT_PERMISSIONS, ...current };

  for (const key of Object.keys(CARETAKER_PERMISSIONS)) {
    if (typeof changes[key] === "boolean") merged[key] = changes[key];
  }

  if (merged.can_manage_tenants || merged.can_record_payments) {
    merged.can_view_tenants = true;
  }

  return merged;
}

async function get_caretaker_property_access(
  client,
  user,
  property_id,
  required = "level_1"
) {
  if (user.role !== "caretaker") {
    const error = new Error(
      "Caretaker access is required."
    );

    error.status_code = 403;
    throw error;
  }

  const result = await client.query(
    `
      SELECT
        property_caretaker_assignments.*
      FROM property_caretaker_assignments
      WHERE property_caretaker_assignments.property_id = $1
        AND property_caretaker_assignments.caretaker_id = $2
        AND property_caretaker_assignments.owner_id = $3
        AND property_caretaker_assignments.status = 'active'
      LIMIT 1
    `,
    [
      property_id,
      user.user_id,
      user.owner_id,
    ]
  );

  const assignment = result.rows[0];

  if (!assignment) {
    const error = new Error(
      "You are not assigned to this property."
    );

    error.status_code = 403;
    throw error;
  }

  const permission = permission_needed(required);

  if (permission && assignment[permission] !== true) {
    const error = new Error(
      `The owner has not given you access to ${CARETAKER_PERMISSIONS[permission]} for this property.`
    );

    error.status_code = 403;
    throw error;
  }

  return assignment;
}

module.exports = {
  CARETAKER_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  caretaker_permissions,
  merge_permissions,
  get_caretaker_property_access,
};
