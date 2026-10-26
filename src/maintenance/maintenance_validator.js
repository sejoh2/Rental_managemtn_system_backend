const { z } = require("zod");
const { id_or_throw, zid } = require("../utils/ids");

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

const charge_timings = [
  "now",
  "move_out",
];

const create_request_schema = z.object({
  unit_id: zid("unt", "unit")
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

  /*
    Who pays is chosen when the issue is reported and may be
    changed until the cost is recorded. Nothing is charged
    before the request is resolved with a cost.
  */
  charge_to_tenant: z.boolean()
    .default(false),

  charge_timing: z.enum(charge_timings)
    .default("now"),
});

const update_request_schema = z.object({
  status: z.enum(statuses)
    .optional(),

  priority: z.enum(priorities)
    .optional(),

  assigned_caretaker_id: zid("usr", "caretaker")
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

  charge_timing: z.enum(charge_timings)
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
  property_id: zid("prp", "property")
    .optional(),

  unit_id: zid("unt", "unit")
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

function validate_id(value, label, prefix) {
  return id_or_throw(value, label, prefix);
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
    validate_id(value, "property", "prp"),

  validate_request_id: (value) =>
    validate_id(value, "maintenance request", "mnt"),
};