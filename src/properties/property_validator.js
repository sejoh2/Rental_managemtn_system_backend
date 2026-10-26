const { z } = require("zod");

const { PREFIX, zid } = require("../utils/ids");

const move_in_billing_options = [
  "prorated",
  "full_month",
  "free_until_next_month",
];

const move_out_billing_options = [
  "prorated",
  "full_month",
];

const service_charge_account_options = [
  "rent",
  "water",
  "electricity",
  "service",
];

const mpesa_account_schema = z.object({
  provider_code: z.literal("mpesa"),

  account_type: z.enum(["paybill", "till"]),

  business_number: z.string()
    .trim()
    .regex(/^\d{4,15}$/, {
      message: "Business number must contain 4 to 15 digits.",
    }),

  display_name: z.string()
    .trim()
    .min(1)
    .max(100)
    .optional(),

  account_name: z.string()
    .trim()
    .min(1)
    .max(150)
    .optional(),

  environment: z.enum(["sandbox", "production"]),

  credentials: z.object({
    consumer_key: z.string().trim().min(1),
    consumer_secret: z.string().trim().min(1),
  }),
});

const connect_account_schema = z.object({
  account_for: z.enum([
    "rent",
    "water",
    "electricity",
    "service",
  ]),
  account: mpesa_account_schema,

  /*
    Only sent when an existing property is changing this
    account, so it may keep its current business number.
  */
  property_id: zid(PREFIX.property, "property")
    .optional(),
});

const replace_account_schema = z.object({
  account_for: z.enum([
    "rent",
    "water",
    "electricity",
    "service",
  ]),
  connection_id: zid(PREFIX.connection_check, "connection"),
});

const create_property_schema = z.object({
  name: z.string().trim().min(2).max(255),

  location: z.string().trim().min(2).max(255),

  property_type: z.enum([
    "apartment_block",
    "bedsitters",
    "mixed_use",
    "single_rooms",
  ]).default("apartment_block"),

  expected_units: z.coerce.number()
    .int()
    .min(0)
    .default(0),

  rent_due_day: z.coerce.number()
    .int()
    .min(1)
    .max(28)
    .default(5),

  move_in_billing: z.enum(move_in_billing_options)
    .default("prorated"),

  move_out_billing: z.enum(move_out_billing_options)
    .default("prorated"),

  sms_sender_id: z.string()
    .trim()
    .max(50)
    .nullable()
    .optional(),

  water_billing_method: z.enum([
    "per_unit_metered",
    "fixed_monthly",
    "included_in_rent",
  ]).default("per_unit_metered"),

  water_rate_per_unit: z.coerce.number()
    .min(0)
    .default(100),

  water_fixed_fee: z.coerce.number()
    .min(0)
    .default(0),

  water_billing_day: z.string()
    .trim()
    .max(50)
    .default("same_as_rent"),

  water_reading_due_days: z.coerce.number()
    .int()
    .min(0)
    .max(31)
    .default(3),

  water_missed_reading_action: z.string()
    .trim()
    .max(50)
    .default("carry_forward"),

  rent_connection_id: zid(PREFIX.connection_check, "rent connection"),

  /*
    Water and electricity accounts are optional. Without one,
    those charges are paid through the rent account.
  */
  water_connection_id: zid(PREFIX.connection_check, "water connection")
    .nullable()
    .optional(),

  electricity_connection_id: zid(PREFIX.connection_check, "electricity connection")
    .nullable()
    .optional(),

  /*
    An optional account of their own for service charges
    and repairs.
  */
  service_connection_id: zid(PREFIX.connection_check, "service connection")
    .nullable()
    .optional(),

  /*
    The account tenants pay service charges and repairs into.
  */
  service_charge_account: z.enum(
    service_charge_account_options
  ).default("rent"),
}).superRefine((data, context) => {
  const connection_ids = [
    data.rent_connection_id,
    data.water_connection_id,
    data.electricity_connection_id,
    data.service_connection_id,
  ].filter(Boolean);

  if (
    data.service_charge_account !== "rent" &&
    !data[`${data.service_charge_account}_connection_id`]
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["service_charge_account"],
      message:
        "Connect that account first, or have service charges paid into the rent account.",
    });
  }

  if (
    new Set(connection_ids).size !==
    connection_ids.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rent_connection_id"],
      message:
        "Each payment account must use its own connection.",
    });
  }

  if (
    data.water_billing_method === "fixed_monthly" &&
    data.water_fixed_fee <= 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["water_fixed_fee"],
      message:
        "Fixed monthly water fee must be greater than zero.",
    });
  }
});

/*
  Water rules, payment accounts, and the caretaker are
  changed through their own endpoints.
*/
const update_property_schema = z.object({
  name: z.string().trim().min(2).max(255).optional(),

  location: z.string().trim().min(2).max(255).optional(),

  property_type: z.enum([
    "apartment_block",
    "bedsitters",
    "mixed_use",
    "single_rooms",
  ]).optional(),

  expected_units: z.coerce.number()
    .int()
    .min(0)
    .optional(),

  rent_due_day: z.coerce.number()
    .int()
    .min(1)
    .max(28)
    .optional(),

  move_in_billing: z.enum(move_in_billing_options)
    .optional(),

  move_out_billing: z.enum(move_out_billing_options)
    .optional(),

  service_charge_account: z.enum(
    service_charge_account_options
  ).optional(),

  sms_sender_id: z.string()
    .trim()
    .max(50)
    .nullable()
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

/*
  Every property keeps a rent account. Only the optional
  water, electricity and service charge accounts can be removed.
*/
const remove_account_schema = z.object({
  account_for: z.enum(
    ["water", "electricity", "service"],
    {
      message:
        "Only the water, electricity or service charge account can be removed. A property always needs a rent account.",
    }
  ),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("Property data is invalid.");

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
  validate_connect_account: (data) =>
    validate(connect_account_schema, data),

  validate_create_property: (data) =>
    validate(create_property_schema, data),

  validate_remove_account: (data) =>
    validate(remove_account_schema, data),

  validate_replace_account: (data) =>
    validate(replace_account_schema, data),

  validate_update_property: (data) =>
    validate(update_property_schema, data),
};