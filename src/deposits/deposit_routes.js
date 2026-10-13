const express = require("express");
const { z } = require("zod");

const deposit_service = require("./deposit_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  Amounts the owner keeps from the deposit at move-out,
  such as repainting. They come out of the rent deposit.
*/
const deductions_schema = z.object({
  deductions: z.array(
    z.object({
      description: z.string()
        .trim()
        .min(2)
        .max(200),

      amount: z.coerce.number()
        .positive(),
    })
  ).max(50).default([]),
});

const refund_schema = z.object({
  paid_on: z.string()
    .date(),

  method: z.enum([
    "mpesa",
    "cash",
    "bank",
    "other",
  ]),

  reference: z.string()
    .trim()
    .max(200)
    .nullable()
    .optional(),
});

function validate(schema, data) {
  const result = schema.safeParse(data || {});

  if (!result.success) {
    const error = new Error(
      "Deposit reconciliation data is invalid."
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

function validate_tenant_id(value) {
  const id = Number(value);

  if (!Number.isInteger(id) || id < 1) {
    const error = new Error(
      "A valid tenant ID is required."
    );

    error.status_code = 422;
    throw error;
  }

  return id;
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

function handle(action, message) {
  return async (req, res, next) => {
    try {
      const data = await action(
        req,
        validate_tenant_id(req.params.tenant_id)
      );

      return res.status(200).json({
        success: true,
        ...(message ? { message } : {}),
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}

router.get(
  "/tenants/:tenant_id/deposit-reconciliation",
  guard,
  handle((req, tenant_id) =>
    deposit_service.get_reconciliation(req.user, tenant_id)
  )
);

router.post(
  "/tenants/:tenant_id/deposit-reconciliation/calculate",
  guard,
  handle((req, tenant_id) =>
    deposit_service.calculate_reconciliation(
      req.user,
      tenant_id,
      validate(deductions_schema, req.body)
    )
  )
);

router.post(
  "/tenants/:tenant_id/deposit-reconciliation/confirm",
  guard,
  handle(
    (req, tenant_id) =>
      deposit_service.confirm_reconciliation(
        req.user,
        tenant_id,
        validate(deductions_schema, req.body),
        req.ip
      ),
    "Deposits reconciled successfully."
  )
);

const reopen_schema = z.object({
  reason: z.string()
    .trim()
    .min(3, "Say why the reconciliation is being reopened.")
    .max(500),
});

router.post(
  "/tenants/:tenant_id/deposit-reconciliation/reopen",
  guard,
  handle(
    (req, tenant_id) =>
      deposit_service.reopen_reconciliation(
        req.user,
        tenant_id,
        validate(reopen_schema, req.body),
        req.ip
      ),
    "Reconciliation reopened."
  )
);

router.post(
  "/tenants/:tenant_id/deposit-reconciliation/refund",
  guard,
  handle(
    (req, tenant_id) =>
      deposit_service.record_refund(
        req.user,
        tenant_id,
        validate(refund_schema, req.body),
        req.ip
      ),
    "Refund recorded successfully."
  )
);

module.exports = router;
