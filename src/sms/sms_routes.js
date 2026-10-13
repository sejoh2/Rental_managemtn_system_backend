const express = require("express");

const sms_controller = require("./sms_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  Bulk tenant SMS and templates are owner-only.
  Caretakers cannot send broadcasts.
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
  "/sms/stats",
  guard,
  sms_controller.get_sms_stats
);

router.post(
  "/sms/recipients/estimate",
  guard,
  sms_controller.estimate_recipients
);

router.get(
  "/sms/templates",
  guard,
  sms_controller.list_templates
);

router.post(
  "/sms/templates",
  guard,
  sms_controller.create_template
);

router.patch(
  "/sms/templates/:template_id",
  guard,
  sms_controller.update_template
);

router.delete(
  "/sms/templates/:template_id",
  guard,
  sms_controller.delete_template
);

router.get(
  "/sms/broadcasts",
  guard,
  sms_controller.list_broadcasts
);

router.post(
  "/sms/broadcasts",
  guard,
  sms_controller.create_broadcast
);

router.patch(
  "/sms/broadcasts/:broadcast_id",
  guard,
  sms_controller.update_broadcast
);

router.post(
  "/sms/broadcasts/:broadcast_id/cancel",
  guard,
  sms_controller.cancel_broadcast
);

router.get(
  "/sms/messages",
  guard,
  sms_controller.list_messages
);

router.post(
  "/sms/messages/:message_id/retry",
  guard,
  sms_controller.retry_message
);

module.exports = router;