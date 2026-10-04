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

module.exports = {
  validate_user_id,
};