const PDFDocument = require("pdfkit");

function format_money(value) {
  return `KES ${Number(value || 0).toLocaleString(
    "en-KE",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

function format_date(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleDateString(
    "en-KE",
    {
      year: "numeric",
      month: "short",
      day: "numeric",
    }
  );
}

function safe_filename(value) {
  return String(value || "report")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function write_key_value(document, label, value) {
  document
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(`${label}: `, {
      continued: true,
    });

  document
    .font("Helvetica")
    .fontSize(9)
    .text(String(value));
}

function section_title(document, title) {
  document.moveDown(1);

  document
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#1f2937")
    .text(title);

  document
    .moveTo(
      document.x,
      document.y + 4
    )
    .lineTo(
      document.page.width - document.page.margins.right,
      document.y + 4
    )
    .strokeColor("#d1d5db")
    .stroke();

  document.moveDown(0.7);
}

function stream_dashboard_pdf(
  res,
  report,
  report_type
) {
  const filename = `${safe_filename(
    report_type
  )}-${report.period.start_date}-to-${
    report.period.end_date
  }.pdf`;

  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: "Rental Management Report",
      Author: "Rental Management System",
    },
  });

  res.status(200);

  res.setHeader(
    "Content-Type",
    "application/pdf"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  document.pipe(res);

  document
    .font("Helvetica-Bold")
    .fontSize(18)
    .text("RENTAL MANAGEMENT REPORT", {
      align: "center",
    });

  document.moveDown(0.4);

  document
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#4b5563")
    .text(
      `Period: ${report.period.start_date} to ${report.period.end_date}`,
      {
        align: "center",
      }
    );

  document.text(
    report.property_id
      ? `Property ID: ${report.property_id}`
      : "Scope: All properties",
    {
      align: "center",
    }
  );

  if (
    report_type === "full_monthly_summary" ||
    report_type === "occupancy_arrears"
  ) {
    section_title(document, "Occupancy");

    write_key_value(
      document,
      "Occupied units",
      `${report.occupancy.occupied_units} of ${report.occupancy.total_units}`
    );

    write_key_value(
      document,
      "Occupancy rate",
      `${report.occupancy.occupancy_rate}%`
    );

    write_key_value(
      document,
      "Vacant units",
      report.occupancy.vacant_units
    );

    write_key_value(
      document,
      "Maintenance units",
      report.occupancy.maintenance_units
    );

    section_title(document, "Arrears");

    write_key_value(
      document,
      "Total arrears",
      format_money(report.arrears.total_arrears)
    );

    report.arrears.by_property.forEach((property) => {
      document
        .font("Helvetica")
        .fontSize(9)
        .text(
          `${property.property_name}: ${format_money(
            property.arrears_amount
          )} (${property.tenants_in_arrears} tenant(s))`
        );
    });
  }

  if (
    report_type === "full_monthly_summary" ||
    report_type === "rent_collection"
  ) {
    section_title(document, "Rent Collection");

    write_key_value(
      document,
      "Rent collected",
      format_money(report.collection.rent_collected)
    );

    write_key_value(
      document,
      "Rent deposits collected",
      format_money(
        report.collection.rent_deposits_collected
      )
    );
  }

  if (
    report_type === "full_monthly_summary" ||
    report_type === "water_billing"
  ) {
    section_title(document, "Water Billing");

    write_key_value(
      document,
      "Water billed",
      format_money(report.water.water_billed)
    );

    write_key_value(
      document,
      "Water collected",
      format_money(report.water.water_collected)
    );

    write_key_value(
      document,
      "Water outstanding",
      format_money(report.water.water_outstanding)
    );

    write_key_value(
      document,
      "Meter readings submitted",
      report.water.meter_readings_submitted
    );

    write_key_value(
      document,
      "Flagged readings",
      report.water.flagged_readings
    );
  }

  if (report_type === "full_monthly_summary") {
    section_title(document, "Expenses and Operating Position");

    write_key_value(
      document,
      "Recorded expenses",
      format_money(
        report.expenses.total_expenses
      )
    );

    write_key_value(
      document,
      "Net operating income",
      format_money(
        report.expenses.net_operating_income
      )
    );
  }

  if (report_type === "sms_usage") {
    section_title(document, "SMS Usage");

    write_key_value(
      document,
      "Messages created",
      report.sms.total_messages
    );

    write_key_value(
      document,
      "Accepted by provider",
      report.sms.accepted_messages
    );

    write_key_value(
      document,
      "Failed",
      report.sms.failed_messages
    );

    write_key_value(
      document,
      "Acceptance rate",
      `${report.sms.delivery_rate}%`
    );

    write_key_value(
      document,
      "Estimated SMS cost",
      format_money(report.sms.sms_cost)
    );
  }

  document.moveDown(2);

  document
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#6b7280")
    .text(
      `Generated on ${new Date().toLocaleString(
        "en-KE"
      )}`,
      {
        align: "center",
      }
    );

  document.end();
}

function stream_tenant_statement_pdf(res, statement) {
  const filename = [
    "tenant-statement",
    safe_filename(statement.tenant.full_name),
    statement.tenant.id,
  ].join("-");

  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: `Tenant Statement - ${statement.tenant.full_name}`,
      Author: "Rental Management System",
    },
  });

  res.status(200);

  res.setHeader(
    "Content-Type",
    "application/pdf"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.pdf"`
  );

  document.pipe(res);

  document
    .font("Helvetica-Bold")
    .fontSize(17)
    .text("TENANT STATEMENT", {
      align: "center",
    });

  document.moveDown(1);

  write_key_value(
    document,
    "Tenant",
    statement.tenant.full_name
  );

  write_key_value(
    document,
    "Property / Unit",
    `${statement.tenant.property_name} - ${statement.tenant.unit_number}`
  );

  write_key_value(
    document,
    "Period",
    `${statement.period.start_date} to ${statement.period.end_date}`
  );

  write_key_value(
    document,
    "Outstanding balance",
    format_money(statement.outstanding_balance)
  );

  write_key_value(
    document,
    "Available credit",
    format_money(statement.credit_balance)
  );

  section_title(document, "Charges");

  if (!statement.charges.length) {
    document
      .font("Helvetica")
      .fontSize(9)
      .text("No charges found for this statement.");
  }

  statement.charges.forEach((charge) => {
    document
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(
        `${charge.charge_type.replace(/_/g, " ")} - ${format_date(
          charge.due_date
        )}`
      );

    document
      .font("Helvetica")
      .fontSize(9)
      .text(
        `Due: ${format_money(
          charge.amount_due
        )} | Paid: ${format_money(
          charge.amount_paid
        )} | Balance: ${format_money(
          charge.balance
        )}`
      );

    document.moveDown(0.35);
  });

  section_title(document, "Payments");

  if (!statement.payments.length) {
    document
      .font("Helvetica")
      .fontSize(9)
      .text("No matched payments found for this period.");
  }

  statement.payments.forEach((payment) => {
    document
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(
        `${format_date(
          payment.received_at
        )} - ${format_money(payment.amount)}`
      );

    document
      .font("Helvetica")
      .fontSize(9)
      .text(
        `${payment.payment_method} | Ref: ${
          payment.reference || "-"
        }`
      );

    document.moveDown(0.35);
  });

  document.moveDown(1);

  document
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#6b7280")
    .text(
      `Generated on ${new Date().toLocaleString(
        "en-KE"
      )}`,
      {
        align: "center",
      }
    );

  document.end();
}

