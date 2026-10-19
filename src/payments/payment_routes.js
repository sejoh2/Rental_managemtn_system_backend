const express = require("express");

const payment_controller = require("./payment_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const {
  as_owner,
  property_of_record,
} = require("../caretakers/caretaker_acting");

const router = express.Router();

/*
  Daraja callback URLs, each with the payment account's secret:
  /api/properties/c2b/validation/<secret>
  /api/properties/c2b/confirmation/<secret>
  (the old ones without a secret no longer record payments).

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

/*
  Must stay above "/payments/:payment_id".
*/
router.get(
  "/payments/export",
  guard,
  payment_controller.export_payments
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

/*
  A payment handed over in person: the owner, or the property's
  caretaker when the owner has allowed it for that property.
*/
const manual_payment_guard = [
  authenticate,
  require_role("owner", "caretaker"),
  as_owner({
    property: property_of_record("tenants", "tenant_id"),
    permission: "can_record_payments",
    permission_message:
      "The owner has not allowed you to record payments for this property.",
  }),
];

router.post(
  "/tenants/:tenant_id/payments/manual",
  manual_payment_guard,
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