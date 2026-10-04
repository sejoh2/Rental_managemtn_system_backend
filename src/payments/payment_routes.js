const express = require("express");

const payment_controller = require("./payment_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  Current Daraja callback URLs remain:
  /api/properties/c2b/validation
  /api/properties/c2b/confirmation

  The property confirmation controller delegates to
  payment_service.receive_mpesa_c2b_confirmation().
*/

/*
  Owner-facing routes.
*/
router.use(authenticate);
router.use(require_role("owner"));

router.get(
  "/payments",
  payment_controller.list_payments
);

router.get(
  "/payments/stats",
  payment_controller.get_payment_stats
);

router.get(
  "/payments/unmatched",
  payment_controller.list_unmatched_payments
);

router.get(
  "/payments/:payment_id",
  payment_controller.get_payment
);

router.post(
  "/payments/:payment_id/match",
  payment_controller.match_payment
);

router.get(
  "/tenants/:tenant_id/payments",
  payment_controller.list_tenant_payments
);

router.post(
  "/tenants/:tenant_id/payments/manual",
  payment_controller.record_manual_payment
);

/*
  Development/sandbox testing only.
*/
router.post(
  "/payments/mpesa/sandbox/simulate",
  payment_controller.simulate_sandbox_payment
);

module.exports = router;