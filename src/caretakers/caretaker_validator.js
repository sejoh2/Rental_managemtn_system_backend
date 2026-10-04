const { z } = require("zod");

const permission_levels = [
  "level_1",
  "level_2",
];

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

  permission_level: z.enum(permission_levels)
    .default("level_1"),
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