const { z } = require("zod");

const {
  validate_template_placeholders,
} = require("./agreement_template_service");

const template_schema = z.object({
  name: z.string()
    .trim()
    .min(2)
    .max(150)
    .optional(),

  content: z.string()
    .trim()
    .min(40)
    .max(30000),

  notice_period_days: z.coerce.number()
    .int()
    .min(1)
    .max(365)
    .default(30),
}).superRefine((data, context) => {
  try {
    validate_template_placeholders(data.content);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: error.message,
    });
  }
});

const sign_agreement_schema = z.object({
  signed_at: z.string()
    .date()
    .optional(),

  signed_notes: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),
});

const list_agreements_schema = z.object({
  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  status: z.enum([
    "awaiting_signature",
    "signed",
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
  validate_template: (data) =>
    validate(
      template_schema,
      data,
      "Agreement template data is invalid."
    ),

  validate_sign_agreement: (data) =>
    validate(
      sign_agreement_schema,
      data,
      "Agreement signing data is invalid."
    ),

  validate_list_agreements: (data) =>
    validate(
      list_agreements_schema,
      data,
      "Agreement filters are invalid."
    ),

  validate_property_id: (value) =>
    validate_id(value, "property"),

  validate_tenant_id: (value) =>
    validate_id(value, "tenant"),

  validate_agreement_id: (value) =>
    validate_id(value, "agreement"),
};