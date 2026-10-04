const agreement_service = require(
  "./agreement_service"
);

const {
  validate_template,
  validate_sign_agreement,
  validate_list_agreements,
  validate_property_id,
  validate_tenant_id,
  validate_agreement_id,
} = require("./agreement_validator");

const {
  stream_agreement_pdf,
} = require("./agreement_pdf_service");

async function get_default_template(req, res, next) {
  try {
    const template =
      await agreement_service.get_default_template_for_owner(
        req.user
      );

    return res.status(200).json({
      success: true,
      data: template,
    });
  } catch (error) {
    next(error);
  }
}

async function save_default_template(req, res, next) {
  try {
    const data = validate_template(req.body);

    const template =
      await agreement_service.save_template(
        req.user,
        null,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Default agreement template saved successfully.",
      data: template,
    });
  } catch (error) {
    next(error);
  }
}

async function get_property_template(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const templates =
      await agreement_service.get_templates_for_property(
        req.user,
        property_id
      );

    return res.status(200).json({
      success: true,
      data: templates,
    });
  } catch (error) {
    next(error);
  }
}

async function save_property_template(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    const data = validate_template(req.body);

    const template =
      await agreement_service.save_template(
        req.user,
        property_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Property agreement template saved successfully.",
      data: template,
    });
  } catch (error) {
    next(error);
  }
}

async function delete_property_template(
  req,
  res,
  next
) {
  try {
    const property_id = validate_property_id(
      req.params.property_id
    );

    await agreement_service.delete_property_template(
      req.user,
      property_id,
      req.ip
    );

    return res.status(200).json({
      success: true,
      message:
        "Property template removed. The default template will now apply.",
    });
  } catch (error) {
    next(error);
  }
}

async function list_agreements(req, res, next) {
  try {
    const filters = validate_list_agreements(
      req.query
    );

    const agreements =
      await agreement_service.list_agreements(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      total: agreements.length,
      data: agreements,
    });
  } catch (error) {
    next(error);
  }
}

async function get_agreement(req, res, next) {
  try {
    const agreement_id = validate_agreement_id(
      req.params.agreement_id
    );

    const agreement =
      await agreement_service.get_agreement_by_id(
        req.user,
        agreement_id
      );

    return res.status(200).json({
      success: true,
      data: agreement,
    });
  } catch (error) {
    next(error);
  }
}

async function get_tenant_agreement(
  req,
  res,
  next
) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const agreement =
      await agreement_service.get_tenant_agreement(
        req.user,
        tenant_id
      );

    return res.status(200).json({
      success: true,
      data: agreement,
    });
  } catch (error) {
    next(error);
  }
}

async function generate_tenant_agreement(
  req,
  res,
  next
) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const agreement =
      await agreement_service.generate_agreement_for_existing_tenant(
        req.user,
        tenant_id,
        req.ip
      );

    return res.status(201).json({
      success: true,
      message:
        "Tenancy agreement generated successfully.",
      data: agreement,
    });
  } catch (error) {
    next(error);
  }
}

async function mark_agreement_signed(
  req,
  res,
  next
) {
  try {
    const agreement_id = validate_agreement_id(
      req.params.agreement_id
    );

    const data = validate_sign_agreement(req.body);

    const agreement =
      await agreement_service.mark_agreement_signed(
        req.user,
        agreement_id,
        data,
        req.ip
      );

    return res.status(200).json({
      success: true,
      message:
        "Agreement marked as signed successfully.",
      data: agreement,
    });
  } catch (error) {
    next(error);
  }
}

async function download_agreement_pdf(
  req,
  res,
  next
) {
  try {
    const agreement_id = validate_agreement_id(
      req.params.agreement_id
    );

    const agreement =
      await agreement_service.get_agreement_by_id(
        req.user,
        agreement_id
      );

    return stream_agreement_pdf(res, agreement);
  } catch (error) {
    next(error);
  }
}

async function download_tenant_agreement_pdf(
  req,
  res,
  next
) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const agreement =
      await agreement_service.get_tenant_agreement(
        req.user,
        tenant_id
      );

    return stream_agreement_pdf(res, agreement);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  get_default_template,
  save_default_template,

  get_property_template,
  save_property_template,
  delete_property_template,

  list_agreements,
  get_agreement,

  get_tenant_agreement,
  generate_tenant_agreement,

  mark_agreement_signed,

  download_agreement_pdf,
  download_tenant_agreement_pdf,
};