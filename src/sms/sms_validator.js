const { z } = require("zod");

const recipient_groups = [
  "all_active_tenants",
  "tenants_with_arrears",
  "tenants_with_credit_balance",
  "property",
  "specific_tenant",
];

const variables_schema = z
  .record(
    z.string().trim().min(1).max(60),
    z.union([
      z.string().trim().max(300),
      z.number().finite(),
    ])
  )
  .optional()
  .default({});

const template_schema = z.object({
  name: z.string()
    .trim()
    .min(2)
    .max(120),

  body: z.string()
    .trim()
    .min(1)
    .max(1000),
});

const update_template_schema = template_schema.partial()
  .refine(
    (data) => Object.keys(data).length > 0,
    "At least one template field is required."
  );

const recipient_target_schema = z.object({
  recipient_group: z.enum(recipient_groups),

  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  tenant_id: z.coerce.number()
    .int()
    .positive()
    .optional(),
}).superRefine((data, context) => {
  if (
    data.recipient_group === "property" &&
    !data.property_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["property_id"],
      message: "property_id is required when sending to one property.",
    });
  }

  if (
    data.recipient_group === "specific_tenant" &&
    !data.tenant_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["tenant_id"],
      message: "tenant_id is required when sending to a specific tenant.",
    });
  }

  if (
    data.recipient_group !== "property" &&
    data.property_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["property_id"],
      message: "property_id is only valid for the property recipient group.",
    });
  }

  if (
    data.recipient_group !== "specific_tenant" &&
    data.tenant_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["tenant_id"],
      message: "tenant_id is only valid for the specific_tenant recipient group.",
    });
  }
});

const broadcast_schema = recipient_target_schema.extend({
  template_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  /*
    A template may be selected and then edited in the compose box.
    The edited body is saved as a broadcast snapshot.
  */
  message: z.string()
    .trim()
    .min(1)
    .max(1000)
    .optional(),

  variables: variables_schema,

  /*
    Omit send_at to send immediately.
    Use an ISO date with timezone when scheduling, for example:
    2026-10-01T08:00:00+03:00
  */
  send_at: z.string()
    .trim()
    .max(80)
    .optional(),
}).superRefine((data, context) => {
  if (!data.template_id && !data.message) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "Provide a template_id or a message.",
    });
  }

  if (data.send_at) {
    const date = new Date(data.send_at);

    if (Number.isNaN(date.getTime())) {
      context.addIssue({
        code: "custom",
        path: ["send_at"],
        message: "send_at must be a valid ISO date and time.",
      });
    } else if (date.getTime() <= Date.now()) {
      context.addIssue({
        code: "custom",
        path: ["send_at"],
        message: "send_at must be in the future.",
      });
    }
  }
});

const list_messages_schema = z.object({
  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  tenant_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  status: z.enum([
    "queued",
    "accepted",
    "failed",
    "cancelled",
  ]).optional(),

  limit: z.coerce.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(30),
});

const list_broadcasts_schema = z.object({
  status: z.enum([
    "scheduled",
    "sending",
    "completed",
    "partially_failed",
    "cancelled",
  ]).optional(),

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
  validate_create_template: (data) =>
    validate(
      template_schema,
      data,
      "SMS template data is invalid."
    ),

  validate_update_template: (data) =>
    validate(
      update_template_schema,
      data,
      "SMS template data is invalid."
    ),

  validate_recipient_target: (data) =>
    validate(
      recipient_target_schema,
      data,
      "SMS recipient selection is invalid."
    ),

  validate_broadcast: (data) =>
    validate(
      broadcast_schema,
      data,
      "SMS broadcast data is invalid."
    ),

  validate_list_messages: (data) =>
    validate(
      list_messages_schema,
      data,
      "SMS message filters are invalid."
    ),

  validate_list_broadcasts: (data) =>
    validate(
      list_broadcasts_schema,
      data,
      "SMS broadcast filters are invalid."
    ),

  validate_template_id: (value) =>
    validate_id(value, "SMS template"),

  validate_broadcast_id: (value) =>
    validate_id(value, "SMS broadcast"),

  validate_message_id: (value) =>
    validate_id(value, "SMS message"),
};