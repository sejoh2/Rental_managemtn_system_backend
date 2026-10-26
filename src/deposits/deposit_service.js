const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  charge_priority_order_sql,
  apply_tenant_credits,
} = require("../billing/billing_service");

/*
  Deposit reconciliation after a tenant moves out.

  - Each deposit first covers its own kind of unpaid bill:
    the rent deposit covers rent, service charges, repairs and
    the deductions the owner adds; the water deposit covers
    water; the electricity deposit covers electricity.
  - The deposits are shown separately until the owner asks for
    the final figure. That merges them: money left on one
    deposit, and any credit the tenant holds, covers what
    another deposit could not. What remains is refunded to the
    tenant; what is still unpaid stays as the tenant's debt.
  - Only deposit money that was actually paid counts as held.
  - Confirming is final. Deposit money used for a bill becomes
    income on that day.
*/

const deposit_groups = [
  {
    key: "rent",
    deposit_type: "rent_deposit",
    bill_types: [
      "rent",
      "service",
      "repair",
      "deduction",
    ],
  },
  {
    key: "water",
    deposit_type: "water_deposit",
    bill_types: ["water"],
  },
  {
    key: "electricity",
    deposit_type: "electricity_deposit",
    bill_types: ["electricity"],
  },
];

function service_error(message, status_code = 400) {
  const error = new Error(message);

  error.status_code = status_code;
  return error;
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sum(items, pick) {
  return money(
    items.reduce((total, item) => total + pick(item), 0)
  );
}

async function load_tenant(
  client,
  owner_id,
  tenant_id,
  lock = false
) {
  const result = await client.query(
    `
      SELECT
        tenants.*,
        units.unit_number,
        properties.name AS property_name
      FROM tenants
      INNER JOIN units
        ON units.id = tenants.unit_id
      INNER JOIN properties
        ON properties.id = tenants.property_id
      WHERE tenants.id = $1
        AND tenants.owner_id = $2
      ${lock ? "FOR UPDATE OF tenants" : ""}
    `,
    [tenant_id, owner_id]
  );

  if (!result.rows[0]) {
    throw service_error(
      "Tenant not found or you do not have access to them.",
      404
    );
  }

  return result.rows[0];
}

async function load_settlement(client, tenant_id) {
  const result = await client.query(
    `
      SELECT
        deposit_settlements.*,
        TO_CHAR(
          refund_paid_on,
          'YYYY-MM-DD'
        ) AS refund_paid_on_text
      FROM deposit_settlements
      WHERE tenant_id = $1
    `,
    [tenant_id]
  );

  return result.rows[0] || null;
}

function public_settlement(settlement) {
  return {
    id: settlement.id,

    deposits_held: Number(settlement.deposits_held),
    credit_held: Number(settlement.credit_held),
    deductions_total: Number(
      settlement.deductions_total
    ),
    applied_to_bills: Number(
      settlement.applied_to_bills
    ),

    refund_due: Number(settlement.refund_due),
    tenant_owes: Number(settlement.tenant_owes),

    groups: settlement.breakdown.groups || [],

    confirmed_at: settlement.confirmed_at,

    refund_paid_on: settlement.refund_paid_on_text,
    refund_method: settlement.refund_method,
    refund_reference: settlement.refund_reference,
  };
}

/*
  The tenant's live charges, in the order they are settled,
  and the credit they hold.
*/
async function load_position(client, tenant_id, lock = false) {
  const charges_result = await client.query(
    `
      SELECT
        id,
        charge_type,
        description,
        TO_CHAR(
          billing_period,
          'YYYY-MM-DD'
        ) AS billing_period,
        amount_due,
        amount_paid
      FROM tenant_charges
      WHERE tenant_id = $1
        AND status <> 'void'
      ORDER BY
        ${charge_priority_order_sql},
        due_date ASC,
        id ASC
      ${lock ? "FOR UPDATE" : ""}
    `,
    [tenant_id]
  );

  const credit_result = await client.query(
    `
      SELECT COALESCE(SUM(remaining_amount), 0) AS credit
      FROM tenant_credits
      WHERE tenant_id = $1
        AND remaining_amount > 0
    `,
    [tenant_id]
  );

  return {
    charges: charges_result.rows,
    credit: money(credit_result.rows[0].credit),
  };
}

/*
  What each deposit holds and what it has to cover.
  deductions are amounts the owner typed that are not saved
  as charges yet; they come out of the rent deposit.
*/
function build_groups(charges, deductions = []) {
  return deposit_groups.map((group) => {
    const deposits = charges.filter(
      (charge) => charge.charge_type === group.deposit_type
    );

    const items = charges
      .filter(
        (charge) =>
          group.bill_types.includes(charge.charge_type) &&
          Number(charge.amount_due) >
            Number(charge.amount_paid)
      )
      .map((charge) => ({
        charge_id: charge.id,
        charge_type: charge.charge_type,
        description: charge.description,
        billing_period: charge.billing_period,
        amount: money(
          Number(charge.amount_due) -
            Number(charge.amount_paid)
        ),
      }));

    if (group.key === "rent") {
      for (const deduction of deductions) {
        items.push({
          charge_id: null,
          charge_type: "deduction",
          description: deduction.description,
          billing_period: "1970-01-01",
          amount: money(deduction.amount),
        });
      }
    }

    const held = sum(deposits, (charge) =>
      Number(charge.amount_paid)
    );

    const unpaid = sum(items, (item) => item.amount);
    const covered = Math.min(held, unpaid);

    return {
      key: group.key,
      deposit_type: group.deposit_type,

      /*
        What the tenant was asked for, and how much of it
        they actually paid. Only the paid part is held.
      */
      deposit_charged: sum(deposits, (charge) =>
        Number(charge.amount_due)
      ),
      held,

      items,
      unpaid,

      covered,
      left: money(held - covered),
      shortfall: money(unpaid - covered),
    };
  });
}

/*
  The merged result: money left over and credit held, less
  what the deposits could not cover.
*/
function final_figure(groups, credit) {
  const net = money(
    sum(groups, (group) => group.left) +
      credit -
      sum(groups, (group) => group.shortfall)
  );

  return {
    deposits_held: sum(groups, (group) => group.held),
    credit_held: credit,
    unpaid_total: sum(groups, (group) => group.unpaid),
    refund_due: net > 0 ? net : 0,
    tenant_owes: net < 0 ? money(-net) : 0,
  };
}

/*
  Every repair charged to the tenant during the stay. The
  groups only list what is still unpaid, so a repair the tenant
  already paid would otherwise not appear at move-out at all.
*/
async function load_repairs(client, tenant_id) {
  const result = await client.query(
    `
      SELECT
        tenant_charges.id,
        tenant_charges.description,
        tenant_charges.amount_due,
        tenant_charges.amount_paid,

        COALESCE(
          (
            SELECT SUM(deposit_applications.amount)
            FROM deposit_applications
            WHERE deposit_applications.tenant_charge_id =
              tenant_charges.id
          ),
          0
        ) AS at_move_out,

        TO_CHAR(
          (
            tenant_charges.created_at
            AT TIME ZONE 'Africa/Nairobi'
          )::DATE,
          'YYYY-MM-DD'
        ) AS charged_on

      FROM tenant_charges
      WHERE tenant_charges.tenant_id = $1
        AND tenant_charges.charge_type = 'repair'
        AND tenant_charges.status <> 'void'
      ORDER BY tenant_charges.id
    `,
    [tenant_id]
  );

  return result.rows.map((row) => {
    const amount = money(row.amount_due);
    const at_move_out = money(row.at_move_out);

    return {
      charge_id: row.id,
      description: row.description,
      charged_on: row.charged_on,
      amount,

      /*
        Paid by the tenant before the reconciliation, from a
        payment or their credit.
      */
      paid_during_stay:
        money(row.amount_paid) - at_move_out,

      /*
        Taken from the deposits or credit at move-out.
      */
      covered_at_move_out: at_move_out,

      unpaid: amount - money(row.amount_paid),
    };
  });
}

function ensure_moved_out(tenant) {
  if (tenant.status !== "moved_out") {
    throw service_error(
      "Move the tenant out first. Deposits are reconciled after move-out."
    );
  }
}

async function get_reconciliation(owner, tenant_id) {
  const tenant = await load_tenant(
    db,
    owner.user_id,
    tenant_id
  );

  const settlement = await load_settlement(db, tenant_id);

  if (settlement) {
    return {
      status: "confirmed",
      settlement: public_settlement(settlement),
      repairs: await load_repairs(db, tenant_id),
    };
  }

  ensure_moved_out(tenant);

  const position = await load_position(db, tenant_id);

  return {
    status: "open",
    groups: build_groups(position.charges),
    credit_held: position.credit,
    repairs: await load_repairs(db, tenant_id),
  };
}

/*
  The final figure for the deductions the owner has typed.
  Nothing is saved.
*/
async function calculate_reconciliation(
  owner,
  tenant_id,
  data
) {
  const tenant = await load_tenant(
    db,
    owner.user_id,
    tenant_id
  );

  ensure_moved_out(tenant);

  if (await load_settlement(db, tenant_id)) {
    throw service_error(
      "This tenant's deposits have already been reconciled.",
      409
    );
  }

  const position = await load_position(db, tenant_id);

  const groups = build_groups(
    position.charges,
    data.deductions
  );

  return {
    status: "open",
    groups,
    credit_held: position.credit,
    repairs: await load_repairs(db, tenant_id),
    deductions_total: sum(
      data.deductions,
      (deduction) => deduction.amount
    ),
    ...final_figure(groups, position.credit),
  };
}

async function confirm_reconciliation(
  owner,
  tenant_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const tenant = await load_tenant(
      client,
      owner.user_id,
      tenant_id,
      true
    );

    ensure_moved_out(tenant);

    if (await load_settlement(client, tenant_id)) {
      throw service_error(
        "This tenant's deposits have already been reconciled.",
        409
      );
    }

    /*
      Credit first settles what it normally may, by account.
    */
    await apply_tenant_credits(client, tenant_id);

    /*
      Each deduction becomes a charge on the tenant, so it is
      on their record like any other bill. A deduction comes from
      nothing else, so its source is the charge itself: that keeps
      several deductions apart.
    */
    for (const deduction of data.deductions) {
      await client.query(
        `
          INSERT INTO tenant_charges (
            id,
            tenant_id,
            owner_id,
            property_id,
            unit_id,
            charge_type,
            billing_period,
            due_date,
            amount_due,
            description,
            source_id
          )
          SELECT
            fresh.id,
            $1,$2,$3,$4,
            'deduction',
            DATE '1970-01-01',
            (
              CURRENT_TIMESTAMP
              AT TIME ZONE 'Africa/Nairobi'
            )::DATE,
            $5,$6,
            fresh.id
          FROM (SELECT new_id('chg') AS id) AS fresh
        `,
        [
          tenant.id,
          tenant.owner_id,
          tenant.property_id,
          tenant.unit_id,
          deduction.amount,
          deduction.description,
        ]
      );
    }

    /*
      A tenant who has left no longer owes a deposit: only
      what they paid is held. A charge cannot have a zero
      amount, so a deposit that was never paid is marked void.
    */
    await client.query(
      `
        UPDATE tenant_charges
        SET
          amount_due = CASE
            WHEN amount_paid > 0 THEN amount_paid
            ELSE amount_due
          END,
          status = CASE
            WHEN amount_paid > 0 THEN 'paid'
            ELSE 'void'
          END
        WHERE tenant_id = $1
          AND charge_type = ANY($2)
          AND status IN ('open', 'partial')
      `,
      [
        tenant_id,
        deposit_groups.map((group) => group.deposit_type),
      ]
    );

    const position = await load_position(
      client,
      tenant_id,
      true
    );

    const groups = build_groups(position.charges);
    const figure = final_figure(groups, position.credit);

    const settlement_result = await client.query(
      `
        INSERT INTO deposit_settlements (
          tenant_id,
          owner_id,
          property_id,
          deposits_held,
          credit_held,
          deductions_total,
          breakdown,
          confirmed_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id
      `,
      [
        tenant.id,
        tenant.owner_id,
        tenant.property_id,
        figure.deposits_held,
        figure.credit_held,
        sum(data.deductions, (item) => item.amount),
        JSON.stringify({ groups }),
        owner.user_id,
      ]
    );

    const settlement_id = settlement_result.rows[0].id;

    /*
      Money available from each source, and what each bill
      still needs.
    */
    const pools = { credit: position.credit };

    for (const group of groups) {
      pools[group.deposit_type] = group.held;
    }

    const bills = groups.flatMap((group) =>
      group.items.map((item) => ({
        ...item,
        deposit_type: group.deposit_type,
        outstanding: item.amount,
      }))
    );

    let applied_to_bills = 0;

    async function apply(bill, source) {
      const amount = money(
        Math.min(pools[source], bill.outstanding)
      );

      if (amount <= 0) {
        return;
      }

      await client.query(
        `
          INSERT INTO deposit_applications (
            settlement_id,
            tenant_charge_id,
            source,
            amount
          )
          VALUES ($1,$2,$3,$4)
        `,
        [settlement_id, bill.charge_id, source, amount]
      );

      await client.query(
        `
          UPDATE tenant_charges
          SET
            amount_paid = amount_paid + $1,
            status = CASE
              WHEN amount_paid + $1 >= amount_due
              THEN 'paid'
              ELSE 'partial'
            END
          WHERE id = $2
        `,
        [amount, bill.charge_id]
      );

      pools[source] = money(pools[source] - amount);
      bill.outstanding = money(bill.outstanding - amount);
      applied_to_bills = money(applied_to_bills + amount);
    }

    /*
      First each deposit pays its own kind of bill. Then what
      is left anywhere, credit first, pays what remains.
    */
    for (const bill of bills) {
      await apply(bill, bill.deposit_type);
    }

    for (const bill of bills) {
      for (const source of [
        "credit",
        "rent_deposit",
        "water_deposit",
        "electricity_deposit",
      ]) {
        await apply(bill, source);
      }
    }

    const refund_due = sum(
      Object.values(pools),
      (amount) => amount
    );

    const tenant_owes = sum(
      bills,
      (bill) => bill.outstanding
    );

    /*
      The credit is now either used or part of the refund.
      What each credit held is kept with the settlement, so
      reopening it can put the credit back exactly. The newest
      payment is noted too ('' when there is none, which every
      later payment's ID sorts after).
    */
    const credits_before = await client.query(
      `
        SELECT id, remaining_amount
        FROM tenant_credits
        WHERE tenant_id = $1
          AND remaining_amount > 0
      `,
      [tenant_id]
    );

    await client.query(
      `
        UPDATE deposit_settlements
        SET breakdown =
          breakdown || jsonb_build_object(
            'credits',
            $1::JSONB,
            'last_payment_id',
            (
              SELECT COALESCE(MAX(id), '')
              FROM payments
              WHERE tenant_id = $3
            )
          )
        WHERE id = $2
      `,
      [
        JSON.stringify(
          credits_before.rows.map((credit) => ({
            id: credit.id,
            remaining: Number(credit.remaining_amount),
          }))
        ),
        settlement_id,
        tenant_id,
      ]
    );

    await client.query(
      `
        UPDATE tenant_credits
        SET remaining_amount = 0
        WHERE tenant_id = $1
          AND remaining_amount > 0
      `,
      [tenant_id]
    );

    await client.query(
      `
        UPDATE deposit_settlements
        SET
          applied_to_bills = $1,
          refund_due = $2,
          tenant_owes = $3
        WHERE id = $4
      `,
      [
        applied_to_bills,
        refund_due,
        tenant_owes,
        settlement_id,
      ]
    );

    await client.query(
      `
        UPDATE tenants
        SET deposit_refund_decision = $1
        WHERE id = $2
      `,
      [
        refund_due <= 0
          ? "no_refund"
          : applied_to_bills > 0
            ? "partial_refund"
            : "full_refund",
        tenant_id,
      ]
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "DEPOSIT_RECONCILED",
      entity_type: "tenant",
      entity_id: tenant.id,
      metadata: {
        property_id: tenant.property_id,
        unit_number: tenant.unit_number,
        deposits_held: figure.deposits_held,
        credit_held: figure.credit_held,
        deductions: data.deductions,
        applied_to_bills,
        refund_due,
        tenant_owes,
      },
      ip_address,
    });

    return get_reconciliation(owner, tenant_id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Undoes a confirmed reconciliation so the owner can correct
  it, for example to add a deduction that was forgotten, and
  confirm again.

  Everything the confirmation did is put back: the bills the
  deposits paid are unpaid again, the deductions are removed,
  and the credit the tenant held is restored.

  Refused once the refund has been recorded as paid, or once
  the tenant has paid anything after the confirmation: those
  must be dealt with first, because money has already moved.
*/
async function reopen_reconciliation(
  owner,
  tenant_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const tenant = await load_tenant(
      client,
      owner.user_id,
      tenant_id,
      true
    );

    const settlement_result = await client.query(
      `
        SELECT *
        FROM deposit_settlements
        WHERE tenant_id = $1
        FOR UPDATE
      `,
      [tenant_id]
    );

    const settlement = settlement_result.rows[0];

    if (!settlement) {
      throw service_error(
        "This tenant's deposits have not been reconciled yet."
      );
    }

    if (settlement.refund_paid_on) {
      throw service_error(
        "The refund has already been recorded as paid, so this reconciliation can no longer be reopened.",
        409
      );
    }

    /*
      The confirmation noted the tenant's newest payment, so a
      later one is recognised by its ID (IDs sort by age). A
      settlement made before that was recorded falls back to the
      time.
    */
    const last_payment_id =
      settlement.breakdown?.last_payment_id;

    const later_payment = await client.query(
      `
        SELECT 1
        FROM payments
        WHERE tenant_id = $1
          AND status = 'matched'
          AND (
            ($2::record_id IS NOT NULL AND id > $2::record_id)
            OR (
              $2::record_id IS NULL
              AND created_at > $3::TIMESTAMPTZ
            )
          )
        LIMIT 1
      `,
      [
        tenant_id,
        last_payment_id ?? null,
        settlement.confirmed_at,
      ]
    );

    if (later_payment.rows[0]) {
      throw service_error(
        "This tenant has paid since the reconciliation was confirmed. Reverse that payment first, then reopen.",
        409
      );
    }

    /*
      Bills the deposits and credit paid are unpaid again.
    */
    const applications = await client.query(
      `
        SELECT tenant_charge_id, SUM(amount) AS amount
        FROM deposit_applications
        WHERE settlement_id = $1
        GROUP BY tenant_charge_id
      `,
      [settlement.id]
    );

    for (const application of applications.rows) {
      await client.query(
        `
          UPDATE tenant_charges
          SET
            amount_paid = amount_paid - $1,
            status = CASE
              WHEN amount_paid - $1 <= 0 THEN 'open'
              ELSE 'partial'
            END
          WHERE id = $2
        `,
        [
          application.amount,
          application.tenant_charge_id,
        ]
      );
    }

    await client.query(
      `
        DELETE FROM deposit_applications
        WHERE settlement_id = $1
      `,
      [settlement.id]
    );

    /*
      Deductions exist only because of the confirmation. They
      are deleted, not voided, so the corrected ones can take
      their place.
    */
    await client.query(
      `
        DELETE FROM tenant_charges
        WHERE tenant_id = $1
          AND charge_type = 'deduction'
      `,
      [tenant_id]
    );

    /*
      The credit goes back where it was. A settlement made
      before the credit was recorded per row gets its total
      back on the newest credits.
    */
    const saved_credits = settlement.breakdown?.credits;

    if (Array.isArray(saved_credits)) {
      for (const credit of saved_credits) {
        await client.query(
          `
            UPDATE tenant_credits
            SET remaining_amount =
              LEAST(original_amount, $1::NUMERIC)
            WHERE id = $2
              AND tenant_id = $3
          `,
          [credit.remaining, credit.id, tenant_id]
        );
      }
    } else {
      let to_restore = money(settlement.credit_held);

      const credits = await client.query(
        `
          SELECT id, original_amount
          FROM tenant_credits
          WHERE tenant_id = $1
          ORDER BY id DESC
          FOR UPDATE
        `,
        [tenant_id]
      );

      for (const credit of credits.rows) {
        if (to_restore <= 0) {
          break;
        }

        const amount = Math.min(
          to_restore,
          money(credit.original_amount)
        );

        await client.query(
          `
            UPDATE tenant_credits
            SET remaining_amount = $1
            WHERE id = $2
          `,
          [amount, credit.id]
        );

        to_restore = money(to_restore - amount);
      }
    }

    await client.query(
      `
        DELETE FROM deposit_settlements
        WHERE id = $1
      `,
      [settlement.id]
    );

    await client.query(
      `
        UPDATE tenants
        SET deposit_refund_decision = NULL
        WHERE id = $1
      `,
      [tenant_id]
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "DEPOSIT_RECONCILIATION_REOPENED",
      entity_type: "tenant",
      entity_id: tenant.id,
      metadata: {
        property_id: tenant.property_id,
        unit_number: tenant.unit_number,
        reason: data.reason,
        refund_due_was: settlement.refund_due,
        tenant_owed_was: settlement.tenant_owes,
        deductions_were: settlement.deductions_total,
      },
      ip_address,
    });

    return get_reconciliation(owner, tenant_id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Records that the owner paid the refund to the tenant.
  The refund is paid once, in full.
*/
async function record_refund(
  owner,
  tenant_id,
  data,
  ip_address
) {
  const tenant = await load_tenant(
    db,
    owner.user_id,
    tenant_id
  );

  const settlement = await load_settlement(db, tenant_id);

  if (!settlement) {
    throw service_error(
      "Reconcile this tenant's deposits before recording a refund."
    );
  }

  if (Number(settlement.refund_due) <= 0) {
    throw service_error(
      "No refund is due to this tenant."
    );
  }

  const result = await db.query(
    `
      UPDATE deposit_settlements
      SET
        refund_paid_on = $1,
        refund_method = $2,
        refund_reference = $3,
        refund_recorded_by = $4,
        refund_recorded_at = CURRENT_TIMESTAMP
      WHERE id = $5
        AND refund_paid_on IS NULL
      RETURNING id
    `,
    [
      data.paid_on,
      data.method,
      data.reference || null,
      owner.user_id,
      settlement.id,
    ]
  );

  if (!result.rows[0]) {
    throw service_error(
      "This refund has already been recorded as paid.",
      409
    );
  }

  await log_audit({
    user_id: owner.user_id,
    action: "DEPOSIT_REFUND_PAID",
    entity_type: "tenant",
    entity_id: tenant.id,
    metadata: {
      property_id: tenant.property_id,
      unit_number: tenant.unit_number,
      amount: Number(settlement.refund_due),
      paid_on: data.paid_on,
      method: data.method,
      reference: data.reference || null,
    },
    ip_address,
  });

  return get_reconciliation(owner, tenant_id);
}

module.exports = {
  get_reconciliation,
  calculate_reconciliation,
  confirm_reconciliation,
  reopen_reconciliation,
  record_refund,
};
