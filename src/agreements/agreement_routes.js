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

router.use(authenticate);
router.use(require_role("owner"));

/*
  Owner default template.
*/
router.get(
  "/agreement-templates/default",
  agreement_controller.get_default_template
);

router.put(
  "/agreement-templates/default",
  agreement_controller.save_default_template
);

/*
  Property-specific template override.
*/
router.get(
  "/properties/:property_id/agreement-template",
  agreement_controller.get_property_template
);

router.put(
  "/properties/:property_id/agreement-template",
  agreement_controller.save_property_template
);

router.delete(
  "/properties/:property_id/agreement-template",
  agreement_controller.delete_property_template
);

/*
  Agreement management.
*/
router.get(
  "/agreements",
  agreement_controller.list_agreements
);

router.get(
  "/agreements/:agreement_id",
  agreement_controller.get_agreement
);

router.patch(
  "/agreements/:agreement_id/sign",
  agreement_controller.mark_agreement_signed
);

router.get(
  "/agreements/:agreement_id/download",
  agreement_controller.download_agreement_pdf
);

/*
  Tenant-profile agreement actions.
*/
router.get(
  "/tenants/:tenant_id/agreement",
  agreement_controller.get_tenant_agreement
);

router.post(
  "/tenants/:tenant_id/agreement/generate",
  agreement_controller.generate_tenant_agreement
);

router.get(
  "/tenants/:tenant_id/agreement/download",
  agreement_controller.download_tenant_agreement_pdf
);

module.exports = router;