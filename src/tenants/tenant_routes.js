const express = require("express");

const tenant_controller = require("./tenant_controller");

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

/*
  A caretaker may view the tenants of a property they are
  assigned to (Level 1) and add or edit them (Level 2).
  The level is checked in the tenant service.
*/
const caretaker_guard = [
  authenticate,
  require_role("owner", "caretaker"),
];

router.get(
  "/properties/:property_id/tenants",
  caretaker_guard,
  tenant_controller.list_property_tenants
);

router.post(
  "/properties/:property_id/tenants",
  caretaker_guard,
  tenant_controller.create_tenant
);

router.get(
  "/tenants",
  guard,
  tenant_controller.list_tenants
);

router.get(
  "/tenants/:tenant_id",
  caretaker_guard,
  tenant_controller.get_tenant
);

router.patch(
  "/tenants/:tenant_id",
  caretaker_guard,
  tenant_controller.update_tenant
);

router.post(
  "/tenants/:tenant_id/move-out",
  guard,
  tenant_controller.move_out_tenant
);

router.post(
  "/tenants/:tenant_id/undo-move-out",
  guard,
  tenant_controller.undo_move_out
);

module.exports = router;