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
/*
  The guard is attached to each route, not to the whole router.
  This router is mounted on "/api" next to the others, and a
  router-wide check would also refuse requests meant for them.
*/
const guard = [
  authenticate,
  require_role("owner"),
];

router.get(
  "/payments",
  guard,
  payment_controller.list_payments
);

router.get(
  "/payments/stats",
  guard,
  payment_controller.get_payment_stats
);

router.get(
  "/payments/unmatched",
  guard,
  payment_controller.list_unmatched_payments
);

router.get(
  "/payments/:payment_id",
  guard,
  payment_controller.get_payment
);

router.post(
  "/payments/:payment_id/match",
  guard,
  payment_controller.match_payment
);

router.post(
  "/payments/:payment_id/reverse",
  guard,
  payment_controller.reverse_payment
);

router.get(
  "/tenants/:tenant_id/payments",
  guard,
  payment_controller.list_tenant_payments
);

router.post(
  "/tenants/:tenant_id/payments/manual",
  guard,
  payment_controller.record_manual_payment
);

/*
  Development/sandbox testing only.
*/
router.post(
  "/payments/mpesa/sandbox/simulate",
  guard,
  payment_controller.simulate_sandbox_payment
);

module.exports = router;