const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const dates = require("./subscription_dates");

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
  paid_through::TEXT AS paid_through, carry_amount, created_at
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

async function get_settings(client = db) {
  return (
    await client.query(
      "SELECT monthly_price, grace_days, updated_at FROM subscription_settings WHERE subscription_settings_id = 1"
    )
  ).rows[0];
}

async function list_plans(client = db, { enabled_only = false } = {}) {
  const settings = await get_settings(client);
  const rows = (
    await client.query(
      `SELECT months, discount_percent::FLOAT AS discount_percent, enabled, updated_at
       FROM subscription_plans ${enabled_only ? "WHERE enabled" : ""} ORDER BY months`
    )
  ).rows;

  return rows.map((plan) => {
    const price = plan_price(settings.monthly_price, plan.months, plan.discount_percent);

    return {
      ...plan,
      price,
      full_price: settings.monthly_price * plan.months,
      saving: settings.monthly_price * plan.months - price,
    };
  });
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
  const grace_ends_on = dates.add_days(covered_until, settings.grace_days);
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
    let discount = await active_discount(client, owner_id);

    if (discount && discount.months_total && discount.months_used >= discount.months_total) {
      await client.query("UPDATE subscription_discounts SET ended_at = CURRENT_TIMESTAMP WHERE discount_id = $1", [discount.discount_id]);
      discount = null;
    }

    const discount_amount = !discount
      ? 0
      : discount.kind === "percent"
        ? Math.round((base_amount * discount.value) / 100)
        : Math.min(discount.value, base_amount);
    const carried_amount = subscription.carry_amount;
    const amount_due = Math.max(base_amount - discount_amount + carried_amount, 0);

    const invoice = (
      await client.query(
        `INSERT INTO subscription_invoices
           (owner_id, kind, period_start, period_end, months, base_amount, discount_amount, discount_id, carried_amount, amount_due)
         VALUES ($1, 'monthly', $2, $3, 1, $4, $5, $6, $7, $8)
         RETURNING ${INVOICE_COLUMNS}`,
        [owner_id, period_start, period_end, base_amount, discount_amount, discount_amount ? discount.discount_id : null, carried_amount, amount_due]
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
    const plan = (await list_plans(client, { enabled_only: true })).find((item) => item.months === months);

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
    // Filled in as the M-Pesa number; the owner may type another.
    sign_in_phone: owner?.phone || null,
    open_invoice: invoice && invoice.status === "open" ? invoice : null,
    plans: await list_plans(db, { enabled_only: true }),
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

async function update_plan(admin, months, { discount_percent, enabled, reason }, ip_address) {
  const before = (await db.query("SELECT months, discount_percent::FLOAT AS discount_percent, enabled FROM subscription_plans WHERE months = $1", [months])).rows[0];

  if (!before) throw service_error("Plan not found.", 404);

  await db.query(
    `UPDATE subscription_plans SET discount_percent = COALESCE($2, discount_percent), enabled = COALESCE($3, enabled), updated_by = $4, updated_at = CURRENT_TIMESTAMP
     WHERE months = $1`,
    [months, discount_percent ?? null, enabled ?? null, admin.user_id]
  );

  const after = (await list_plans()).find((plan) => plan.months === months);

  await log_audit({
    user_id: admin.user_id,
    action: "SUBSCRIPTION_PLAN_CHANGED",
    entity_type: "subscription_plan",
    entity_id: months,
    metadata: { months, before: { discount_percent: before.discount_percent, enabled: before.enabled }, after: { discount_percent: after.discount_percent, enabled: after.enabled, price: after.price }, reason },
    ip_address,
  });

  return after;
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
        s.trial_ends_on::TEXT AS trial_ends_on, s.paid_through::TEXT AS paid_through, s.carry_amount,
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
  settle_invoice,
  in_transaction,
  get_invoice,
  list_invoices,
  list_payments,
  get_payment,
  owner_summary,
  extend_trial,
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
