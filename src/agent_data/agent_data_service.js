const db = require("../config/db");

const {
  get_settings: get_billing_settings,
  state_of: billing_state_of,
} = require("../subscriptions/subscription_service");

const billing_dates = require("../subscriptions/subscription_dates");

/*
  What the customer agent may read about Kodi, decided with the
  owner on 2026-10-16: totals across Kodi, and each landlord's
  account (name, contact, size, sign-ins, which features they use),
  so the agent can report and spot landlords going quiet.

  Never tenants' personal data: tenants appear only as counts.
  Read-only: nothing here changes anything.

  "Payments" are rent and bills that landlords collect from their
  tenants through Kodi, not money paid to Kodi. Money paid to Kodi
  (landlords' subscriptions, from 2026-10-18) is "kodi_income".
*/

const since = "CURRENT_TIMESTAMP - ($1::INT * INTERVAL '1 day')";

async function summary({ days }) {
  const totals = (
    await db.query(
      `
        SELECT
          (SELECT COUNT(*)::INT FROM users WHERE role = 'owner') AS landlords,
          (SELECT COUNT(*)::INT FROM users WHERE role = 'owner' AND status = 'active') AS landlords_active_accounts,
          (SELECT COUNT(*)::INT FROM users WHERE role = 'owner' AND created_at >= ${since}) AS landlords_new,
          (SELECT COUNT(*)::INT FROM users WHERE role = 'caretaker' AND status = 'active') AS caretakers,

          (SELECT COUNT(*)::INT FROM audit_logs WHERE action = 'LOGIN_SUCCESS' AND created_at >= ${since}) AS sign_ins,
          (SELECT COUNT(DISTINCT user_id)::INT FROM audit_logs WHERE action = 'LOGIN_SUCCESS' AND created_at >= ${since}) AS people_signed_in,
          (SELECT COUNT(DISTINCT a.owner_id)::INT
            FROM audit_logs a JOIN users u ON u.user_id = a.owner_id AND u.role = 'owner'
            WHERE a.action = 'LOGIN_SUCCESS' AND a.created_at >= ${since}) AS landlords_signed_in,
          (SELECT COUNT(*)::INT FROM audit_logs WHERE action = 'LOGIN_FAILED' AND created_at >= ${since}) AS failed_sign_ins,

          (SELECT COUNT(*)::INT FROM properties WHERE status = 'active') AS properties,
          (SELECT COUNT(*)::INT FROM units u JOIN properties p ON p.id = u.property_id
            WHERE p.status = 'active' AND u.archived_at IS NULL AND u.status <> 'inactive') AS units,
          (SELECT COUNT(*)::INT FROM units u JOIN properties p ON p.id = u.property_id
            WHERE p.status = 'active' AND u.archived_at IS NULL AND u.status = 'occupied') AS units_occupied,
          (SELECT COUNT(*)::INT FROM tenants WHERE status IN ('active', 'notice_given')) AS tenants_current,
          (SELECT COUNT(*)::INT FROM tenants WHERE created_at >= ${since}) AS tenants_added,

          (SELECT COUNT(*)::INT FROM payments WHERE status IN ('matched', 'unmatched') AND received_at >= ${since}) AS payments,
          (SELECT COALESCE(SUM(amount), 0)::NUMERIC(14,2) FROM payments WHERE status IN ('matched', 'unmatched') AND received_at >= ${since}) AS payments_amount,
          (SELECT COUNT(*)::INT FROM payments WHERE payment_source = 'mpesa_c2b' AND status IN ('matched', 'unmatched') AND received_at >= ${since}) AS payments_by_mpesa,
          (SELECT COUNT(*)::INT FROM payments WHERE status = 'unmatched' AND received_at >= ${since}) AS payments_unmatched,

          (SELECT COUNT(*)::INT FROM sms_messages WHERE status = 'accepted' AND created_at >= ${since}) AS sms_sent,
          (SELECT COUNT(*)::INT FROM maintenance_requests WHERE created_at >= ${since}) AS maintenance_reported,
          (SELECT COUNT(*)::INT FROM maintenance_requests WHERE status IN ('reported', 'in_progress')) AS maintenance_open
      `,
      [days]
    )
  ).rows[0];

  // How many landlords used each feature in the period (or have it set up, for service charges).
  const features = (
    await db.query(
      `
        SELECT
          (SELECT COUNT(DISTINCT owner_id)::INT FROM payments WHERE payment_source = 'mpesa_c2b' AND received_at >= ${since}) AS mpesa_collection,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM water_meter_readings WHERE created_at >= ${since}) AS water_readings,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM service_charges WHERE status = 'active') AS service_charges,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM agreements WHERE created_at >= ${since}) AS agreements,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM deposit_settlements WHERE created_at >= ${since}) AS deposit_settlements,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM expenses WHERE status = 'recorded' AND created_at >= ${since}) AS expenses,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM maintenance_requests WHERE created_at >= ${since}) AS maintenance,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM sms_messages WHERE created_at >= ${since}) AS sms,
          (SELECT COUNT(DISTINCT owner_id)::INT FROM property_caretaker_assignments WHERE status = 'active') AS caretakers
      `,
      [days]
    )
  ).rows[0];

  const by_day = (
    await db.query(
      `
        SELECT
          to_char(day, 'YYYY-MM-DD') AS day,
          (SELECT COUNT(*)::INT FROM audit_logs a
            WHERE a.action = 'LOGIN_SUCCESS'
              AND (a.created_at AT TIME ZONE 'Africa/Nairobi')::DATE = day::DATE) AS sign_ins,
          (SELECT COUNT(*)::INT FROM users u
            WHERE u.role = 'owner'
              AND (u.created_at AT TIME ZONE 'Africa/Nairobi')::DATE = day::DATE) AS new_landlords
        FROM generate_series(
          (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::DATE - (LEAST($1::INT, 31) - 1),
          (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::DATE,
          INTERVAL '1 day'
        ) AS day
        ORDER BY day
      `,
      [days]
    )
  ).rows;

  return {
    period_days: days,
    totals,
    landlords_using_feature: features,
    by_day,
    kodi_income: await kodi_income(days),
    note: "payments are rent and bills landlords collected from tenants through Kodi, not income to Kodi. kodi_income is what landlords paid Kodi.",
  };
}

