const property_service = require("./property_service");

const {
  validate_connect_account,
  validate_create_property,
} = require("./property_validator");

const payment_service =
  require("../payments/payment_service");

async function connect_payment_account(req, res, next) {
  try {
    const { account_for, account } =
      validate_connect_account(req.body);

    const result =
      await property_service.validate_payment_account_connection(
        req.user,
        account_for,
        account,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "M-Pesa credentials validated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function create_property(req, res, next) {
  try {
    const data = validate_create_property(req.body);

    const property =
      await property_service.create_property(
        req.user,
        data,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message:
        "Property and M-Pesa payment accounts created successfully.",
      data: property,
    });
  } catch (error) {
    next(error);
  }
}

async function list_properties(req, res, next) {
  try {
    const properties =
      await property_service.list_properties(req.user);

    return res.status(200).json({
      success: true,
      data: properties,
    });
  } catch (error) {
    next(error);
  }
}

async function get_property(req, res, next) {
  try {
    const property_id = Number(req.params.property_id);

    if (!Number.isInteger(property_id) || property_id < 1) {
      return res.status(422).json({
        success: false,
        error: "A valid property ID is required.",
      });
    }

    const property =
      await property_service.get_property_by_id(
        req.user,
        property_id
      );

    if (!property) {
      return res.status(404).json({
        success: false,
        error: "Property not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: property,
    });
  } catch (error) {
    next(error);
  }
}

async function archive_property(req, res, next) {
  try {
    const property_id = Number(req.params.property_id);

    if (!Number.isInteger(property_id) || property_id < 1) {
      return res.status(422).json({
        success: false,
        error: "A valid property ID is required.",
      });
    }

    await property_service.archive_property(
      req.user,
      property_id,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Property archived successfully.",
    });
  } catch (error) {
    next(error);
  }
}

async function reregister_payment_account_c2b_urls(
  req,
  res,
  next
) {
  try {
    const property_id = Number(req.params.property_id);
    const payment_account_id = Number(
      req.params.payment_account_id
    );

    if (!Number.isInteger(property_id) || property_id < 1) {
      return res.status(422).json({
        success: false,
        error: "A valid property ID is required.",
      });
    }

    if (
      !Number.isInteger(payment_account_id) ||
      payment_account_id < 1
    ) {
      return res.status(422).json({
        success: false,
        error: "A valid payment account ID is required.",
      });
    }

    const result =
      await property_service.reregister_payment_account_c2b_urls(
        req.user,
        property_id,
        payment_account_id,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "M-Pesa C2B callback URLs registered successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function c2b_validation(req, res, next) {
  try {
    await property_service.save_c2b_callback(
      "validation",
      req.body
    );

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  } catch (error) {
    next(error);
  }
}

async function c2b_confirmation(req, res, next) {
  try {
    /*
      Keep the raw confirmation event for diagnostics.
    */
    await property_service.save_c2b_callback(
      "confirmation",
      req.body
    );

    /*
      Creates one matched or unmatched payment.
      Duplicate M-Pesa transaction IDs are ignored safely.
    */
    await payment_service.receive_mpesa_c2b_confirmation(
      req.body
    );

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  connect_payment_account,
  create_property,
  list_properties,
  get_property,
  archive_property,
  reregister_payment_account_c2b_urls,
  c2b_validation,
  c2b_confirmation,
};