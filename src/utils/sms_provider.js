let sms_client = null;

function get_sms_client() {
  if (sms_client) {
    return sms_client;
  }

  const africastalking = require("africastalking");

  sms_client = africastalking({
    username: process.env.AFRICASTALKING_USERNAME,
    apiKey: process.env.AFRICASTALKING_API_KEY,
  }).SMS;

  return sms_client;
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

  const sms = get_sms_client();

  const options = {
    to: [phone],
    message,
  };

  /*
    Property sender ID takes priority. If a property does not have one,
    use the default sender ID from .env.
  */
  const final_sender_id =
    sender_id ||
    process.env.AFRICASTALKING_SENDER_ID ||
    null;

  if (final_sender_id) {
    options.senderId = final_sender_id;
  }

  const response = await sms.send(options);

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
  send_sms,
};