/*
  Money landlords paid Kodi (their subscriptions), in whole
  shillings, by Nairobi day: in the period, this calendar month and
  last month; and where every landlord stands (trial, paid, payment
  due in the grace days, read-only) with what is owed. Read only:
  landlords without a billing row yet are counted as "not_set_up".
*/
async function kodi_income(days) {
  const settings = await get_billing_settings();
  const today = billing_dates.today();
  const month_start = billing_dates.month_start(today);
  const last_month_start = billing_dates.month_start(billing_dates.add_days(month_start, -1));

  const money = (
    await db.query(
      `
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE paid_on > $1::DATE - $2::INT), 0)::INT AS received_in_period,
          (COUNT(*) FILTER (WHERE paid_on > $1::DATE - $2::INT))::INT AS payments_in_period,
          COALESCE(SUM(amount) FILTER (WHERE paid_on >= $3::DATE), 0)::INT AS received_this_month,
          COALESCE(SUM(amount) FILTER (WHERE paid_on >= $4::DATE AND paid_on < $3::DATE), 0)::INT AS received_last_month,
          COALESCE(SUM(amount), 0)::INT AS received_ever
        FROM subscription_payments
      `,
      [today, days, month_start, last_month_start]
    )
  ).rows[0];

  const accounts = (
    await db.query(`
      SELECT
        s.trial_ends_on::TEXT AS trial_ends_on,
        s.paid_through::TEXT AS paid_through,
        i.amount_due AS owing
      FROM users u
      LEFT JOIN subscriptions s ON s.owner_id = u.user_id
      LEFT JOIN subscription_invoices i ON i.owner_id = u.user_id AND i.kind = 'monthly' AND i.status = 'open'
      WHERE u.role = 'owner' AND u.status = 'active'
    `)
  ).rows;

  const landlords_by_state = { trial: 0, active: 0, grace: 0, read_only: 0, not_set_up: 0 };
  let owing = 0;

  for (const account of accounts) {
    if (!account.trial_ends_on) {
      landlords_by_state.not_set_up += 1;
      continue;
    }

    const { state } = billing_state_of(account, settings, today);

    landlords_by_state[state] += 1;

    if (["grace", "read_only"].includes(state)) owing += account.owing || 0;
  }

  return {
    ...money,
    monthly_price: settings.monthly_price,
    grace_days: settings.grace_days,
    landlords_by_state,
    owing_now: owing,
    note: "Whole shillings. active = paid; grace = bill unpaid, still working; read_only = unpaid after the grace days.",
  };
}

