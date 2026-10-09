const { z } = require("zod");

const create_tenant_schema = z.object({
  unit_id: z.coerce.number()
    .int()
    .positive(),

  full_name: z.string()
    .trim()
    .min(2)
    .max(200),

  /*
    This becomes payment_phone after Kenyan phone normalization.
  */
  phone: z.string()
    .trim()
    .min(1),

  email: z.string()
    .trim()
    .email()
    .nullable()
    .optional(),

  national_id: z.string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  move_in_date: z.string()
    .date(),
});

const update_tenant_schema = z.object({
  full_name: z.string()
    .trim()
    .min(2)
    .max(200)
    .optional(),

  phone: z.string()
    .trim()
    .min(1)
    .optional(),

  email: z.string()
    .trim()
    .email()
    .nullable()
    .optional(),

  national_id: z.string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  status: z.enum([
    "active",
    "notice_given",
  ]).optional(),

  notice_date: z.string()
    .date()
    .nullable()
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

const move_out_schema = z.object({
  move_out_date: z.string()
    .date(),

  deposit_refund_decision: z.enum([
    "full_refund",
    "partial_refund",
    "no_refund",
  ]).optional(),

  move_out_reason: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),
});

const list_tenants_schema = z.object({
  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  status: z.enum([
    "active",
    "notice_given",
    "moved_out",
    "inactive",
  ]).optional(),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("Tenant data is invalid.");

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
  validate_create_tenant: (data) =>
    validate(create_tenant_schema, data),

  validate_update_tenant: (data) =>
    validate(update_tenant_schema, data),

  validate_list_tenants: (data) =>
    validate(list_tenants_schema, data),

  validate_move_out: (data) =>
    validate(move_out_schema, data),

  validate_property_id: (value) =>
    validate_id(value, "property"),

  validate_tenant_id: (value) =>
    validate_id(value, "tenant"),
};