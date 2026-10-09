const express = require("express");

const unit_controller = require("./unit_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();


/*
  Owners exclusively manage their units.
  Caretaker permissions will be added later after caretakers
  and property assignment are implemented.
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
  "/properties/:property_id/units",
  guard,
  unit_controller.list_property_units
);

router.post(
  "/properties/:property_id/units",
  guard,
  unit_controller.create_unit
);

router.get(
  "/units/:unit_id",
  guard,
  unit_controller.get_unit
);

router.patch(
  "/units/:unit_id",
  guard,
  unit_controller.update_unit
);

router.delete(
  "/units/:unit_id",
  guard,
  unit_controller.archive_unit
);

module.exports = router;