const SORTS = {
  // Longest without anyone in the account signing in first.
  quiet: "last_activity_at ASC NULLS FIRST",
  active: "sign_ins DESC, last_activity_at DESC NULLS LAST",
  largest: "units DESC",
  newest: "created_at DESC",
};

/*
  Each landlord's account, for the period. last_activity_at counts
  the landlord and their caretakers signing in.
*/
async function landlords({ days, q, sort, limit, owner_id = null }) {
  const params = [days];
  const conditions = ["u.role = 'owner'"];

  if (owner_id) {
    params.push(owner_id);
    conditions.push(`u.user_id = $${params.length}`);
  }

  if (q) {
    params.push(`%${q}%`);
    conditions.push(
      `(u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR CONCAT(u.first_name, ' ', u.last_name) ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.email ILIKE $${params.length})`
    );
  }

  params.push(limit);

  const rows = (
    await db.query(
      `
        SELECT * FROM (
          SELECT
            u.user_id AS landlord_id,
            TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name,
            u.phone,
            u.email,
            u.status AS account_status,
            u.created_at,
            u.last_login_at AS landlord_last_sign_in_at,
            (SELECT MAX(a.created_at) FROM audit_logs a
              WHERE a.action = 'LOGIN_SUCCESS' AND a.owner_id = u.user_id) AS last_activity_at,
            (SELECT COUNT(*)::INT FROM audit_logs a
              WHERE a.action = 'LOGIN_SUCCESS' AND a.owner_id = u.user_id AND a.created_at >= ${since}) AS sign_ins,
            (SELECT COUNT(*)::INT FROM properties p WHERE p.owner_id = u.user_id AND p.status = 'active') AS properties,
            (SELECT COUNT(*)::INT FROM units un JOIN properties p ON p.id = un.property_id
              WHERE p.owner_id = u.user_id AND p.status = 'active' AND un.archived_at IS NULL AND un.status <> 'inactive') AS units,
            (SELECT COUNT(*)::INT FROM units un JOIN properties p ON p.id = un.property_id
              WHERE p.owner_id = u.user_id AND p.status = 'active' AND un.archived_at IS NULL AND un.status = 'occupied') AS units_occupied,
            (SELECT COUNT(*)::INT FROM tenants t WHERE t.owner_id = u.user_id AND t.status IN ('active', 'notice_given')) AS tenants_current,
            (SELECT COUNT(*)::INT FROM payments pa
              WHERE pa.owner_id = u.user_id AND pa.status IN ('matched', 'unmatched') AND pa.received_at >= ${since}) AS payments,
            (SELECT COALESCE(SUM(pa.amount), 0)::NUMERIC(14,2) FROM payments pa
              WHERE pa.owner_id = u.user_id AND pa.status IN ('matched', 'unmatched') AND pa.received_at >= ${since}) AS payments_amount,
            (SELECT COUNT(*)::INT FROM payments pa
              WHERE pa.owner_id = u.user_id AND pa.status = 'unmatched' AND pa.received_at >= ${since}) AS payments_unmatched,
            (SELECT COUNT(*)::INT FROM sms_messages s WHERE s.owner_id = u.user_id AND s.created_at >= ${since}) AS sms,
            (SELECT COUNT(*)::INT FROM maintenance_requests m
              WHERE m.owner_id = u.user_id AND m.status IN ('reported', 'in_progress')) AS maintenance_open,
            (SELECT COUNT(*)::INT FROM users c WHERE c.owner_id = u.user_id AND c.role = 'caretaker' AND c.status = 'active') AS caretakers,
            json_build_object(
              'mpesa_collection', EXISTS (SELECT 1 FROM payments pa WHERE pa.owner_id = u.user_id AND pa.payment_source = 'mpesa_c2b'),
              'water_readings', EXISTS (SELECT 1 FROM water_meter_readings w WHERE w.owner_id = u.user_id),
              'service_charges', EXISTS (SELECT 1 FROM service_charges sc WHERE sc.owner_id = u.user_id),
              'agreements', EXISTS (SELECT 1 FROM agreements ag WHERE ag.owner_id = u.user_id),
              'deposit_settlements', EXISTS (SELECT 1 FROM deposit_settlements ds WHERE ds.owner_id = u.user_id),
              'expenses', EXISTS (SELECT 1 FROM expenses e WHERE e.owner_id = u.user_id),
              'maintenance', EXISTS (SELECT 1 FROM maintenance_requests m WHERE m.owner_id = u.user_id),
              'sms', EXISTS (SELECT 1 FROM sms_messages s WHERE s.owner_id = u.user_id)
            ) AS features_used
          FROM users u
          WHERE ${conditions.join(" AND ")}
        ) landlord
        ORDER BY ${SORTS[sort] || SORTS.active}
        LIMIT $${params.length}
      `,
      params
    )
  ).rows;

  const total = (await db.query("SELECT COUNT(*)::INT AS total FROM users WHERE role = 'owner'")).rows[0].total;

  return { period_days: days, total_landlords: total, landlords: await with_billing(rows) };
}

