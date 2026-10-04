const user_service = require("./user_service");

const {
  validate_user_id,
} = require("./user_validator");

async function list_users(req, res, next) {
  try {
    const users = await user_service.list_users();

    return res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error) {
    next(error);
  }
}

async function get_user(req, res, next) {
  try {
    const user_id = validate_user_id(req.params);

    const user = await user_service.get_user_by_id(user_id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user_id: Number(user.user_id),
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        role: user.role,
        owner_id: user.owner_id
          ? Number(user.owner_id)
          : null,
        status: user.status,
        last_login_at: user.last_login_at,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function promote_to_owner(req, res, next) {
  try {
    const target_user_id = validate_user_id(req.params);

    const user = await user_service.promote_to_owner({
      admin_user: req.user,
      target_user_id,
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "User promoted to owner successfully.",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function deactivate_user(req, res, next) {
  try {
    const target_user_id = validate_user_id(req.params);

    const user = await user_service.deactivate_user({
      admin_user: req.user,
      target_user_id,
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "User deactivated successfully.",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function activate_user(req, res, next) {
  try {
    const target_user_id = validate_user_id(req.params);

    const user = await user_service.activate_user({
      admin_user: req.user,
      target_user_id,
      ip_address: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "User activated successfully.",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list_users,
  get_user,
  promote_to_owner,
  deactivate_user,
  activate_user,
};