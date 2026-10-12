const { z } = require("zod");

const match_payment_schema = z.object({
  tenant_id: z.coerce.number()
    .int()
    .positive(),

  /*
    If true, the payer number becomes the tenant's
    future automatic M-Pesa matching number.
  */
  remember_payment_phone: z.boolean()
    .default(false),
});

const manual_payment_schema = z.object({
  amount: z.coerce.number()
    .positive(),

  payment_method: z.enum([
    "cash",
    "mpesa",
    "bank",
    "other",
  ]),

  account_for: z.enum([
    "rent",
    "water",
    "electricity",
    "service",
  ]).default("rent"),

  received_at: z.string()
    .datetime()
    .optional(),

  reference: z.string()
    .trim()
    .max(200)
    .nullable()
    .optional(),

  notes: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),
});

const export_payments_schema = z.object({
  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  status: z.enum([
    "matched",
    "unmatched",
    "reversed",
  ]).optional(),

  from_date: z.string()
    .date()
    .optional(),

  to_date: z.string()
    .date()
    .optional(),
});

const reverse_payment_schema = z.object({
  reason: z.string()
    .trim()
    .min(2)
    .max(5000),
});

const sandbox_simulation_schema = z.object({
  payment_account_id: z.coerce.number()
    .int()
    .positive(),

  phone: z.string()
    .trim()
    .min(1),

  amount: z.coerce.number()
    .positive(),

  bill_reference: z.string()
    .trim()
    .max(150)
    .optional(),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("Payment data is invalid.");

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
  validate_match_payment: (data) =>
    validate(match_payment_schema, data),

  validate_export_payments: (data) =>
    validate(export_payments_schema, data),

  validate_reverse_payment: (data) =>
    validate(reverse_payment_schema, data),

  validate_manual_payment: (data) =>
    validate(manual_payment_schema, data),

  validate_sandbox_simulation: (data) =>
    validate(sandbox_simulation_schema, data),

  validate_payment_id: (value) =>
    validate_id(value, "payment"),

  validate_tenant_id: (value) =>
    validate_id(value, "tenant"),
};