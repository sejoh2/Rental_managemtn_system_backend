const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const dates = require("./subscription_dates");

const {
  send_sms,
} = require("../utils/sms_provider");


/*
  The rules of Kodi's billing (see subscription_tables.js): the
  state of each owner's account, their bills, and the admin's
  changes. Money is always worked out here, never taken from a
  request.

  States: trial; active (paid); grace (bill unpaid, everything
  still works until grace_ends_on); read_only (from the day
  after, until paid). A bill is never charged for a month the
  account spent read-only: when such a month has passed, its
  bill is closed and the current month's bill replaces it.
*/

function service_error(message, status_code = 400) {
  const error = new Error(message);

  error.status_code = status_code;

  return error;
}

const SUBSCRIPTION_COLUMNS = `
  owner_id, trial_ends_on::TEXT AS trial_ends_on,
  paid_through::TEXT AS paid_through, carry_amount, created_at,
  grace_cut_on::TEXT AS grace_cut_on
`;

const INVOICE_COLUMNS = `
  invoice_id, owner_id, kind, period_start::TEXT AS period_start,
  period_end::TEXT AS period_end, months, base_amount, discount_amount,
  discount_id, carried_amount, amount_due, custom_amount_reason, status,
  void_reason, auto_stk_at, created_at, paid_at
`;

const PAYMENT_COLUMNS = `
  payment_id, owner_id, invoice_id, method, amount, mpesa_receipt,
  reference, phone, paid_on::TEXT AS paid_on, note, recorded_by, created_at
`;

// "Price of 10 months" style prices: rounded to the nearest 10 shillings.
function plan_price(monthly_price, months, discount_percent) {
  return Math.round((monthly_price * months * (1 - Number(discount_percent) / 100)) / 10) * 10;
}

/*
  KODI_MONTHLY_PRICE in the server's .env (whole shillings) is the
  monthly price when set (decided 2026-10-19); every card is worked
  out from it. A new value counts from the moment the server starts
  with it: bills and payments already made keep their amounts. Empty:
  the price saved on the admin Billing page.
*/
function price_from_env() {
  const value = String(process.env.KODI_MONTHLY_PRICE || "").trim();

  if (!value) return null;

  const price = Number(value);

  if (!Number.isInteger(price) || price < 1 || price > 1000000) {
    console.error("[SUBSCRIPTIONS] KODI_MONTHLY_PRICE must be whole shillings between 1 and 1,000,000; the admin price is used.");
    return null;
  }

  return price;
}

async function get_settings(client = db) {
  const settings = (
    await client.query(
      "SELECT monthly_price, grace_days, updated_at FROM subscription_settings WHERE subscription_settings_id = 1"
    )
  ).rows[0];
  const env_price = price_from_env();

  return env_price ? { ...settings, monthly_price: env_price, price_from_env: true } : { ...settings, price_from_env: false };
}

/*
  At start-up: a new KODI_MONTHLY_PRICE is saved as the price and the
  change is recorded (before, after, when), so it is clear from when
  each price applied.
*/
async function sync_price_from_env() {
  const env_price = price_from_env();

  if (!env_price) return null;

  const before = (
    await db.query("SELECT monthly_price FROM subscription_settings WHERE subscription_settings_id = 1")
  ).rows[0].monthly_price;

  if (before === env_price) return null;

  await db.query(
    "UPDATE subscription_settings SET monthly_price = $1, updated_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE subscription_settings_id = 1",
    [env_price]
  );

  await log_audit({
    user_id: null,
    action: "SUBSCRIPTION_PRICE_SET_FROM_ENV",
    entity_type: "subscription_settings",
    entity_id: 1,
    metadata: { before: { monthly_price: before }, after: { monthly_price: env_price }, applies_from: new Date().toISOString() },
  });

  console.log(`[SUBSCRIPTIONS] Monthly price set from .env: KSh ${before} -> KSh ${env_price} (bills already made keep their amount).`);

  return { before, after: env_price };
}

const round10 = (value) => Math.round(value / 10) * 10;

function offer_active(plan, day) {
  return Number(plan.offer_percent) > 0 && (!plan.offer_ends_on || day <= plan.offer_ends_on);
}

/*
  One card's price on a day: the full price (months x monthly
  price), its regular price (less the card's discount), and the
  public offer when it is running and lower. Rounded to the nearest
  10 shillings (the monthly price itself is kept exact).
*/
function price_card(monthly_price, plan, day) {
  const full_price = monthly_price * plan.months;
  const discount = Number(plan.discount_percent) || 0;
  const regular_price = discount ? round10(full_price * (1 - discount / 100)) : full_price;
  const offer_price = offer_active(plan, day) ? round10(full_price * (1 - Number(plan.offer_percent) / 100)) : null;
  const on_offer = offer_price !== null && offer_price < regular_price;
  const price = on_offer ? offer_price : regular_price;

  return {
    full_price,
    regular_price,
    price,
    per_month: Math.round(price / plan.months),
    saving: full_price - price,
    offer: on_offer ? { percent: Number(plan.offer_percent), label: plan.offer_label || null, ends_on: plan.offer_ends_on || null } : null,
  };
}

const PLAN_COLUMNS = `
  months, name, tagline, features, most_popular, discount_percent::FLOAT AS discount_percent, enabled,
  offer_percent::FLOAT AS offer_percent, offer_label, offer_ends_on::TEXT AS offer_ends_on, updated_at
`;

