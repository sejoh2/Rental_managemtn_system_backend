const { z } = require("zod");
const { id_or_throw, zid } = require("../utils/ids");

const report_types = [
  "full_monthly_summary",
  "rent_collection",
  "water_billing",
  "occupancy_arrears",
  "sms_usage",
];

const report_periods = [
  "this_month",
  "last_month",
  "last_3_months",
  "last_6_months",
  "this_year",
];

const report_formats = [
  "pdf",
  "csv",
];

const dashboard_schema = z.object({
  property_id: zid("prp", "property")
    .optional(),

  period: z.enum(report_periods)
    .optional()
    .default("this_month"),
});

const export_schema = z.object({
  type: z.enum(report_types)
    .optional()
    .default("full_monthly_summary"),

  property_id: zid("prp", "property")
    .optional(),

  period: z.enum(report_periods)
    .optional()
    .default("this_month"),

  format: z.enum(report_formats)
    .optional()
    .default("pdf"),
});

const tenant_statement_schema = z.object({
  period: z.enum(report_periods)
    .optional()
    .default("last_6_months"),
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
  validate_dashboard_filters: (data) =>
    validate(
      dashboard_schema,
      data,
      "Report filters are invalid."
    ),

  validate_export_filters: (data) =>
    validate(
      export_schema,
      data,
      "Report export options are invalid."
    ),

  validate_tenant_statement_filters: (data) =>
    validate(
      tenant_statement_schema,
      data,
      "Tenant statement filters are invalid."
    ),

  validate_tenant_id: (value) =>
    validate_id(value, "tenant", "tnt"),
};