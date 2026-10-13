const unit_service = require("./unit_service");

const {
  validate_create_unit,
  validate_update_unit,
  validate_property_id,
  validate_unit_id,
} = require("./unit_validator");

async function create_unit(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_create_unit(req.body);

    const unit = await unit_service.create_unit(
      req.user,
      property_id,
      data,
      req.ip
    );

    return res.status(201).json({
      success: true,
      message: "Unit created successfully.",
      data: unit,
    });
  } catch (error) {
    next(error);
  }
}

async function list_property_units(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const units =
      await unit_service.list_property_units(
        req.user,
        property_id,
        req.query.include_archived === "true"
      );

    return res.status(200).json({
      success: true,
      data: units,
    });
  } catch (error) {
    next(error);
  }
}

async function restore_unit(req, res, next) {
  try {
    const unit = await unit_service.restore_unit(
      req.user,
      validate_unit_id(req.params.unit_id),
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Unit restored.",
      data: unit,
    });
  } catch (error) {
    next(error);
  }
}

async function get_unit(req, res, next) {
  try {
    const unit_id = validate_unit_id(
      req.params.unit_id
    );

    const unit = await unit_service.get_unit_by_id(
      req.user,
      unit_id
    );

    return res.status(200).json({
      success: true,
      data: unit,
    });
  } catch (error) {
    next(error);
  }
}

async function update_unit(req, res, next) {
  try {
    const unit_id = validate_unit_id(
      req.params.unit_id
    );

    const data = validate_update_unit(req.body);

    const unit = await unit_service.update_unit(
      req.user,
      unit_id,
      data,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Unit updated successfully.",
      data: unit,
    });
  } catch (error) {
    next(error);
  }
}

async function archive_unit(req, res, next) {
  try {
    const unit_id = validate_unit_id(
      req.params.unit_id
    );

    await unit_service.archive_unit(
      req.user,
      unit_id,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Unit archived successfully.",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  restore_unit,
  create_unit,
  list_property_units,
  get_unit,
  update_unit,
  archive_unit,
};