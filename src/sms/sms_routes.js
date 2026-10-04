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
router.use(authenticate);
router.use(require_role("owner"));

router.get(
  "/sms/stats",
  sms_controller.get_sms_stats
);

router.post(
  "/sms/recipients/estimate",
  sms_controller.estimate_recipients
);

router.get(
  "/sms/templates",
  sms_controller.list_templates
);

router.post(
  "/sms/templates",
  sms_controller.create_template
);

router.patch(
  "/sms/templates/:template_id",
  sms_controller.update_template
);

router.delete(
  "/sms/templates/:template_id",
  sms_controller.delete_template
);

router.get(
  "/sms/broadcasts",
  sms_controller.list_broadcasts
);

router.post(
  "/sms/broadcasts",
  sms_controller.create_broadcast
);

router.post(
  "/sms/broadcasts/:broadcast_id/cancel",
  sms_controller.cancel_broadcast
);

router.get(
  "/sms/messages",
  sms_controller.list_messages
);

router.post(
  "/sms/messages/:message_id/retry",
  sms_controller.retry_message
);

module.exports = router;