const auth_service = require("./auth_service");

const token_service = require("../security/token_service");

const {
  account_status,
  ensure_monthly_invoice,
} = require("../subscriptions/subscription_service");

const {
  account_owner_id,
} = require("../subscriptions/subscription_access");

const {
  validate_request_otp,
  validate_verify_otp,
  validate_refresh_token,
  validate_name,
} = require("./auth_validator");

async function request_otp(req, res, next) {
  try {
    const { phone } = validate_request_otp(req.body);

    const result = await auth_service.request_otp(
      phone,
      req.ip
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

async function verify_otp(req, res, next) {
  try {
    const { phone, code } = validate_verify_otp(req.body);

    const result = await auth_service.verify_otp(
      phone,
      code,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Authenticated successfully.",
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

async function refresh_token(req, res, next) {
  try {
    const { refresh_token } =
      validate_refresh_token(req.body);

    const result = await auth_service.refresh(
      refresh_token
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    error.status_code = 401;
    next(error);
  }
}

async function logout(req, res) {
  await auth_service.logout(
    req.body?.refresh_token,
    req.ip
  );

  return res.status(200).json({
    success: true,
    message: "Logged out successfully.",
  });
}

async function me(req, res, next) {
  try {
    return res.status(200).json({
      success: true,
      user: token_service.public_user(req.user),
      subscription: await subscription_summary(req.user),
    });
  } catch (error) {
    return next(error);
  }
}

/*
  Where the account stands with its Kodi bill, for the banner on
  every page (web and phone app). Caretakers see the state only.
*/
async function subscription_summary(user) {
  const owner_id = account_owner_id(user);

  if (!owner_id) {
    return null;
  }

  const status = await account_status(owner_id);
  const summary = {
    state: status.state,
    read_only: status.read_only,
    covered_until: status.covered_until,
    grace_ends_on: status.grace_ends_on,
    days_left: status.days_left,
    grace_days_left: status.grace_days_left,
  };

  if (user.role !== "owner") {
    return summary;
  }

  // Past the cover, the bill exists (made here if the job has not run yet).
  const { invoice } = ["grace", "read_only"].includes(status.state)
    ? await ensure_monthly_invoice(owner_id)
    : { invoice: null };

  return {
    ...summary,
    trial_ends_on: status.trial_ends_on,
    amount_due: invoice?.status === "open" ? invoice.amount_due : null,
  };
}

async function set_name(req, res, next) {
  try {
    const { full_name } = validate_name(req.body);

    const user = await auth_service.set_name(
      req.user,
      full_name,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Name saved.",
      user,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  set_name,
  request_otp,
  verify_otp,
  refresh_token,
  logout,
  me,
};