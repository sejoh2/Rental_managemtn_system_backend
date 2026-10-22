const express = require("express");
const { rateLimit } = require("express-rate-limit");

const water_controller = require(
  "./water_controller"
);

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
  Per network address, far above normal use: totals are heavy queries.
*/
const totals_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});


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

/*
  Correcting, cancelling and resolving a reading: the owner, or
  the caretaker assigned to the reading's property (the user's
  decision, 2026-10-13). The same rules apply to both.
*/
const reading_change_guard = [
  ...reading_guard,
  as_owner({
    property: property_of_record(
      "water_meter_readings",
      "reading_id"
    ),
    level: "can_read_meters",
  }),
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
  totals_limiter,
  // Billed and collected totals: the owner's alone.
  guard,
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

/*
  Owner only: correcting a reading changes the tenant's bill.
*/
router.patch(
  "/water-readings/:reading_id",
  reading_change_guard,
  water_controller.edit_meter_reading
);

router.post(
  "/water-readings/:reading_id/cancel",
  reading_change_guard,
  water_controller.cancel_meter_reading
);

router.patch(
  "/water-readings/:reading_id/review",
  reading_change_guard,
  water_controller.review_meter_reading
);

module.exports = router;