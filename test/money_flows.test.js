/*
  Money checks through the real API, on a throwaway database.

  Runs only when MONEY_TEST_DATABASE_URL points at an empty
  database on this computer (localhost), for example in CI:
    MONEY_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_test npm test
  Never point it at a real database: it creates and changes
  records freely.
*/
const test = require("node:test");
const assert = require("node:assert/strict");

const url = process.env.MONEY_TEST_DATABASE_URL || "";
const safe = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);

if (!safe) {
  test("money checks (skipped: set MONEY_TEST_DATABASE_URL to a local throwaway database)", { skip: true }, () => {});
  return;
}

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: url,
  DB_SSL: "false",
  DB_POOL_MAX: "4",
  JWT_ACCESS_SECRET: "money-test-access-".padEnd(48, "a"),
  JWT_REFRESH_SECRET: "money-test-refresh-".padEnd(48, "b"),
  ADMIN_PHONE: "0700000001",
  ADMIN_FIRST_NAME: "Test",
  ADMIN_LAST_NAME: "Admin",
  SMS_MODE: "console",
  PAYMENT_CREDENTIAL_ENCRYPTION_KEY: "c".repeat(64),
  PUBLIC_API_URL: "https://api.example.invalid",
  FRONTEND_URL: "http://localhost:5173",
  KODI_MPESA_RESULT_SECRET: "s".repeat(40),
  AGENT_API_TOKEN: "",
  R2_ACCOUNT_ID: "",
  FIREBASE_SERVICE_ACCOUNT: "",
  KODI_MONTHLY_PRICE: "",
});

const path = require("path");
const r = (p) => require(path.join(__dirname, "..", p));

// Sign-in codes are read from the messages instead of being sent.
const sms = [];
r("src/utils/sms_provider").send_sms = async ({ phone, message }) => {
  sms.push({ phone, message });
  return { provider: "test", response: {} };
};

const INITS = [
  ["auth/auth_tables", "init_auth_tables"], ["properties/property_tables", "init_property_tables"],
  ["units/unit_tables", "init_unit_tables"], ["tenants/tenant_tables", "init_tenant_tables"],
  ["payments/payment_tables", "init_payment_tables"], ["service_charges/service_charge_tables", "init_service_charge_tables"],
  ["deposits/deposit_tables", "init_deposit_tables"], ["water/water_tables", "init_water_tables"],
  ["expenses/expense_tables", "init_expense_tables"], ["maintenance/maintenance_tables", "init_maintenance_tables"],
  ["caretakers/caretaker_tables", "init_caretaker_tables"], ["middleware/idempotency", "init_idempotency_tables"],
  ["agreements/agreement_tables", "init_agreement_tables"], ["sms/sms_tables", "init_sms_tables"],
  ["settings/settings_tables", "init_settings_tables"], ["reminders/reminder_service", "init_reminder_tables"],
  ["files/file_service", "init_file_tables"], ["live/live_tables", "init_live_tables"],
  ["subscriptions/subscription_tables", "init_subscription_tables"], ["push/push_tables", "init_push_tables"],
  ["analytics/analytics_tables", "init_analytics_tables"], ["live/live_tables", "init_data_change_triggers"],
];

let db, server, base, owner, owner_id;
const tokens = {};
let counter = 0;

const call = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : null };
};

