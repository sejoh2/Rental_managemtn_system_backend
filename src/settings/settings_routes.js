const express = require("express");

const settings_controller = require(
  "./settings_controller"
);

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  Settings are owner-only.

  Caretakers receive operational permissions only through
  their property assignment and Level 1 / Level 2 setting.
*/
router.use(authenticate);
router.use(require_role("owner"));

router.get(
  "/settings",
  settings_controller.get_settings
);

router.patch(
  "/settings/profile",
  settings_controller.update_profile
);

router.patch(
  "/settings/defaults",
  settings_controller.update_defaults
);

router.patch(
  "/settings/notifications",
  settings_controller.update_notifications
);

router.get(
  "/settings/audit-logs",
  settings_controller.list_audit_logs
);

router.get(
  "/settings/properties/:property_id",
  settings_controller.get_property_settings
);

module.exports = router;