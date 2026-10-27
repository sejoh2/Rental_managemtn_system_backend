const axios = require("axios");

function get_base_url(environment) {
  return environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

function normalize_msisdn(phone) {
  let value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("0")) {
    value = `254${value.slice(1)}`;
  }

  if (!value.startsWith("254")) {
    value = `254${value}`;
  }

  return value;
}

async function get_access_token({
  consumer_key,
  consumer_secret,
  environment,
}) {
  const authorization = Buffer.from(
    `${consumer_key}:${consumer_secret}`
  ).toString("base64");

  const response = await axios.get(
    `${get_base_url(environment)}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${authorization}`,
      },
      timeout: 15000,
    }
  );

  if (!response.data?.access_token) {
    throw new Error(
      "Daraja did not return an access token."
    );
  }

  return response.data.access_token;
}

async function register_c2b_urls({
  consumer_key,
  consumer_secret,
  business_number,
  environment,
  validation_url,
  confirmation_url,
}) {
  const access_token = await get_access_token({
    consumer_key,
    consumer_secret,
    environment,
  });

  const register = (version) =>
    axios.post(
      `${get_base_url(environment)}/mpesa/c2b/${version}/registerurl`,
      {
        ShortCode: String(business_number),
        ResponseType: "Completed",
        ValidationURL: validation_url,
        ConfirmationURL: confirmation_url,
      },
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

  try {
    try {
      return (await register("v2")).data;
    } catch (error) {
      /*
        The sandbox's v2 registration is often "currently
        unreachable" (500.003.1001) while v1 works: try v1 once.
        Production keeps v2 only.
      */
      if (environment !== "production" && error.response?.status >= 500) {
        return (await register("v1")).data;
      }

      throw error;
    }
  } catch (error) {
    const message = String(
      error.response?.data?.errorMessage ||
        error.response?.data?.ResponseDescription ||
        error.message ||
        ""
    ).toLowerCase();

    if (message.includes("duplicate notification info")) {
      return {
        already_registered: true,
      };
    }

    // Only the status and Safaricom's answer: the request holds the access token.
    console.error(
      "[MPESA] Registering the payment address failed:",
      error.response?.status || error.code || "",
      JSON.stringify(error.response?.data || {}).slice(0, 500)
    );

    const reason = error.response?.data?.errorMessage || error.response?.data?.ResponseDescription || null;
    const refused = new Error(
      `Safaricom did not accept the payment address for ${business_number}${reason ? `: ${String(reason).replace(/[.\s]+$/, "")}` : " (it answered with an error)"}. Try again in a moment; in the sandbox, try another test shortcode.`
    );

    refused.status_code = 502;
    throw refused;
  }
}

/*
  Sandbox only. Daraja C2B simulation supports PayBill accounts.
*/
async function simulate_c2b_payment({
  consumer_key,
  consumer_secret,
  business_number,
  phone,
  amount,
  bill_reference,
}) {
  const access_token = await get_access_token({
    consumer_key,
    consumer_secret,
    environment: "sandbox",
  });

  const response = await axios.post(
    `${get_base_url("sandbox")}/mpesa/c2b/v1/simulate`,
    {
      ShortCode: String(business_number),
      CommandID: "CustomerPayBillOnline",
      Amount: Number(amount),
      Msisdn: normalize_msisdn(phone),
      BillRefNumber: bill_reference || "KODI-TEST",
    },
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return response.data;
}

module.exports = {
  get_access_token,
  register_c2b_urls,
  simulate_c2b_payment,
};