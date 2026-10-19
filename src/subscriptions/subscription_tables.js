const db = require("../config/db");

/*
  Kodi's own billing: what each landlord (owner) pays Kodi.
  Decided with the owner of Kodi on 2026-10-18:
  - a free trial until the end of the next full calendar month;
  - then a flat monthly price (KSh 5,000, decided 2026-10-19), billed on
    the 1st, paid by M-Pesa STK push to Kodi's till;
  - 7 grace days, then the account is read-only until it pays;
  - prepaid plans with a discount (3, 6, 12 months), each switched
    on by the admin; discounts and custom amounts per landlord;
    trials extended and free months given by the admin.

  Amounts are whole Kenyan shillings. Dates are Nairobi days.
*/
async function init_subscription_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscription_settings (
      subscription_settings_id SMALLINT PRIMARY KEY DEFAULT 1
        CHECK (subscription_settings_id = 1),
      monthly_price INTEGER NOT NULL DEFAULT 5000
        CHECK (monthly_price BETWEEN 1 AND 1000000),
      grace_days INTEGER NOT NULL DEFAULT 7
        CHECK (grace_days BETWEEN 0 AND 30),
      updated_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO subscription_settings (subscription_settings_id)
    VALUES (1)
    ON CONFLICT DO NOTHING;

    /*
      Paying ahead. 12 months at 16.67% off is "the price of 10";
      prices are rounded to the nearest 10 shillings.
    */
    CREATE TABLE IF NOT EXISTS subscription_plans (
      months INTEGER PRIMARY KEY CHECK (months BETWEEN 2 AND 24),
      discount_percent NUMERIC(5, 2) NOT NULL
        CHECK (discount_percent >= 0 AND discount_percent < 100),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO subscription_plans (months, discount_percent)
    VALUES (6, 10), (12, 16.67)
    ON CONFLICT DO NOTHING;

    -- The 3-month card was removed (2026-10-19): Monthly, 6 months and 1 year.
    DELETE FROM subscription_plans WHERE months = 3;

    /*
      The pricing cards (decided 2026-10-19): one package, paid for a
      month, 3 months, 6 months or a year. Each card has its words, an
      optional public offer (a percentage off, until a date) and can be
      shown or hidden; the monthly card's price is the monthly bill.
    */
    ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_months_check;
    ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_months_check CHECK (months BETWEEN 1 AND 24);

    ALTER TABLE subscription_plans
      ADD COLUMN IF NOT EXISTS name VARCHAR(40),
      ADD COLUMN IF NOT EXISTS tagline VARCHAR(160),
      ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::JSONB,
      ADD COLUMN IF NOT EXISTS most_popular BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS offer_percent NUMERIC(5, 2),
      ADD COLUMN IF NOT EXISTS offer_label VARCHAR(60),
      ADD COLUMN IF NOT EXISTS offer_ends_on DATE;

    ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_offer_check;
    ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_offer_check
      CHECK (offer_percent IS NULL OR (offer_percent > 0 AND offer_percent < 100));

    INSERT INTO subscription_plans (months, discount_percent, enabled)
    VALUES (1, 0, TRUE)
    ON CONFLICT DO NOTHING;

    UPDATE subscription_plans
    SET name = CASE months WHEN 1 THEN 'Monthly' WHEN 3 THEN '3 months' WHEN 6 THEN '6 months' WHEN 12 THEN '1 year' ELSE months || ' months' END
    WHERE name IS NULL;

    UPDATE subscription_plans
    SET tagline = CASE months
      WHEN 1 THEN 'Pay month by month.'
      WHEN 3 THEN 'A little off for paying a quarter ahead.'
      WHEN 6 THEN 'Half a year ahead, more saved.'
      WHEN 12 THEN 'The best value: about two months free.'
      ELSE NULL END
    WHERE tagline IS NULL;

    -- Brief lines, so the cards stay short (the earlier long default is replaced too; edited lists are kept).
    UPDATE subscription_plans
    SET features = '["All properties, units and tenants", "M-Pesa auto-matching", "Water billing with photos", "SMS reminders and receipts", "Deposits and move-outs", "Expenses and repairs", "Caretaker app", "Reports and statements"]'::JSONB
    WHERE features = '[]'::JSONB
       OR features = '["All your properties, units and tenants", "M-Pesa payments matched to tenants automatically", "Water bills from photo meter readings", "Rent reminders and receipts by SMS", "Deposits, move-ins and move-outs worked out", "Expenses, repairs and maintenance", "Caretaker phone app", "Reports and tenant statements"]'::JSONB;

    UPDATE subscription_plans SET most_popular = TRUE
    WHERE months = 12 AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE most_popular);

    /*
      One row per owner. The account is covered until the later
      of trial_ends_on and paid_through (both the last day
      covered); carry_amount is what the admin chose to move to
      the next bill.
    */
    CREATE TABLE IF NOT EXISTS subscriptions (
      owner_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      trial_ends_on DATE NOT NULL,
      paid_through DATE,
      carry_amount INTEGER NOT NULL DEFAULT 0 CHECK (carry_amount >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- The pricing card a person picked on the home page, told while they wait for owner access.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_plan_months SMALLINT;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_requested_plan_months_check;
    ALTER TABLE users ADD CONSTRAINT users_requested_plan_months_check
      CHECK (requested_plan_months IS NULL OR requested_plan_months BETWEEN 1 AND 24);

    -- The admin ending one landlord's grace period early: the last day of grace.
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_cut_on DATE;

    /*
      A discount for one landlord: a percentage or an amount off
      each monthly bill, for some months or until ended. One at a
      time per landlord.
    */
    CREATE TABLE IF NOT EXISTS subscription_discounts (
      discount_id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      kind VARCHAR(10) NOT NULL CHECK (kind IN ('percent', 'amount')),
      value INTEGER NOT NULL CHECK (value > 0),
      months_total INTEGER CHECK (months_total IS NULL OR months_total BETWEEN 1 AND 36),
      months_used INTEGER NOT NULL DEFAULT 0 CHECK (months_used >= 0),
      reason TEXT NOT NULL,
      created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMPTZ,
      CHECK (kind <> 'percent' OR value <= 100)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_discount_active
      ON subscription_discounts(owner_id)
      WHERE ended_at IS NULL;

    /*
      A bill: one calendar month (monthly) or several (prepaid).
      amount_due = base_amount - discount_amount + carried_amount,
      unless the admin set a custom amount. At most one open
      monthly bill per owner.
    */
    CREATE TABLE IF NOT EXISTS subscription_invoices (
      invoice_id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      kind VARCHAR(10) NOT NULL CHECK (kind IN ('monthly', 'prepaid')),
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      months INTEGER NOT NULL CHECK (months >= 1),
      base_amount INTEGER NOT NULL CHECK (base_amount >= 0),
      discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      discount_id BIGINT REFERENCES subscription_discounts(discount_id) ON DELETE SET NULL,
      carried_amount INTEGER NOT NULL DEFAULT 0 CHECK (carried_amount >= 0),
      amount_due INTEGER NOT NULL CHECK (amount_due >= 0),
      custom_amount_reason TEXT,
      status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
      void_reason TEXT,
      auto_stk_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMPTZ,
      CHECK (period_end >= period_start)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_invoice_open_monthly
      ON subscription_invoices(owner_id)
      WHERE kind = 'monthly' AND status = 'open';

    CREATE INDEX IF NOT EXISTS idx_subscription_invoices_owner
      ON subscription_invoices(owner_id, created_at DESC);

    /*
      Money received. An M-Pesa receipt number counts once, ever.
    */
    CREATE TABLE IF NOT EXISTS subscription_payments (
      payment_id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      invoice_id BIGINT REFERENCES subscription_invoices(invoice_id) ON DELETE SET NULL,
      method VARCHAR(20) NOT NULL CHECK (method IN ('mpesa_stk', 'cash', 'bank', 'mpesa_other', 'other')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      mpesa_receipt VARCHAR(20),
      reference VARCHAR(100),
      phone VARCHAR(20),
      paid_on DATE NOT NULL,
      note TEXT,
      recorded_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_payment_receipt
      ON subscription_payments(mpesa_receipt)
      WHERE mpesa_receipt IS NOT NULL;

    /*
      Each STK push Kodi asked Safaricom to send. A payment is
      counted only for a request made here, with the same
      amount, once Safaricom confirms it when asked directly.
    */
    CREATE TABLE IF NOT EXISTS subscription_stk_requests (
      stk_id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      invoice_id BIGINT NOT NULL REFERENCES subscription_invoices(invoice_id) ON DELETE CASCADE,
      phone VARCHAR(20) NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      checkout_request_id VARCHAR(100),
      merchant_request_id VARCHAR(100),
      status VARCHAR(12) NOT NULL DEFAULT 'sending'
        CHECK (status IN ('sending', 'sent', 'confirming', 'paid', 'failed', 'cancelled', 'expired')),
      result_code VARCHAR(20),
      result_desc TEXT,
      mpesa_receipt VARCHAR(20),
      requested_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
      automatic BOOLEAN NOT NULL DEFAULT FALSE,
      checks INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_stk_checkout
      ON subscription_stk_requests(checkout_request_id)
      WHERE checkout_request_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_subscription_stk_owner
      ON subscription_stk_requests(owner_id, created_at DESC);

    -- What Safaricom sent to the result address, as received.
    CREATE TABLE IF NOT EXISTS subscription_stk_events (
      event_id BIGSERIAL PRIMARY KEY,
      checkout_request_id VARCHAR(100),
      payload JSONB NOT NULL,
      ip_address VARCHAR(100),
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Reminders already sent, so each goes once.
    CREATE TABLE IF NOT EXISTS subscription_notices (
      owner_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      notice_key VARCHAR(100) NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_id, notice_key)
    );
  `);

  /*
    Any change to an owner's billing (a trial ended or extended, a
    bill made or changed, a payment) is announced like a bell change
    (live_tables.js), so the owner's open pages update at once.
  */
  await db.query(`
    DROP TRIGGER IF EXISTS bell_subscriptions ON subscriptions;
    CREATE TRIGGER bell_subscriptions
      AFTER INSERT OR UPDATE ON subscriptions
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');

    DROP TRIGGER IF EXISTS bell_subscription_invoices ON subscription_invoices;
    CREATE TRIGGER bell_subscription_invoices
      AFTER INSERT OR UPDATE ON subscription_invoices
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');

    DROP TRIGGER IF EXISTS bell_subscription_payments ON subscription_payments;
    CREATE TRIGGER bell_subscription_payments
      AFTER INSERT ON subscription_payments
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');

    DROP TRIGGER IF EXISTS bell_subscription_discounts ON subscription_discounts;
    CREATE TRIGGER bell_subscription_discounts
      AFTER INSERT OR UPDATE ON subscription_discounts
      FOR EACH ROW
      EXECUTE FUNCTION announce_bell_change('owner');
  `);

  console.log("[SUBSCRIPTIONS] Tables are ready.");
}

module.exports = {
  init_subscription_tables,
};
