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

module.exports = {
  create_request,
  list_requests,
  get_request,
  update_request,
  get_status_counts,
};