function escape_csv(value) {
  const text = String(
    value === undefined ||
    value === null
      ? ""
      : value
  );

  return `"${text.replace(/"/g, '""')}"`;
}

function stream_dashboard_csv(
  res,
  report,
  report_type
) {
  const rows = [
    ["Report type", report_type],
    [
      "Period",
      `${report.period.start_date} to ${report.period.end_date}`,
    ],
    [
      "Property ID",
      report.property_id || "All properties",
    ],
    [],
  ];

  if (
    report_type === "full_monthly_summary" ||
    report_type === "occupancy_arrears"
  ) {
    rows.push(
      ["Occupancy"],
      [
        "Total units",
        report.occupancy.total_units,
      ],
      [
        "Occupied units",
        report.occupancy.occupied_units,
      ],
      [
        "Occupancy rate",
        `${report.occupancy.occupancy_rate}%`,
      ],
      [],
      ["Arrears by property"],
      [
        "Property",
        "Arrears",
        "Tenants in arrears",
      ]
    );

    report.arrears.by_property.forEach((item) => {
      rows.push([
        item.property_name,
        item.arrears_amount,
        item.tenants_in_arrears,
      ]);
    });

    rows.push([]);
  }

  if (
    report_type === "full_monthly_summary" ||
    report_type === "rent_collection"
  ) {
    rows.push(
      ["Rent Collection"],
      [
        "Rent collected",
        report.collection.rent_collected,
      ],
      [
        "Rent deposits collected",
        report.collection.rent_deposits_collected,
      ],
      []
    );
  }

  if (
    report_type === "full_monthly_summary" ||
    report_type === "water_billing"
  ) {
    rows.push(
      ["Water Billing"],
      [
        "Water billed",
        report.water.water_billed,
      ],
      [
        "Water collected",
        report.water.water_collected,
      ],
      [
        "Water outstanding",
        report.water.water_outstanding,
      ],
      [
        "Meter readings submitted",
        report.water.meter_readings_submitted,
      ],
      [
        "Flagged readings",
        report.water.flagged_readings,
      ],
      []
    );
  }

  if (report_type === "full_monthly_summary") {
    rows.push(
      ["Expenses"],
      [
        "Total expenses",
        report.expenses.total_expenses,
      ],
      [
        "Net operating income",
        report.expenses.net_operating_income,
      ],
      []
    );
  }

  if (report_type === "sms_usage") {
    rows.push(
      ["SMS Usage"],
      [
        "Messages created",
        report.sms.total_messages,
      ],
      [
        "Accepted by provider",
        report.sms.accepted_messages,
      ],
      [
        "Failed",
        report.sms.failed_messages,
      ],
      [
        "Acceptance rate",
        `${report.sms.delivery_rate}%`,
      ],
      [
        "Estimated SMS cost",
        report.sms.sms_cost,
      ]
    );
  }

  const csv = rows
    .map((row) =>
      row.map(escape_csv).join(",")
    )
    .join("\r\n");

  const filename = `${safe_filename(
    report_type
  )}-${report.period.start_date}-to-${
    report.period.end_date
  }.csv`;

  res.status(200);

  res.setHeader(
    "Content-Type",
    "text/csv; charset=utf-8"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  return res.send(csv);
}

module.exports = {
  stream_dashboard_pdf,
  stream_dashboard_csv,
  stream_tenant_statement_pdf,
};