const settings_service = require(
  "./settings_service"
);

const {
  validate_profile,
  validate_defaults,
  validate_notifications,
  validate_audit_filters,
  validate_property_id,
} = require("./settings_validator");

async function get_settings(req, res, next) {
  try {
    const settings =
      await settings_service.get_settings(
        req.user
      );

    return res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    next(error);
  }
}

async function update_profile(req, res, next) {
  try {
    const data = validate_profile(req.body);

    const settings =
      await settings_service.update_profile(
        req.user,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Owner profile updated successfully.",

      /*
        Phone is intentionally excluded from this endpoint.
        It remains the OTP authentication identity.
      */
      data: settings,
    });
  } catch (error) {
    next(error);
  }
}

async function update_defaults(req, res, next) {
  try {
    const data = validate_defaults(req.body);

    const settings =
      await settings_service.update_defaults(
        req.user,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Default rent due day updated successfully.",
      data: settings,
    });
  } catch (error) {
    next(error);
  }
}

async function update_notifications(
  req,
  res,
  next
) {
  try {
    const data = validate_notifications(req.body);

    const settings =
      await settings_service.update_notifications(
        req.user,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Notification preferences updated successfully.",
      data: settings,
    });
  } catch (error) {
    next(error);
  }
}

async function get_property_settings(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const property_settings =
      await settings_service.get_property_settings(
        req.user,
        property_id
      );

    return res.status(200).json({
      success: true,
      data: property_settings,
    });
  } catch (error) {
    next(error);
  }
}

async function list_audit_logs(req, res, next) {
  try {
    const filters = validate_audit_filters(
      req.query
    );

    const audit_logs =
      await settings_service.list_audit_logs(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      total: audit_logs.length,
      data: audit_logs,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  get_settings,
  update_profile,
  update_defaults,
  update_notifications,
  get_property_settings,
  list_audit_logs,
};