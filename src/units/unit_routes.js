const express = require("express");

const unit_controller = require("./unit_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const {
  as_owner,
  property_in_path,
} = require("../caretakers/caretaker_acting");

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

/*
  The owner, or the caretaker assigned to the property. Adding
  and changing units stays with the owner.
*/
const list_guard = [
  authenticate,
  require_role("owner", "caretaker"),
  as_owner({ property: property_in_path }),
];

router.get(
  "/properties/:property_id/units",
  list_guard,
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

router.post(
  "/units/:unit_id/restore",
  guard,
  unit_controller.restore_unit
);

router.delete(
  "/units/:unit_id",
  guard,
  unit_controller.archive_unit
);

module.exports = router;