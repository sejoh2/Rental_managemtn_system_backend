const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

/*
  Who carries an expense. Only a repair can be charged to one
  tenant; other costs are recovered through service charges,
  which the per-category figures show.

  owner_cost   not charged to a tenant
  recovered    charged to a tenant and paid in full
  pending      charged to a tenant, not fully paid yet
  at_move_out  charged to a tenant, to be deducted from the
               deposit when they move out
*/
function expense_recovery(expense) {
  const amount = Number(expense.amount);

  if (!expense.charged_tenant_id) {
    return {
      status: "owner_cost",
      tenant_id: null,
      tenant_name: null,
      charged: 0,
      paid: 0,
      pending: 0,
      owner_cost: amount,
    };
  }

  const charged = Number(expense.charged_amount);
  const paid = Number(expense.charged_paid);

  return {
    status:
      expense.charge_status === "held"
        ? "at_move_out"
        : paid >= charged
          ? "recovered"
          : "pending",

    tenant_id: Number(expense.charged_tenant_id),
    tenant_name: expense.charged_tenant_name,
    charged,
    paid,
    pending: charged - paid,
    owner_cost: amount - charged,
  };
}

function public_expense(expense) {
  return {
    id: Number(expense.id),

    owner_id: Number(expense.owner_id),
    property_id: Number(expense.property_id),

    property_name: expense.property_name || null,

    category: expense.category,
    amount: Number(expense.amount),
    expense_date: expense.expense_date,

    notes: expense.notes,
    receipt_url: expense.receipt_url,

    status: expense.status,
    void_reason: expense.void_reason,
    voided_at: expense.voided_at,

    /*
      Set when the expense came from a maintenance request.
    */
    maintenance_request_id: expense.maintenance_request_id
      ? Number(expense.maintenance_request_id)
      : null,

    unit_number: expense.unit_number || null,

    recovery: expense_recovery(expense),

    created_by: expense.created_by
      ? Number(expense.created_by)
      : null,

    created_by_name: expense.created_by_name || null,
    created_by_role: expense.created_by_role,

    created_at: expense.created_at,
    updated_at: expense.updated_at,
  };
}

function get_owner_id(user) {
  return user.role === "caretaker"
    ? Number(user.owner_id)
    : Number(user.user_id);
}

async function ensure_property_access(
  client,
  user,
  property_id
) {
  const owner_id = get_owner_id(user);

  if (user.role === "owner") {
    const result = await client.query(
      `
        SELECT *
        FROM properties
        WHERE id = $1
          AND owner_id = $2
          AND status = 'active'
        LIMIT 1
      `,
      [property_id, owner_id]
    );

    if (!result.rows[0]) {
      const error = new Error(
        "Property not found or you do not have access to it."
      );

      error.status_code = 404;
      throw error;
    }

    return result.rows[0];
  }

  if (user.role === "caretaker") {
    const result = await client.query(
      `
        SELECT properties.*
        FROM property_caretaker_assignments
        INNER JOIN properties
          ON properties.id =
            property_caretaker_assignments.property_id
        WHERE property_caretaker_assignments.property_id = $1
          AND property_caretaker_assignments.caretaker_id = $2
          AND property_caretaker_assignments.owner_id = $3
          AND property_caretaker_assignments.status = 'active'
          AND properties.status = 'active'
        LIMIT 1
      `,
      [
        property_id,
        user.user_id,
        owner_id,
      ]
    );

    if (!result.rows[0]) {
      const error = new Error(
        "You are not assigned to this property."
      );

      error.status_code = 403;
      throw error;
    }

    return result.rows[0];
  }

  const error = new Error(
    "You do not have permission to manage expenses."
  );

  error.status_code = 403;
  throw error;
}

