const { z } = require("zod");

const categories = [
  "plumbing",
  "electrical",
  "water",
  "structural",
  "security",
  "cleaning",
  "appliance",
  "other",
];

const priorities = [
  "low",
  "normal",
  "high",
  "urgent",
];

const statuses = [
  "reported",
  "in_progress",
  "resolved",
  "cancelled",
];

const create_request_schema = z.object({
  unit_id: z.coerce.number()
    .int()
    .positive()
    .nullable()
    .optional(),

  title: z.string()
    .trim()
    .min(3)
    .max(255),

  description: z.string()
    .trim()
    .max(10000)
    .nullable()
    .optional(),

  category: z.enum(categories)
    .default("other"),

  priority: z.enum(priorities)
    .default("normal"),
});

const update_request_schema = z.object({
  status: z.enum(statuses)
    .optional(),

  priority: z.enum(priorities)
    .optional(),

  assigned_caretaker_id: z.coerce.number()
    .int()
    .positive()
    .nullable()
    .optional(),

  assigned_vendor_name: z.string()
    .trim()
    .max(255)
    .nullable()
    .optional(),

  estimated_cost: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  actual_cost: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  /*
    Owner only. Charges the actual cost to the tenant living
    in the unit when the request is resolved.
  */
  charge_to_tenant: z.boolean()
    .optional(),

  resolution_notes: z.string()
    .trim()
    .max(10000)
    .nullable()
    .optional(),

  cancellation_reason: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

const list_requests_schema = z.object({
  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  unit_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  status: z.enum(statuses)
    .optional(),

  priority: z.enum(priorities)
    .optional(),
});

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
  validate_create_request: (data) =>
    validate(
      create_request_schema,
      data,
      "Maintenance request data is invalid."
    ),

  validate_update_request: (data) =>
    validate(
      update_request_schema,
      data,
      "Maintenance update data is invalid."
    ),

  validate_list_requests: (data) =>
    validate(
      list_requests_schema,
      data,
      "Maintenance filters are invalid."
    ),

  validate_property_id: (value) =>
    validate_id(value, "property"),

  validate_request_id: (value) =>
    validate_id(value, "maintenance request"),
};