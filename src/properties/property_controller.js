const property_service = require("./property_service");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  callback_ip_allowed,
  legacy_callbacks_allowed,
} = require("../payments/mpesa/c2b_callback_security");

const {
  validate_connect_account,
  validate_create_property,
  validate_update_property,
  validate_replace_account,
  validate_remove_account,
} = require("./property_validator");

const payment_service =
  require("../payments/payment_service");

const { PREFIX, id_or_throw } = require("../utils/ids");

async function connect_payment_account(req, res, next) {
  try {
    const { account_for, account, property_id } =
      validate_connect_account(req.body);

    const result =
      await property_service.validate_payment_account_connection(
        req.user,
        account_for,
        account,
        req.ip,
        property_id
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
    const property_id = id_or_throw(req.params.property_id, "property", PREFIX.property);

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

async function update_property(req, res, next) {
  try {
    const property_id = id_or_throw(req.params.property_id, "property", PREFIX.property);

    const data = validate_update_property(req.body);

    const property =
      await property_service.update_property(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message: "Property updated successfully.",
      data: property,
    });
  } catch (error) {
    next(error);
  }
}

async function replace_payment_account(req, res, next) {
  try {
    const property_id = id_or_throw(req.params.property_id, "property", PREFIX.property);

    const { account_for, connection_id } =
      validate_replace_account({
        account_for: req.params.account_for,
        connection_id: req.body?.connection_id,
      });

    const property =
      await property_service.replace_payment_account(
        req.user,
        property_id,
        account_for,
        connection_id,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Payment account changed successfully.",
      data: property,
    });
  } catch (error) {
    next(error);
  }
}

async function remove_payment_account(req, res, next) {
  try {
    const property_id = id_or_throw(req.params.property_id, "property", PREFIX.property);

    const { account_for } = validate_remove_account({
      account_for: req.params.account_for,
    });

    const property =
      await property_service.remove_payment_account(
        req.user,
        property_id,
        account_for,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Payment account removed successfully.",
      data: property,
    });
  } catch (error) {
    next(error);
  }
}

async function archive_property(req, res, next) {
  try {
    const property_id = id_or_throw(req.params.property_id, "property", PREFIX.property);

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
    const property_id = id_or_throw(req.params.property_id, "property", PREFIX.property);
    const payment_account_id = id_or_throw(
      req.params.payment_account_id,
      "payment account",
      PREFIX.payment_account
    );

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

const accepted = (res) =>
  res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });

/*
  A payment notice Kodi does not record: kept in the audit log
  (business number, transaction and network address only) so the
  admin sees it.
*/
async function refuse_notice(req, reason, account = null) {
  console.warn(`[MPESA] Payment notice refused: ${reason}`);

  await log_audit({
    user_id: null,
    owner_id: account?.owner_id || null,
    action: "MPESA_CALLBACK_REFUSED",
    entity_type: "payment_account",
    entity_id: account?.id || null,
    metadata: {
      reason,
      business_number: req.body?.BusinessShortCode ? String(req.body.BusinessShortCode).slice(0, 20) : null,
      transaction_id: req.body?.TransID ? String(req.body.TransID).slice(0, 30) : null,
    },
    ip_address: req.ip,
  });
}

async function c2b_validation(req, res, next) {
  try {
    if (!callback_ip_allowed(req.ip)) {
      return res.status(403).json({ ResultCode: 1, ResultDesc: "Rejected" });
    }

    await property_service.save_c2b_callback(
      "validation",
      req.body
    );

    return accepted(res);
  } catch (error) {
    next(error);
  }
}

/*
  Safaricom's payment notice, at the account's secret address. It is
  recorded only when the address's secret is the one kept for the
  account that owns the business number.
*/
async function c2b_confirmation(req, res, next) {
  try {
    if (!callback_ip_allowed(req.ip)) {
      await refuse_notice(req, "The notice came from a network address that is not Safaricom's.");
      return res.status(403).json({ ResultCode: 1, ResultDesc: "Rejected" });
    }

    const check = await property_service.check_c2b_notice(
      req.body,
      req.params.callback_token
    );

    if (check.reason) {
      await refuse_notice(req, check.reason, check.account);
      return res.status(404).json({ success: false, error: "Route not found." });
    }

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

    return accepted(res);
  } catch (error) {
    console.error(
      payment_service.notice_log_line(
        req.body,
        `could not be recorded: ${error.message}`
      )
    );
    next(error);
  }
}

/*
  The old address without a secret. Safaricom gets its answer so it
  stops retrying, but nothing is recorded, unless the short move
  setting MPESA_C2B_ALLOW_LEGACY_CALLBACKS=true is on.
*/
async function legacy_c2b_confirmation(req, res, next) {
  try {
    if (!callback_ip_allowed(req.ip)) {
      await refuse_notice(req, "The notice came from a network address that is not Safaricom's.");
      return res.status(403).json({ ResultCode: 1, ResultDesc: "Rejected" });
    }

    await property_service.save_c2b_callback(
      "confirmation",
      req.body
    );

    if (!legacy_callbacks_allowed()) {
      await refuse_notice(req, "The notice came to the old address without a secret: re-register this account's addresses.");
      return accepted(res);
    }

    await payment_service.receive_mpesa_c2b_confirmation(
      req.body
    );

    return accepted(res);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  legacy_c2b_confirmation,
  connect_payment_account,
  create_property,
  list_properties,
  get_property,
  update_property,
  replace_payment_account,
  remove_payment_account,
  archive_property,
  reregister_payment_account_c2b_urls,
  c2b_validation,
  c2b_confirmation,
};