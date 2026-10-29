const payment_service = require("./payment_service");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  send_csv,
  humanize,
} = require("../utils/csv");

const {
  validate_export_payments,
  validate_match_payment,
  validate_reverse_payment,
  validate_manual_payment,
  validate_possible_duplicates,
  validate_dismiss_payment,
  validate_sandbox_simulation,
  validate_payment_id,
  validate_tenant_id,
} = require("./payment_validator");

async function list_payments(req, res, next) {
  try {
    const payments =
      await payment_service.list_payments(req.user);

    return res.status(200).json({
      success: true,
      data: payments,
    });
  } catch (error) {
    next(error);
  }
}

const method_labels = {
  mpesa: "M-Pesa",
  cash: "Cash",
  bank: "Bank transfer",
  other: "Other",
};

function how_received(payment) {
  if (payment.match_type === "automatic") {
    return "Auto-matched";
  }

  if (payment.payment_source === "manual") {
    return "Recorded manually";
  }

  return payment.match_type === "manual"
    ? "Matched manually"
    : "";
}

/*
  Deposits and one-off charges are not billed for a month:
  they use the placeholder period 1970-01-01.
*/
function applied_to_text(payment) {
  return payment.applied_to
    .map((item) => {
      const name =
        item.description || humanize(item.charge_type);

      return item.period_label === "Jan 1970"
        ? name
        : `${name} ${item.period_label}`;
    })
    .join("; ");
}

/*
  The file is built here, not in the browser, so it always
  holds the complete, permission-checked data, and every
  export of financial records is written to the audit log.
*/
async function export_payments(req, res, next) {
  try {
    const filters = validate_export_payments(req.query);

    const payments = await payment_service.list_payments(
      req.user,
      filters
    );

    await log_audit({
      user_id: req.user.user_id,
      action: "PAYMENTS_EXPORTED",
      entity_type: "payment",
      metadata: {
        ...filters,
        rows: payments.length,
      },
      ip_address: req.ip,
    });

    return send_csv(
      res,
      `payments-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        "Date",
        "Tenant",
        "Property",
        "Unit",
        "Payer phone",
        "Amount (KES)",
        "Method",
        "How received",
        "Paid into",
        "Applied to",
        "Reference",
        "Status",
        "Reversal reason",
      ],
      payments.map((payment) => [
        payment.received_at_local,
        payment.tenant_name,
        payment.property_name,
        payment.unit_number,
        payment.payer_phone,
        payment.amount,
        method_labels[payment.payment_method] ||
          payment.payment_method,
        how_received(payment),
        humanize(payment.account_for),
        applied_to_text(payment),
        payment.provider_transaction_id ||
          payment.reference,
        humanize(payment.status),
        payment.reverse_reason,
      ])
    );
  } catch (error) {
    next(error);
  }
}

async function list_unmatched_payments(req, res, next) {
  try {
    const payments =
      await payment_service.list_unmatched_payments(
        req.user
      );

    return res.status(200).json({
      success: true,
      data: payments,
    });
  } catch (error) {
    next(error);
  }
}

async function get_payment_stats(req, res, next) {
  try {
    const stats =
      await payment_service.get_payment_stats(req.user);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

async function get_payment(req, res, next) {
  try {
    const payment_id = validate_payment_id(
      req.params.payment_id
    );

    const payment =
      await payment_service.get_payment_by_id(
        req.user,
        payment_id
      );

    return res.status(200).json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
}

async function match_payment(req, res, next) {
  try {
    const payment_id = validate_payment_id(
      req.params.payment_id
    );

    const {
      tenant_id,
      remember_payment_phone,
    } = validate_match_payment(req.body);

    const payment =
      await payment_service.match_unmatched_payment(
        req.user,
        payment_id,
        tenant_id,
        remember_payment_phone,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Payment matched successfully.",
      data: payment,
    });
  } catch (error) {
    next(error);
  }
}

async function reverse_payment(req, res, next) {
  try {
    const payment_id = validate_payment_id(
      req.params.payment_id
    );

    const { reason } = validate_reverse_payment(req.body);

    const payment =
      await payment_service.reverse_payment(
        req.user,
        payment_id,
        reason,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        payment.status === "unmatched"
          ? "Payment unassigned. It is back under unmatched payments."
          : "Payment reversed successfully.",
      data: payment,
    });
  } catch (error) {
    next(error);
  }
}

async function record_manual_payment(req, res, next) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const data = validate_manual_payment(req.body);

    const payment =
      await payment_service.record_manual_payment(
        req.user,
        tenant_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message: "Manual payment recorded successfully.",
      data: payment,
    });
  } catch (error) {
    next(error);
  }
}

async function list_possible_duplicates(req, res, next) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const query = validate_possible_duplicates(req.query);

    return res.status(200).json({
      success: true,
      data: await payment_service.list_possible_duplicates(
        req.user,
        tenant_id,
        query
      ),
    });
  } catch (error) {
    next(error);
  }
}

async function dismiss_payment(req, res, next) {
  try {
    const payment_id = validate_payment_id(
      req.params.payment_id
    );

    const { reason } = validate_dismiss_payment(req.body);

    return res.status(200).json({
      success: true,
      message: "Marked as not a tenant payment.",
      data: await payment_service.dismiss_payment(
        req.user,
        payment_id,
        reason,
        req.ip
      ),
    });
  } catch (error) {
    next(error);
  }
}

async function restore_payment(req, res, next) {
  try {
    const payment_id = validate_payment_id(
      req.params.payment_id
    );

    return res.status(200).json({
      success: true,
      message: "The payment is back under unmatched payments.",
      data: await payment_service.restore_payment(
        req.user,
        payment_id,
        req.ip
      ),
    });
  } catch (error) {
    next(error);
  }
}

async function simulate_sandbox_payment(
  req,
  res,
  next
) {
  try {
    const data = validate_sandbox_simulation(req.body);

    const result =
      await payment_service.simulate_sandbox_payment(
        req.user,
        data
      );

    return res.status(200).json({
      success: true,
      message:
        "Sandbox payment simulation submitted to Daraja.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function list_tenant_payments(req, res, next) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const payments =
      await payment_service.list_tenant_payments(
        req.user,
        tenant_id
      );

    return res.status(200).json({
      success: true,
      data: payments,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list_payments,
  export_payments,
  list_unmatched_payments,
  get_payment_stats,
  get_payment,
  match_payment,
  reverse_payment,
  record_manual_payment,
  list_possible_duplicates,
  dismiss_payment,
  restore_payment,
  list_tenant_payments,
  simulate_sandbox_payment,
};