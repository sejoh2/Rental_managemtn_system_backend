const crypto = require("crypto");
const axios = require("axios");

const {
  get_access_token,
} = require("../payments/mpesa/daraja_c2b_client");

/*
  Kodi's own till (not a landlord's): STK push ("enter your PIN"
  on the landlord's phone) and asking Safaricom for a request's
  result. Credentials live only in the server's environment:

  KODI_MPESA_ENV             sandbox or production
  KODI_MPESA_CONSUMER_KEY    the Daraja app's key and secret
  KODI_MPESA_CONSUMER_SECRET
  KODI_MPESA_SHORTCODE       the till's store (head office) number
  KODI_MPESA_TILL_NUMBER     the till that receives the money

  Till only (Buy Goods), decided 2026-10-18: no paybill.
  KODI_MPESA_PASSKEY         from Safaricom when the till goes live on Daraja
  KODI_MPESA_RESULT_SECRET   long random text in the result address

  The result address is PUBLIC_API_URL + /api/subscriptions/stk-result/<secret>
  (Safaricom refuses addresses with words such as "mpesa" or "query").
*/

const env = () => (process.env.KODI_MPESA_ENV === "production" ? "production" : "sandbox");
const base_url = () => (env() === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");

function configured() {
  return Boolean(
    process.env.KODI_MPESA_CONSUMER_KEY &&
      process.env.KODI_MPESA_CONSUMER_SECRET &&
      process.env.KODI_MPESA_SHORTCODE &&
      process.env.KODI_MPESA_TILL_NUMBER &&
      process.env.KODI_MPESA_PASSKEY &&
      (process.env.KODI_MPESA_RESULT_SECRET || "").length >= 32 &&
      /^https:\/\//.test(process.env.PUBLIC_API_URL || "")
  );
}

function result_url() {
  return `${(process.env.PUBLIC_API_URL || "").replace(/\/+$/, "")}/api/subscriptions/stk-result/${process.env.KODI_MPESA_RESULT_SECRET}`;
}

// Compared in constant time; a wrong secret looks like any unknown address.
function result_secret_matches(given) {
  const expected = Buffer.from(process.env.KODI_MPESA_RESULT_SECRET || "", "utf8");
  const received = Buffer.from(String(given || ""), "utf8");

  return expected.length >= 32 && expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// Daraja's timestamp, in Nairobi time: YYYYMMDDHHmmss.
function timestamp(now = new Date()) {
  const nairobi = new Date(now.getTime() + 3 * 3600 * 1000);

  return nairobi.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function password(time) {
  return Buffer.from(`${process.env.KODI_MPESA_SHORTCODE}${process.env.KODI_MPESA_PASSKEY}${time}`).toString("base64");
}

let cached_token = null;

async function token() {
  if (cached_token && cached_token.expires_at > Date.now()) return cached_token.value;

  const value = await get_access_token({
    consumer_key: process.env.KODI_MPESA_CONSUMER_KEY,
    consumer_secret: process.env.KODI_MPESA_CONSUMER_SECRET,
    environment: env(),
  });

  // Daraja tokens last an hour.
  cached_token = { value, expires_at: Date.now() + 50 * 60 * 1000 };

  return value;
}

class MpesaError extends Error {
  constructor(message, { code = null, pending = false } = {}) {
    super(message);
    this.name = "MpesaError";
    this.code = code;
    this.pending = pending;
  }
}

function explain(error) {
  const data = error.response?.data || {};
  const code = data.errorCode || data.ResponseCode || null;
  const message = data.errorMessage || data.ResponseDescription || error.message || "M-Pesa did not answer.";

  return new MpesaError(`M-Pesa refused: ${String(message).slice(0, 200)}`, {
    code,
    // The request is still being processed: ask again later.
    pending: /500\.001\.1001|being processed/i.test(`${code} ${message}`),
  });
}

/*
  Sends the prompt. phone is "2547XXXXXXXX".
  -> { checkout_request_id, merchant_request_id, customer_message }
*/
async function stk_push({ phone, amount, account_reference, description }) {
  const time = timestamp();

  try {
    const response = await axios.post(
      `${base_url()}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.KODI_MPESA_SHORTCODE,
        Password: password(time),
        Timestamp: time,
        TransactionType: "CustomerBuyGoodsOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.KODI_MPESA_TILL_NUMBER,
        PhoneNumber: phone,
        CallBackURL: result_url(),
        AccountReference: account_reference.slice(0, 12),
        TransactionDesc: description.slice(0, 13),
      },
      { headers: { Authorization: `Bearer ${await token()}` }, timeout: 30000 }
    );

    if (String(response.data?.ResponseCode) !== "0") throw new MpesaError(`M-Pesa refused: ${response.data?.ResponseDescription || "no reason given"}`);

    return {
      checkout_request_id: response.data.CheckoutRequestID,
      merchant_request_id: response.data.MerchantRequestID,
      customer_message: response.data.CustomerMessage,
    };
  } catch (error) {
    if (error instanceof MpesaError) throw error;
    throw explain(error);
  }
}

/*
  Asks Safaricom directly how a request ended, so a payment never
  rests on the result message alone.
  -> { result_code: "0" when paid, result_desc }
*/
async function stk_status(checkout_request_id) {
  const time = timestamp();

  try {
    const response = await axios.post(
      `${base_url()}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: process.env.KODI_MPESA_SHORTCODE,
        Password: password(time),
        Timestamp: time,
        CheckoutRequestID: checkout_request_id,
      },
      { headers: { Authorization: `Bearer ${await token()}` }, timeout: 30000 }
    );

    return {
      result_code: response.data?.ResultCode === undefined ? null : String(response.data.ResultCode),
      result_desc: response.data?.ResultDesc || null,
    };
  } catch (error) {
    throw explain(error);
  }
}

module.exports = {
  MpesaError,
  env,
  configured,
  result_url,
  result_secret_matches,
  stk_push,
  stk_status,
  timestamp,
};
