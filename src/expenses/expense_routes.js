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

router.use(authenticate);

router.use(
  require_role("owner", "caretaker")
);

router.post(
  "/properties/:property_id/expenses",
  expense_controller.create_expense
);

router.get(
  "/expenses",
  expense_controller.list_expenses
);

router.get(
  "/expenses/summary",
  expense_controller.get_expense_summary
);

router.get(
  "/expenses/:expense_id",
  expense_controller.get_expense
);

/*
  A caretaker can record expenses, but only an owner can void one.
  This prevents a caretaker from hiding an already-recorded expense.
*/
router.post(
  "/expenses/:expense_id/void",
  expense_controller.void_expense
);

module.exports = router;