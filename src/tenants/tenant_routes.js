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

router.get(
  "/properties/:property_id/tenants",
  guard,
  tenant_controller.list_property_tenants
);

router.post(
  "/properties/:property_id/tenants",
  guard,
  tenant_controller.create_tenant
);

router.get(
  "/tenants",
  guard,
  tenant_controller.list_tenants
);

router.get(
  "/tenants/:tenant_id",
  guard,
  tenant_controller.get_tenant
);

router.patch(
  "/tenants/:tenant_id",
  guard,
  tenant_controller.update_tenant
);

router.post(
  "/tenants/:tenant_id/move-out",
  guard,
  tenant_controller.move_out_tenant
);

module.exports = router;