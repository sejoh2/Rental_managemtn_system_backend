const { z } = require("zod");

const user_id_schema = z.object({
  user_id: z.coerce.number().int().positive(),
});

function validate_user_id(params) {
  const result = user_id_schema.safeParse(params);

  if (!result.success) {
    const error = new Error("A valid user ID is required.");
    error.status_code = 422;
    throw error;
  }

  return result.data.user_id;
}

/*
  Letters in any language, with spaces, dots, hyphens and
  apostrophes.
*/
const name_field = z.string()
  .trim()
  .min(2, "Enter the person's name.")
  .max(100, "The name is too long.")
  .regex(
    /^\p{L}[\p{L}\s.'-]*$/u,
    "Use letters only in the name."
  );

const phone_field = z.string()
  .trim()
  .min(1, "Enter a phone number.")
  .max(30);

const create_owner_schema = z.object({
  full_name: name_field,
  phone: phone_field,
});

const update_user_schema = z.object({
  full_name: name_field.optional(),
  phone: phone_field.optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  {
    message: "Provide a name or a phone number to change.",
  }
);

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("User details are invalid.");

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
  validate_user_id,

  validate_create_owner: (data) =>
    validate(create_owner_schema, data),

  validate_update_user: (data) =>
    validate(update_user_schema, data),
};