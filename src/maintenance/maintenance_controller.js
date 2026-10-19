const maintenance_service = require(
  "./maintenance_service"
);

const {
  validate_create_request,
  validate_update_request,
  validate_list_requests,
  validate_property_id,
  validate_request_id,
} = require("./maintenance_validator");

async function create_request(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_create_request(req.body);

    const request =
      await maintenance_service.create_request(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message:
        "Maintenance request reported successfully.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

async function list_requests(req, res, next) {
  try {
    const filters = validate_list_requests(
      req.query
    );

    const requests =
      await maintenance_service.list_requests(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      total: requests.length,
      data: requests,
    });
  } catch (error) {
    next(error);
  }
}

async function get_request(req, res, next) {
  try {
    const request_id = validate_request_id(
      req.params.request_id
    );

    const request =
      await maintenance_service.get_request_by_id(
        req.user,
        request_id
      );

    return res.status(200).json({
      success: true,
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

async function update_request(req, res, next) {
  try {
    const request_id = validate_request_id(
      req.params.request_id
    );

    const data = validate_update_request(req.body);

    const request =
      await maintenance_service.update_request(
        req.user,
        request_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Maintenance request updated successfully.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

async function send_repair_charge_sms(req, res, next) {
  try {
    const request_id = validate_request_id(
      req.params.request_id
    );

    const request =
      await maintenance_service.send_repair_charge_sms(
        req.user,
        request_id,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "SMS sent to the tenant.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

async function get_status_counts(req, res, next) {
  try {
    const counts =
      await maintenance_service.get_status_counts(
        req.user
      );

    return res.status(200).json({
      success: true,
      data: counts,
    });
  } catch (error) {
    next(error);
  }
}

/*
  The caretaker's new repairs (reported by the owner, or given
  to them), for the bell in the phone app.
*/
async function list_notices(req, res, next) {
  try {
    if (req.user.role !== "caretaker") {
      const error = new Error("Only caretakers have this list.");

      error.status_code = 403;
      throw error;
    }

    const notices =
      await maintenance_service.list_caretaker_notices(req.user);

    return res.status(200).json({
      success: true,
      total: notices.length,
      data: notices,
    });
  } catch (error) {
    next(error);
  }
}

async function mark_notices_seen(req, res, next) {
  try {
    return res.status(200).json({
      success: true,
      data: await maintenance_service.mark_notices_seen(req.user),
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list_notices,
  mark_notices_seen,
  create_request,
  list_requests,
  get_request,
  update_request,
  send_repair_charge_sms,
  get_status_counts,
};