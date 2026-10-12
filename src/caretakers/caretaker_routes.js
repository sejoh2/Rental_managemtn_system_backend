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
  "/caretakers",
  guard,
  caretaker_controller.list_caretakers
);

router.get(
  "/caretakers/:caretaker_id",
  guard,
  caretaker_controller.get_caretaker
);

router.patch(
  "/caretakers/:caretaker_id",
  guard,
  caretaker_controller.update_caretaker
);

router.post(
  "/properties/:property_id/caretaker",
  guard,
  caretaker_controller.assign_caretaker
);

router.patch(
  "/properties/:property_id/caretaker",
  guard,
  caretaker_controller.update_property_caretaker
);

module.exports = router;