async function create_expense(
  user,
  property_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const property = await ensure_property_access(
      client,
      user,
      property_id
    );

    const owner_id = get_owner_id(user);

    const result = await client.query(
      `
        INSERT INTO expenses (
          owner_id,
          property_id,
          category,
          amount,
          expense_date,
          notes,
          receipt_url,
          created_by,
          created_by_role
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9
        )
        RETURNING *
      `,
      [
        owner_id,
        property.id,
        data.category,
        data.amount,
        data.expense_date,
        data.notes || null,
        data.receipt_url || null,
        user.user_id,
        user.role,
      ]
    );

    await client.query("COMMIT");

    const expense = result.rows[0];

    await log_audit({
      user_id: user.user_id,
      action: "EXPENSE_RECORDED",
      entity_type: "expense",
      entity_id: expense.id,
      metadata: {
        property_id,
        category: expense.category,
        amount: expense.amount,
        expense_date: expense.expense_date,
        created_by_role: user.role,
      },
      ip_address,
    });

    return public_expense({
      ...expense,
      property_name: property.name,
      created_by_name: [
        user.first_name,
        user.last_name,
      ]
        .filter(Boolean)
        .join(" "),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function list_expenses(user, filters) {
  const owner_id = get_owner_id(user);

  const result = await db.query(
    `
      SELECT
        expenses.*,
        properties.name AS property_name,
        CONCAT(
          users.first_name,
          ' ',
          users.last_name
        ) AS created_by_name,

        expense_unit.unit_number,

        charged_tenant.id AS charged_tenant_id,
        charged_tenant.full_name AS charged_tenant_name,
        repair_charge.amount_due AS charged_amount,
        repair_charge.amount_paid AS charged_paid,
        repair_charge.status AS charge_status
      FROM expenses
      INNER JOIN properties
        ON properties.id = expenses.property_id
      INNER JOIN users
        ON users.user_id = expenses.created_by
      LEFT JOIN units AS expense_unit
        ON expense_unit.id = expenses.unit_id
      LEFT JOIN maintenance_requests
        ON maintenance_requests.id =
          expenses.maintenance_request_id
      LEFT JOIN tenant_charges AS repair_charge
        ON repair_charge.id =
          maintenance_requests.tenant_charge_id
        AND repair_charge.status <> 'void'
      LEFT JOIN tenants AS charged_tenant
        ON charged_tenant.id = repair_charge.tenant_id
      WHERE expenses.owner_id = $1

        AND (
          $2::BIGINT IS NULL
          OR expenses.property_id = $2
        )

        AND (
          $3::VARCHAR IS NULL
          OR expenses.category = $3
        )

        AND (
          $4::VARCHAR IS NULL
          OR expenses.status = $4
        )

        AND (
          $5::DATE IS NULL
          OR expenses.expense_date >= $5
        )

        AND (
          $6::DATE IS NULL
          OR expenses.expense_date <= $6
        )

        AND (
          $7::BIGINT IS NULL
          OR EXISTS (
            SELECT 1
            FROM property_caretaker_assignments
            WHERE property_caretaker_assignments.property_id =
              expenses.property_id
              AND property_caretaker_assignments.caretaker_id = $7
              AND property_caretaker_assignments.status = 'active'
          )
        )

      ORDER BY
        expenses.expense_date DESC,
        expenses.created_at DESC
    `,
    [
      owner_id,
      filters.property_id || null,
      filters.category || null,
      filters.status || null,
      filters.from_date || null,
      filters.to_date || null,
      user.role === "caretaker"
        ? user.user_id
        : null,
    ]
  );

  return result.rows.map(public_expense);
}

async function get_expense_for_owner(
  user,
  expense_id
) {
  const owner_id = get_owner_id(user);

  const result = await db.query(
    `
      SELECT
        expenses.*,
        properties.name AS property_name,
        CONCAT(
          users.first_name,
          ' ',
          users.last_name
        ) AS created_by_name,

        expense_unit.unit_number,

        charged_tenant.id AS charged_tenant_id,
        charged_tenant.full_name AS charged_tenant_name,
        repair_charge.amount_due AS charged_amount,
        repair_charge.amount_paid AS charged_paid,
        repair_charge.status AS charge_status
      FROM expenses
      INNER JOIN properties
        ON properties.id = expenses.property_id
      INNER JOIN users
        ON users.user_id = expenses.created_by
      LEFT JOIN units AS expense_unit
        ON expense_unit.id = expenses.unit_id
      LEFT JOIN maintenance_requests
        ON maintenance_requests.id =
          expenses.maintenance_request_id
      LEFT JOIN tenant_charges AS repair_charge
        ON repair_charge.id =
          maintenance_requests.tenant_charge_id
        AND repair_charge.status <> 'void'
      LEFT JOIN tenants AS charged_tenant
        ON charged_tenant.id = repair_charge.tenant_id
      WHERE expenses.id = $1
        AND expenses.owner_id = $2
      LIMIT 1
    `,
    [expense_id, owner_id]
  );

  const expense = result.rows[0];

  if (!expense) {
    const error = new Error(
      "Expense not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  /*
    A caretaker must additionally be assigned to its property.
  */
  if (user.role === "caretaker") {
    const client = await db.get_client();

    try {
      await ensure_property_access(
        client,
        user,
        expense.property_id
      );
    } finally {
      client.release();
    }
  }

  return public_expense(expense);
}

async function void_expense(
  owner,
  expense_id,
  data,
  ip_address
) {
  if (owner.role !== "owner") {
    const error = new Error(
      "Only the property owner can void an expense."
    );

    error.status_code = 403;
    throw error;
  }

  const existing = await get_expense_for_owner(
    owner,
    expense_id
  );

  if (existing.status === "void") {
    const error = new Error(
      "This expense has already been voided."
    );

    error.status_code = 400;
    throw error;
  }

  const result = await db.query(
    `
      UPDATE expenses
      SET
        status = 'void',
        void_reason = $1,
        voided_by = $2,
        voided_at = CURRENT_TIMESTAMP
      WHERE id = $3
        AND owner_id = $4
      RETURNING *
    `,
    [
      data.void_reason,
      owner.user_id,
      expense_id,
      owner.user_id,
    ]
  );

  const expense = result.rows[0];

  await log_audit({
    user_id: owner.user_id,
    action: "EXPENSE_VOIDED",
    entity_type: "expense",
    entity_id: expense.id,
    metadata: {
      property_id: expense.property_id,
      amount: expense.amount,
      void_reason: expense.void_reason,
    },
    ip_address,
  });

  return get_expense_for_owner(owner, expense.id);
}

async function get_expense_summary(
  user,
  filters
) {
  const owner_id = get_owner_id(user);

  const result = await db.query(
    `
      WITH selected_expenses AS (
        SELECT expenses.amount
        FROM expenses
        WHERE expenses.owner_id = $1
          AND expenses.status = 'recorded'

          AND (
            $2::BIGINT IS NULL
            OR expenses.property_id = $2
          )

          AND (
            $3::DATE IS NULL
            OR expenses.expense_date >= $3
          )

          AND (
            $4::DATE IS NULL
            OR expenses.expense_date <= $4
          )

          AND (
            $5::BIGINT IS NULL
            OR EXISTS (
              SELECT 1
              FROM property_caretaker_assignments
              WHERE property_caretaker_assignments.property_id =
                expenses.property_id
                AND property_caretaker_assignments.caretaker_id = $5
                AND property_caretaker_assignments.status = 'active'
            )
          )
      ),

      /*
        Income is what payments actually settled: rent, water,
        electricity, service charges and repairs. Deposits are
        held for the tenant, so they are not income until they
        are used for a bill at move-out.
      */
      selected_payments AS (
        SELECT
          payment_allocations.amount,
          tenant_charges.charge_type AS income_type
        FROM payment_allocations
        INNER JOIN payments
          ON payments.id =
            payment_allocations.payment_id
        INNER JOIN tenant_charges
          ON tenant_charges.id =
            payment_allocations.tenant_charge_id
        WHERE payments.owner_id = $1
          AND payments.status = 'matched'

          AND (
            $2::BIGINT IS NULL
            OR payments.property_id = $2
          )

          AND (
            $3::DATE IS NULL
            OR (
              payments.received_at
              AT TIME ZONE 'Africa/Nairobi'
            )::DATE >= $3
          )

          AND (
            $4::DATE IS NULL
            OR (
              payments.received_at
              AT TIME ZONE 'Africa/Nairobi'
            )::DATE <= $4
          )

          AND (
            $5::BIGINT IS NULL
            OR EXISTS (
              SELECT 1
              FROM property_caretaker_assignments
              WHERE property_caretaker_assignments.property_id =
                payments.property_id
                AND property_caretaker_assignments.caretaker_id = $5
                AND property_caretaker_assignments.status = 'active'
            )
          )

        UNION ALL

        /*
          Deposit and credit money used for a tenant's bills
          at move-out becomes income on the day it was used.
        */
        SELECT
          deposit_applications.amount,
          tenant_charges.charge_type AS income_type
        FROM deposit_applications
        INNER JOIN deposit_settlements
          ON deposit_settlements.id =
            deposit_applications.settlement_id
        INNER JOIN tenant_charges
          ON tenant_charges.id =
            deposit_applications.tenant_charge_id
        WHERE deposit_settlements.owner_id = $1

          AND (
            $2::BIGINT IS NULL
            OR deposit_settlements.property_id = $2
          )

          AND (
            $3::DATE IS NULL
            OR (
              deposit_settlements.confirmed_at
              AT TIME ZONE 'Africa/Nairobi'
            )::DATE >= $3
          )

          AND (
            $4::DATE IS NULL
            OR (
              deposit_settlements.confirmed_at
              AT TIME ZONE 'Africa/Nairobi'
            )::DATE <= $4
          )

          AND (
            $5::BIGINT IS NULL
            OR EXISTS (
              SELECT 1
              FROM property_caretaker_assignments
              WHERE property_caretaker_assignments.property_id =
                deposit_settlements.property_id
                AND property_caretaker_assignments.caretaker_id = $5
                AND property_caretaker_assignments.status = 'active'
            )
          )
      )

      SELECT
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM selected_expenses
        ) AS total_expenses,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM selected_payments
          WHERE income_type = 'rent'
        ) AS rent_collected,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM selected_payments
          WHERE income_type = 'water'
        ) AS water_collected,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM selected_payments
          WHERE income_type = 'electricity'
        ) AS electricity_collected,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM selected_payments
          WHERE income_type = 'service'
        ) AS service_collected,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM selected_payments
          WHERE income_type IN ('repair', 'deduction')
        ) AS repairs_collected
    `,
    [
      owner_id,
      filters.property_id || null,
      filters.from_date || null,
      filters.to_date || null,
      user.role === "caretaker"
        ? user.user_id
        : null,
    ]
  );

  const summary = result.rows[0];

  const rent_collected = Number(
    summary.rent_collected
  );

  const water_collected = Number(
    summary.water_collected
  );

  const electricity_collected = Number(
    summary.electricity_collected
  );

  const service_collected = Number(
    summary.service_collected
  );

  /*
    Repairs charged to tenants and move-out deductions.
  */
  const repairs_collected = Number(
    summary.repairs_collected
  );

  const total_expenses = Number(
    summary.total_expenses
  );

  return {
    property_id: filters.property_id || null,
    from_date: filters.from_date || null,
    to_date: filters.to_date || null,

    rent_collected,
    water_collected,
    electricity_collected,
    service_collected,
    repairs_collected,
    total_expenses,

    net_profit:
      rent_collected +
      water_collected +
      electricity_collected +
      service_collected +
      repairs_collected -
      total_expenses,
  };
}

/*
  Owners usually pay running costs first and recover them from
  tenants. For each expense category this compares:

  spent     expenses recorded in the period
  charged   service charges, repairs and move-out deductions
            billed to tenants for the period
  paid      how much of that the tenants have paid so far

  A monthly charge belongs to its billing month. A one-off
  charge, a repair or a deduction belongs to the day it was
  billed.
*/
async function get_expense_reconciliation(
  user,
  filters
) {
  const owner_id = get_owner_id(user);

  const result = await db.query(
    `
      WITH spent AS (
        SELECT
          expenses.category,
          SUM(expenses.amount) AS spent
        FROM expenses
        WHERE expenses.owner_id = $1
          AND expenses.status = 'recorded'

          AND (
            $2::BIGINT IS NULL
            OR expenses.property_id = $2
          )

          AND (
            $3::DATE IS NULL
            OR expenses.expense_date >= $3
          )

          AND (
            $4::DATE IS NULL
            OR expenses.expense_date <= $4
          )

          AND (
            $5::BIGINT IS NULL
            OR EXISTS (
              SELECT 1
              FROM property_caretaker_assignments
              WHERE property_caretaker_assignments.property_id =
                expenses.property_id
                AND property_caretaker_assignments.caretaker_id = $5
                AND property_caretaker_assignments.status = 'active'
            )
          )

        GROUP BY expenses.category
      ),

      billed AS (
        SELECT
          CASE
            WHEN tenant_charges.charge_type = 'service'
              THEN COALESCE(
                service_charges.category,
                'other'
              )
            ELSE 'repairs_maintenance'
          END AS category,

          tenant_charges.amount_due,
          tenant_charges.amount_paid,

          CASE
            WHEN tenant_charges.billing_period =
              DATE '1970-01-01'
              THEN (
                tenant_charges.created_at
                AT TIME ZONE 'Africa/Nairobi'
              )::DATE
            ELSE tenant_charges.billing_period
          END AS billed_on

        FROM tenant_charges

        LEFT JOIN service_charges
          ON tenant_charges.charge_type = 'service'
          AND service_charges.id =
            tenant_charges.source_id

        WHERE tenant_charges.owner_id = $1
          AND tenant_charges.charge_type IN (
            'service',
            'repair',
            'deduction'
          )
          AND tenant_charges.status <> 'void'

          AND (
            $2::BIGINT IS NULL
            OR tenant_charges.property_id = $2
          )

          AND (
            $5::BIGINT IS NULL
            OR EXISTS (
              SELECT 1
              FROM property_caretaker_assignments
              WHERE property_caretaker_assignments.property_id =
                tenant_charges.property_id
                AND property_caretaker_assignments.caretaker_id = $5
                AND property_caretaker_assignments.status = 'active'
            )
          )
      ),

      charged AS (
        SELECT
          category,
          SUM(amount_due) AS charged,
          SUM(amount_paid) AS paid
        FROM billed
        WHERE (
            $3::DATE IS NULL
            OR billed_on >= $3
          )
          AND (
            $4::DATE IS NULL
            OR billed_on <= $4
          )
        GROUP BY category
      )

      SELECT
        COALESCE(spent.category, charged.category)
          AS category,
        COALESCE(spent.spent, 0) AS spent,
        COALESCE(charged.charged, 0) AS charged,
        COALESCE(charged.paid, 0) AS paid
      FROM spent
      FULL JOIN charged
        ON charged.category = spent.category
      ORDER BY 1
    `,
    [
      owner_id,
      filters.property_id || null,
      filters.from_date || null,
      filters.to_date || null,
      user.role === "caretaker"
        ? user.user_id
        : null,
    ]
  );

  const categories = result.rows.map((row) => {
    const spent = Number(row.spent);
    const charged = Number(row.charged);
    const paid = Number(row.paid);

    return {
      category: row.category,
      spent,
      charged,
      paid,

      /*
        Charged to tenants but not paid yet.
      */
      outstanding: charged - paid,

      /*
        What the owner carries: spent and not charged on.
        Negative when tenants were charged more than was spent.
      */
      owner_cost: spent - charged,
    };
  });

  const total = (field) =>
    categories.reduce(
      (sum, category) => sum + category[field],
      0
    );

  return {
    property_id: filters.property_id || null,
    from_date: filters.from_date || null,
    to_date: filters.to_date || null,

    categories,

    totals: {
      spent: total("spent"),
      charged: total("charged"),
      paid: total("paid"),
      outstanding: total("outstanding"),
      owner_cost: total("owner_cost"),
    },
  };
}

module.exports = {
  create_expense,
  list_expenses,
  get_expense_for_owner,
  void_expense,
  get_expense_summary,
  get_expense_reconciliation,
};