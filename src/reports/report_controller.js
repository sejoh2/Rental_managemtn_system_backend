const report_service = require(
  "./report_service"
);

const {
  stream_dashboard_pdf,
  stream_dashboard_csv,
  stream_tenant_statement_pdf,
} = require("./report_file_service");

const {
  validate_dashboard_filters,
  validate_export_filters,
  validate_tenant_statement_filters,
  validate_tenant_id,
} = require("./report_validator");

async function get_dashboard_report(
  req,
  res,
  next
) {
  try {
    const filters = validate_dashboard_filters(
      req.query
    );

    const report =
      await report_service.get_dashboard_report(
        req.user,
        filters
      );

    return res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    next(error);
  }
}

async function export_report(req, res, next) {
  try {
    const filters = validate_export_filters(
      req.query
    );

    const report =
      await report_service.get_dashboard_report(
        req.user,
        filters
      );

    if (filters.format === "csv") {
      return stream_dashboard_csv(
        res,
        report,
        filters.type
      );
    }

    return stream_dashboard_pdf(
      res,
      report,
      filters.type
    );
  } catch (error) {
    next(error);
  }
}

async function get_tenant_statement(
  req,
  res,
  next
) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const filters =
      validate_tenant_statement_filters(
        req.query
      );

    const statement =
      await report_service.get_tenant_statement(
        req.user,
        tenant_id,
        filters
      );

    return res.status(200).json({
      success: true,
      data: statement,
    });
  } catch (error) {
    next(error);
  }
}

async function download_tenant_statement_pdf(
  req,
  res,
  next
) {
  try {
    const tenant_id = validate_tenant_id(
      req.params.tenant_id
    );

    const filters =
      validate_tenant_statement_filters(
        req.query
      );

    const statement =
      await report_service.get_tenant_statement(
        req.user,
        tenant_id,
        filters
      );

    return stream_tenant_statement_pdf(
      res,
      statement
    );
  } catch (error) {
    next(error);
  }
}

module.exports = {
  get_dashboard_report,
  export_report,
  get_tenant_statement,
  download_tenant_statement_pdf,
};