function normalize_phone(phone) {
  let value = String(phone || "")
    .trim()
    .replace(/[\s()-]/g, "");

  if (!value) {
    return "";
  }

  if (value.startsWith("+")) {
    value = value.slice(1);
  }

  if (/^0[17]\d{8}$/.test(value)) {
    value = `254${value.slice(1)}`;
  }

  if (/^[17]\d{8}$/.test(value)) {
    value = `254${value}`;
  }

  if (!/^254[17]\d{8}$/.test(value)) {
    return "";
  }

  return `+${value}`;
}

function mask_phone(phone) {
  const normalized = normalize_phone(phone);

  if (!normalized) {
    return "";
  }

  return `${normalized.slice(0, 7)}***${normalized.slice(-3)}`;
}

module.exports = {
  normalize_phone,
  mask_phone,
};