const db = require("../config/db");

const {
  normalize_phone,
} = require("../utils/phone");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  create_agreement_for_new_tenant,
} = require("../agreements/agreement_service");

const {
  create_move_in_charges,
  adjust_move_out_charges,
} = require("../billing/billing_service");

const {
  get_caretaker_property_access,
} = require("../caretakers/caretaker_access_service");

/*
  The owner account an action belongs to: the owner's own, or
  the owner a caretaker works for.
*/
function account_owner_id(user) {
  return user.role === "caretaker"
    ? Number(user.owner_id)
    : Number(user.user_id);
}

/*
  A caretaker must be assigned to the property: Level 1 to
  view its tenants, Level 2 to add or edit them. Owners pass.
*/
async function ensure_caretaker_access(
  client,
  user,
  property_id,
  required_level
) {
  if (user.role === "caretaker") {
    await get_caretaker_property_access(
      client,
      user,
      property_id,
      required_level
    );
  }
}

function public_tenant(tenant) {
  return {
    id: Number(tenant.id),

    owner_id: Number(tenant.owner_id),
    property_id: Number(tenant.property_id),
    unit_id: Number(tenant.unit_id),

    unit_number: tenant.unit_number || null,
    property_name: tenant.property_name || null,

    full_name: tenant.full_name,

    /*
      Frontend can use phone for normal display.
      payment_phone explicitly documents the matching identity.
    */
    phone: tenant.payment_phone,
    payment_phone: tenant.payment_phone,

    email: tenant.email,
    national_id: tenant.national_id,

    move_in_date: tenant.move_in_date,

    /*
      These are snapshots copied from the unit.
      They are not payment records or paid balances.
    */
    monthly_rent: Number(tenant.monthly_rent),
    rent_deposit_due: Number(tenant.rent_deposit_due),
    water_deposit_due: Number(
      tenant.water_deposit_due
    ),

    water_payment_reference:
      tenant.water_payment_reference,

    status: tenant.status,
    notice_date: tenant.notice_date,

    moved_out_at: tenant.moved_out_at,
    move_out_date: tenant.move_out_date,
    move_out_reason: tenant.move_out_reason,

    deposit_refund_decision:
      tenant.deposit_refund_decision,

    /*
      What the tenant owes now and any overpayment held as
      credit. Present on list and profile responses only.
    */
    balance:
      tenant.balance == null
        ? undefined
        : Number(tenant.balance),

    credit_balance:
      tenant.credit_balance == null
        ? undefined
        : Number(tenant.credit_balance),

    created_at: tenant.created_at,
    updated_at: tenant.updated_at,
  };
}

const tenant_overview_select = `
  SELECT
    tenants.*,
    units.unit_number,
    properties.name AS property_name,
    financials.balance,
    financials.credit_balance
  FROM tenants
  INNER JOIN units
    ON units.id = tenants.unit_id
  INNER JOIN properties
    ON properties.id = tenants.property_id
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(
        (
          SELECT SUM(
            tenant_charges.amount_due -
            tenant_charges.amount_paid
          )
          FROM tenant_charges
          WHERE tenant_charges.tenant_id = tenants.id
            AND tenant_charges.status IN (
              'open',
              'partial'
            )
        ),
        0
      ) AS balance,

      COALESCE(
        (
          SELECT SUM(
            tenant_credits.remaining_amount
          )
          FROM tenant_credits
          WHERE tenant_credits.tenant_id = tenants.id
            AND tenant_credits.remaining_amount > 0
        ),
        0
      ) AS credit_balance
  ) AS financials
`;

const tenant_overview_order = `
  ORDER BY
    CASE
      WHEN tenants.status = 'active' THEN 0
      WHEN tenants.status = 'notice_given' THEN 1
      ELSE 2
    END,
    properties.name ASC,
    units.unit_number ASC,
    tenants.created_at DESC
`;

