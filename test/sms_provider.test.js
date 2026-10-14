/*
  The SMS sender in live mode, with Africa's Talking replaced by a
  fake, so no message is ever sent and no key is needed.
*/
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { send_sms } = require("../src/utils/sms_provider");

const real_fetch = global.fetch;
const saved_env = { ...process.env };

let requests;

function answer(status, body) {
  global.fetch = async (url, options) => {
    requests.push({ url, options });

    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status }
    );
  };
}

function accepted(status_code = 101, status = "Success") {
  return {
    SMSMessageData: {
      Message: "Sent to 1/1 Total Cost: KES 0.8000",
      Recipients: [
        {
          statusCode: status_code,
          number: "+254712345678",
          status,
          cost: "KES 0.8000",
          messageId: "ATXid_test",
        },
      ],
    },
  };
}

beforeEach(() => {
  requests = [];
  process.env.SMS_MODE = "live";
  process.env.AFRICASTALKING_USERNAME = "rentalco";
  process.env.AFRICASTALKING_API_KEY = "test-key";
  delete process.env.AFRICASTALKING_SENDER_ID;
});

afterEach(() => {
  global.fetch = real_fetch;
  process.env = { ...saved_env };
});

test("sends the message as Africa's Talking expects it", async () => {
  answer(201, accepted());

  const result = await send_sms({
    phone: "+254712345678",
    message: "Your code is 123456",
    sender_id: "RENTALCO",
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.provider, "africastalking");
  assert.equal(requests.length, 1);

  const { url, options } = requests[0];
  const form = new URLSearchParams(options.body);

  assert.equal(url, "https://api.africastalking.com/version1/messaging");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.apiKey, "test-key");
  assert.equal(options.headers.Accept, "application/json");
  assert.equal(form.get("username"), "rentalco");
  assert.equal(form.get("to"), "+254712345678");
  assert.equal(form.get("message"), "Your code is 123456");
  assert.equal(form.get("from"), "RENTALCO");
});

test("uses the default sender ID when the property has none", async () => {
  process.env.AFRICASTALKING_SENDER_ID = "DEFAULTID";
  answer(201, accepted());

  await send_sms({ phone: "+254712345678", message: "Hello" });

  assert.equal(new URLSearchParams(requests[0].options.body).get("from"), "DEFAULTID");
});

test("sends without a sender ID when there is none at all", async () => {
  answer(201, accepted());

  await send_sms({ phone: "+254712345678", message: "Hello" });

  assert.equal(new URLSearchParams(requests[0].options.body).has("from"), false);
});

test("the sandbox account uses the sandbox address", async () => {
  process.env.AFRICASTALKING_USERNAME = "sandbox";
  answer(201, accepted());

  await send_sms({ phone: "+254712345678", message: "Hello" });

  assert.equal(requests[0].url, "https://api.sandbox.africastalking.com/version1/messaging");
});

test("a refused sender ID is reported, even though the answer is 201", async () => {
  answer(201, accepted(406, "InvalidSenderId"));

  await assert.rejects(
    send_sms({ phone: "+254712345678", message: "Hello", sender_id: "NOTOURS" }),
    /refused the sender ID "NOTOURS"/
  );
});

test("any other refusal is reported with its reason", async () => {
  answer(201, accepted(403, "InvalidPhoneNumber"));

  await assert.rejects(
    send_sms({ phone: "+254", message: "Hello" }),
    /did not send this message: InvalidPhoneNumber/
  );
});

test("a wrong API key is reported", async () => {
  answer(401, "The supplied authentication is invalid");

  await assert.rejects(
    send_sms({ phone: "+254712345678", message: "Hello" }),
    /refused the request: The supplied authentication is invalid/
  );
});

test("no connection is reported, not thrown as a raw error", async () => {
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    send_sms({ phone: "+254712345678", message: "Hello" }),
    /could not be reached. The message was not sent/
  );
});

test("console mode never calls Africa's Talking", async () => {
  process.env.SMS_MODE = "console";
  answer(201, accepted());

  const original_log = console.log;
  console.log = () => {};

  try {
    const result = await send_sms({ phone: "+254712345678", message: "Hello" });

    assert.equal(result.provider, "console");
  } finally {
    console.log = original_log;
  }

  assert.equal(requests.length, 0);
});
