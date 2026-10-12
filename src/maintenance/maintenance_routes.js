const express = require("express");

const maintenance_controller = require(
  "./maintenance_controller"
);

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
  require_role("owner", "caretaker"),
];

router.get(
  "/maintenance/counts",
  guard,
  maintenance_controller.get_status_counts
);

router.get(
  "/maintenance",
  guard,
  maintenance_controller.list_requests
);

router.get(
  "/maintenance/:request_id",
  guard,
  maintenance_controller.get_request
);

router.post(
  "/properties/:property_id/maintenance",
  guard,
  maintenance_controller.create_request
);

router.patch(
  "/maintenance/:request_id",
  guard,
  maintenance_controller.update_request
);

/*
  Sent by hand: nothing tells the tenant automatically.
*/
router.post(
  "/maintenance/:request_id/charge-sms",
  guard,
  maintenance_controller.send_repair_charge_sms
);

module.exports = router;