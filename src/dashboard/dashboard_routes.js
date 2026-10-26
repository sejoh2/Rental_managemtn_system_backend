const express = require("express");
const { z } = require("zod");
const { zid } = require("../utils/ids");

const dashboard_service = require("./dashboard_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

const home_schema = z.object({
  property_id: zid("prp", "property")
    .optional(),
});

const search_schema = z.object({
  q: z.string()
    .trim()
    .min(2)
    .max(100),
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error(
      "Dashboard request is invalid."
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

/*
  The guard is attached to each route, not to the whole router.
  This router is mounted on "/api" next to the others, and a
  router-wide check would also refuse requests meant for them.
*/
const guard = [
  authenticate,
  require_role("owner"),
];

function handle(action) {
  return async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await action(req),
      });
    } catch (error) {
      next(error);
    }
  };
}

router.get(
  "/dashboard/home",
  guard,
  handle((req) =>
    dashboard_service.get_home(
      req.user,
      validate(home_schema, req.query)
    )
  )
);

router.get(
  "/dashboard/attention",
  guard,
  handle((req) =>
    dashboard_service.get_attention(req.user)
  )
);

router.get(
  "/dashboard/search",
  guard,
  handle((req) =>
    dashboard_service.search(
      req.user,
      validate(search_schema, req.query).q
    )
  )
);

module.exports = router;
