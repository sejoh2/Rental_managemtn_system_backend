const express = require("express");

const expense_controller = require(
  "./expense_controller"
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
  require_role("owner", "caretaker"),
];

router.post(
  "/properties/:property_id/expenses",
  guard,
  expense_controller.create_expense
);

router.get(
  "/expenses",
  guard,
  expense_controller.list_expenses
);

/*
  Must stay above "/expenses/:expense_id".
*/
router.get(
  "/expenses/export",
  guard,
  expense_controller.export_expenses
);

router.get(
  "/expenses/summary",
  guard,
  expense_controller.get_expense_summary
);

router.get(
  "/expenses/reconciliation",
  guard,
  expense_controller.get_expense_reconciliation
);

router.get(
  "/expenses/:expense_id",
  guard,
  expense_controller.get_expense
);

router.patch(
  "/expenses/:expense_id",
  guard,
  expense_controller.update_expense
);

/*
  A caretaker can record expenses, but only an owner can void one.
  This prevents a caretaker from hiding an already-recorded expense.
*/
router.post(
  "/expenses/:expense_id/void",
  guard,
  expense_controller.void_expense
);

module.exports = router;