async function get_caretaker_property_access(
  client,
  user,
  property_id,
  required_level = "level_1"
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

  if (
    required_level === "level_2" &&
    assignment.permission_level !== "level_2"
  ) {
    const error = new Error(
      "Level 2 caretaker permission is required for this action."
    );

    error.status_code = 403;
    throw error;
  }

  return assignment;
}

module.exports = {
  get_caretaker_property_access,
};