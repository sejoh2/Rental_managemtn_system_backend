const tenant_service = require("./tenant_service");

const {
  validate_create_tenant,
  validate_update_tenant,
  validate_move_out,
  validate_undo_move_out,
  validate_list_tenants,
  validate_property_id,
  validate_tenant_id,
} = require("./tenant_validator");

async function create_tenant(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_create_tenant(req.body);

    const tenant = await tenant_service.create_tenant(
      req.user,
      property_id,
      data,
      req.ip
    );

    return res.status(201).json({
      success: true,
      message:
        "Tenant added successfully. The unit is now occupied.",
      data: tenant,
    });
  } catch (error) {
    next(error);
  }
}

async function list_property_tenants(req, res, next) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const tenants =
      await tenant_service.list_property_tenants(
        req.user,
        property_id
      );

    return res.status(200).json({
      success: true,
      data: tenants,
    });
  } catch (error) {
    next(error);
  }
}

async function list_tenants(req, res, next) {
  try {
    const filters = validate_list_tenants(req.query);

    const tenants = await tenant_service.list_tenants(
      req.user,
      filters
    );

    return res.status(200).json({
      success: true,
      total: tenants.length,
      data: tenants,
    });
  } catch (error) {
    next(error);
  }
}

async function get_tenant(req, res, next) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const tenant = await tenant_service.get_tenant_by_id(
      req.user,
      tenant_id
    );

    return res.status(200).json({
      success: true,
      data: tenant,
    });
  } catch (error) {
    next(error);
  }
}

async function update_tenant(req, res, next) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const data = validate_update_tenant(req.body);

    const tenant = await tenant_service.update_tenant(
      req.user,
      tenant_id,
      data,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: "Tenant updated successfully.",
      data: tenant,
    });
  } catch (error) {
    next(error);
  }
}

async function move_out_tenant(req, res, next) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const data = validate_move_out(req.body);

    const tenant =
      await tenant_service.move_out_tenant(
        req.user,
        tenant_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Tenant moved out successfully. The unit is now vacant.",
      data: tenant,
    });
  } catch (error) {
    next(error);
  }
}

async function undo_move_out(req, res, next) {
  try {
    const tenant = await tenant_service.undo_move_out(
      req.user,
      validate_tenant_id(req.params.tenant_id),
      validate_undo_move_out(req.body),
      req.ip
    );

    return res.status(200).json({
      success: true,
      message:
        "The move-out was undone. The tenant lives in the unit again.",
      data: tenant,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  undo_move_out,
  create_tenant,
  list_property_tenants,
  list_tenants,
  get_tenant,
  update_tenant,
  move_out_tenant,
};