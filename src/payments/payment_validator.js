const { z } = require("zod");
const { id_or_throw, zid } = require("../utils/ids");

const match_payment_schema = z.object({
  tenant_id: zid("tnt", "tenant"),

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

  /*
    Kodi found an unmatched M-Pesa payment that may be this same
    money, and the owner says it is a different payment: why.
  */
  duplicate_override_reason: z.string()
    .trim()
    .min(3)
    .max(500)
    .nullable()
    .optional(),
});

const possible_duplicates_schema = z.object({
  amount: z.coerce.number()
    .positive()
    .optional(),

  reference: z.string()
    .trim()
    .max(200)
    .optional(),
});

const dismiss_payment_schema = z.object({
  reason: z.string()
    .trim()
    .min(3)
    .max(500),
});

const export_payments_schema = z.object({
  property_id: zid("prp", "property")
    .optional(),

  status: z.enum([
    "matched",
    "unmatched",
    "reversed",
    "dismissed",
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
  payment_account_id: zid("pac", "payment account"),

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

function validate_id(value, label, prefix) {
  return id_or_throw(value, label, prefix);
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

  validate_possible_duplicates: (data) =>
    validate(possible_duplicates_schema, data),

  validate_dismiss_payment: (data) =>
    validate(dismiss_payment_schema, data),

  validate_sandbox_simulation: (data) =>
    validate(sandbox_simulation_schema, data),

  validate_payment_id: (value) =>
    validate_id(value, "payment", "pay"),

  validate_tenant_id: (value) =>
    validate_id(value, "tenant", "tnt"),
};