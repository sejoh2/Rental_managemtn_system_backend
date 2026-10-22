const express = require("express");
const { z } = require("zod");

const file_service = require("./file_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const {
  as_owner,
} = require("../caretakers/caretaker_acting");

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

/*
  Attaching and opening files: the owner, or a caretaker in a
  property they are assigned to. Deleting stays with the owner,
  so proof cannot be removed by the person it is about.

  Tenant documents are personal papers; among caretakers only
  one who may manage tenants (level 2) reaches them.
*/
const staff = [
  authenticate,
  require_role("owner", "caretaker"),
];

/*
  The switch a caretaker needs for each kind of file.
*/
function level_for(kind) {
  return {
    tenant_document: "can_manage_tenants",
    expense_receipt: "can_add_expenses",
    meter_photo: "can_read_meters",
  }[kind] || "level_1";
}

/*
  For a request that names the record: ?kind=&target_id=
*/
const record_guard = [
  ...staff,
  as_owner({
    property: async (req, owner_id) => {
      const { kind, target_id } = validate(
        target_schema,
        req.query
      );

      const target = await file_service.get_target_or_throw(
        { user_id: owner_id },
        kind,
        target_id
      );

      return {
        property_id: target.property_id,
        level: level_for(kind),
      };
    },
  }),
];

/*
  For a request that names the file: /files/:file_id/...
*/
const file_guard = [
  ...staff,
  as_owner({
    property: async (req, owner_id) => {
      const file = await file_service.get_file_or_throw(
        { user_id: owner_id },
        file_id_or_throw(req.params.file_id)
      );

      return {
        property_id: file.property_id,
        level: level_for(file.kind),
      };
    },
  }),
];

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
  record_guard,
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
  staff,
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
  record_guard,
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
  file_guard,
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
