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

router.use(authenticate);

/*
  For now, only owners can submit and review readings.
  When the caretaker mobile app is added, change the
  submission route to allow both owner and caretaker,
  then verify caretaker-property assignment in the service.
*/
router.use(require_role("owner"));

router.put(
  "/properties/:property_id/water-billing-rules",
  water_controller.update_water_rules
);

router.get(
  "/properties/:property_id/water-readings",
  water_controller.list_readings
);

router.get(
  "/properties/:property_id/water-billing/stats",
  water_controller.get_water_stats
);

router.post(
  "/properties/:property_id/units/:unit_id/water-readings",
  water_controller.submit_meter_reading
);

router.post(
  "/properties/:property_id/water-bills/generate-fixed",
  water_controller.generate_fixed_monthly_bills
);

router.patch(
  "/water-readings/:reading_id/review",
  water_controller.review_meter_reading
);

module.exports = router;