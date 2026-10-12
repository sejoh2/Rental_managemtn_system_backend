const service_charge_service = require(
  "./service_charge_service"
);

const {
  validate_create_service_charge,
  validate_update_service_charge,
  validate_property_id,
  validate_service_charge_id,
} = require("./service_charge_validator");

async function list_service_charges(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const service_charges =
      await service_charge_service.list_service_charges(
        req.user,
        property_id
      );

    return res.status(200).json({
      success: true,
      total: service_charges.length,
      data: service_charges,
    });
  } catch (error) {
    next(error);
  }
}

async function create_service_charge(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_create_service_charge(
      req.body
    );

    const service_charge =
      await service_charge_service.create_service_charge(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message: "Service charge added successfully.",
      data: service_charge,
    });
  } catch (error) {
    next(error);
  }
}

async function update_service_charge(req, res, next) {
  try {
    const service_charge_id = validate_service_charge_id(
      req.params.service_charge_id
    );

    const data = validate_update_service_charge(
      req.body
    );

    const service_charge =
      await service_charge_service.update_service_charge(
        req.user,
        service_charge_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Service charge updated successfully.",
      data: service_charge,
    });
  } catch (error) {
    next(error);
  }
}

async function archive_service_charge(req, res, next) {
  try {
    const service_charge_id = validate_service_charge_id(
      req.params.service_charge_id
    );

    await service_charge_service.archive_service_charge(
      req.user,
      service_charge_id,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Service charge removed successfully.",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list_service_charges,
  create_service_charge,
  update_service_charge,
  archive_service_charge,
};
