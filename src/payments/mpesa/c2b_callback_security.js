const crypto = require("crypto");

const {
  encrypt_json,
  decrypt_json,
} = require("../../utils/crypto");

/*
  Landlords' M-Pesa payment notices (C2B) come to a public address,
  so anyone who knew it could post a made-up payment. Each payment
  account therefore gets its own long random secret in its address:

    /api/properties/c2b/confirmation/<secret>

  The secret is kept encrypted with the account and checked, in
  constant time, against the account that owns the business number
  in the notice. A leaked address affects one account only.
  Safaricom has no way to confirm a C2B payment without the
  landlord's extra API (initiator) credentials, so the secret is the
  main guard; MPESA_CALLBACK_ALLOWED_IPS can also limit notices to
  Safaricom's network addresses.

  The old addresses without a secret no longer record payments
  (unless MPESA_C2B_ALLOW_LEGACY_CALLBACKS=true, for a short move):
  re-register the account's addresses in Settings, Payment accounts.
*/

function new_callback_token() {
  return crypto.randomBytes(32).toString("hex");
}

function seal_callback_token(token) {
  return encrypt_json({ token });
}

function callback_token_matches(sealed, given) {
  if (!sealed || typeof given !== "string" || !/^[a-f0-9]{64}$/.test(given)) {
    return false;
  }

  let expected;

  try {
    expected = decrypt_json(sealed).token;
  } catch {
    return false;
  }

  const a = Buffer.from(String(expected), "utf8");
  const b = Buffer.from(given, "utf8");

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Never written to logs or shown in full: the secret is the part after the last slash.
function mask_callback_url(url) {
  return String(url || "").replace(/\/[a-f0-9]{64}$/, "/…");
}

/*
  MPESA_CALLBACK_ALLOWED_IPS: comma-separated addresses Safaricom
  sends from (from Safaricom's Daraja documentation). Empty: any
  address (the secret still applies). Needs TRUST_PROXY=true on
  Render so the real address is seen.
*/
function callback_ip_allowed(ip) {
  const allowed = String(process.env.MPESA_CALLBACK_ALLOWED_IPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!allowed.length) {
    return true;
  }

  const address = String(ip || "").replace(/^::ffff:/, "");

  return allowed.includes(address);
}

const legacy_callbacks_allowed = () =>
  process.env.MPESA_C2B_ALLOW_LEGACY_CALLBACKS === "true";

module.exports = {
  new_callback_token,
  seal_callback_token,
  callback_token_matches,
  mask_callback_url,
  callback_ip_allowed,
  legacy_callbacks_allowed,
};
