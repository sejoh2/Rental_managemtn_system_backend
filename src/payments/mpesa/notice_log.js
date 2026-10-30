/*
  One line in the server log for every M-Pesa payment notice, so the
  owner can see on Render whether Safaricom called and what Kodi did:
    [MPESA] Payment notice for 600996, KES 8,000 (TJU4K8P2QX): matched to house A1 (pay_...)
  No name or phone number: the log is kept outside the database.
*/
function notice_log_line(payload, outcome) {
  const shortcode = String(payload?.BusinessShortCode || "?").slice(0, 20);
  const receipt = String(payload?.TransID || "?").slice(0, 30);
  const amount = Number(payload?.TransAmount);
  const amount_text = Number.isFinite(amount) && payload?.TransAmount !== undefined
    ? `KES ${amount.toLocaleString("en-KE")}`
    : "an unknown amount";

  return `[MPESA] Payment notice for ${shortcode}, ${amount_text} (${receipt}): ${outcome}`;
}

module.exports = {
  notice_log_line,
};
