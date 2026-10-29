/*
  A tenant's statement as a running account, like a bank
  statement (the owner's rule, 2026-10-29):

    1 Oct  Brought forward                       6,000
    1 Oct  October rent          10,000         16,000
    5 Oct  M-Pesa payment                12,000  4,000
    31 Oct Balance at the end                    4,000

  The balance is what the tenant owes less what they have paid
  ahead (credit), so a tenant in credit shows a negative balance.
  The closing balance always equals what they owe today less
  their credit and any refund still due to them.

  The lines, by date (Kenyan time):
  - a bill: every bill that is not void, on the day it was made.
    A repair held for move-out is left out until it is due;
  - a payment: every payment matched to the tenant, on the day it
    was paid;
  - deposits at move-out: the deposit money held is taken off,
    since it then pays bills or is refunded;
  - a refund paid: what was paid back to the tenant.
*/

const {
  to_cents,
  cents_to_number,
} = require("../utils/money");

const KIND_ORDER = {
  bill: 1,
  payment: 2,
  deposits: 3,
  refund: 4,
};

const CHARGE_LABELS = {
  rent: "Rent",
  water: "Water",
  electricity: "Electricity",
  service: "Service charge",
  repair: "Repair",
  deduction: "Deduction at move-out",
  rent_deposit: "Rent deposit",
  water_deposit: "Water deposit",
  electricity_deposit: "Electricity deposit",
};

const ACCOUNT_BILLS = {
  rent: "rent",
  water: "water",
  electricity: "electricity",
  service: "service charges",
};

const METHOD_LABELS = {
  mpesa: "M-Pesa",
  cash: "Cash",
  bank: "Bank",
  other: "Other",
};

function bill_label(row) {
  const kind = CHARGE_LABELS[row.charge_type] || "Bill";
  const monthly = !row.billing_period.startsWith("1970");

  if (row.description && !monthly) {
    return row.description;
  }

  return monthly
    ? `${kind}, ${row.period_label}${row.description && row.charge_type === "service" ? ` (${row.description})` : ""}`
    : kind;
}

async function load_lines(client, tenant_id) {
  const result = await client.query(
    `
      SELECT
        'bill' AS kind,
        tenant_charges.id,
        tenant_charges.created_at AS happened_at,
        TO_CHAR(
          tenant_charges.created_at AT TIME ZONE 'Africa/Nairobi',
          'YYYY-MM-DD'
        ) AS day,
        tenant_charges.amount_due AS amount,
        tenant_charges.charge_type,
        tenant_charges.description,
        TO_CHAR(tenant_charges.billing_period, 'YYYY-MM-DD') AS billing_period,
        TO_CHAR(tenant_charges.billing_period, 'FMMonth YYYY') AS period_label,
        NULL AS method,
        NULL AS reference
      FROM tenant_charges
      WHERE tenant_charges.tenant_id = $1
        AND tenant_charges.status NOT IN ('void', 'held')

      UNION ALL

      SELECT
        'payment',
        payments.id,
        payments.received_at,
        TO_CHAR(
          payments.received_at AT TIME ZONE 'Africa/Nairobi',
          'YYYY-MM-DD'
        ),
        payments.amount,
        NULL, NULL, NULL, NULL,
        payments.payment_method,
        COALESCE(payments.provider_transaction_id, payments.reference)
      FROM payments
      WHERE payments.tenant_id = $1
        AND payments.status = 'matched'

      UNION ALL

      SELECT
        'deposits',
        deposit_settlements.id,
        deposit_settlements.confirmed_at,
        TO_CHAR(
          deposit_settlements.confirmed_at AT TIME ZONE 'Africa/Nairobi',
          'YYYY-MM-DD'
        ),
        deposit_settlements.deposits_held,
        NULL, NULL, NULL, NULL, NULL, NULL
      FROM deposit_settlements
      WHERE deposit_settlements.tenant_id = $1
        AND deposit_settlements.deposits_held > 0

      UNION ALL

      SELECT
        'refund',
        deposit_settlements.id,
        COALESCE(
          deposit_settlements.refund_recorded_at,
          deposit_settlements.refund_paid_on::TIMESTAMPTZ
        ),
        TO_CHAR(deposit_settlements.refund_paid_on, 'YYYY-MM-DD'),
        deposit_settlements.refund_paid_amount,
        NULL, NULL, NULL, NULL,
        deposit_settlements.refund_method,
        deposit_settlements.refund_reference
      FROM deposit_settlements
      WHERE deposit_settlements.tenant_id = $1
        AND deposit_settlements.refund_paid_on IS NOT NULL
        AND deposit_settlements.refund_paid_amount > 0
    `,
    [tenant_id]
  );

  return result.rows.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      new Date(a.happened_at) - new Date(b.happened_at) ||
      String(a.id).localeCompare(String(b.id))
  );
}