async function list_plans(client = db, { enabled_only = false, now = new Date() } = {}) {
  const settings = await get_settings(client);
  const day = dates.today(now);
  const rows = (
    await client.query(`SELECT ${PLAN_COLUMNS} FROM subscription_plans ${enabled_only ? "WHERE enabled" : ""} ORDER BY months`)
  ).rows;

  return rows.map((plan) => ({ ...plan, ...price_card(settings.monthly_price, plan, day) }));
}

// The monthly card (its offer applies to monthly bills).
async function monthly_card(client, now) {
  return (await list_plans(client, { now })).find((plan) => plan.months === 1) || null;
}

/*
  What a monthly bill takes off: the landlord's own discount or the
  monthly card's discount and offer, whichever is better for them
  (never both).
*/
async function monthly_reduction(client, owner_id, base_amount, now, { end_used_up = false } = {}) {
  let discount = await active_discount(client, owner_id);

  if (discount && discount.months_total && discount.months_used >= discount.months_total) {
    if (end_used_up) await client.query("UPDATE subscription_discounts SET ended_at = CURRENT_TIMESTAMP WHERE discount_id = $1", [discount.discount_id]);
    discount = null;
  }

  const own = !discount ? 0 : discount.kind === "percent" ? Math.round((base_amount * discount.value) / 100) : Math.min(discount.value, base_amount);
  const card = await monthly_card(client, now);
  const card_off = card ? Math.max(base_amount - card.price, 0) : 0;

  return own >= card_off && own > 0
    ? { discount_amount: own, discount_id: discount.discount_id }
    : { discount_amount: card_off, discount_id: null };
}

/*
  Every owner has a subscription row; the trial starts when it is
  first made (when the admin creates or promotes the owner).
*/
async function ensure_subscription(owner_id, client = db, now = new Date()) {
  await client.query(
    `
      INSERT INTO subscriptions (owner_id, trial_ends_on)
      SELECT user_id, $2::DATE FROM users WHERE user_id = $1 AND role = 'owner'
      ON CONFLICT (owner_id) DO NOTHING
    `,
    [owner_id, dates.trial_end_for(dates.today(now))]
  );

  const subscription = (
    await client.query(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_id = $1`, [owner_id])
  ).rows[0];

  if (!subscription) throw service_error("Owner account not found.", 404);

  return subscription;
}

function state_of(subscription, settings, day) {
  const covered_until = dates.later(subscription.trial_ends_on, subscription.paid_through);
  let grace_ends_on = dates.add_days(covered_until, settings.grace_days);

  // The admin ended this landlord's grace early (only for the cover it was ended in).
  if (subscription.grace_cut_on && subscription.grace_cut_on >= covered_until && subscription.grace_cut_on < grace_ends_on) {
    grace_ends_on = subscription.grace_cut_on;
  }

  let state = "active";

  if (day <= subscription.trial_ends_on) state = "trial";
  else if (day > grace_ends_on) state = "read_only";
  else if (day > covered_until) state = "grace";

  return {
    state,
    covered_until,
    grace_ends_on,
    read_only: state === "read_only",
    days_left: day <= covered_until ? dates.days_between(day, covered_until) : 0,
    days_overdue: day > covered_until ? dates.days_between(covered_until, day) : 0,
    // In the grace days: the days left to pay, counting today (1 on the last day).
    grace_days_left: state === "grace" ? dates.days_between(day, grace_ends_on) + 1 : 0,
  };
}

async function account_status(owner_id, { client = db, now = new Date() } = {}) {
  const subscription = await ensure_subscription(owner_id, client, now);
  const settings = await get_settings(client);

  return {
    ...subscription,
    ...state_of(subscription, settings, dates.today(now)),
    grace_days: settings.grace_days,
    monthly_price: settings.monthly_price,
  };
}

async function open_monthly_invoice(owner_id, client = db) {
  return (
    await client.query(
      `SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE owner_id = $1 AND kind = 'monthly' AND status = 'open'`,
      [owner_id]
    )
  ).rows[0] || null;
}

async function lock_subscription(client, owner_id, now) {
  await ensure_subscription(owner_id, client, now);

  return (
    await client.query(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_id = $1 FOR UPDATE`, [owner_id])
  ).rows[0];
}

