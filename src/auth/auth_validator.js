const { z } = require("zod");

const phone_schema = z.object({
  phone: z.string().trim().min(1),
});

const verify_otp_schema = z.object({
  phone: z.string().trim().min(1),
  code: z.string().trim().regex(/^\d{6}$/),
});

const refresh_token_schema = z.object({
  refresh_token: z.string().min(1),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("Invalid request data.");

    error.status_code = 422;

    error.details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw error;
  }

  return result.data;
}

module.exports = {
  validate_request_otp: (data) => validate(phone_schema, data),
  validate_verify_otp: (data) => validate(verify_otp_schema, data),
  validate_refresh_token: (data) =>
    validate(refresh_token_schema, data),
};