function normalize_payment_phone(phone) {
  const normalized = normalize_phone(phone);

  if (!normalized) {
    const error = new Error(
      "Phone number must be a valid Kenyan mobile number."
    );

    error.status_code = 422;
    throw error;
  }

  return normalized;
}

function generate_water_reference(
  unit_number,
  full_name
) {
  const last_name = full_name
    .trim()
    .split(/\s+/)
    .at(-1)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 30);

  const clean_unit_number = String(unit_number)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 30);

  return `${clean_unit_number}-${last_name}`;
}

async function ensure_owner_owns_property(
  owner_id,
  property_id,
  client = db
) {
  const result = await client.query(
    `
      SELECT id, name
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status = 'active'
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

async function get_tenant_row_for_owner(
  owner_id,
  tenant_id,
  client = db
) {
  const result = await client.query(
    `
      SELECT
        tenants.*,
        units.unit_number
      FROM tenants
      INNER JOIN units
        ON units.id = tenants.unit_id
      WHERE tenants.id = $1
        AND tenants.owner_id = $2
    `,
    [tenant_id, owner_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Tenant not found or you do not have access to them."
    );

    error.status_code = 404;
    throw error;
  }

  return result.rows[0];
}

async function create_tenant(
  owner,
  property_id,
  data,
  ip_address
) {
  const owner_id = account_owner_id(owner);

  const payment_phone = normalize_payment_phone(
    data.phone
  );

  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    await ensure_caretaker_access(
      client,
      owner,
      property_id,
      "level_2"
    );

    await ensure_owner_owns_property(
      owner_id,
      property_id,
      client
    );

    /*
      Lock the unit so two simultaneous requests cannot
      add tenants to the same unit.
    */
    const unit_result = await client.query(
      `
        SELECT units.*
        FROM units
        INNER JOIN properties
          ON properties.id = units.property_id
        WHERE units.id = $1
          AND units.property_id = $2
          AND properties.owner_id = $3
        FOR UPDATE
      `,
      [
        data.unit_id,
        property_id,
        owner_id,
      ]
    );

    const unit = unit_result.rows[0];

    if (!unit) {
      const error = new Error(
        "Unit not found or it does not belong to this property."
      );

      error.status_code = 404;
      throw error;
    }

    if (!["vacant", "reserved"].includes(unit.status)) {
      const error = new Error(
        "A tenant can only be added to a vacant or reserved unit."
      );

      error.status_code = 400;
      throw error;
    }

    const water_payment_reference =
      generate_water_reference(
        unit.unit_number,
        data.full_name
      );

    const tenant_result = await client.query(
      `
        INSERT INTO tenants (
          owner_id,
          property_id,
          unit_id,

          full_name,
          payment_phone,
          email,
          national_id,
          move_in_date,

          monthly_rent,
          rent_deposit_due,
          water_deposit_due,

          water_payment_reference,
          status
        )
        VALUES (
          $1,$2,$3,
          $4,$5,$6,$7,$8,
          $9,$10,$11,
          $12,'active'
        )
        RETURNING *
      `,
      [
        owner_id,
        property_id,
        unit.id,

        data.full_name,
        payment_phone,
        data.email || null,
        data.national_id || null,
        data.move_in_date,

        /*
          Snapshot unit requirements during move-in.
        */
        unit.monthly_rent,
        unit.rent_deposit,
        unit.water_deposit,

        water_payment_reference,
      ]
    );

    const tenant = tenant_result.rows[0];

    /*
      Deposits are created by a database trigger. The first
      month's rent, electricity, and fixed water follow the
      property's move-in billing rule.
    */
    await create_move_in_charges(client, tenant.id);

    /*
      Occupancy changes immediately.
      Deposit payment is not required for occupancy.
    */
    await client.query(
  `
    UPDATE units
    SET status = 'occupied'
    WHERE id = $1
  `,
  [unit.id]
);

/*
  The agreement is created before COMMIT.
  If it cannot be generated, tenant creation is rolled back too.
*/
const agreement =
  await create_agreement_for_new_tenant(
    client,
    tenant.id
  );

await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "TENANT_MOVED_IN",
      entity_type: "tenant",
      entity_id: tenant.id,
      metadata: {
        property_id,
        unit_id: unit.id,
        unit_number: unit.unit_number,
        payment_phone: tenant.payment_phone,
        monthly_rent: tenant.monthly_rent,
        rent_deposit_due: tenant.rent_deposit_due,
        water_deposit_due: tenant.water_deposit_due,
      },
      ip_address,
    });

    return {
  ...public_tenant({
    ...tenant,
    unit_number: unit.unit_number,
  }),
  agreement,
};
  } catch (error) {
    await client.query("ROLLBACK");

    /*
      Clear duplicate-key messages become correct API responses.
    */
    if (error.code === "23505") {
      if (
        error.constraint ===
        "uq_active_payment_phone_per_property"
      ) {
        const duplicate_error = new Error(
          "This payment phone is already assigned to an active tenant in this property."
        );

        duplicate_error.status_code = 409;
        throw duplicate_error;
      }

      if (
        error.constraint ===
        "uq_active_water_reference_per_property"
      ) {
        const duplicate_error = new Error(
          "A tenant with this generated water reference already exists in this property."
        );

        duplicate_error.status_code = 409;
        throw duplicate_error;
      }

      const duplicate_error = new Error(
        "This unit already has an active tenant."
      );

      duplicate_error.status_code = 409;
      throw duplicate_error;
    }

    throw error;
  } finally {
    client.release();
  }
}

async function list_property_tenants(owner, property_id) {
  const owner_id = account_owner_id(owner);

  await ensure_caretaker_access(
    db,
    owner,
    property_id,
    "level_1"
  );

  await ensure_owner_owns_property(
    owner_id,
    property_id
  );

  const result = await db.query(
    `
      ${tenant_overview_select}
      WHERE tenants.owner_id = $1
        AND tenants.property_id = $2
      ${tenant_overview_order}
    `,
    [owner_id, property_id]
  );

  return result.rows.map(public_tenant);
}

/*
  Every tenant of the owner, across all properties, with
  what each one owes. Archived properties are left out.
*/
async function list_tenants(owner, filters) {
  const result = await db.query(
    `
      ${tenant_overview_select}
      WHERE tenants.owner_id = $1
        AND properties.status != 'archived'
        AND (
          $2::BIGINT IS NULL
          OR tenants.property_id = $2
        )
        AND (
          $3::VARCHAR IS NULL
          OR tenants.status = $3
        )
      ${tenant_overview_order}
    `,
    [
      owner.user_id,
      filters.property_id || null,
      filters.status || null,
    ]
  );

  return result.rows.map(public_tenant);
}

async function get_tenant_by_id(owner, tenant_id) {
  const owner_id = account_owner_id(owner);

  const result = await db.query(
    `
      ${tenant_overview_select}
      WHERE tenants.id = $1
        AND tenants.owner_id = $2
    `,
    [tenant_id, owner_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Tenant not found or you do not have access to them."
    );

    error.status_code = 404;
    throw error;
  }

  await ensure_caretaker_access(
    db,
    owner,
    result.rows[0].property_id,
    "level_1"
  );

  return public_tenant(result.rows[0]);
}

async function update_tenant(
  owner,
  tenant_id,
  data,
  ip_address
) {
  const owner_id = account_owner_id(owner);

  const existing = await get_tenant_row_for_owner(
    owner_id,
    tenant_id
  );

  await ensure_caretaker_access(
    db,
    owner,
    existing.property_id,
    "level_2"
  );

  if (
    !["active", "notice_given"].includes(
      existing.status
    )
  ) {
    const error = new Error(
      "Moved-out or inactive tenant records cannot be updated."
    );

    error.status_code = 400;
    throw error;
  }

  const payment_phone = data.phone
    ? normalize_payment_phone(data.phone)
    : existing.payment_phone;

  const result = await db.query(
    `
      UPDATE tenants
      SET
        full_name = COALESCE($1, full_name),
        payment_phone = $2,
        email = $3,
        national_id = $4,
        status = COALESCE($5, status),
        notice_date = $6
      WHERE id = $7
      RETURNING *
    `,
    [
      data.full_name ?? null,
      payment_phone,

      Object.prototype.hasOwnProperty.call(data, "email")
        ? data.email
        : existing.email,

      Object.prototype.hasOwnProperty.call(
        data,
        "national_id"
      )
        ? data.national_id
        : existing.national_id,

      data.status ?? null,

      Object.prototype.hasOwnProperty.call(
        data,
        "notice_date"
      )
        ? data.notice_date
        : existing.notice_date,

      tenant_id,
    ]
  );

  const tenant = result.rows[0];

  await log_audit({
    user_id: owner.user_id,
    action: "TENANT_UPDATED",
    entity_type: "tenant",
    entity_id: tenant.id,
    metadata: {
      updated_fields: Object.keys(data),
    },
    ip_address,
  });

  return public_tenant({
    ...tenant,
    unit_number: existing.unit_number,
  });
}

async function move_out_tenant(
  owner,
  tenant_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const tenant_result = await client.query(
      `
        SELECT
          tenants.*,
          units.unit_number
        FROM tenants
        INNER JOIN units
          ON units.id = tenants.unit_id
        WHERE tenants.id = $1
          AND tenants.owner_id = $2
        FOR UPDATE OF tenants, units
      `,
      [tenant_id, owner.user_id]
    );

    const tenant = tenant_result.rows[0];

    if (!tenant) {
      const error = new Error(
        "Tenant not found or you do not have access to them."
      );

      error.status_code = 404;
      throw error;
    }

    if (
      !["active", "notice_given"].includes(
        tenant.status
      )
    ) {
      const error = new Error(
        "Only an active tenant can be moved out."
      );

      error.status_code = 400;
      throw error;
    }

    const updated_tenant_result = await client.query(
      `
        UPDATE tenants
        SET
          status = 'moved_out',
          moved_out_at = CURRENT_TIMESTAMP,
          move_out_date = $1,
          move_out_reason = $2,
          deposit_refund_decision = $3
        WHERE id = $4
        RETURNING *
      `,
      [
        data.move_out_date,
        data.move_out_reason || null,
        data.deposit_refund_decision || null,
        tenant_id,
      ]
    );

    await client.query(
      `
        UPDATE units
        SET status = 'vacant'
        WHERE id = $1
      `,
      [tenant.unit_id]
    );

    /*
      Settles the final month according to the property's
      move-out billing rule and voids any later charges.
    */
    const charge_adjustments =
      await adjust_move_out_charges(
        client,
        tenant_id,
        data.move_out_date
      );

    /*
      Repairs that were kept for move-out are now due, so the
      deposit reconciliation can cover them and a tenant who
      still owes can pay them.
    */
    await client.query(
      `
        UPDATE tenant_charges
        SET status = 'open'
        WHERE tenant_id = $1
          AND status = 'held'
      `,
      [tenant_id]
    );

    await client.query("COMMIT");

    const updated_tenant =
      updated_tenant_result.rows[0];

    await log_audit({
      user_id: owner.user_id,
      action: "TENANT_MOVED_OUT",
      entity_type: "tenant",
      entity_id: updated_tenant.id,
      metadata: {
        property_id: updated_tenant.property_id,
        unit_id: updated_tenant.unit_id,
        unit_number: tenant.unit_number,
        move_out_date: data.move_out_date,
        deposit_refund_decision:
          data.deposit_refund_decision || null,
        charge_adjustments,
      },
      ip_address,
    });

    return public_tenant({
      ...updated_tenant,
      unit_number: tenant.unit_number,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  create_tenant,
  list_property_tenants,
  list_tenants,
  get_tenant_by_id,
  update_tenant,
  move_out_tenant,
};