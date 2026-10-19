const express = require("express");
const { rateLimit } = require("express-rate-limit");

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
  Per network address, far above what the phone app needs. Stops
  anyone from flooding the server or the database.
*/
const notices_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});


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

/*
  What is new: the caretaker's list for the phone app's bell,
  and "Mark all as read" (the caretaker's list, or the owner's
  repairs marked done by the caretaker).
*/
router.get(
  "/maintenance/notices",
  notices_limiter,
  guard,
  maintenance_controller.list_notices
);

router.post(
  "/maintenance/notices/seen",
  notices_limiter,
  guard,
  maintenance_controller.mark_notices_seen
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