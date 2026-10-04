const express = require("express");

const report_controller = require(
  "./report_controller"
);

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

router.use(authenticate);

/*
  Owners:
  - all their properties, or one property

  Caretakers:
  - Level 1 or Level 2
  - their assigned property only
*/
router.use(
  require_role("owner", "caretaker")
);

router.get(
  "/reports/dashboard",
  report_controller.get_dashboard_report
);

router.get(
  "/reports/export",
  report_controller.export_report
);

router.get(
  "/reports/tenants/:tenant_id/statement",
  report_controller.get_tenant_statement
);

router.get(
  "/reports/tenants/:tenant_id/statement/download",
  report_controller.download_tenant_statement_pdf
);

module.exports = router;