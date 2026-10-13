const express = require("express");

const water_controller = require(
  "./water_controller"
);

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();


/*
  For now, only owners can submit and review readings.
  When the caretaker mobile app is added, change the
  submission route to allow both owner and caretaker,
  then verify caretaker-property assignment in the service.
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

/*
  Meter readings are entered by the owner or by the caretaker
  assigned to the property. The service checks the assignment.
  Billing rules and reviewing flagged readings stay owner-only.
*/
const reading_guard = [
  authenticate,
  require_role("owner", "caretaker"),
];

router.put(
  "/properties/:property_id/water-billing-rules",
  guard,
  water_controller.update_water_rules
);

router.get(
  "/properties/:property_id/water-readings",
  reading_guard,
  water_controller.list_readings
);

router.get(
  "/properties/:property_id/water-billing/stats",
  reading_guard,
  water_controller.get_water_stats
);

router.get(
  "/properties/:property_id/units/:unit_id/water-readings/previous",
  reading_guard,
  water_controller.get_previous_reading
);

router.post(
  "/properties/:property_id/units/:unit_id/water-readings",
  reading_guard,
  water_controller.submit_meter_reading
);

router.post(
  "/properties/:property_id/water-bills/generate-fixed",
  guard,
  water_controller.generate_fixed_monthly_bills
);

router.patch(
  "/water-readings/:reading_id/review",
  guard,
  water_controller.review_meter_reading
);

module.exports = router;