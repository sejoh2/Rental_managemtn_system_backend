const express = require("express");

const { z } = require("zod");

const admin_service = require("./admin_service");

const platform_service = require("./admin_platform_service");

const sender_service = require("../sms/sender_approval_service");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  send_csv,
} = require("../utils/csv");

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
  "/overview",
  async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await admin_service.get_overview(),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/owners/:owner_id/open",
  async (req, res, next) => {
    try {
      const owner_id = Number(req.params.owner_id);

      if (!Number.isInteger(owner_id) || owner_id < 1) {
        const error = new Error(
          "A valid owner ID is required."
        );

        error.status_code = 422;
        throw error;
      }

      return res.status(200).json({
        success: true,
        data: await admin_service.open_owner_account(
          req.user,
          owner_id,
          req.ip
        ),
      });
    } catch (error) {
      next(error);
    }
  }
);

function positive_id(value, label) {
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

function respond(handler) {
  return async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await handler(req),
      });
    } catch (error) {
      next(error);
    }
  };
}

router.get(
  "/owners/:owner_id",
  respond((req) =>
    platform_service.get_owner_detail(
      positive_id(req.params.owner_id, "owner")
    )
  )
);

router.get(
  "/notifications",
  respond(() => platform_service.get_notifications())
);

router.get(
  "/system",
  respond(() => platform_service.get_system_status())
);

router.get(
  "/sms-usage",
  respond(() => platform_service.get_sms_usage())
);

router.get(
  "/sender-ids",
  respond(() => sender_service.list_sender_requests())
);

const review_schema = z.object({
  decision: z.enum(["approved", "rejected"]),

  note: z.string()
    .trim()
    .max(500)
    .nullable()
    .optional(),
});

router.post(
  "/sender-ids/:request_id/review",
  respond((req) => {
    const result = review_schema.safeParse(req.body);

    if (!result.success) {
      const error = new Error(
        "Choose to approve or reject the sender ID."
      );

      error.status_code = 422;
      throw error;
    }

    return sender_service.review_sender_request(
      req.user,
      positive_id(req.params.request_id, "request"),
      {
        decision: result.data.decision,
        note: result.data.note || null,
      },
      req.ip
    );
  })
);

/*
  The filtered audit log as a CSV file. The download itself is
  written to the audit log.
*/
router.get(
  "/audit-logs/export",
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
        throw error;
      }

      const rows =
        await platform_service.get_audit_export_rows(
          result.data
        );

      await log_audit({
        user_id: req.user.user_id,
        action: "AUDIT_LOG_EXPORTED",
        entity_type: "audit_log",
        metadata: {
          rows: rows.length,
          owner_id: result.data.owner_id || null,
          user_id: result.data.user_id || null,
          action: result.data.action || null,
          from_date: result.data.from_date || null,
          to_date: result.data.to_date || null,
        },
        ip_address: req.ip,
      });

      return send_csv(
        res,
        "kodi-audit-log.csv",
        platform_service.audit_export_headers,
        rows
      );
    } catch (error) {
      next(error);
    }
  }
);

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

router.get(
  "/audit-logs/:log_id",
  respond((req) =>
    admin_service.get_audit_log(
      positive_id(req.params.log_id, "audit entry")
    )
  )
);

module.exports = router;
