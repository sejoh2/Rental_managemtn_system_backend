const db = require("../config/db");

const subscriptions = require("./subscription_service");
const payments = require("./subscription_payment_service");
const mpesa = require("./subscription_mpesa");
const dates = require("./subscription_dates");

/*
  Every minute: payment requests without a result are checked with
  Safaricom. Every 15 minutes: bills on the 1st, the automatic
  M-Pesa prompt, and reminders by SMS, only between 09:00 and
  19:00 Nairobi time:
  - trial ending: 7, 3 and 1 days before;
  - a new bill, with the prompt;
  - during the grace days: every 2 days;
  - the day the account becomes read-only.
  Each reminder goes once (subscription_notices). Under an advisory
  lock, so two servers never send the same thing.
*/

const BILLING_EVERY_MS = 15 * 60 * 1000;
const money = payments.money;

async function send_notice(owner_id, notice_key, message) {
  const fresh = (
    await db.query(
      "INSERT INTO subscription_notices (owner_id, notice_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING notice_key",
      [owner_id, notice_key]
    )
  ).rows[0];

  if (fresh) await payments.notify_owner(owner_id, message);

  return Boolean(fresh);
}

async function bill_owner(owner_id, now) {
  const hour = dates.nairobi_hour(now);
  const daytime = hour >= 9 && hour < 19;
  let status = await subscriptions.account_status(owner_id, { now });

  if (status.state === "trial") {
    if (daytime && [7, 3, 1].includes(status.days_left)) {
      const after = dates.add_days(status.trial_ends_on, 1);

      await send_notice(
        owner_id,
        `trial:${status.trial_ends_on}:${status.days_left}`,
        `Kodi: your free trial ends on ${dates.label(status.trial_ends_on)} (in ${status.days_left} day${status.days_left === 1 ? "" : "s"}). From ${dates.label(after)} Kodi is ${money(status.monthly_price)} a month. Pay in Kodi, Settings, Billing.`
      );
    }

    return;
  }

  if (!["grace", "read_only"].includes(status.state)) return;

  const { invoice } = await subscriptions.ensure_monthly_invoice(owner_id, now);

  // A bill of 0 (a full discount) is settled at once.
  status = await subscriptions.account_status(owner_id, { now });

  if (!invoice || invoice.status !== "open" || !daytime) return;

  const period = dates.period_label(invoice.period_start, invoice.period_end);

  if (status.state === "grace") {
    await send_notice(
      owner_id,
      `bill:${invoice.invoice_id}`,
      `Kodi: your bill for ${period} is ${money(invoice.amount_due)}. Approve the M-Pesa prompt on your phone, or pay in Kodi, Settings, Billing, by ${dates.label(status.grace_ends_on)}.`
    );

    if (!invoice.auto_stk_at && mpesa.configured()) {
      await db.query("UPDATE subscription_invoices SET auto_stk_at = CURRENT_TIMESTAMP WHERE invoice_id = $1", [invoice.invoice_id]);

      await payments.request_payment({ owner_id, automatic: true }).catch((error) => {
        console.error(`[SUBSCRIPTIONS] Automatic payment request for owner ${owner_id} failed:`, error.message);
      });
    }

    if (status.days_overdue > 1 && status.days_overdue % 2 === 1) {
      await send_notice(
        owner_id,
        `due:${invoice.invoice_id}:${status.days_overdue}`,
        `Kodi: your bill of ${money(invoice.amount_due)} is not paid yet. Pay by ${dates.label(status.grace_ends_on)} to keep using Kodi fully: Settings, Billing.`
      );
    }

    return;
  }

  await send_notice(
    owner_id,
    `read_only:${status.covered_until}`,
    `Kodi: your account is now read-only because the bill of ${money(invoice.amount_due)} is unpaid. You can still see everything, and tenants' M-Pesa payments are still recorded. Pay in Settings, Billing to continue at once.`
  );
}

async function run_billing(now = new Date()) {
  const lock = await db.get_client();

  try {
    if (!(await lock.query("SELECT pg_try_advisory_lock(hashtext('kodi_subscriptions')) AS ok")).rows[0].ok) return 0;

    try {
      const owners = (await db.query("SELECT user_id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY user_id")).rows;

      for (const { user_id } of owners) {
        try {
          await bill_owner(user_id, now);
        } catch (error) {
          console.error(`[SUBSCRIPTIONS] Billing owner ${user_id} failed:`, error.message);
        }
      }

      return owners.length;
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('kodi_subscriptions'))");
    }
  } finally {
    lock.release();
  }
}

let scheduler_started = false;

function start_subscription_scheduler() {
  if (scheduler_started) return;

  scheduler_started = true;

  let last_billing = 0;
  let running = false;

  const run = async () => {
    if (running) return;

    running = true;

    try {
      if (mpesa.configured()) await payments.check_waiting_requests();

      if (Date.now() - last_billing >= BILLING_EVERY_MS) {
        last_billing = Date.now();
        await run_billing();
      }
    } catch (error) {
      console.error("[SUBSCRIPTIONS] Scheduled check failed:", error.message);
    } finally {
      running = false;
    }
  };

  run();
  setInterval(run, 60 * 1000).unref();
}

module.exports = {
  run_billing,
  bill_owner,
  start_subscription_scheduler,
};
