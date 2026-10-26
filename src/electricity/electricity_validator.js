const { z } = require("zod");
const { id_or_throw, zid } = require("../utils/ids");

const period_schema = z.string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: "The month must look like 2026-10.",
  });

const list_bills_schema = z.object({
  period: period_schema.optional(),
});

/*
  The amount the owner types for each unit for one month.
  Zero removes a bill that has not been paid yet.
*/
const save_bills_schema = z.object({
  period: period_schema,

  bills: z.array(
    z.object({
      unit_id: zid("unt", "unit"),

      amount: z.coerce.number()
        .min(0),
    })
  ).min(1).max(1000),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error(
      "Electricity bill data is invalid."
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

function validate_property_id(value) {
  return id_or_throw(value, "property", "prp");
}

module.exports = {
  validate_list_bills: (data) =>
    validate(list_bills_schema, data),

  validate_save_bills: (data) =>
    validate(save_bills_schema, data),

  validate_property_id,
};
