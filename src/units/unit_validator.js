const { z } = require("zod");

const water_billing_methods = [
  "fixed_monthly",
  "per_unit_metered",
  "included_in_rent",
];

const unit_types = [
  "bedsitter",
  "studio",
  "one_bedroom",
  "two_bedroom",
  "three_bedroom",
  "shop",
  "office",
  "other",
];

const editable_statuses = [
  "vacant",
  "reserved",
  "maintenance",
  "inactive",
];

/*
  Occupied status must only be set later by the Tenants move-in flow.
*/
const create_unit_schema = z.object({
  unit_number: z.string().trim().min(1).max(100),

  unit_type: z.enum(unit_types).default("other"),

  block_or_floor: z.string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  monthly_rent: z.coerce.number().positive(),

  rent_deposit: z.coerce.number().min(0),

  water_billing_method: z.enum(water_billing_methods),

  water_fixed_monthly_bill: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  water_rate_per_unit: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  water_meter_number: z.string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  /*
    Optional fixed amount billed with rent each month.
  */
  electricity_monthly_charge: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  /*
    Optional one-off deposit charged in full at move-in.
  */
  electricity_deposit: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  status: z.enum(editable_statuses)
    .default("vacant"),
}).superRefine((data, context) => {
  if (
    data.water_billing_method === "fixed_monthly" &&
    (!data.water_fixed_monthly_bill ||
      data.water_fixed_monthly_bill <= 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["water_fixed_monthly_bill"],
      message:
        "A fixed monthly water bill must be greater than zero.",
    });
  }

  if (
    data.water_billing_method === "per_unit_metered" &&
    (!data.water_rate_per_unit ||
      data.water_rate_per_unit <= 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["water_rate_per_unit"],
      message:
        "Water rate per unit must be greater than zero.",
    });
  }

  if (
    data.water_billing_method === "per_unit_metered" &&
    !data.water_meter_number
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["water_meter_number"],
      message:
        "A water meter number is required for metered billing.",
    });
  }
});

const update_unit_schema = z.object({
  unit_number: z.string()
    .trim()
    .min(1)
    .max(100)
    .optional(),

  unit_type: z.enum(unit_types).optional(),

  block_or_floor: z.string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  monthly_rent: z.coerce.number()
    .positive()
    .optional(),

  rent_deposit: z.coerce.number()
    .min(0)
    .optional(),

  water_billing_method: z.enum(water_billing_methods)
    .optional(),

  water_fixed_monthly_bill: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  water_rate_per_unit: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  water_meter_number: z.string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  /*
    Optional fixed amount billed with rent each month.
  */
  electricity_monthly_charge: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  /*
    Optional one-off deposit charged in full at move-in.
  */
  electricity_deposit: z.coerce.number()
    .min(0)
    .nullable()
    .optional(),

  status: z.enum(editable_statuses)
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

function validate(schema, value) {
  const result = schema.safeParse(value);

  if (!result.success) {
    const error = new Error("Unit data is invalid.");

    error.status_code = 422;

    error.details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw error;
  }

  return result.data;
}

function validate_property_id(value) {
  const property_id = Number(value);

  if (!Number.isInteger(property_id) || property_id < 1) {
    const error = new Error(
      "A valid property ID is required."
    );

    error.status_code = 422;
    throw error;
  }

  return property_id;
}

function validate_unit_id(value) {
  const unit_id = Number(value);

  if (!Number.isInteger(unit_id) || unit_id < 1) {
    const error = new Error(
      "A valid unit ID is required."
    );

    error.status_code = 422;
    throw error;
  }

  return unit_id;
}

module.exports = {
  validate_create_unit: (data) =>
    validate(create_unit_schema, data),

  validate_update_unit: (data) =>
    validate(update_unit_schema, data),

  validate_property_id,
  validate_unit_id,
};