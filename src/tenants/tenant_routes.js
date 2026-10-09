const express = require("express");

const tenant_controller = require("./tenant_controller");

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
  "/properties/:property_id/tenants",
  tenant_controller.list_property_tenants
);

router.post(
  "/properties/:property_id/tenants",
  tenant_controller.create_tenant
);

router.get(
  "/tenants",
  tenant_controller.list_tenants
);

router.get(
  "/tenants/:tenant_id",
  tenant_controller.get_tenant
);

router.patch(
  "/tenants/:tenant_id",
  tenant_controller.update_tenant
);

router.post(
  "/tenants/:tenant_id/move-out",
  tenant_controller.move_out_tenant
);

module.exports = router;