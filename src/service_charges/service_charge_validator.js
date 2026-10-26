const { z } = require("zod");
const { id_or_throw, zid } = require("../utils/ids");

const categories = [
  "repairs_maintenance",
  "security",
  "garbage",
  "cleaning",
  "utilities",
  "other",
];

/*
  A unit listed here pays its own amount instead of the
  charge's amount. Zero means the unit is not charged.
*/
const unit_amounts_schema = z.array(
  z.object({
    unit_id: zid("unt", "unit"),

    amount: z.coerce.number()
      .min(0),
  })
).max(1000);

const create_service_charge_schema = z.object({
  name: z.string()
    .trim()
    .min(2)
    .max(100),

  category: z.enum(categories),

  frequency: z.enum(["monthly", "once"]),

  /*
    For a monthly charge, when the tenants already living in
    the property are first billed: 'now' for the rest of this
    month, or 'next_billing' to start with the next monthly
    billing run. A one-off charge is always billed now.
  */
  first_billing: z.enum(["now", "next_billing"])
    .default("now"),

  amount: z.coerce.number()
    .min(0),

  unit_amounts: unit_amounts_schema
    .default([]),
}).refine(
  (data) =>
    data.amount > 0 ||
    data.unit_amounts.some((item) => item.amount > 0),
  {
    path: ["amount"],
    message:
      "Enter an amount greater than zero for the charge or for at least one unit.",
  }
);

/*
  The frequency cannot be changed once the charge exists,
  because tenants have already been billed under it.
*/
const update_service_charge_schema = z.object({
  name: z.string()
    .trim()
    .min(2)
    .max(100)
    .optional(),

  category: z.enum(categories)
    .optional(),

  amount: z.coerce.number()
    .min(0)
    .optional(),

  unit_amounts: unit_amounts_schema
    .optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide at least one field to update.",
  }
);

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error(
      "Service charge data is invalid."
    );

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
  validate_create_service_charge: (data) =>
    validate(create_service_charge_schema, data),

  validate_update_service_charge: (data) =>
    validate(update_service_charge_schema, data),

  validate_property_id: (value) =>
    validate_id(value, "property", "prp"),

  validate_service_charge_id: (value) =>
    validate_id(value, "service charge", "svc"),
};
