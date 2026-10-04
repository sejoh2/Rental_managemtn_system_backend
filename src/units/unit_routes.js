const express = require("express");

const unit_controller = require("./unit_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

router.use(authenticate);

/*
  Owners exclusively manage their units.
  Caretaker permissions will be added later after caretakers
  and property assignment are implemented.
*/
router.use(require_role("owner"));

router.get(
  "/properties/:property_id/units",
  unit_controller.list_property_units
);

router.post(
  "/properties/:property_id/units",
  unit_controller.create_unit
);

router.get(
  "/units/:unit_id",
  unit_controller.get_unit
);

router.patch(
  "/units/:unit_id",
  unit_controller.update_unit
);

router.delete(
  "/units/:unit_id",
  unit_controller.archive_unit
);

module.exports = router;