const {
  account_status,
} = require("./subscription_service");

/*
  A read-only account (bill unpaid after the grace days) can sign
  in, see and download everything, and pay its bill; it cannot add,
  change or send anything. Checked on the server for every request
  that changes something, whatever the page shows. Tenants' M-Pesa
  payments still arrive and are recorded (those come from
  Safaricom, not from a signed-in person). The admin is never
  blocked, also inside an owner's account.
*/

// Marking repairs as read changes nothing in the account, so it works while read-only too.
const ALWAYS_ALLOWED =
  /^\/api\/(auth|subscriptions|admin|users)(\/|\?|$)|^\/api\/live\/ticket(\?|$)|^\/api\/maintenance\/notices\/seen(\?|$)/;
const READING = new Set(["GET", "HEAD", "OPTIONS"]);

function account_owner_id(user) {
  if (user.role === "owner") return user.user_id;
  if (user.role === "caretaker") return user.owner_id;

  return null;
}

// -> null when allowed, or the refusal to send.
async function write_refusal(req) {
  if (READING.has(req.method) || req.admin || ALWAYS_ALLOWED.test(req.originalUrl)) return null;

  const owner_id = account_owner_id(req.user);

  if (!owner_id) return null;

  const status = await account_status(owner_id);

  if (!status.read_only) return null;

  return {
    success: false,
    code: "account_read_only",
    error:
      req.user.role === "owner"
        ? "Your Kodi account is read-only because the Kodi bill is not paid. Pay it in Settings, Billing, and everything works again at once."
        : "This Kodi account is read-only until the owner pays the Kodi bill.",
  };
}

async function owner_is_read_only(owner_id) {
  if (!owner_id) return false;

  return (await account_status(owner_id)).read_only;
}

/*
  Used just before an SMS goes out for an owner's account. The
  message is then kept as failed with this reason, and can be sent
  again once the bill is paid.
*/
async function assert_can_send_sms(owner_id) {
  if (await owner_is_read_only(owner_id)) {
    throw new Error("Not sent: this Kodi account is read-only until the Kodi bill is paid.");
  }
}

module.exports = {
  write_refusal,
  owner_is_read_only,
  assert_can_send_sms,
  account_owner_id,
};
