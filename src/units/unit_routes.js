const express = require("express");
const { rateLimit } = require("express-rate-limit");

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

const db = require("../config/db");

/*
  The property of the unit in /units/:unit_id, if it is in the
  owner's account (units carry no owner of their own).
*/
async function property_of_unit(req, owner_id) {
  const unit_id = Number(req.params.unit_id);

  if (!Number.isInteger(unit_id) || unit_id < 1) {
    return null;
  }

  const result = await db.query(
    `
      SELECT units.property_id
      FROM units
      INNER JOIN properties
        ON properties.id = units.property_id
      WHERE units.id = $1
        AND properties.owner_id = $2
    `,
    [unit_id, owner_id]
  );

  return result.rows[0]?.property_id || null;
}

const router = express.Router();

/*
  Per network address, far above what the phone app needs. Stops
  anyone from flooding the server or the database.
*/
const unit_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});


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
  unit_limiter,
  authenticate,
  require_role("owner", "caretaker"),
  as_owner({ property: property_of_unit }),
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