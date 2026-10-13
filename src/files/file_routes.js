const express = require("express");
const { z } = require("zod");

const file_service = require("./file_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  The guard is attached to each route, not to the whole router.
  This router is mounted on "/api" next to the others, and a
  router-wide check would also refuse requests meant for them.
*/
const guard = [
  authenticate,
  require_role("owner"),
];

const kind_field = z.enum(Object.keys(file_service.kinds));

const id_field = z.coerce.number()
  .int()
  .positive();

const target_schema = z.object({
  kind: kind_field,
  target_id: id_field,
});

const upload_schema = target_schema.extend({
  name: z.string()
    .trim()
    .min(1)
    .max(255),

  label: z.string()
    .trim()
    .max(120)
    .optional(),
});

const counts_schema = z.object({
  kind: kind_field,

  /*
    "12,15,19"
  */
  target_ids: z.string()
    .trim()
    .regex(/^\d+(,\d+){0,499}$/),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("File details are invalid.");

    error.status_code = 422;

    error.details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw error;
  }

  return result.data;
}

function file_id_or_throw(value) {
  const result = id_field.safeParse(value);

  if (!result.success) {
    const error = new Error("A valid file ID is required.");

    error.status_code = 422;
    throw error;
  }

  return result.data;
}

function respond(handler, status = 200) {
  return async (req, res, next) => {
    try {
      return res.status(status).json({
        success: true,
        data: await handler(req),
      });
    } catch (error) {
      next(error);
    }
  };
}

router.get(
  "/files",
  guard,
  respond((req) => {
    const { kind, target_id } = validate(
      target_schema,
      req.query
    );

    return file_service.list_files(req.user, kind, target_id);
  })
);

router.get(
  "/files/counts",
  guard,
  respond((req) => {
    const { kind, target_ids } = validate(
      counts_schema,
      req.query
    );

    return file_service.count_files(
      req.user,
      kind,
      target_ids.split(",").map(Number)
    );
  })
);

/*
  The file itself is the request body, with its type in the
  Content-Type header; what it is attached to is in the query.
  The size limit is a little above the service's own 5 MB, so
  the service can answer with its clearer message.
*/
router.post(
  "/files",
  guard,
  express.raw({
    type: () => true,
    limit: file_service.MAX_BYTES + 256 * 1024,
  }),
  respond((req) => {
    const data = validate(upload_schema, req.query);

    return file_service.upload_file(
      req.user,
      data,
      req.body,
      String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase(),
      req.ip
    );
  }, 201)
);

router.get(
  "/files/:file_id/link",
  guard,
  respond((req) =>
    file_service.get_file_link(
      req.user,
      file_id_or_throw(req.params.file_id),
      req.ip
    )
  )
);

router.delete(
  "/files/:file_id",
  guard,
  respond(async (req) => {
    await file_service.delete_file(
      req.user,
      file_id_or_throw(req.params.file_id),
      req.ip
    );

    return null;
  })
);

module.exports = router;
