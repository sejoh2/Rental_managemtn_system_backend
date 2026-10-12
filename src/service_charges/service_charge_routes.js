const express = require("express");

const service_charge_controller = require(
  "./service_charge_controller"
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
  require_role("owner"),
];

router.get(
  "/properties/:property_id/service-charges",
  guard,
  service_charge_controller.list_service_charges
);

router.post(
  "/properties/:property_id/service-charges",
  guard,
  service_charge_controller.create_service_charge
);

router.patch(
  "/service-charges/:service_charge_id",
  guard,
  service_charge_controller.update_service_charge
);

router.delete(
  "/service-charges/:service_charge_id",
  guard,
  service_charge_controller.archive_service_charge
);

module.exports = router;
