const PDFDocument = require("pdfkit");

const dates = require("./subscription_dates");

/*
  A plain receipt for a payment to Kodi (not a tax invoice; eTIMS
  comes later). Built from the stored payment and bill only.
*/

const METHODS = {
  mpesa_stk: "M-Pesa",
  cash: "Cash",
  bank: "Bank transfer",
  mpesa_other: "M-Pesa",
  other: "Other",
};

const ACCENT = "#C1440E";
const INK = "#201C18";
const SOFT = "#6B635B";

const money = (amount) => `KSh ${Number(amount).toLocaleString("en-KE")}`;

function receipt_number(payment) {
  return `KODI-R-${String(payment.payment_id).padStart(6, "0")}`;
}

function build_receipt({ payment, invoice, owner }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 40, info: { Title: `Kodi receipt ${receipt_number(payment)}` } });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.roundedRect(40, 40, 26, 26, 6).fill(ACCENT);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(15).text("K", 40, 46, { width: 26, align: "center" });
    doc.fillColor(INK).fontSize(16).text("Kodi", 74, 45);
    doc.fillColor(SOFT).font("Helvetica").fontSize(9).text("Rental management", 74, 63);

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text("Receipt", 40, 100);
    doc.fillColor(SOFT).font("Helvetica").fontSize(9).text(`${receipt_number(payment)}   ·   ${dates.label(payment.paid_on)}`, 40, 124);

    const rows = [
      ["Received from", `${owner.first_name} ${owner.last_name}`.trim()],
      ["Phone", owner.phone],
      ["For", invoice ? `Kodi subscription, ${dates.period_label(invoice.period_start, invoice.period_end)}` : "Kodi subscription"],
      ["Paid by", METHODS[payment.method] || payment.method],
    ];

    if (payment.mpesa_receipt) rows.push(["M-Pesa receipt", payment.mpesa_receipt]);
    if (payment.reference && !payment.mpesa_receipt && payment.method !== "mpesa_stk") rows.push(["Reference", payment.reference]);
    if (invoice && invoice.discount_amount > 0) rows.push(["Discount", money(invoice.discount_amount)]);

    let y = 158;

    for (const [name, value] of rows) {
      doc.fillColor(SOFT).font("Helvetica").fontSize(9).text(name, 40, y, { width: 110 });
      doc.fillColor(INK).font("Helvetica").fontSize(10).text(String(value || "-"), 150, y, { width: 230 });
      y += 22;
    }

    doc.moveTo(40, y + 6).lineTo(380, y + 6).strokeColor("#E6DFD6").stroke();
    doc.fillColor(SOFT).font("Helvetica").fontSize(9).text("Amount paid", 40, y + 20);
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(20).text(money(payment.amount), 150, y + 14);

    doc.fillColor(SOFT).font("Helvetica").fontSize(8).text("Thank you for using Kodi. This receipt confirms payment; it is not a tax invoice.", 40, 540, { width: 340 });

    doc.end();
  });
}

module.exports = {
  build_receipt,
  receipt_number,
};
