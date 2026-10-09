const { z } = require("zod");

const profile_schema = z.object({
  full_name: z.string()
    .trim()
    .min(2)
    .max(200)
    .optional(),

  email: z.string()
    .trim()
    .email()
    .max(255)
    .nullable()
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  "Provide at least one profile field to update."
);

const defaults_schema = z.object({
  default_rent_due_day: z.coerce.number()
    .int()
    .min(1)
    .max(28),
});

const notifications_schema = z.object({
  notify_payment_received: z.boolean()
    .optional(),

  auto_rent_reminder: z.boolean()
    .optional(),

  remind_water_readings: z.boolean()
    .optional(),

  alert_suspicious_water: z.boolean()
    .optional(),

  weekly_collection_summary: z.boolean()
    .optional(),

  monthly_profit_report: z.boolean()
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  "Provide at least one notification preference."
);

const audit_filters_schema = z.object({
  limit: z.coerce.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(30),
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

function validate_property_id(value) {
  const property_id = Number(value);

  if (
    !Number.isInteger(property_id) ||
    property_id < 1
  ) {
    const error = new Error(
      "A valid property ID is required."
    );

    error.status_code = 422;

    throw error;
  }

  return property_id;
}

module.exports = {
  validate_profile: (data) =>
    validate(
      profile_schema,
      data,
      "Profile data is invalid."
    ),

  validate_defaults: (data) =>
    validate(
      defaults_schema,
      data,
      "Owner defaults are invalid."
    ),

  validate_notifications: (data) =>
    validate(
      notifications_schema,
      data,
      "Notification preferences are invalid."
    ),

  validate_audit_filters: (data) =>
    validate(
      audit_filters_schema,
      data,
      "Audit log filters are invalid."
    ),

  validate_property_id,
};