function describe(row) {
  switch (row.kind) {
    case "bill":
      return bill_label(row);

    case "payment":
      return [
        `${METHOD_LABELS[row.method] || "Payment"} payment`,
        row.reference,
      ]
        .filter(Boolean)
        .join(" ");

    case "deposits":
      return "Deposits held at move-out, used for bills or refunded";

    default:
      return [
        "Deposit refund paid to the tenant",
        row.reference,
      ]
        .filter(Boolean)
        .join(" ");
  }
}

// How a line moves the balance, in cents.
function movement(row) {
  const cents = to_cents(row.amount);

  return row.kind === "bill" || row.kind === "refund" ? cents : -cents;
}

/*
  What the tenant holds or is owed back, to explain a balance:
  credit by the account it can pay, and any refund still due.
*/
async function load_position(client, tenant_id) {
  const result = await client.query(
    `
      SELECT
        COALESCE(
          (
            SELECT SUM(amount_due - amount_paid)
            FROM tenant_charges
            WHERE tenant_id = $1
              AND status IN ('open', 'partial')
          ),
          0
        ) AS owed,

        COALESCE(
          (
            SELECT JSON_AGG(credit ORDER BY credit.account_for)
            FROM (
              SELECT
                COALESCE(payments.account_for, 'rent') AS account_for,
                SUM(tenant_credits.remaining_amount) AS amount
              FROM tenant_credits
              INNER JOIN payments
                ON payments.id = tenant_credits.source_payment_id
              WHERE tenant_credits.tenant_id = $1
                AND tenant_credits.remaining_amount > 0
              GROUP BY COALESCE(payments.account_for, 'rent')
            ) AS credit
          ),
          '[]'::JSON
        ) AS credits,

        COALESCE(
          (
            SELECT refund_due - refund_paid_amount
            FROM deposit_settlements
            WHERE tenant_id = $1
          ),
          0
        ) AS refund_outstanding
    `,
    [tenant_id]
  );

  const row = result.rows[0];

  const credits = (row.credits || []).map((credit) => ({
    account_for: credit.account_for,
    amount: cents_to_number(to_cents(credit.amount)),
    // "held for water bills"
    pays: ACCOUNT_BILLS[credit.account_for] || "rent",
  }));

  return {
    owed: cents_to_number(to_cents(row.owed)),
    credit: cents_to_number(
      credits.reduce((total, credit) => total + to_cents(credit.amount), 0)
    ),
    credits,
    refund_outstanding: cents_to_number(to_cents(row.refund_outstanding)),
  };
}

/*
  The statement for a period: { start_date, end_date } as
  'YYYY-MM-DD' Kenyan days.
*/
async function build_ledger(client, tenant_id, period) {
  const rows = await load_lines(client, tenant_id);

  let balance = 0;
  let opening = 0;
  const lines = [];
  let billed = 0;
  let paid = 0;

  for (const row of rows) {
    const change = movement(row);

    if (row.day < period.start_date) {
      balance += change;
      opening = balance;
      continue;
    }

    if (row.day > period.end_date) {
      break;
    }

    balance += change;

    if (change > 0) {
      billed += change;
    } else {
      paid -= change;
    }

    lines.push({
      date: row.day,
      kind: row.kind,
      id: row.id,
      description: describe(row),
      charge_type: row.charge_type || null,
      // What the line adds to what is owed, or takes off it.
      billed: change > 0 ? cents_to_number(change) : null,
      paid: change < 0 ? cents_to_number(-change) : null,
      balance: cents_to_number(balance),
    });
  }

  const position = await load_position(client, tenant_id);

  return {
    opening_balance: cents_to_number(opening),
    lines,
    total_billed: cents_to_number(billed),
    total_paid: cents_to_number(paid),
    closing_balance: cents_to_number(balance),

    /*
      Today's figures behind the balance, for "Owed 16,500, credit
      3,000 held for water bills".
    */
    ...position,
    balance_today: cents_to_number(
      to_cents(position.owed) -
        to_cents(position.credit) -
        to_cents(position.refund_outstanding)
    ),
  };
}

module.exports = {
  build_ledger,
};
