const express = require("express");

const agreement_controller = require(
  "./agreement_controller"
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

/*
  Owner default template.
*/
router.get(
  "/agreement-templates/default",
  guard,
  agreement_controller.get_default_template
);

router.put(
  "/agreement-templates/default",
  guard,
  agreement_controller.save_default_template
);

/*
  Property-specific template override.
*/
router.get(
  "/properties/:property_id/agreement-template",
  guard,
  agreement_controller.get_property_template
);

router.put(
  "/properties/:property_id/agreement-template",
  guard,
  agreement_controller.save_property_template
);

router.delete(
  "/properties/:property_id/agreement-template",
  guard,
  agreement_controller.delete_property_template
);

/*
  Agreement management.
*/
router.get(
  "/agreements",
  guard,
  agreement_controller.list_agreements
);

router.get(
  "/agreements/:agreement_id",
  guard,
  agreement_controller.get_agreement
);

router.patch(
  "/agreements/:agreement_id/sign",
  guard,
  agreement_controller.mark_agreement_signed
);

router.patch(
  "/agreements/:agreement_id/unsign",
  guard,
  agreement_controller.unmark_agreement_signed
);

router.post(
  "/agreements/:agreement_id/regenerate",
  guard,
  agreement_controller.regenerate_agreement
);

router.get(
  "/agreements/:agreement_id/download",
  guard,
  agreement_controller.download_agreement_pdf
);

/*
  Tenant-profile agreement actions.
*/
router.get(
  "/tenants/:tenant_id/agreement",
  guard,
  agreement_controller.get_tenant_agreement
);

router.post(
  "/tenants/:tenant_id/agreement/generate",
  guard,
  agreement_controller.generate_tenant_agreement
);

router.get(
  "/tenants/:tenant_id/agreement/download",
  guard,
  agreement_controller.download_tenant_agreement_pdf
);

module.exports = router;