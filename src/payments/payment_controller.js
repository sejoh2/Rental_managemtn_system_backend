const payment_service = require("./payment_service");

const {
  validate_match_payment,
  validate_reverse_payment,
  validate_manual_payment,
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
  list_unmatched_payments,
  get_payment_stats,
  get_payment,
  match_payment,
  reverse_payment,
  record_manual_payment,
  list_tenant_payments,
  simulate_sandbox_payment,
};