async function in_transaction(work) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const result = await work(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/*
  A paid bill: the account is covered to its last day, carried
  amounts it included are settled, a limited discount counts one
  more month, and any other open bill it covers is closed.
*/
async function settle_invoice(client, invoice_id) {
  const invoice = (
    await client.query(
      `UPDATE subscription_invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP
       WHERE invoice_id = $1 AND status = 'open' RETURNING ${INVOICE_COLUMNS}`,
      [invoice_id]
    )
  ).rows[0];

  if (!invoice) return null;

  const subscription = (
    await client.query(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_id = $1 FOR UPDATE`, [invoice.owner_id])
  ).rows[0];
  const paid_through = dates.later(subscription.paid_through, invoice.period_end);

  await client.query(
    `UPDATE subscriptions SET paid_through = $2, carry_amount = GREATEST(carry_amount - $3, 0), updated_at = CURRENT_TIMESTAMP
     WHERE owner_id = $1`,
    [invoice.owner_id, paid_through, invoice.carried_amount]
  );

  if (invoice.discount_id && invoice.discount_amount > 0) {
    await client.query(
      `UPDATE subscription_discounts
       SET months_used = months_used + 1,
           ended_at = CASE WHEN months_total IS NOT NULL AND months_used + 1 >= months_total THEN CURRENT_TIMESTAMP ELSE ended_at END
       WHERE discount_id = $1`,
      [invoice.discount_id]
    );
  }

  await client.query(
    `UPDATE subscription_invoices SET status = 'void', void_reason = $3
     WHERE owner_id = $1 AND status = 'open' AND period_start <= $2::DATE`,
    [invoice.owner_id, paid_through, `Covered by bill #${invoice.invoice_id}.`]
  );

  return { ...invoice, status: "paid", paid_through };
}

async function active_discount(client, owner_id) {
  return (
    await client.query(
      "SELECT * FROM subscription_discounts WHERE owner_id = $1 AND ended_at IS NULL",
      [owner_id]
    )
  ).rows[0] || null;
}

/*
  The bill for the month after the account's cover runs out, once
  that month has started. Safe to call any number of times.
  -> { invoice, created } (invoice null while the account is covered)
*/
async function ensure_monthly_invoice(owner_id, now = new Date()) {
  return in_transaction(async (client) => {
    const subscription = await lock_subscription(client, owner_id, now);
    const settings = await get_settings(client);
    const day = dates.today(now);
    const state = state_of(subscription, settings, day);
    let open = await open_monthly_invoice(owner_id, client);

    if (day <= state.covered_until) return { invoice: open, created: false };

    // A month spent read-only is not charged: its bill is closed.
    if (open && open.period_end < day) {
      await client.query(
        "UPDATE subscription_invoices SET status = 'void', void_reason = $2 WHERE invoice_id = $1",
        [open.invoice_id, "Not charged: the month ended while the account was read-only."]
      );
      open = null;
    }

    if (open) return { invoice: open, created: false };

    let period_start = dates.add_days(state.covered_until, 1);

    if (dates.month_end(period_start) < day) period_start = dates.month_start(day);

    const period_end = dates.month_end(period_start);
    const base_amount = settings.monthly_price;
    const { discount_amount, discount_id } = await monthly_reduction(client, owner_id, base_amount, now, { end_used_up: true });
    const carried_amount = subscription.carry_amount;
    const amount_due = Math.max(base_amount - discount_amount + carried_amount, 0);

    const invoice = (
      await client.query(
        `INSERT INTO subscription_invoices
           (owner_id, kind, period_start, period_end, months, base_amount, discount_amount, discount_id, carried_amount, amount_due)
         VALUES ($1, 'monthly', $2, $3, 1, $4, $5, $6, $7, $8)
         RETURNING ${INVOICE_COLUMNS}`,
        [owner_id, period_start, period_end, base_amount, discount_amount, discount_id, carried_amount, amount_due]
      )
    ).rows[0];

    await log_audit({
      user_id: null,
      owner_id,
      action: "SUBSCRIPTION_BILL_CREATED",
      entity_type: "subscription_invoice",
      entity_id: invoice.invoice_id,
      metadata: { period: dates.period_label(period_start, period_end), base_amount, discount_amount, carried_amount, amount_due },
    });

    // A discount of the full price: nothing to pay, the month is covered.
    if (amount_due === 0) return { invoice: await settle_invoice(client, invoice.invoice_id), created: true };

    return { invoice, created: true };
  });
}

/*
  A bill for a prepaid plan, from the first month not yet covered
  (or the current one, after a read-only spell). Any carried
  amount is included. Open until paid, then it replaces the
  monthly bill it covers.
*/
async function create_prepaid_invoice(owner_id, months, now = new Date()) {
  return in_transaction(async (client) => {
    const subscription = await lock_subscription(client, owner_id, now);
    const settings = await get_settings(client);
    const plan = months > 1 ? (await list_plans(client, { enabled_only: true, now })).find((item) => item.months === months) : null;

    if (!plan) throw service_error("That plan is not available.", 404);

    const day = dates.today(now);
    const state = state_of(subscription, settings, day);
    const open = await open_monthly_invoice(owner_id, client);
    let period_start = open && open.period_end >= day ? open.period_start : dates.add_days(state.covered_until, 1);

    if (dates.month_end(period_start) < day) period_start = dates.month_start(day);

    const period_end = dates.month_end(period_start, months - 1);

    // Unpaid prepaid bills from earlier tries are replaced.
    await client.query(
      "UPDATE subscription_invoices SET status = 'void', void_reason = 'Replaced by a new request.' WHERE owner_id = $1 AND kind = 'prepaid' AND status = 'open'",
      [owner_id]
    );

    return (
      await client.query(
        `INSERT INTO subscription_invoices
           (owner_id, kind, period_start, period_end, months, base_amount, discount_amount, carried_amount, amount_due)
         VALUES ($1, 'prepaid', $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${INVOICE_COLUMNS}`,
        [owner_id, period_start, period_end, months, plan.full_price, plan.saving, subscription.carry_amount, plan.price + subscription.carry_amount]
      )
    ).rows[0];
  });
}

/*
  Paying the next month ahead (decided 2026-10-19): the Pay button is
  always there. With nothing due (in the trial, or paid up), it pays
  the first month not yet covered, at the monthly price less the
  landlord's discount, plus anything carried. Trial and paid days
  are never lost: the month starts after them.
*/
async function next_month_terms(client, owner_id, now) {
  const subscription = (await client.query(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_id = $1`, [owner_id])).rows[0];
  const settings = await get_settings(client);
  const day = dates.today(now);
  const state = state_of(subscription, settings, day);
  let period_start = dates.add_days(state.covered_until, 1);

  if (dates.month_end(period_start) < day) period_start = dates.month_start(day);

  const base_amount = settings.monthly_price;
  const { discount_amount, discount_id } = await monthly_reduction(client, owner_id, base_amount, now);

  return {
    period_start,
    period_end: dates.month_end(period_start),
    base_amount,
    discount_amount,
    discount_id,
    carried_amount: subscription.carry_amount,
    amount: Math.max(base_amount - discount_amount + subscription.carry_amount, 0),
  };
}

async function create_next_month_invoice(owner_id, now = new Date()) {
  return in_transaction(async (client) => {
    await lock_subscription(client, owner_id, now);

    const terms = await next_month_terms(client, owner_id, now);

    if (terms.amount < 1) throw service_error("There is nothing to pay: the next month is free with your discount.", 409);

    await client.query(
      "UPDATE subscription_invoices SET status = 'void', void_reason = 'Replaced by a new request.' WHERE owner_id = $1 AND kind = 'prepaid' AND status = 'open'",
      [owner_id]
    );

    return (
      await client.query(
        `INSERT INTO subscription_invoices
           (owner_id, kind, period_start, period_end, months, base_amount, discount_amount, discount_id, carried_amount, amount_due)
         VALUES ($1, 'prepaid', $2, $3, 1, $4, $5, $6, $7, $8)
         RETURNING ${INVOICE_COLUMNS}`,
        [owner_id, terms.period_start, terms.period_end, terms.base_amount, terms.discount_amount, terms.discount_id, terms.carried_amount, terms.amount]
      )
    ).rows[0];
  });
}

async function get_invoice(invoice_id, client = db) {
  return (await client.query(`SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE invoice_id = $1`, [invoice_id])).rows[0] || null;
}

async function list_invoices(owner_id, limit = 24) {
  return (
    await db.query(
      `SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE owner_id = $1 AND (status <> 'void' OR kind = 'monthly')
       ORDER BY created_at DESC LIMIT $2`,
      [owner_id, limit]
    )
  ).rows;
}

async function list_payments(owner_id, limit = 24) {
  return (
    await db.query(`SELECT ${PAYMENT_COLUMNS} FROM subscription_payments WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`, [owner_id, limit])
  ).rows;
}

async function get_payment(payment_id) {
  return (await db.query(`SELECT ${PAYMENT_COLUMNS} FROM subscription_payments WHERE payment_id = $1`, [payment_id])).rows[0] || null;
}

// What the owner's Billing tab shows.
async function owner_summary(owner_id, now = new Date()) {
  const { invoice } = await ensure_monthly_invoice(owner_id, now);
  const status = await account_status(owner_id, { now });
  const pending = (
    await db.query(
      `SELECT stk_id, phone, amount, status, created_at FROM subscription_stk_requests
       WHERE owner_id = $1 AND status IN ('sending', 'sent', 'confirming') AND created_at > CURRENT_TIMESTAMP - INTERVAL '5 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [owner_id]
    )
  ).rows[0] || null;

  const owner = (await db.query("SELECT phone FROM users WHERE user_id = $1", [owner_id])).rows[0];

  return {
    status,
    // With nothing due: what the Pay button pays (the next month, ahead).
    next_month: invoice && invoice.status === "open" ? null : await next_month_terms(db, owner_id, now),
    // Filled in as the M-Pesa number; the owner may type another.
    sign_in_phone: owner?.phone || null,
    open_invoice: invoice && invoice.status === "open" ? invoice : null,
    // The cards that are on; Monthly always, since the monthly bill is paid with it.
    plans: (await list_plans(db, { now })).filter((plan) => plan.enabled || plan.months === 1),
    // The length of the last period paid for (1, 3, 6 or 12 months), to mark the landlord's card.
    current_plan_months:
      (
        await db.query(
          "SELECT months FROM subscription_invoices WHERE owner_id = $1 AND status = 'paid' AND amount_due > 0 ORDER BY paid_at DESC LIMIT 1",
          [owner_id]
        )
      ).rows[0]?.months || null,
    invoices: await list_invoices(owner_id),
    payments: await list_payments(owner_id),
    discount: await active_discount(db, owner_id),
    pending_payment: pending,
  };
}

/*
  Admin changes. Each needs a reason and is recorded with what it
  was before and after.
*/
function admin_audit(admin, owner_id, action, metadata, ip_address) {
  return log_audit({
    user_id: admin.user_id,
    owner_id,
    action,
    entity_type: "subscription",
    entity_id: owner_id,
    metadata,
    ip_address,
  });
}

async function require_owner(owner_id) {
  const owner = (await db.query("SELECT user_id, first_name, last_name, phone, role, status FROM users WHERE user_id = $1", [owner_id])).rows[0];

  if (!owner || owner.role !== "owner") throw service_error("Owner account not found.", 404);

  return owner;
}

async function extend_trial(admin, owner_id, { months, reason }, ip_address, now = new Date()) {
  await require_owner(owner_id);

  const result = await in_transaction(async (client) => {
    const before = await lock_subscription(client, owner_id, now);

    if (dates.today(now) > before.trial_ends_on) {
      throw service_error("The trial has already ended. Give free months instead.", 409);
    }

    const trial_ends_on = dates.month_end(before.trial_ends_on, months);

    await client.query("UPDATE subscriptions SET trial_ends_on = $2, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1", [owner_id, trial_ends_on]);
    await client.query(
      "UPDATE subscription_invoices SET status = 'void', void_reason = 'Covered by a longer trial.' WHERE owner_id = $1 AND status = 'open' AND period_start <= $2::DATE",
      [owner_id, trial_ends_on]
    );

    return { before: before.trial_ends_on, after: trial_ends_on };
  });

  await admin_audit(admin, owner_id, "SUBSCRIPTION_TRIAL_EXTENDED", { months, reason, trial_ends_before: result.before, trial_ends_after: result.after }, ip_address);

  return account_status(owner_id, { now });
}

/*
  The admin ends a landlord's free trial today (decided 2026-10-19),
  choosing the first bill for each landlord:
  - full: the full monthly price for the rest of this month;
  - prorated: only the days left this month, counting today;
  - next_month: free to the end of this month, first bill on the 1st.
  Any discount the landlord has applies; months already paid ahead
  still count.
*/
function first_bill_amount(full_amount, day, first_bill) {
  if (first_bill !== "prorated") return full_amount;

  const days_in_month = Number(dates.month_end(day).slice(8, 10));
  const days_left = dates.days_between(day, dates.month_end(day)) + 1;

  return Math.round((full_amount * days_left) / days_in_month);
}

async function end_trial(admin, owner_id, { first_bill, reason }, ip_address, now = new Date()) {
  await require_owner(owner_id);

  const day = dates.today(now);

  const result = await in_transaction(async (client) => {
    const before = await lock_subscription(client, owner_id, now);

    if (day > before.trial_ends_on) {
      throw service_error("The free trial has already ended.", 409);
    }

    const trial_ends_on = first_bill === "next_month" ? dates.month_end(day) : dates.add_days(day, -1);

    if (first_bill === "next_month" && trial_ends_on === before.trial_ends_on) {
      throw service_error("The trial already ends this month.", 409);
    }

    await client.query("UPDATE subscriptions SET trial_ends_on = $2, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1", [owner_id, trial_ends_on]);

    return { before: before.trial_ends_on, after: trial_ends_on };
  });

  let invoice = null;

  if (first_bill !== "next_month") {
    invoice = (await ensure_monthly_invoice(owner_id, now)).invoice;

    // The part of the month left, of what is owed for the month (after any discount).
    if (invoice && invoice.status === "open" && first_bill === "prorated" && invoice.period_start === day) {
      const month_part = invoice.amount_due - invoice.carried_amount;
      const amount = first_bill_amount(month_part, day, first_bill) + invoice.carried_amount;

      if (amount < invoice.amount_due) {
        const days_left = dates.days_between(day, dates.month_end(day)) + 1;

        invoice = (
          await db.query(
            `UPDATE subscription_invoices SET amount_due = $2, custom_amount_reason = $3 WHERE invoice_id = $1 AND status = 'open' RETURNING ${INVOICE_COLUMNS}`,
            [invoice.invoice_id, Math.max(amount, 1), `Part month: ${days_left} of ${Number(dates.month_end(day).slice(8, 10))} days (trial ended early).`]
          )
        ).rows[0];
      }
    }
  }

  /*
    No M-Pesa prompt is sent (none ever is by itself): the landlord
    gets this SMS now, in place of the usual bill SMS.
  */
  const settings = await get_settings();
  const owner_phone = (await db.query("SELECT phone FROM users WHERE user_id = $1", [owner_id])).rows[0]?.phone;
  const money = (amount) => `KSh ${Number(amount).toLocaleString("en-KE")}`;
  let message;

  if (invoice?.status === "open") {
    await db.query("UPDATE subscription_invoices SET auto_stk_at = CURRENT_TIMESTAMP WHERE invoice_id = $1", [invoice.invoice_id]);
    await db.query("INSERT INTO subscription_notices (owner_id, notice_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [owner_id, `bill:${invoice.invoice_id}`]);

    const grace_ends_on = dates.add_days(result.after, settings.grace_days);

    message = `Kodi: your free trial has ended. Your bill for ${dates.period_label(invoice.period_start, invoice.period_end)} is ${money(invoice.amount_due)} (${Number(invoice.period_start.slice(8, 10))} to ${dates.label(invoice.period_end)}). Pay in Kodi, Settings, Billing, by ${dates.label(grace_ends_on)}.`;
  } else if (first_bill === "next_month") {
    message = `Kodi: your free trial now ends on ${dates.label(result.after)}. Your first bill, ${money(settings.monthly_price)}, comes on ${dates.label(dates.add_days(result.after, 1))}.`;
  } else {
    message = `Kodi: your free trial has ended. You have already paid ahead, so there is nothing to pay now.`;
  }

  if (owner_phone) {
    try {
      await send_sms({ phone: owner_phone, message });
    } catch (error) {
      console.error("[SUBSCRIPTIONS] Trial-ended SMS failed:", error.message);
    }
  }

  await admin_audit(
    admin,
    owner_id,
    "SUBSCRIPTION_TRIAL_ENDED",
    {
      first_bill,
      reason,
      trial_ends_before: result.before,
      trial_ends_after: result.after,
      bill_id: invoice?.invoice_id || null,
      bill_amount: invoice?.status === "open" ? invoice.amount_due : null,
    },
    ip_address
  );

  return { ...(await account_status(owner_id, { now })), open_invoice: invoice?.status === "open" ? invoice : null };
}

/*
  The admin ends one landlord's grace period now (decided
  2026-10-19): the account is read-only from today until the bill is
  paid, and the landlord is told by SMS. Paying clears it.
*/
async function end_grace(admin, owner_id, { reason }, ip_address, now = new Date()) {
  const owner = await require_owner(owner_id);
  const day = dates.today(now);

  const result = await in_transaction(async (client) => {
    const subscription = await lock_subscription(client, owner_id, now);
    const settings = await get_settings(client);
    const state = state_of(subscription, settings, day);

    if (state.state !== "grace") throw service_error("This landlord is not in a grace period.", 409);

    const cut = dates.add_days(day, -1);

    await client.query("UPDATE subscriptions SET grace_cut_on = $2, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1", [owner_id, cut]);

    return { grace_ends_before: state.grace_ends_on, grace_ends_after: cut };
  });

  const invoice = await open_monthly_invoice(owner_id);

  if (owner.phone) {
    try {
      await send_sms({
        phone: owner.phone,
        message: `Kodi: your grace period has ended and your account is now read-only${invoice ? ` until the bill of KSh ${invoice.amount_due.toLocaleString("en-KE")} is paid` : " until your bill is paid"}. You can still see everything. Pay in Kodi, Settings, Billing, and it unlocks at once.`,
      });
    } catch (error) {
      console.error("[SUBSCRIPTIONS] Grace-ended SMS failed:", error.message);
    }
  }

  await admin_audit(admin, owner_id, "SUBSCRIPTION_GRACE_ENDED", { reason, ...result, bill_amount: invoice?.amount_due ?? null }, ip_address);

  return account_status(owner_id, { now });
}

async function give_free_months(admin, owner_id, { months, reason }, ip_address, now = new Date()) {
  await require_owner(owner_id);

  const result = await in_transaction(async (client) => {
    const before = await lock_subscription(client, owner_id, now);
    const settings = await get_settings(client);
    const day = dates.today(now);
    const state = state_of(before, settings, day);
    // After a read-only spell the free months start from this month.
    const base = state.read_only ? dates.add_days(dates.month_start(day), -1) : state.covered_until;
    const paid_through = dates.later(before.paid_through, dates.month_end(base, months));

    await client.query("UPDATE subscriptions SET paid_through = $2, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1", [owner_id, paid_through]);
    await client.query(
      "UPDATE subscription_invoices SET status = 'void', void_reason = 'Covered by free months from Kodi.' WHERE owner_id = $1 AND status = 'open' AND period_start <= $2::DATE",
      [owner_id, paid_through]
    );

    return { before: before.paid_through, after: paid_through };
  });

  await admin_audit(admin, owner_id, "SUBSCRIPTION_FREE_MONTHS_GIVEN", { months, reason, paid_through_before: result.before, paid_through_after: result.after }, ip_address);

  return account_status(owner_id, { now });
}

async function create_discount(admin, owner_id, { kind, value, months, reason }, ip_address) {
  await require_owner(owner_id);

  const settings = await get_settings();

  if (kind === "amount" && value > settings.monthly_price) {
    throw service_error(`The amount off cannot be more than the monthly price (KSh ${settings.monthly_price.toLocaleString("en-KE")}).`, 422);
  }

  let discount;

  try {
    discount = (
      await db.query(
        `INSERT INTO subscription_discounts (owner_id, kind, value, months_total, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [owner_id, kind, value, months || null, reason, admin.user_id]
      )
    ).rows[0];
  } catch (error) {
    if (error.code === "23505") throw service_error("This landlord already has a discount. End it first.", 409);
    throw error;
  }

  await admin_audit(admin, owner_id, "SUBSCRIPTION_DISCOUNT_GIVEN", { discount_id: discount.discount_id, kind, value, months: months || "always", reason }, ip_address);

  return discount;
}

async function end_discount(admin, discount_id, { reason }, ip_address) {
  const discount = (
    await db.query("UPDATE subscription_discounts SET ended_at = CURRENT_TIMESTAMP WHERE discount_id = $1 AND ended_at IS NULL RETURNING *", [discount_id])
  ).rows[0];

  if (!discount) throw service_error("That discount is not active.", 404);

  await admin_audit(admin, discount.owner_id, "SUBSCRIPTION_DISCOUNT_ENDED", { discount_id, reason, months_used: discount.months_used }, ip_address);

  return discount;
}

/*
  The admin lowers one bill (a landlord who can pay 8,000 this
  month). The rest is forgiven or moved to the next bill.
*/
async function set_invoice_amount(admin, invoice_id, { amount, remainder, reason }, ip_address) {
  const result = await in_transaction(async (client) => {
    const invoice = (
      await client.query(`SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE invoice_id = $1 FOR UPDATE`, [invoice_id])
    ).rows[0];

    if (!invoice) throw service_error("Bill not found.", 404);
    if (invoice.status !== "open") throw service_error("Only an unpaid bill can be changed.", 409);
    if (amount >= invoice.amount_due) throw service_error(`Enter an amount lower than the current KSh ${invoice.amount_due.toLocaleString("en-KE")}.`, 422);

    const waiting = (
      await client.query(
        "SELECT 1 FROM subscription_stk_requests WHERE invoice_id = $1 AND status IN ('sending', 'sent', 'confirming') AND created_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes'",
        [invoice_id]
      )
    ).rows[0];

    if (waiting) throw service_error("An M-Pesa payment for this bill is in progress. Try again in a few minutes.", 409);

    const difference = invoice.amount_due - amount;

    await client.query("SELECT 1 FROM subscriptions WHERE owner_id = $1 FOR UPDATE", [invoice.owner_id]);

    if (remainder === "carry") {
      await client.query("UPDATE subscriptions SET carry_amount = carry_amount + $2, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1", [invoice.owner_id, difference]);
    }

    const updated = (
      await client.query(
        `UPDATE subscription_invoices SET amount_due = $2, custom_amount_reason = $3 WHERE invoice_id = $1 RETURNING ${INVOICE_COLUMNS}`,
        [invoice_id, amount, reason]
      )
    ).rows[0];

    return { invoice, updated, difference };
  });

  await admin_audit(
    admin,
    result.invoice.owner_id,
    "SUBSCRIPTION_BILL_AMOUNT_CHANGED",
    { invoice_id, amount_before: result.invoice.amount_due, amount_after: amount, remainder, remainder_amount: result.difference, reason },
    ip_address
  );

  return result.updated;
}

/*
  Money received outside STK (cash, bank, another M-Pesa route),
  for the full amount of an unpaid bill.
*/
async function record_manual_payment(admin, invoice_id, { amount, method, reference, paid_on, note }, ip_address, now = new Date()) {
  if (paid_on > dates.today(now)) throw service_error("The payment date cannot be in the future.", 422);

  const result = await in_transaction(async (client) => {
    const invoice = (
      await client.query(`SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE invoice_id = $1 FOR UPDATE`, [invoice_id])
    ).rows[0];

    if (!invoice) throw service_error("Bill not found.", 404);
    if (invoice.status !== "open") throw service_error("This bill is not waiting for payment.", 409);
    if (amount !== invoice.amount_due) {
      throw service_error(`The bill is KSh ${invoice.amount_due.toLocaleString("en-KE")}. To accept less, change the bill's amount first.`, 422);
    }

    const payment = (
      await client.query(
        `INSERT INTO subscription_payments (owner_id, invoice_id, method, amount, reference, paid_on, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PAYMENT_COLUMNS}`,
        [invoice.owner_id, invoice_id, method, amount, reference || null, paid_on, note, admin.user_id]
      )
    ).rows[0];
    const settled = await settle_invoice(client, invoice_id);

    return { payment, settled };
  });

  await admin_audit(
    admin,
    result.payment.owner_id,
    "SUBSCRIPTION_PAYMENT_RECORDED",
    { invoice_id, payment_id: result.payment.payment_id, amount, method, reference: reference || null, paid_on, note, paid_through: result.settled.paid_through },
    ip_address
  );

  return result;
}

async function update_settings(admin, changes, ip_address) {
  if (changes.monthly_price !== undefined && price_from_env()) {
    throw service_error("The monthly price is set in the server's .env (KODI_MONTHLY_PRICE). Change it there and restart the server.", 409);
  }

  const before = await get_settings();
  const after = (
    await db.query(
      `UPDATE subscription_settings
       SET monthly_price = COALESCE($1, monthly_price), grace_days = COALESCE($2, grace_days), updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE subscription_settings_id = 1
       RETURNING monthly_price, grace_days, updated_at`,
      [changes.monthly_price ?? null, changes.grace_days ?? null, admin.user_id]
    )
  ).rows[0];

  await log_audit({
    user_id: admin.user_id,
    action: "SUBSCRIPTION_SETTINGS_CHANGED",
    entity_type: "subscription_settings",
    entity_id: 1,
    metadata: { before: { monthly_price: before.monthly_price, grace_days: before.grace_days }, after: { monthly_price: after.monthly_price, grace_days: after.grace_days }, reason: changes.reason },
    ip_address,
  });

  return after;
}

/*
  A pricing card: its words, discount, offer, and whether it is
  shown. Only one card is "most popular". Recorded with what changed.
*/
const CARD_FIELDS = ["name", "tagline", "features", "most_popular", "discount_percent", "enabled", "offer_percent", "offer_label", "offer_ends_on"];

async function update_plan(admin, months, changes, ip_address) {
  const before = (await db.query(`SELECT ${PLAN_COLUMNS} FROM subscription_plans WHERE months = $1`, [months])).rows[0];

  if (!before) throw service_error("Plan not found.", 404);

  const fields = CARD_FIELDS.filter((field) => changes[field] !== undefined);

  if (fields.length) {
    await in_transaction(async (client) => {
      if (changes.most_popular === true) await client.query("UPDATE subscription_plans SET most_popular = FALSE WHERE months <> $1", [months]);

      await client.query(
        `UPDATE subscription_plans SET ${fields.map((field, index) => `${field} = $${index + 2}`).join(", ")}, updated_by = $${fields.length + 2}, updated_at = CURRENT_TIMESTAMP
         WHERE months = $1`,
        [months, ...fields.map((field) => (field === "features" ? JSON.stringify(changes[field]) : changes[field])), admin.user_id]
      );
    });
  }

  const after = (await list_plans()).find((plan) => plan.months === months);
  const summary = (plan) => Object.fromEntries(CARD_FIELDS.map((field) => [field, plan[field]]));

  await log_audit({
    user_id: admin.user_id,
    action: "SUBSCRIPTION_PLAN_CHANGED",
    entity_type: "subscription_plan",
    entity_id: months,
    metadata: { months, before: summary(before), after: { ...summary(after), price: after.price }, reason: changes.reason },
    ip_address,
  });

  return after;
}

// What the landing page shows: the cards that are on, with today's prices. Nothing about any landlord.
async function public_pricing(now = new Date()) {
  const settings = await get_settings();

  return {
    currency: "KES",
    monthly_price: settings.monthly_price,
    trial: "Free until the end of the next full calendar month",
    // Signing up today: the trial's last day, and the days to pay after a bill is due.
    trial_ends_example: dates.trial_end_for(dates.today(now)),
    grace_days: settings.grace_days,
    cards: (await list_plans(db, { enabled_only: true, now })).map((plan) => ({
      months: plan.months,
      name: plan.name,
      tagline: plan.tagline,
      features: plan.features,
      most_popular: plan.most_popular,
      full_price: plan.full_price,
      regular_price: plan.regular_price,
      price: plan.price,
      per_month: plan.per_month,
      saving: plan.saving,
      offer: plan.offer,
    })),
  };
}

// The admin's Billing page: every owner and where they stand.
async function list_accounts(now = new Date()) {
  await db.query(
    `INSERT INTO subscriptions (owner_id, trial_ends_on)
     SELECT user_id, $1::DATE FROM users WHERE role = 'owner'
     ON CONFLICT (owner_id) DO NOTHING`,
    [dates.trial_end_for(dates.today(now))]
  );

  const settings = await get_settings();
  const day = dates.today(now);
  const rows = (
    await db.query(`
      SELECT
        u.user_id AS owner_id, u.first_name, u.last_name, u.phone, u.status AS user_status,
        s.trial_ends_on::TEXT AS trial_ends_on, s.paid_through::TEXT AS paid_through, s.carry_amount, s.grace_cut_on::TEXT AS grace_cut_on,
        i.invoice_id AS open_invoice_id, i.amount_due AS open_amount,
        (SELECT MAX(created_at) FROM subscription_payments p WHERE p.owner_id = u.user_id) AS last_paid_at,
        d.kind AS discount_kind, d.value AS discount_value
      FROM users u
      JOIN subscriptions s ON s.owner_id = u.user_id
      LEFT JOIN subscription_invoices i ON i.owner_id = u.user_id AND i.kind = 'monthly' AND i.status = 'open'
      LEFT JOIN subscription_discounts d ON d.owner_id = u.user_id AND d.ended_at IS NULL
      WHERE u.role = 'owner'
      ORDER BY u.first_name, u.last_name
    `)
  ).rows;

  return rows.map((row) => ({ ...row, ...state_of(row, settings, day) }));
}

async function account_detail(owner_id, now = new Date()) {
  const owner = await require_owner(owner_id);

  await ensure_monthly_invoice(owner_id, now);

  return {
    owner: { owner_id: owner.user_id, first_name: owner.first_name, last_name: owner.last_name, phone: owner.phone, status: owner.status },
    status: await account_status(owner_id, { now }),
    open_invoice: await open_monthly_invoice(owner_id),
    invoices: await list_invoices(owner_id, 60),
    payments: await list_payments(owner_id, 60),
    discounts: (await db.query("SELECT * FROM subscription_discounts WHERE owner_id = $1 ORDER BY created_at DESC", [owner_id])).rows,
    payment_requests: (
      await db.query(
        `SELECT stk_id, invoice_id, phone, amount, status, result_desc, mpesa_receipt, automatic, created_at, completed_at
         FROM subscription_stk_requests WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [owner_id]
      )
    ).rows,
    history: (
      await db.query(
        `SELECT audit_log_id, user_id, action, metadata, created_at FROM audit_logs
         WHERE owner_id = $1 AND action LIKE 'SUBSCRIPTION%' ORDER BY created_at DESC LIMIT 50`,
        [owner_id]
      )
    ).rows,
  };
}

module.exports = {
  service_error,
  price_from_env,
  sync_price_from_env,
  INVOICE_COLUMNS,
  PAYMENT_COLUMNS,
  plan_price,
  get_settings,
  list_plans,
  ensure_subscription,
  state_of,
  account_status,
  open_monthly_invoice,
  ensure_monthly_invoice,
  create_prepaid_invoice,
  create_next_month_invoice,
  settle_invoice,
  in_transaction,
  get_invoice,
  list_invoices,
  list_payments,
  get_payment,
  owner_summary,
  extend_trial,
  end_trial,
  end_grace,
  price_card,
  public_pricing,
  first_bill_amount,
  give_free_months,
  create_discount,
  end_discount,
  set_invoice_amount,
  record_manual_payment,
  update_settings,
  update_plan,
  list_accounts,
  account_detail,
};
