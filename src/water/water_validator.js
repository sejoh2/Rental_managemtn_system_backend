const { z } = require("zod");

const water_methods = [
  "per_unit_metered",
  "fixed_monthly",
  "included_in_rent",
];

const missed_reading_actions = [
  "carry_forward",
  "do_not_bill",
  "estimate_average",
];

const water_rules_schema = z.object({
  water_billing_method: z.enum(water_methods),

  water_rate_per_unit: z.coerce.number()
    .min(0)
    .optional(),

  water_fixed_fee: z.coerce.number()
    .min(0)
    .optional(),

  water_billing_day: z.string()
    .trim()
    .min(1)
    .max(50)
    .default("same_as_rent"),

  water_reading_due_days: z.coerce.number()
    .int()
    .min(0)
    .max(31)
    .default(3),

  water_missed_reading_action: z.enum(
    missed_reading_actions
  ).default("carry_forward"),

  /*
    Property-level rules are copied to units.
    False protects currently occupied units unless explicitly requested.
  */
  apply_to_occupied_units: z.boolean()
    .default(false),
}).superRefine((data, context) => {
  if (
    data.water_billing_method ===
      "per_unit_metered" &&
    (!data.water_rate_per_unit ||
      data.water_rate_per_unit <= 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["water_rate_per_unit"],
      message:
        "A metered property requires a water rate greater than zero.",
    });
  }

  if (
    data.water_billing_method ===
      "fixed_monthly" &&
    (!data.water_fixed_fee ||
      data.water_fixed_fee <= 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["water_fixed_fee"],
      message:
        "A fixed-monthly property requires a water fee greater than zero.",
    });
  }
});

const submit_reading_schema = z.object({
  billing_period: z.string().date(),

  current_reading: z.coerce.number()
    .min(0),

  /*
    Required only for the first ever reading of a unit.
  */
  previous_reading: z.coerce.number()
    .min(0)
    .optional(),

  /*
    A second reading for a tenant who was already read this
    month, taken when they move out, so they are billed for
    what they used since.
  */
  final_reading: z.boolean()
    .optional()
    .default(false),

  meter_photo_url: z.string()
    .url()
    .max(2000)
    .nullable()
    .optional(),

  notes: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),
});

const review_reading_schema = z.object({
  action: z.enum([
    "approve",
    "reject",
  ]),

  /*
    Required if correcting a suspicious meter entry.
  */
  corrected_current_reading: z.coerce.number()
    .min(0)
    .optional(),

  notes: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),
});

const generate_fixed_bills_schema = z.object({
  billing_period: z.string().date(),
});

const list_readings_schema = z.object({
  billing_period: z.string()
    .date()
    .optional(),

  status: z.enum([
    "submitted",
    "flagged",
    "rejected",
  ]).optional(),
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
  validate_water_rules: (data) =>
    validate(
      water_rules_schema,
      data,
      "Water billing rules are invalid."
    ),

  validate_submit_reading: (data) =>
    validate(
      submit_reading_schema,
      data,
      "Water meter reading data is invalid."
    ),

  validate_review_reading: (data) =>
    validate(
      review_reading_schema,
      data,
      "Water meter-reading review data is invalid."
    ),

  validate_generate_fixed_bills: (data) =>
    validate(
      generate_fixed_bills_schema,
      data,
      "Water billing generation data is invalid."
    ),

  validate_list_readings: (data) =>
    validate(
      list_readings_schema,
      data,
      "Water reading filters are invalid."
    ),

  validate_property_id: (value) =>
    validate_id(value, "property"),

  validate_unit_id: (value) =>
    validate_id(value, "unit"),

  validate_reading_id: (value) =>
    validate_id(value, "water reading"),
};