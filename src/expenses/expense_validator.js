const { z } = require("zod");

const categories = [
  "repairs_maintenance",
  "security",
  "garbage",
  "cleaning",
  "utilities",
  "other",
];

const create_expense_schema = z.object({
  category: z.enum(categories),

  amount: z.coerce.number()
    .positive(),

  expense_date: z.string()
    .date(),

  notes: z.string()
    .trim()
    .max(5000)
    .nullable()
    .optional(),

  receipt_url: z.string()
    .url()
    .max(2000)
    .nullable()
    .optional(),

  /*
    The unit the cost was for. Leave it out, or send null, for
    a cost of the whole property.
  */
  unit_id: z.coerce.number()
    .int()
    .positive()
    .nullable()
    .optional(),
});

const update_expense_schema = create_expense_schema
  .partial()
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message: "Provide at least one field to change.",
    }
  );

const list_expenses_schema = z.object({
  property_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  category: z.enum(categories)
    .optional(),

  status: z.enum([
    "recorded",
    "void",
  ]).optional(),

  from_date: z.string()
    .date()
    .optional(),

  to_date: z.string()
    .date()
    .optional(),
});

const void_expense_schema = z.object({
  void_reason: z.string()
    .trim()
    .min(2)
    .max(5000),
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
  validate_create_expense: (data) =>
    validate(
      create_expense_schema,
      data,
      "Expense data is invalid."
    ),

  validate_list_expenses: (data) =>
    validate(
      list_expenses_schema,
      data,
      "Expense filters are invalid."
    ),

  validate_update_expense: (data) =>
    validate(
      update_expense_schema,
      data,
      "Expense data is invalid."
    ),

  validate_void_expense: (data) =>
    validate(
      void_expense_schema,
      data,
      "Expense void data is invalid."
    ),

  validate_property_id: (value) =>
    validate_id(value, "property"),

  validate_expense_id: (value) =>
    validate_id(value, "expense"),
};