/*
  CSV files are opened in spreadsheet programs, which treat a
  cell starting with = + - or @ as a formula. Text typed by a
  user (a tenant name, a note, a reference) could therefore run
  a formula on the owner's computer. Such cells are prefixed
  with an apostrophe so they are shown as plain text.
  Numbers are left alone so they can still be summed.
*/
function csv_cell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return String(value);
  }

  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function to_csv(headers, rows) {
  return [headers, ...rows]
    .map((row) => row.map(csv_cell).join(","))
    .join("\r\n");
}

/*
  The byte-order mark makes Excel read the file as UTF-8.
*/
function send_csv(res, filename, headers, rows) {
  res.setHeader(
    "Content-Type",
    "text/csv; charset=utf-8"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  return res
    .status(200)
    .send(`﻿${to_csv(headers, rows)}`);
}

/*
  "repairs_maintenance" -> "Repairs maintenance"
*/
function humanize(value) {
  if (!value) {
    return "";
  }

  const text = String(value).replace(/_/g, " ");

  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = {
  to_csv,
  send_csv,
  humanize,
};