async function sign_in(phone) {
  await fetch(base + "/api/auth/request-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
  const code = /\b(\d{6})\b/.exec([...sms].reverse().find((m) => m.phone.endsWith(phone.slice(-9))).message)[1];
  const res = await fetch(base + "/api/auth/verify-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, code }) });
  return (await res.json()).access_token;
}

// Kenyan dates relative to today.
const nairobi = (date) => new Date(date.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const today = () => nairobi(new Date());
const month_start = (offset = 0) => {
  const d = new Date(new Date().getTime() + 3 * 3600 * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
};
const trans_time = (date) => new Date(date.getTime() + 3 * 3600 * 1000).toISOString().replace(/[-T:]/g, "").slice(0, 14);
const receipt = () => `TST${String(++counter).padStart(7, "0")}`;

async function make_property(name) {
  const property = (await db.query(
    "INSERT INTO properties (owner_id, created_by, name, location, water_billing_method) VALUES ($1, $1, $2, 'Thika', 'included_in_rent') RETURNING id",
    [owner_id, name]
  )).rows[0].id;
  const security = r("src/payments/mpesa/c2b_callback_security");
  const number = String(400000 + Math.floor(Math.random() * 99999));
  const token = security.new_callback_token();
  await db.query(
    `INSERT INTO payment_accounts (owner_id, property_id, account_for, provider_code, account_type, label, business_number, connection_status, c2b_callback_token_encrypted)
     VALUES ($1, $2, 'rent', 'mpesa', 'paybill', 'Rent', $3, 'connected', $4)`,
    [owner_id, property, number, security.seal_callback_token(token)]
  );
  tokens[property] = { number, token };
  return property;
}

let phone_counter = 100;
async function make_tenant(property, unit_number) {
  const phone = `0722${String(++phone_counter).padStart(6, "0")}`;
  let res = await call("POST", `/api/properties/${property}/units`, { unit_number, unit_type: "bedsitter", monthly_rent: 10000, rent_deposit: 0, water_deposit: 0, water_billing_method: "included_in_rent" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const unit = res.body.unit?.id || res.body.data?.id;
  res = await call("POST", `/api/properties/${property}/tenants`, { unit_id: unit, full_name: `Tenant ${unit_number}`, phone, move_in_date: month_start(-2) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const tenant = res.body.tenant?.id || res.body.data?.id;
  // Only the bills each test makes itself.
  await db.query("DELETE FROM tenant_charges WHERE tenant_id = $1", [tenant]);
  return { property, unit, tenant, phone, payment_phone: "+254" + phone.slice(1) };
}

async function bill(t, type, amount, { period = month_start(-1), due = month_start(-1), created = null, status = "open" } = {}) {
  return (await db.query(
    `INSERT INTO tenant_charges (tenant_id, owner_id, property_id, unit_id, charge_type, billing_period, due_date, amount_due, status, source_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, new_id('src'), COALESCE($10::TIMESTAMPTZ, CURRENT_TIMESTAMP)) RETURNING id`,
    [t.tenant, owner_id, t.property, t.unit, type, period, due, amount, status, created]
  )).rows[0].id;
}

const charge = async (id) => (await db.query("SELECT amount_due::TEXT AS due, amount_paid::TEXT AS paid, status FROM tenant_charges WHERE id = $1", [id])).rows[0];
const credit = async (t) => Number((await db.query("SELECT COALESCE(SUM(remaining_amount),0) AS c FROM tenant_credits WHERE tenant_id = $1", [t.tenant])).rows[0].c);

function c2b(t, amount, { trans = receipt(), phone = t.payment_phone.replace("+", ""), time = new Date() } = {}) {
  const { number, token } = tokens[t.property];
  return fetch(`${base}/api/properties/c2b/confirmation/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ TransactionType: "Pay Bill", TransID: trans, TransTime: trans_time(time), TransAmount: String(amount), BusinessShortCode: number, BillRefNumber: "A1", MSISDN: phone, FirstName: "TEST" }),
  }).then(async (res) => ({ status: res.status, trans }));
}

const payment_by_receipt = async (trans) => (await db.query("SELECT * FROM payments WHERE provider_transaction_id = $1", [trans])).rows[0];

const pay_by_hand = (t, amount, extra = {}) =>
  call("POST", `/api/tenants/${t.tenant}/payments/manual`, { amount, payment_method: "cash", account_for: "rent", ...extra });

test.before(async () => {
  await r("src/utils/ids").init_id_function();
  for (const [f, fn] of INITS) await r(`src/${f}`)[fn]();
  db = r("src/config/db");
  server = r("app").listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const admin_token = await sign_in("0700000001");
  owner = admin_token;
  await call("POST", "/api/users", { full_name: "Mary Owner", phone: "0711000001", role: "owner" });
  owner = await sign_in("0711000001");
  owner_id = (await db.query("SELECT user_id FROM users WHERE phone LIKE '%711000001'")).rows[0].user_id;
});

test.after(async () => {
  server?.close();
  await db?.end?.();
});

test("a payment over bills with cents is recorded, not lost", async () => {
  const p = await make_property("Cents Court");
  const t = await make_tenant(p, "C1");
  const a = await bill(t, "rent", "1234.56");
  const b = await bill(t, "rent", "65.44", { period: month_start(0), due: month_start(0) });
  const res = await c2b(t, 1300);
  assert.equal(res.status, 200);
  const payment = await payment_by_receipt(res.trans);
  assert.equal(payment?.status, "matched");
  assert.equal((await charge(a)).status, "paid");
  assert.equal((await charge(b)).status, "paid");
  assert.equal(await credit(t), 0);
});

test("a bill paid in two parts with cents ends up paid, not partial", async () => {
  const p = await make_property("Partial Place");
  const t = await make_tenant(p, "P1");
  const a = await bill(t, "rent", "406.16");
  assert.equal((await pay_by_hand(t, 150.15)).status, 201);
  assert.equal((await pay_by_hand(t, 256.01)).status, 201);
  const c = await charge(a);
  assert.equal(c.paid, "406.16");
  assert.equal(c.status, "paid");
});

test("an M-Pesa payment is dated when the tenant paid, not when Kodi heard", async () => {
  const p = await make_property("Clock House");
  const t = await make_tenant(p, "K1");
  const paid = new Date(Date.now() - 50 * 60 * 1000);
  paid.setUTCMilliseconds(0);
  const res = await c2b(t, 500, { time: paid });
  const payment = await payment_by_receipt(res.trans);
  assert.equal(new Date(payment.received_at).toISOString(), paid.toISOString());
  assert.ok(new Date(payment.notified_at) - paid > 49 * 60 * 1000);
});

let former;
test("a former tenant's M-Pesa payment names them and can be matched to them", async () => {
  const p = await make_property("Former Flats");
  former = await make_tenant(p, "F1");
  await bill(former, "rent", 5000);
  const out = await call("POST", `/api/tenants/${former.tenant}/move-out`, { move_out_date: today() });
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const res = await c2b(former, 5000);
  const payment = await payment_by_receipt(res.trans);
  assert.equal(payment.status, "unmatched");
  assert.match(payment.unmatched_reason, /Tenant F1, who has moved out/);

  const match = await call("POST", `/api/payments/${payment.id}/match`, { tenant_id: former.tenant });
  assert.equal(match.status, 200, JSON.stringify(match.body));
  const owed = await db.query("SELECT COALESCE(SUM(amount_due - amount_paid),0)::INT AS o FROM tenant_charges WHERE tenant_id = $1 AND status IN ('open','partial')", [former.tenant]);
  assert.equal(owed.rows[0].o, 0);
});

test("recording by hand money that is already in Kodi is caught", async () => {
  const p = await make_property("Duplicate Drive");
  const t = await make_tenant(p, "D1");
  await bill(t, "rent", 10000);
  // The tenant pays from a number Kodi does not know yet: unmatched.
  const stranger = "254733000111";
  const unmatched = await c2b(t, 4000, { phone: stranger });
  const u = await payment_by_receipt(unmatched.trans);
  assert.equal(u.status, "unmatched");

  let res = await pay_by_hand(t, 4000, { payment_method: "mpesa" });
  assert.equal(res.status, 422);
  assert.equal(res.body.details.code, "receipt_required");

  res = await pay_by_hand(t, 4000, { payment_method: "mpesa", reference: unmatched.trans.toLowerCase() });
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, "unmatched_receipt");

  // The form's check: same amount in the last 30 days.
  res = await call("GET", `/api/tenants/${t.tenant}/payments/possible-duplicates?amount=4000`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.candidates.map((c) => [c.id, c.reasons]), [[u.id, ["amount"]]]);

  // From the tenant's own number: must be answered.
  const own = await c2b({ ...t, payment_phone: "+254733000222" }, 2500, { phone: "254733000222" });
  await db.query("UPDATE tenants SET payment_phone = '+254733000222' WHERE id = $1", [t.tenant]);
  res = await pay_by_hand(t, 2500);
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, "possible_duplicate");
  res = await pay_by_hand(t, 2500, { duplicate_override_reason: "Paid cash as well" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.duplicate_override_reason, "Paid cash as well");

  // A receipt already counted is refused.
  const matched = await c2b(t, 100, { phone: "254733000222" });
  res = await pay_by_hand(t, 100, { payment_method: "mpesa", reference: matched.trans });
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, "receipt_recorded");

  // Matching the unmatched one instead counts it once.
  res = await call("POST", `/api/payments/${u.id}/match`, { tenant_id: t.tenant });
  assert.equal(res.status, 200);
  assert.equal((await payment_by_receipt(unmatched.trans)).status, "matched");
  // The one the owner said was different money stays unmatched.
  assert.equal((await payment_by_receipt(own.trans)).status, "unmatched");
});

test("an unmatched payment can be marked not a tenant payment, and put back", async () => {
  const p = await make_property("Stray Street");
  const t = await make_tenant(p, "S1");
  const res = await c2b(t, 777, { phone: "254799999999" });
  const payment = await payment_by_receipt(res.trans);
  const before = (await call("GET", "/api/payments/stats")).body.data;
  let out = await call("POST", `/api/payments/${payment.id}/dismiss`, { reason: "Owner topped up the till" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.data.status, "dismissed");
  const unmatched = (await call("GET", "/api/payments/unmatched")).body.data;
  assert.ok(!unmatched.some((x) => x.id === payment.id));
  const after = (await call("GET", "/api/payments/stats")).body.data;
  assert.equal(after.unmatched_count, before.unmatched_count - 1);
  out = await call("POST", `/api/payments/${payment.id}/restore`);
  assert.equal(out.body.data.status, "unmatched");
});

test("a payment the deposit settlement used cannot be reversed until it is reopened", async () => {
  const p = await make_property("Jane Gardens");
  const t = await make_tenant(p, "J1");
  await bill(t, "rent_deposit", 10000, { period: "1970-01-01" });
  const p1 = await pay_by_hand(t, 10000);
  assert.equal(p1.status, 201);
  await bill(t, "rent", 3000);
  await call("POST", `/api/tenants/${t.tenant}/move-out`, { move_out_date: today() });
  let res = await call("POST", `/api/tenants/${t.tenant}/deposit-reconciliation/confirm`, { deductions: [] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.settlement.refund_due, 7000);

  res = await call("POST", `/api/payments/${p1.body.data.id}/reverse`, { reason: "Typed by mistake" });
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, "reopen_settlement_first");

  res = await call("POST", `/api/tenants/${t.tenant}/deposit-reconciliation/reopen`, { reason: "Deposit never paid" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  res = await call("POST", `/api/payments/${p1.body.data.id}/reverse`, { reason: "Typed by mistake" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  res = await call("POST", `/api/tenants/${t.tenant}/deposit-reconciliation/confirm`, { deductions: [] });
  assert.equal(res.body.data.settlement.refund_due, 0);
  assert.equal(res.body.data.settlement.tenant_owes, 3000);
});

test("once the refund is paid out, its payments cannot be reversed", async () => {
  const p = await make_property("Paid Out Park");
  const t = await make_tenant(p, "R1");
  await bill(t, "rent_deposit", 8000, { period: "1970-01-01" });
  const p1 = await pay_by_hand(t, 8000);
  await call("POST", `/api/tenants/${t.tenant}/move-out`, { move_out_date: today() });
  await call("POST", `/api/tenants/${t.tenant}/deposit-reconciliation/confirm`, { deductions: [] });
  const refund = await call("POST", `/api/tenants/${t.tenant}/deposit-reconciliation/refund`, { paid_on: today(), method: "cash" });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const res = await call("POST", `/api/payments/${p1.body.data.id}/reverse`, { reason: "Mistake" });
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, "refund_paid");
});

test("a settled former tenant's extra money is added to their refund", async () => {
  const p = await make_property("Peter Place");
  const t = await make_tenant(p, "E1");
  await bill(t, "rent", 5000);
  await call("POST", `/api/tenants/${t.tenant}/move-out`, { move_out_date: today() });
  let res = await call("POST", `/api/tenants/${t.tenant}/deposit-reconciliation/confirm`, { deductions: [] });
  assert.equal(res.body.data.settlement.tenant_owes, 5000);

  const later = await pay_by_hand(t, 6000);
  assert.equal(later.status, 201, JSON.stringify(later.body));
  res = await call("GET", `/api/tenants/${t.tenant}/deposit-reconciliation`);
  assert.equal(res.body.data.settlement.tenant_owes, 0);
  assert.equal(res.body.data.settlement.refund_due, 1000);
  assert.equal(res.body.data.settlement.added_after_settlement, 1000);
  assert.equal(await credit(t), 0);

  res = await call("POST", `/api/payments/${later.body.data.id}/reverse`, { reason: "Wrong tenant" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  res = await call("GET", `/api/tenants/${t.tenant}/deposit-reconciliation`);
  assert.equal(res.body.data.settlement.tenant_owes, 5000);
  assert.equal(res.body.data.settlement.refund_due, 0);
});

test("the statement brings the balance forward and adds up", async () => {
  const p = await make_property("Statement Street");
  const t = await make_tenant(p, "T1");
  const last = new Date(`${month_start(-1)}T09:00:00+03:00`);
  // Last month: rent of 10,000, 4,000 paid.
  await bill(t, "rent", 10000, { period: month_start(-1), due: month_start(-1), created: last.toISOString() });
  const first = await pay_by_hand(t, 4000, { received_at: new Date(last.getTime() + 3600e3).toISOString() });
  assert.equal(first.status, 201);
  // This month: rent of 10,000, then 12,000 paid.
  await bill(t, "rent", 10000, { period: month_start(0), due: month_start(0) });
  assert.equal((await pay_by_hand(t, 12000)).status, 201);

  const res = await call("GET", `/api/reports/tenants/${t.tenant}/statement?period=this_month`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const ledger = res.body.data.ledger;
  assert.equal(ledger.opening_balance, 6000);
  assert.deepEqual(ledger.lines.map((l) => [l.billed, l.paid, l.balance]), [[10000, null, 16000], [null, 12000, 4000]]);
  assert.equal(ledger.closing_balance, 4000);
  assert.equal(ledger.balance_today, 4000);
  assert.equal(ledger.owed, 4000);

  const pdf = await fetch(`${base}/api/reports/tenants/${t.tenant}/statement/download?period=this_month`, { headers: { Authorization: `Bearer ${owner}` } });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type"), /pdf/);
});

test("the dashboard and reports agree on what is owed and overdue", async () => {
  const p = await make_property("Agreement Avenue");
  const t = await make_tenant(p, "A1");
  await bill(t, "rent", 10000, { period: month_start(1), due: month_start(1) }); // not due yet
  await bill(t, "water", 1500, { due: month_start(-1) }); // overdue
  await bill(t, "rent_deposit", 5000, { period: "1970-01-01", due: month_start(-1) }); // overdue
  await bill(t, "repair", 2000, { status: "held" }); // waits for move-out

  const home = (await call("GET", `/api/dashboard/home?property_id=${p}`)).body.data;
  const report = (await call("GET", `/api/reports/dashboard?property_id=${p}`)).body.data;
  assert.equal(home.owed.owed, 16500);
  assert.equal(home.owed.overdue, 6500);
  assert.equal(report.arrears.total_arrears, 16500);
  assert.equal(report.arrears.total_overdue, 6500);
  assert.equal(report.arrears.by_property[0].arrears_amount, 16500);
  assert.equal(report.arrears.by_property[0].overdue_amount, 6500);

  const tenant = (await call("GET", `/api/tenants/${t.tenant}`)).body.data;
  assert.equal(Number(tenant.balance ?? tenant.tenant?.balance), 16500);

  // Across the whole account too.
  const all_home = (await call("GET", "/api/dashboard/home")).body.data;
  const all_report = (await call("GET", "/api/reports/dashboard")).body.data;
  assert.equal(all_home.owed.owed, all_report.arrears.total_arrears);
  assert.equal(all_home.owed.overdue, all_report.arrears.total_overdue);
  const by_property = all_report.arrears.by_property.reduce((s, x) => s + Math.round(x.arrears_amount * 100), 0) / 100;
  assert.equal(by_property, all_report.arrears.total_arrears);
});

test("every shilling is accounted for, for every tenant", async () => {
  const tenants = (await db.query("SELECT id FROM tenants")).rows;
  assert.ok(tenants.length >= 10);
  const { build_ledger } = r("src/reports/statement_ledger");

  for (const { id } of tenants) {
    const ledger = await build_ledger(db, id, { start_date: "1970-01-01", end_date: "2999-12-31" });
    // The running account ends where today's figures say.
    assert.equal(ledger.closing_balance, ledger.balance_today, `tenant ${id}`);
  }

  // What bills show as paid is exactly what payments, credit and deposits put on them.
  const paid = (await db.query(`
    SELECT
      (SELECT COALESCE(SUM(amount_paid),0) FROM tenant_charges WHERE status <> 'void') AS on_bills,
      (SELECT COALESCE(SUM(payment_allocations.amount),0) FROM payment_allocations
         INNER JOIN payments ON payments.id = payment_allocations.payment_id WHERE payments.status = 'matched') AS from_payments,
      (SELECT COALESCE(SUM(amount),0) FROM deposit_applications) AS from_deposits,
      (SELECT COUNT(*) FROM payment_allocations INNER JOIN tenant_charges ON tenant_charges.id = payment_allocations.tenant_charge_id WHERE tenant_charges.status = 'void') AS on_void
  `)).rows[0];
  assert.equal(Number(paid.on_bills), Number(paid.from_payments) + Number(paid.from_deposits));
  assert.equal(Number(paid.on_void), 0);

  // Money received = bills paid + credit held + credit used at move-out + extra added to refunds.
  const money = (await db.query(`
    SELECT
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'matched') AS received,
      (SELECT COALESCE(SUM(payment_allocations.amount),0) FROM payment_allocations
         INNER JOIN payments ON payments.id = payment_allocations.payment_id WHERE payments.status = 'matched') AS on_bills,
      (SELECT COALESCE(SUM(remaining_amount),0) FROM tenant_credits) AS credit,
      (SELECT COALESCE(SUM((c->>'remaining')::NUMERIC),0) FROM deposit_settlements, JSONB_ARRAY_ELEMENTS(COALESCE(breakdown->'credits','[]'::JSONB)) AS c) AS credit_at_move_out,
      (SELECT COALESCE(SUM(added_to_refund),0) FROM payments WHERE status = 'matched') AS added_to_refunds
  `)).rows[0];
  assert.equal(
    Math.round(Number(money.received) * 100),
    Math.round((Number(money.on_bills) + Number(money.credit) + Number(money.credit_at_move_out) + Number(money.added_to_refunds)) * 100)
  );

  // No bill is left 'partial' when it is paid in full.
  const stuck = await db.query("SELECT COUNT(*)::INT AS n FROM tenant_charges WHERE status = 'partial' AND amount_paid >= amount_due");
  assert.equal(stuck.rows[0].n, 0);
});
