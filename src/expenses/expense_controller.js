const expense_service = require(
  "./expense_service"
);

const {
  validate_create_expense,
  validate_list_expenses,
  validate_void_expense,
  validate_property_id,
  validate_expense_id,
} = require("./expense_validator");

async function create_expense(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_create_expense(req.body);

    const expense =
      await expense_service.create_expense(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message: "Expense recorded successfully.",
      data: expense,
    });
  } catch (error) {
    next(error);
  }
}

async function list_expenses(req, res, next) {
  try {
    const filters = validate_list_expenses(
      req.query
    );

    const expenses =
      await expense_service.list_expenses(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      total: expenses.length,
      data: expenses,
    });
  } catch (error) {
    next(error);
  }
}

async function get_expense(req, res, next) {
  try {
    const expense_id = validate_expense_id(
      req.params.expense_id
    );

    const expense =
      await expense_service.get_expense_for_owner(
        req.user,
        expense_id
      );

    return res.status(200).json({
      success: true,
      data: expense,
    });
  } catch (error) {
    next(error);
  }
}

async function void_expense(req, res, next) {
  try {
    const expense_id = validate_expense_id(
      req.params.expense_id
    );

    const data = validate_void_expense(req.body);

    const expense =
      await expense_service.void_expense(
        req.user,
        expense_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Expense voided successfully.",
      data: expense,
    });
  } catch (error) {
    next(error);
  }
}

async function get_expense_summary(
  req,
  res,
  next
) {
  try {
    const filters = validate_list_expenses(
      req.query
    );

    const summary =
      await expense_service.get_expense_summary(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  create_expense,
  list_expenses,
  get_expense,
  void_expense,
  get_expense_summary,
};