const caretaker_service = require(
  "./caretaker_service"
);

const {
  validate_assign_caretaker,
  validate_update_caretaker,
  validate_update_caretaker_details,
  validate_property_id,
  validate_caretaker_id,
} = require("./caretaker_validator");

async function assign_caretaker(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_assign_caretaker(
      req.body
    );

    const caretaker =
      await caretaker_service.assign_caretaker(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message:
        "Caretaker assigned successfully. Any previous caretaker has lost access to this property.",
      data: caretaker,
    });
  } catch (error) {
    next(error);
  }
}

async function list_caretakers(req, res, next) {
  try {
    const caretakers =
      await caretaker_service.list_caretakers(
        req.user
      );

    return res.status(200).json({
      success: true,
      total: caretakers.length,
      data: caretakers,
    });
  } catch (error) {
    next(error);
  }
}

async function get_caretaker(req, res, next) {
  try {
    const caretaker_id = validate_caretaker_id(
      req.params.caretaker_id
    );

    const caretaker =
      await caretaker_service.get_caretaker(
        req.user,
        caretaker_id
      );

    return res.status(200).json({
      success: true,
      data: caretaker,
    });
  } catch (error) {
    next(error);
  }
}

async function update_property_caretaker(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_update_caretaker(
      req.body
    );

    const caretaker =
      await caretaker_service.update_property_caretaker(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Caretaker settings updated successfully.",
      data: caretaker,
    });
  } catch (error) {
    next(error);
  }
}

async function update_caretaker(req, res, next) {
  try {
    const caretaker_id = validate_caretaker_id(
      req.params.caretaker_id
    );

    const data = validate_update_caretaker_details(
      req.body
    );

    const caretaker =
      await caretaker_service.update_caretaker(
        req.user,
        caretaker_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Caretaker updated successfully.",
      data: caretaker,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  update_caretaker,
  assign_caretaker,
  list_caretakers,
  get_caretaker,
  update_property_caretaker,
};