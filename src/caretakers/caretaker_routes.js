const express = require("express");

const caretaker_controller = require(
  "./caretaker_controller"
);

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

router.use(authenticate);
router.use(require_role("owner"));

router.get(
  "/caretakers",
  caretaker_controller.list_caretakers
);

router.get(
  "/caretakers/:caretaker_id",
  caretaker_controller.get_caretaker
);

router.post(
  "/properties/:property_id/caretaker",
  caretaker_controller.assign_caretaker
);

router.patch(
  "/properties/:property_id/caretaker",
  caretaker_controller.update_property_caretaker
);

module.exports = router;