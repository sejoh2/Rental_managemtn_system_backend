/*
  Keeps a confirmed deposit settlement true to what the former
  tenant pays afterwards, and guards the payments it was built
  from. Decided by the owner on 2026-10-29:

  - Money a former tenant pays after the settlement first pays
    what they still owe; anything extra is added to the refund
    owed back to them.
  - A payment the settlement was worked out from cannot be
    reversed while the settlement stands: the owner reopens it
    first, reverses, and confirms again. Once the refund has been
    paid out it cannot be reversed at all.

  Only the client of the caller's transaction is used, so these
  run inside the payment's own transaction.
*/

const {
  to_cents,
  from_cents,
} = require("../utils/money");

function service_error(message, status_code, code) {
  const error = new Error(message);

  error.status_code = status_code;

  if (code) {
    error.details = { code };
  }

  return error;
}

async function load_settlement(client, tenant_id, lock = false) {
  const result = await client.query(
    `
      SELECT *
      FROM deposit_settlements
      WHERE tenant_id = $1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [tenant_id]
  );

  return result.rows[0] || null;
}

/*
  Adds money a settled former tenant overpaid to their refund.
  Returns false when they have no settlement yet (the caller then
  keeps it as credit, which the settlement will count).
*/
async function add_to_settlement_refund(
  client,
  tenant_id,
  payment_id,
  cents
) {
  const settlement = await load_settlement(client, tenant_id, true);

  if (!settlement) {
    return false;
  }

  await client.query(
    `
      UPDATE deposit_settlements
      SET
        refund_due = refund_due + $1::NUMERIC,
        added_after_settlement =
          added_after_settlement + $1::NUMERIC
      WHERE id = $2
    `,
    [from_cents(cents), settlement.id]
  );

  await client.query(
    `
      UPDATE payments
      SET added_to_refund = added_to_refund + $1::NUMERIC
      WHERE id = $2
    `,
    [from_cents(cents), payment_id]
  );

  return true;
}

/*
  What the former tenant still owes, worked out again from their
  bills.
*/
async function refresh_settlement(client, tenant_id) {
  await client.query(
    `
      UPDATE deposit_settlements
      SET tenant_owes = COALESCE(
        (
          SELECT SUM(amount_due - amount_paid)
          FROM tenant_charges
          WHERE tenant_charges.tenant_id = deposit_settlements.tenant_id
            AND tenant_charges.status IN ('open', 'partial')
        ),
        0
      )
      WHERE tenant_id = $1
    `,
    [tenant_id]
  );
}

/*
  Whether the settlement was worked out from this payment: it was
  made before the settlement was confirmed.
*/
function payment_is_part_of(settlement, payment) {
  const last_payment_id = settlement.breakdown?.last_payment_id;

  if (typeof last_payment_id === "string") {
    return payment.id <= last_payment_id;
  }

  return new Date(payment.created_at) <= new Date(settlement.confirmed_at);
}

/*
  Throws when the payment may not be reversed because of the
  tenant's deposit settlement.
*/
async function check_payment_can_be_reversed(client, payment) {
  if (!payment.tenant_id) {
    return;
  }

  const settlement = await load_settlement(
    client,
    payment.tenant_id,
    true
  );

  if (!settlement) {
    return;
  }

  const name = payment.tenant_name || "This tenant";

  if (payment_is_part_of(settlement, payment)) {
    if (settlement.refund_paid_on) {
      throw service_error(
        `${name}'s deposit refund has already been paid out, and this payment is part of that settlement, so it can no longer be reversed.`,
        409,
        "refund_paid"
      );
    }

    throw service_error(
      `${name}'s deposits are already settled, and this payment is part of that. Reopen the deposit settlement first, then reverse it.`,
      409,
      "reopen_settlement_first"
    );
  }

  /*
    A later payment may be reversed, unless what it added to the
    refund has already been paid out to the tenant.
  */
  const added = to_cents(payment.added_to_refund);
  const unpaid_refund =
    to_cents(settlement.refund_due) -
    to_cents(settlement.refund_paid_amount);

  if (added > 0 && unpaid_refund < added) {
    throw service_error(
      `The extra ${name} paid with this payment has already been refunded to them, so it can no longer be reversed.`,
      409,
      "refund_paid"
    );
  }
}

/*
  Takes back what a reversed payment had added to the refund, and
  works out again what the former tenant owes.
*/
async function take_back_settlement_refund(client, payment) {
  if (!payment.tenant_id) {
    return;
  }

  const added = to_cents(payment.added_to_refund);

  if (added > 0) {
    await client.query(
      `
        UPDATE deposit_settlements
        SET
          refund_due = refund_due - $1::NUMERIC,
          added_after_settlement =
            added_after_settlement - $1::NUMERIC
        WHERE tenant_id = $2
      `,
      [from_cents(added), payment.tenant_id]
    );

    await client.query(
      `
        UPDATE payments
        SET added_to_refund = 0
        WHERE id = $1
      `,
      [payment.id]
    );
  }

  await refresh_settlement(client, payment.tenant_id);
}

module.exports = {
  add_to_settlement_refund,
  refresh_settlement,
  check_payment_can_be_reversed,
  take_back_settlement_refund,
};
