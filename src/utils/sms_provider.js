/*
  Africa's Talking's messaging API, called directly. Their Node
  package was dropped because it brought in an old version of
  axios with known security problems. The test account named
  "sandbox" has its own address.
*/
const LIVE_URL = "https://api.africastalking.com/version1/messaging";
const SANDBOX_URL =
  "https://api.sandbox.africastalking.com/version1/messaging";
const TIMEOUT_MS = 20000;

async function send_with_africastalking({ phone, message, sender_id }) {
  const username = process.env.AFRICASTALKING_USERNAME;

  const form = new URLSearchParams({
    username,
    to: phone,
    message,
  });

  if (sender_id) {
    form.set("from", sender_id);
  }

  let response;

  try {
    response = await fetch(
      username === "sandbox" ? SANDBOX_URL : LIVE_URL,
      {
        method: "POST",
        headers: {
          apiKey: process.env.AFRICASTALKING_API_KEY,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw new Error(
      error.name === "TimeoutError"
        ? "Africa's Talking did not answer in time. The message was not sent."
        : "Africa's Talking could not be reached. The message was not sent."
    );
  }

  const text = await response.text();
  let body = null;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  /*
    A refused request (a wrong API key or username, for example)
    answers with a status above 299, often in plain text.
  */
  if (!response.ok) {
    const reason =
      body?.SMSMessageData?.Message ||
      text.trim().slice(0, 200) ||
      `status ${response.status}`;

    throw new Error(
      `Africa's Talking refused the request: ${reason}.`
    );
  }

  return body;
}

/*
  Africa's Talking answers 201 even when it turns a message
  down (for example an unapproved sender ID), so the answer
  itself has to be read. 100, 101 and 102 mean the message was
  processed, sent or queued; anything else is a refusal.
*/
function check_provider_response(response, sender_id) {
  const data = response?.SMSMessageData || {};
  const recipient = (data.Recipients || [])[0];

  if (
    recipient &&
    [100, 101, 102].includes(Number(recipient.statusCode))
  ) {
    return;
  }

  const reason =
    recipient?.status ||
    data.Message ||
    "no reason given";

  if (/InvalidSenderId/i.test(reason)) {
    throw new Error(
      `Africa's Talking refused the sender ID "${sender_id}". ` +
      "It is not approved for this account. Remove it from the " +
      "property, or have it approved, then send again."
    );
  }

  throw new Error(
    `Africa's Talking did not send this message: ${reason}.`
  );
}

/*
  Used by both authentication OTPs and the SMS Centre.

  sender_id is optional. In live mode, it must be an Africa's Talking
  sender ID that has already been approved for your account.
*/
async function send_sms({
  phone,
  message,
  sender_id = null,
}) {
  const mode = process.env.SMS_MODE || "console";

  if (mode === "console") {
    console.log("");
    console.log(`[SMS CONSOLE] To: ${phone}`);

    if (sender_id) {
      console.log(`[SMS CONSOLE] Sender ID: ${sender_id}`);
    }

    console.log(`[SMS CONSOLE] ${message}`);
    console.log("");

    return {
      status: "accepted",
      provider: "console",
      response: {
        message: "SMS printed to the backend terminal.",
      },
    };
  }

  if (mode !== "live") {
    throw new Error("SMS_MODE must be console or live.");
  }

  /*
    Property sender ID takes priority. If a property does not have one,
    use the default sender ID from .env.
  */
  const final_sender_id =
    sender_id ||
    process.env.AFRICASTALKING_SENDER_ID ||
    null;

  const response = await send_with_africastalking({
    phone,
    message,
    sender_id: final_sender_id,
  });

  check_provider_response(response, final_sender_id);

  return {
    /*
      Africa's Talking accepts the message for processing here.
      Handset delivery receipts can be added later through an AT callback.
    */
    status: "accepted",
    provider: "africastalking",
    response,
  };
}

module.exports = {
  check_provider_response,
  send_sms,
};