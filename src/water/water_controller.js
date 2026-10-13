const water_service = require("./water_service");

const {
  validate_water_rules,
  validate_submit_reading,
  validate_review_reading,
  validate_generate_fixed_bills,
  validate_list_readings,
  validate_property_id,
  validate_unit_id,
  validate_reading_id,
} = require("./water_validator");

async function update_water_rules(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_water_rules(req.body);

    const rules =
      await water_service.update_water_rules(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Water billing rules updated successfully.",
      data: rules,
    });
  } catch (error) {
    next(error);
  }
}

async function get_previous_reading(req, res, next) {
  try {
    const { billing_period } = validate_list_readings({
      billing_period: req.query.billing_period,
    });

    return res.status(200).json({
      success: true,
      data: await water_service.get_previous_reading(
        req.user,
        validate_property_id(req.params.property_id),
        validate_unit_id(req.params.unit_id),
        billing_period
      ),
    });
  } catch (error) {
    next(error);
  }
}

async function submit_meter_reading(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const unit_id = validate_unit_id(
      req.params.unit_id
    );

    const data = validate_submit_reading(req.body);

    const reading =
      await water_service.submit_meter_reading(
        req.user,
        property_id,
        unit_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message:
        reading.status === "flagged"
          ? "Meter reading saved and flagged for review."
          : "Meter reading submitted and water bill created successfully.",
      data: reading,
    });
  } catch (error) {
    next(error);
  }
}

async function review_meter_reading(
  req,
  res,
  next
) {
  try {
    const reading_id = validate_reading_id(
      req.params.reading_id
    );

    const data = validate_review_reading(req.body);

    const reading =
      await water_service.review_meter_reading(
        req.user,
        reading_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        reading.status === "rejected"
          ? "Meter reading rejected successfully."
          : "Meter reading approved and water bill created successfully.",
      data: reading,
    });
  } catch (error) {
    next(error);
  }
}

async function generate_fixed_monthly_bills(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_generate_fixed_bills(
      req.body
    );

    const result =
      await water_service.generate_fixed_monthly_bills(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message:
        "Fixed monthly water billing completed.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function list_readings(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const filters = validate_list_readings(
      req.query
    );

    const readings =
      await water_service.list_readings(
        req.user,
        property_id,
        filters
      );

    return res.status(200).json({
      success: true,
      total: readings.length,
      data: readings,
    });
  } catch (error) {
    next(error);
  }
}

async function get_water_stats(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const stats =
      await water_service.get_water_stats(
        req.user,
        property_id,
        req.query.billing_period
      );

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  get_previous_reading,
  update_water_rules,
  submit_meter_reading,
  review_meter_reading,
  generate_fixed_monthly_bills,
  list_readings,
  get_water_stats,
};