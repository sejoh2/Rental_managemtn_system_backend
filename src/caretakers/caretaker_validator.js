const { z } = require("zod");

const permission_levels = [
  "level_1",
  "level_2",
];

/*
  The switches, any of them; the rest keep their value (or the
  default for a new caretaker).
*/
const permissions_schema = z.object({
  can_read_meters: z.boolean().optional(),
  can_enter_electricity: z.boolean().optional(),
  can_manage_maintenance: z.boolean().optional(),
  can_add_expenses: z.boolean().optional(),
  can_view_tenants: z.boolean().optional(),
  can_manage_tenants: z.boolean().optional(),
  can_record_payments: z.boolean().optional(),
}).strict();

const assign_caretaker_schema = z.object({
  phone: z.string()
    .trim()
    .min(1),

  first_name: z.string()
    .trim()
    .min(2)
    .max(100),

  last_name: z.string()
    .trim()
    .min(2)
    .max(100),

  /*
    Older form: level_2 turns "manage tenants" on.
  */
  permission_level: z.enum(permission_levels)
    .optional(),

  permissions: permissions_schema.optional(),
});

const update_caretaker_schema = z.object({
  first_name: z.string()
    .trim()
    .min(2)
    .max(100)
    .optional(),

  last_name: z.string()
    .trim()
    .min(2)
    .max(100)
    .optional(),

  permission_level: z.enum(permission_levels)
    .optional(),

  permissions: permissions_schema.optional(),

  status: z.enum([
    "active",
    "inactive",
  ]).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

/*
  The caretaker's own details, whichever properties they have.
*/
const update_caretaker_details_schema = z.object({
  first_name: z.string()
    .trim()
    .min(2)
    .max(100)
    .optional(),

  last_name: z.string()
    .trim()
    .min(2)
    .max(100)
    .optional(),

  phone: z.string()
    .trim()
    .min(1)
    .optional(),

  status: z.enum([
    "active",
    "suspended",
  ]).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

function validate(schema, data, message) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error(message);

    error.status_code = 422;

    error.details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw error;
  }

  return result.data;
}

function validate_id(value, label) {
  const id = Number(value);

  if (!Number.isInteger(id) || id < 1) {
    const error = new Error(
      `A valid ${label} ID is required.`
    );

    error.status_code = 422;
    throw error;
  }

  return id;
}

module.exports = {
  validate_update_caretaker_details: (data) =>
    validate(
      update_caretaker_details_schema,
      data,
      "Caretaker update data is invalid."
    ),

  validate_assign_caretaker: (data) =>
    validate(
      assign_caretaker_schema,
      data,
      "Caretaker data is invalid."
    ),

  validate_update_caretaker: (data) =>
    validate(
      update_caretaker_schema,
      data,
      "Caretaker update data is invalid."
    ),

  validate_property_id: (value) =>
    validate_id(value, "property"),

  validate_caretaker_id: (value) =>
    validate_id(value, "caretaker"),
};