// Where each landlord stands with their Kodi bill.
async function with_billing(rows) {
  if (!rows.length) return rows;

  const settings = await get_billing_settings();
  const today = billing_dates.today();
  const billing = new Map(
    (
      await db.query(
        `
          SELECT
            s.owner_id, s.trial_ends_on::TEXT AS trial_ends_on, s.paid_through::TEXT AS paid_through,
            i.amount_due AS owing,
            (SELECT MAX(p.paid_on)::TEXT FROM subscription_payments p WHERE p.owner_id = s.owner_id) AS last_paid_on
          FROM subscriptions s
          LEFT JOIN subscription_invoices i ON i.owner_id = s.owner_id AND i.kind = 'monthly' AND i.status = 'open'
          WHERE s.owner_id = ANY($1::BIGINT[])
        `,
        [rows.map((row) => row.landlord_id)]
      )
    ).rows.map((row) => [String(row.owner_id), row])
  );

  return rows.map((row) => {
    const account = billing.get(String(row.landlord_id));

    if (!account) return { ...row, kodi_billing: null };

    const state = billing_state_of(account, settings, today);

    return {
      ...row,
      kodi_billing: {
        state: state.state,
        trial_ends_on: account.trial_ends_on,
        covered_until: state.covered_until,
        grace_ends_on: state.grace_ends_on,
        owing: ["grace", "read_only"].includes(state.state) ? account.owing || 0 : 0,
        last_paid_on: account.last_paid_on,
      },
    };
  });
}

/*
  Warning signs the agent checks every few minutes to alert the
  owner (M5). Counts only: no names, phones or amounts.
  - Failed sign-ins in the last hour, and the most for one number
    (a possible attack).
  - M-Pesa: payment notices from Safaricom in the last 24 hours, and
    how many of them (older than 10 minutes, so not still being
    processed) never became a payment in Kodi.
  - Landlords' M-Pesa connection checks that failed in 24 hours.
*/
async function signals() {
  return (
    await db.query(`
      SELECT
        (SELECT COUNT(*)::INT FROM audit_logs
          WHERE action = 'LOGIN_FAILED' AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour') AS failed_sign_ins_last_hour,
        (SELECT COALESCE(MAX(n), 0)::INT FROM (
          SELECT COUNT(*) AS n FROM audit_logs
          WHERE action = 'LOGIN_FAILED' AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
          GROUP BY metadata->>'phone'
        ) per_number) AS most_failed_sign_ins_one_number,
        (SELECT COUNT(*)::INT FROM mpesa_c2b_callback_events
          WHERE event_type = 'confirmation' AND received_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours') AS mpesa_notices_24h,
        (SELECT COUNT(*)::INT FROM mpesa_c2b_callback_events e
          WHERE e.event_type = 'confirmation'
            AND e.received_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
            AND e.received_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'
            AND NOT EXISTS (
              SELECT 1 FROM payments p WHERE p.provider_transaction_id = e.payload->>'TransID'
            )) AS mpesa_notices_not_recorded_24h,
        (SELECT COUNT(*)::INT FROM payments
          WHERE status IN ('matched', 'unmatched') AND received_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours') AS payments_24h,
        (SELECT COUNT(*)::INT FROM property_connection_checks
          WHERE status = 'failed' AND created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours') AS mpesa_connections_failed_24h
    `)
  ).rows[0];
}

module.exports = {
  summary,
  landlords,
  signals,
  SORTS,
};
