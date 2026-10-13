const expense_service = require(
  "./expense_service"
);

const {
  log_audit,
} = require("../audit/audit_service");

const {
  send_csv,
  humanize,
} = require("../utils/csv");

const {
  validate_create_expense,
  validate_list_expenses,
  validate_void_expense,
  validate_update_expense,
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

const category_labels = {
  repairs_maintenance: "Repairs & maintenance",
  security: "Security",
  garbage: "Garbage",
  cleaning: "Cleaning",
  utilities: "Utilities",
  other: "Other",
};

function date_only(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  /*
    DATE columns arrive as local midnight, so local parts
    give back the stored calendar day.
  */
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/*
  Built here, not in the browser, so the file always holds the
  complete, permission-checked data and the export is audited.
*/
async function export_expenses(req, res, next) {
  try {
    const filters = validate_list_expenses(req.query);

    const expenses = await expense_service.list_expenses(
      req.user,
      filters
    );

    await log_audit({
      user_id: req.user.user_id,
      action: "EXPENSES_EXPORTED",
      entity_type: "expense",
      metadata: {
        ...filters,
        rows: expenses.length,
      },
      ip_address: req.ip,
    });

    return send_csv(
      res,
      `expenses-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        "Date",
        "Property",
        "Category",
        "Amount (KES)",
        "Notes",
        "Recorded by",
        "Status",
        "Void reason",
      ],
      expenses.map((expense) => [
        date_only(expense.expense_date),
        expense.property_name,
        category_labels[expense.category] ||
          expense.category,
        expense.amount,
        expense.notes,
        (expense.created_by_name || "").trim(),
        humanize(expense.status),
        expense.void_reason,
      ])
    );
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

async function update_expense(req, res, next) {
  try {
    const expense_id = validate_expense_id(
      req.params.expense_id
    );

    const expense =
      await expense_service.update_expense(
        req.user,
        expense_id,
        validate_update_expense(req.body),
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Expense updated.",
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

async function get_expense_reconciliation(
  req,
  res,
  next
) {
  try {
    const filters = validate_list_expenses(
      req.query
    );

    const reconciliation =
      await expense_service.get_expense_reconciliation(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      data: reconciliation,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  update_expense,
  create_expense,
  list_expenses,
  export_expenses,
  get_expense,
  void_expense,
  get_expense_summary,
  get_expense_reconciliation,
};