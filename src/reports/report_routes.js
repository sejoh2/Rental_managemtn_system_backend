const express = require("express");
const { rateLimit } = require("express-rate-limit");

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
  Per network address, far above normal use: totals are heavy queries.
*/
const totals_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});


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

/*
  Totals (income, collections, arrears) are the owner's alone; a
  caretaker sees one tenant's statement at a time.
*/
const owner_guard = [
  authenticate,
  require_role("owner"),
];

router.get(
  "/reports/dashboard",
  totals_limiter,
  owner_guard,
  report_controller.get_dashboard_report
);

router.get(
  "/reports/export",
  totals_limiter,
  owner_guard,
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