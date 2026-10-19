const PDFDocument = require("pdfkit");

const {
  send_csv,
  humanize,
} = require("../utils/csv");

/*
  Builds the files for the Reports page: the report export as
  PDF or CSV, and the tenant statement PDF. The figures come
  from report_service; nothing is calculated here.
*/

const report_titles = {
  full_monthly_summary: "Full summary",
  rent_collection: "Rent collection",
  water_billing: "Water billing",
  occupancy_arrears: "Occupancy and arrears",
  sms_usage: "SMS usage",
};

const charge_names = {
  rent: "Rent",
  water: "Water",
  electricity: "Electricity",
  rent_deposit: "Rent deposit",
  water_deposit: "Water deposit",
  electricity_deposit: "Electricity deposit",
  service: "Service charge",
  repair: "Repair",
  deduction: "Deduction",
};

const method_labels = {
  mpesa: "M-Pesa",
  cash: "Cash",
  bank: "Bank transfer",
  other: "Other",
};

const month_names = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function format_money(value) {
  return `KES ${Number(value || 0).toLocaleString(
    "en-KE",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

/*
  "2026-10-05" -> "5 Oct 2026". Dates arrive as text, so no
  time zone can move them to the day before.
*/
function format_day(value) {
  if (!value) {
    return "-";
  }

  const [year, month, day] = String(value)
    .slice(0, 10)
    .split("-")
    .map(Number);

  return `${day} ${month_names[month - 1]} ${year}`;
}

function period_text(period) {
  return `${format_day(period.start_date)} to ${format_day(
    period.end_date
  )}`;
}

function generated_text() {
  return `Generated on ${new Date().toLocaleString(
    "en-KE",
    { timeZone: "Africa/Nairobi" }
  )}`;
}

/*
  "Rent - Oct 2026", "Garbage - Oct 2026", "Rent deposit".
  Deposits and one-off charges use the placeholder period
  1970-01-01 and have no month. billing_period is 'YYYY-MM-DD'.
*/
function charge_label(charge) {
  const name =
    charge.description ||
    charge_names[charge.charge_type] ||
    humanize(charge.charge_type);

  const period = String(charge.billing_period || "");

  if (!period || period.startsWith("1970")) {
    return name;
  }

  const [year, month] = period.split("-").map(Number);

  return `${name} - ${month_names[month - 1]} ${year}`;
}

function safe_filename(value) {
  return String(value || "report")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function tenant_state(row) {
  return row.is_current ? "Current" : "Former";
}

/*
  What each report type holds. Both the PDF and the CSV are
  built from this, so they always agree.

  A section is { title, lines, table }:
    lines  [label, value, is_money]
    table  { headers, rows, money_columns }
*/
function report_sections(report, report_type) {
  const sections = [];
  const full = report_type === "full_monthly_summary";

  if (full || report_type === "occupancy_arrears") {
    sections.push({
      title: "Occupancy",
      lines: [
        ["Total units", report.occupancy.total_units],
        ["Occupied units", report.occupancy.occupied_units],
        ["Vacant units", report.occupancy.vacant_units],
        [
          "Occupancy rate",
          `${report.occupancy.occupancy_rate}%`,
        ],
      ],
    });

    sections.push({
      title: "Arrears by property",
      lines: [
        [
          "Owed by current tenants",
          report.arrears.total_arrears,
          true,
        ],
        [
          "Owed by former tenants",
          report.arrears.total_former_arrears,
          true,
        ],
      ],
      table: {
        headers: [
          "Property",
          "Current tenants owe",
          "Tenants",
          "Former tenants owe",
          "Tenants",
        ],
        money_columns: [1, 3],
        rows: report.arrears.by_property.map((item) => [
          item.property_name,
          item.arrears_amount,
          item.tenants_in_arrears,
          item.former_tenant_arrears,
          item.former_tenants_in_arrears,
        ]),
      },
    });

    sections.push({
      title: "Tenants who owe money",
      table: {
        headers: [
          "Property",
          "House",
          "Tenant",
          "Status",
          "Owes",
          "Oldest unpaid bill due",
        ],
        money_columns: [4],
        rows: report.details.arrears.map((row) => [
          row.property_name,
          row.unit_number,
          row.full_name,
          tenant_state(row),
          row.balance,
          format_day(row.oldest_due_date),
        ]),
      },
    });
  }

  if (full || report_type === "rent_collection") {
    sections.push({
      title: "Rent collection",
      lines: [
        [
          "Rent collected",
          report.collection.rent_collected,
          true,
        ],
        [
          "Deposits received (held for tenants, not income)",
          report.collection.deposits_collected,
          true,
        ],
      ],
      table: {
        headers: [
          "Property",
          "House",
          "Tenant",
          "Status",
          "Rent billed",
          "Paid",
          "Still owed",
        ],
        money_columns: [4, 5, 6],
        rows: report.details.rent.map((row) => [
          row.property_name,
          row.unit_number,
          row.full_name,
          tenant_state(row),
          row.billed,
          row.paid,
          row.billed - row.paid,
        ]),
      },
    });
  }

  if (full || report_type === "water_billing") {
    sections.push({
      title: "Water billing",
      lines: [
        ["Water billed", report.water.water_billed, true],
        [
          "Water collected",
          report.collection.water_collected,
          true,
        ],
        [
          "Water still owed",
          report.water.water_outstanding,
          true,
        ],
        [
          "Meter readings submitted",
          report.water.meter_readings_submitted,
        ],
        [
          "Flagged readings",
          report.water.flagged_readings,
        ],
      ],
      table: {
        headers: [
          "Property",
          "House",
          "Tenant",
          "Month",
          "Billed",
          "Paid",
          "Still owed",
        ],
        money_columns: [4, 5, 6],
        rows: report.details.water.map((row) => [
          row.property_name,
          row.unit_number,
          row.full_name,
          row.month,
          row.billed,
          row.paid,
          row.billed - row.paid,
        ]),
      },
    });
  }

  if (full) {
    sections.push({
      title: "Income and expenses",
      lines: [
        ["Rent", report.collection.rent_collected, true],
        ["Water", report.collection.water_collected, true],
        [
          "Electricity",
          report.collection.electricity_collected,
          true,
        ],
        [
          "Service charges",
          report.collection.service_collected,
          true,
        ],
        [
          "Repairs and deductions",
          report.collection.repairs_collected,
          true,
        ],
        [
          "Total income",
          report.collection.total_income,
          true,
        ],
        [
          "Expenses",
          report.expenses.total_expenses,
          true,
        ],
        [
          "Net income",
          report.expenses.net_operating_income,
          true,
        ],
      ],
    });
  }

  if (report_type === "sms_usage") {
    sections.push({
      title: "SMS usage",
      lines: [
        ["Messages", report.sms.total_messages],
        [
          "Accepted by the SMS provider",
          report.sms.accepted_messages,
        ],
        ["Failed", report.sms.failed_messages],
        [
          "Accepted",
          `${report.sms.delivery_rate}%`,
        ],
        ["Estimated cost", report.sms.sms_cost, true],
      ],
    });
  }

  return sections;
}

function report_filename(report, report_type, extension) {
  return `${safe_filename(
    report_titles[report_type]
  )}-${report.period.start_date}-to-${
    report.period.end_date
  }.${extension}`;
}

function start_pdf(res, filename, title) {
  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: title,
      Author: "Kodi",
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

  return document;
}

function write_key_value(document, label, value) {
  document.x = document.page.margins.left;

  document
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#111827")
    .text(`${label}: `, {
      continued: true,
    });

  document
    .font("Helvetica")
    .fontSize(9)
    .text(String(value));
}

function section_title(document, title) {
  document.x = document.page.margins.left;
  document.moveDown(1);

  if (
    document.y >
    document.page.height -
      document.page.margins.bottom -
      60
  ) {
    document.addPage();
  }

  document
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#1f2937")
    .text(title);

  document
    .moveTo(
      document.page.margins.left,
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

/*
  A plain table that spreads its columns across the page and
  starts a new page when it runs out of room.
*/
function write_table(document, table) {
  const left = document.page.margins.left;

  const width =
    (document.page.width -
      left -
      document.page.margins.right) /
    table.headers.length;

  const money_columns = table.money_columns || [];

  function write_row(cells, bold) {
    if (
      document.y >
      document.page.height -
        document.page.margins.bottom -
        28
    ) {
      document.addPage();
    }

    const top = document.y;
    let height = 0;

    document
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(8)
      .fillColor("#111827");

    cells.forEach((cell, index) => {
      const text = String(
        cell === null || cell === undefined ? "" : cell
      );

      const options = {
        width: width - 6,
        align:
          money_columns.includes(index) ? "right" : "left",
      };

      height = Math.max(
        height,
        document.heightOfString(text, options)
      );

      document.text(
        text,
        left + index * width,
        top,
        options
      );
    });

    document.x = left;
    document.y = top + height + 4;
  }

  write_row(table.headers, true);

  if (!table.rows.length) {
    document
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6b7280")
      .text("Nothing to show for this period.", left);
  }

  table.rows.forEach((row) => {
    write_row(
      row.map((cell, index) =>
        money_columns.includes(index)
          ? format_money(cell)
          : cell
      ),
      false
    );
  });

  document.x = left;
}

function write_footer(document) {
  document.x = document.page.margins.left;
  document.moveDown(2);

  document
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#6b7280")
    .text(generated_text(), {
      align: "center",
    });
}

function stream_dashboard_pdf(
  res,
  report,
  report_type
) {
  const title = `Kodi report - ${report_titles[report_type]}`;

  const document = start_pdf(
    res,
    report_filename(report, report_type, "pdf"),
    title
  );

  document
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(title.toUpperCase(), {
      align: "center",
    });

  document.moveDown(0.4);

  document
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#4b5563")
    .text(`Period: ${period_text(report.period)}`, {
      align: "center",
    });

  document.text(
    report.property_name
      ? `Property: ${report.property_name}`
      : "All properties",
    {
      align: "center",
    }
  );

  for (const section of report_sections(
    report,
    report_type
  )) {
    section_title(document, section.title);

    (section.lines || []).forEach(
      ([label, value, is_money]) => {
        write_key_value(
          document,
          label,
          is_money ? format_money(value) : value
        );
      }
    );

    if (section.table) {
      if (section.lines) {
        document.moveDown(0.6);
      }

      write_table(document, section.table);
    }
  }

  write_footer(document);

  document.end();
}

/*
  Built with the shared CSV helper, so text a user typed can
  never run as a spreadsheet formula. Amounts stay as numbers
  so they can be summed.
*/
function stream_dashboard_csv(
  res,
  report,
  report_type
) {
  const rows = [
    ["Period", period_text(report.period)],
    [
      "Property",
      report.property_name || "All properties",
    ],
    [],
  ];

  for (const section of report_sections(
    report,
    report_type
  )) {
    rows.push([section.title]);

    (section.lines || []).forEach(([label, value]) => {
      rows.push([label, value]);
    });

    if (section.table) {
      rows.push(section.table.headers);
      rows.push(...section.table.rows);
    }

    rows.push([]);
  }

  return send_csv(
    res,
    report_filename(report, report_type, "csv"),
    ["Kodi report", report_titles[report_type]],
    rows
  );
}

function stream_tenant_statement_pdf(res, statement) {
  const document = start_pdf(
    res,
    `tenant-statement-${safe_filename(
      statement.tenant.full_name
    )}-${statement.tenant.id}.pdf`,
    `Tenant statement - ${statement.tenant.full_name}`
  );

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
    "Property / house",
    `${statement.tenant.property_name} - ${statement.tenant.unit_number}`
  );

  write_key_value(
    document,
    "Period",
    period_text(statement.period)
  );

  write_key_value(
    document,
    "Balance owed today",
    format_money(statement.outstanding_balance)
  );

  write_key_value(
    document,
    "Credit held",
    format_money(statement.credit_balance)
  );

  const charges = statement.charges.filter(
    (charge) => charge.status !== "void"
  );

  section_title(document, "Charges");

  write_table(document, {
    headers: [
      "Charge",
      "Due",
      "Amount",
      "Paid",
      "Still owed",
    ],
    money_columns: [2, 3, 4],
    rows: [
      ...charges.map((charge) => [
        charge_label({
          ...charge,
          billing_period: charge.billing_period_text,
        }),
        format_day(charge.due_date_text),
        charge.amount_due,
        charge.amount_paid,
        charge.balance,
      ]),
      ...(charges.length
        ? [
            [
              "Total",
              "",
              charges.reduce(
                (total, charge) =>
                  total + charge.amount_due,
                0
              ),
              charges.reduce(
                (total, charge) =>
                  total + charge.amount_paid,
                0
              ),
              charges.reduce(
                (total, charge) =>
                  total + charge.balance,
                0
              ),
            ],
          ]
        : []),
    ],
  });

  section_title(document, "Payments");

  write_table(document, {
    headers: [
      "Date",
      "Amount",
      "Method",
      "Reference",
      "Paid for",
    ],
    money_columns: [1],
    rows: statement.payments.map((payment) => [
      format_day(payment.received_on),
      payment.amount,
      method_labels[payment.payment_method] ||
        payment.payment_method,
      payment.provider_transaction_id ||
        payment.reference ||
        "-",
      payment.applied_to.length
        ? payment.applied_to
            .map((item) => charge_label(item))
            .join(", ")
        : "Held as credit",
    ]),
  });

  const settlement = statement.deposit_settlement;

  if (settlement) {
    section_title(document, "Deposit reconciliation");

    write_key_value(
      document,
      "Reconciled on",
      format_day(settlement.confirmed_on)
    );

    write_key_value(
      document,
      "Deposits held",
      format_money(settlement.deposits_held)
    );

    if (settlement.credit_held > 0) {
      write_key_value(
        document,
        "Credit held",
        format_money(settlement.credit_held)
      );
    }

    write_key_value(
      document,
      "Used for unpaid bills and deductions",
      format_money(settlement.applied_to_bills)
    );

    if (settlement.tenant_owes > 0) {
      write_key_value(
        document,
        "Still owed by the tenant",
        format_money(settlement.tenant_owes)
      );
    } else {
      write_key_value(
        document,
        "Refund due to the tenant",
        format_money(settlement.refund_due)
      );

      if (settlement.refund_due > 0) {
        write_key_value(
          document,
          "Refund",
          settlement.refund_paid_on
            ? `Paid on ${format_day(
                settlement.refund_paid_on
              )} by ${
                method_labels[settlement.refund_method] ||
                settlement.refund_method
              }${
                settlement.refund_reference
                  ? ` (${settlement.refund_reference})`
                  : ""
              }`
            : "Not yet paid"
        );
      }
    }
  }

  write_footer(document);

  document.end();
}

module.exports = {
  stream_dashboard_pdf,
  stream_dashboard_csv,
  stream_tenant_statement_pdf,
};
