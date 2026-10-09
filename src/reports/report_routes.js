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


/*
  Owners:
  - all their properties, or one property

  Caretakers:
  - Level 1 or Level 2
  - their assigned property only
*/
/*
  The guard is attached to each route, not to the whole router.
  This router is mounted on "/api" next to the others, and a
  router-wide check would also refuse requests meant for them.
*/
const guard = [
  authenticate,
  require_role("owner", "caretaker"),
];

router.get(
  "/reports/dashboard",
  guard,
  report_controller.get_dashboard_report
);

router.get(
  "/reports/export",
  guard,
  report_controller.export_report
);

router.get(
  "/reports/tenants/:tenant_id/statement",
  guard,
  report_controller.get_tenant_statement
);

router.get(
  "/reports/tenants/:tenant_id/statement/download",
  guard,
  report_controller.download_tenant_statement_pdf
);

module.exports = router;