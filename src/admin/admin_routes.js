const express = require("express");

const { z } = require("zod");

const admin_service = require("./admin_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  System administrators only.
*/
router.use(authenticate);
router.use(require_role("admin"));

const audit_filters_schema = z.object({
  owner_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  user_id: z.coerce.number()
    .int()
    .positive()
    .optional(),

  action: z.string()
    .trim()
    .max(100)
    .optional(),

  from_date: z.string()
    .date()
    .optional(),

  to_date: z.string()
    .date()
    .optional(),

  limit: z.coerce.number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50),

  offset: z.coerce.number()
    .int()
    .min(0)
    .optional()
    .default(0),
});

router.get(
  "/audit-logs/actions",
  async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await admin_service.list_audit_actions(),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/audit-logs",
  async (req, res, next) => {
    try {
      const result = audit_filters_schema.safeParse(
        req.query
      );

      if (!result.success) {
        const error = new Error(
          "Audit log filters are invalid."
        );

        error.status_code = 422;

        error.details = result.error.issues.map(
          (issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })
        );

        throw error;
      }

      const { total, logs } =
        await admin_service.list_audit_logs(result.data);

      return res.status(200).json({
        success: true,
        total,
        data: logs,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
