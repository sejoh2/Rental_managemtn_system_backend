const sms_service = require("./sms_service");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  validate_create_template,
  validate_update_template,
  validate_recipient_target,
  validate_broadcast,
  validate_list_messages,
  validate_list_broadcasts,
  validate_template_id,
  validate_broadcast_id,
  validate_message_id,
} = require("./sms_validator");

async function create_template(req, res, next) {
  try {
    const data = validate_create_template(req.body);

    const template =
      await sms_service.create_template(
        req.user,
        data
      );

    await log_audit({
      user_id: req.user.user_id,
      action: "SMS_TEMPLATE_CREATED",
      entity_type: "sms_template",
      entity_id: template.id,
      metadata: { name: template.name },
      ip_address: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "SMS template created successfully.",
      data: template,
    });
  } catch (error) {
    next(error);
  }
}

async function list_templates(req, res, next) {
  try {
    const templates =
      await sms_service.list_templates(req.user);

    return res.status(200).json({
      success: true,
      total: templates.length,
      data: templates,
    });
  } catch (error) {
    next(error);
  }
}

async function update_template(req, res, next) {
  try {
    const template_id = validate_template_id(
      req.params.template_id
    );

    const data = validate_update_template(req.body);

    const template =
      await sms_service.update_template(
        req.user,
        template_id,
        data
      );

    await log_audit({
      user_id: req.user.user_id,
      action: "SMS_TEMPLATE_UPDATED",
      entity_type: "sms_template",
      entity_id: template.id,
      metadata: {
        name: template.name,
        updated_fields: Object.keys(data),
      },
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "SMS template updated successfully.",
      data: template,
    });
  } catch (error) {
    next(error);
  }
}

async function delete_template(req, res, next) {
  try {
    const template_id = validate_template_id(
      req.params.template_id
    );

    await sms_service.delete_template(
      req.user,
      template_id
    );

    await log_audit({
      user_id: req.user.user_id,
      action: "SMS_TEMPLATE_DELETED",
      entity_type: "sms_template",
      entity_id: template_id,
      metadata: null,
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "SMS template deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
}

async function estimate_recipients(req, res, next) {
  try {
    const target = validate_recipient_target(
      req.body
    );

    const estimate =
      await sms_service.estimate_recipients(
        req.user,
        target
      );

    return res.status(200).json({
      success: true,
      data: estimate,
    });
  } catch (error) {
    next(error);
  }
}

async function create_broadcast(req, res, next) {
  try {
    const data = validate_broadcast(req.body);

    const broadcast =
      await sms_service.create_broadcast(
        req.user,
        data
      );

    await log_audit({
      user_id: req.user.user_id,
      action: data.send_at
        ? "SMS_BROADCAST_SCHEDULED"
        : "SMS_BROADCAST_SENT",
      entity_type: "sms_broadcast",
      entity_id: broadcast.id,
      metadata: {
        recipient_group: broadcast.recipient_group,
        property_id: broadcast.property_id,
        tenant_id: broadcast.tenant_id,
        recipient_count: broadcast.recipient_count,
        scheduled_at: data.send_at || null,
      },
      ip_address: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: data.send_at
        ? "SMS broadcast scheduled successfully."
        : "SMS broadcast queued for sending.",
      data: broadcast,
    });
  } catch (error) {
    next(error);
  }
}

async function list_broadcasts(req, res, next) {
  try {
    const filters = validate_list_broadcasts(
      req.query
    );

    const broadcasts =
      await sms_service.list_broadcasts(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      total: broadcasts.length,
      data: broadcasts,
    });
  } catch (error) {
    next(error);
  }
}

async function update_broadcast(req, res, next) {
  try {
    const broadcast_id = validate_broadcast_id(
      req.params.broadcast_id
    );

    const data = validate_broadcast(req.body);

    const broadcast =
      await sms_service.update_broadcast(
        req.user,
        broadcast_id,
        data
      );

    await log_audit({
      user_id: req.user.user_id,
      action: "SMS_BROADCAST_UPDATED",
      entity_type: "sms_broadcast",
      entity_id: broadcast.id,
      metadata: {
        recipient_group: broadcast.recipient_group,
        property_id: broadcast.property_id,
        tenant_id: broadcast.tenant_id,
        scheduled_at: data.send_at,
      },
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "SMS broadcast updated.",
      data: broadcast,
    });
  } catch (error) {
    next(error);
  }
}

async function list_messages(req, res, next) {
  try {
    const filters = validate_list_messages(
      req.query
    );

    const messages =
      await sms_service.list_messages(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      total: messages.length,
      data: messages,
    });
  } catch (error) {
    next(error);
  }
}

async function get_sms_stats(req, res, next) {
  try {
    const stats =
      await sms_service.get_sms_stats(req.user);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

async function cancel_broadcast(req, res, next) {
  try {
    const broadcast_id = validate_broadcast_id(
      req.params.broadcast_id
    );

    const broadcast =
      await sms_service.cancel_broadcast(
        req.user,
        broadcast_id
      );

    await log_audit({
      user_id: req.user.user_id,
      action: "SMS_BROADCAST_CANCELLED",
      entity_type: "sms_broadcast",
      entity_id: broadcast.id,
      metadata: null,
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "Scheduled SMS broadcast cancelled.",
      data: broadcast,
    });
  } catch (error) {
    next(error);
  }
}

async function retry_message(req, res, next) {
  try {
    const message_id = validate_message_id(
      req.params.message_id
    );

    await sms_service.retry_message(
      req.user,
      message_id
    );

    await log_audit({
      user_id: req.user.user_id,
      action: "SMS_MESSAGE_RETRIED",
      entity_type: "sms_message",
      entity_id: message_id,
      metadata: null,
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "SMS retry queued successfully.",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  update_broadcast,
  create_template,
  list_templates,
  update_template,
  delete_template,

  estimate_recipients,
  create_broadcast,
  list_broadcasts,
  list_messages,
  get_sms_stats,

  cancel_broadcast,
  retry_message,
};