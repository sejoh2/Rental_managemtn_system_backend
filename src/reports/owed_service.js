/*
  What tenants owe, in one place, so the dashboard, Reports and
  every list say the same (the owner's rule, 2026-10-29):

  - Owed: every unpaid bill (open or partly paid), deposits
    included, whether due yet or not. A repair held for move-out
    is not owed yet.
  - Overdue: the part of it past its due date (before today,
    Kenyan time).

  Current tenants (living there, or on notice) and former tenants
  (moved out) are kept apart. Archived properties are left out.
*/

const OVERDUE_SQL = `
  tenant_charges.due_date <
    (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::DATE
`;

const CURRENT_SQL = `tenants.status IN ('active', 'notice_given')`;

const UNPAID_SQL = `(tenant_charges.amount_due - tenant_charges.amount_paid)`;

function amount(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function get_owed_summary(client, owner_id, property_id = null) {
  const result = await client.query(
    `
      SELECT
        COALESCE(SUM(${UNPAID_SQL}) FILTER (WHERE ${CURRENT_SQL}), 0)
          AS owed,
        COALESCE(
          SUM(${UNPAID_SQL}) FILTER (WHERE ${CURRENT_SQL} AND ${OVERDUE_SQL}),
          0
        ) AS overdue,
        COUNT(DISTINCT tenant_charges.tenant_id)
          FILTER (WHERE ${CURRENT_SQL}) AS tenants_owing,
        COUNT(DISTINCT tenant_charges.tenant_id)
          FILTER (WHERE ${CURRENT_SQL} AND ${OVERDUE_SQL}) AS tenants_overdue,

        COALESCE(SUM(${UNPAID_SQL}) FILTER (WHERE NOT ${CURRENT_SQL}), 0)
          AS former_owed,
        COUNT(DISTINCT tenant_charges.tenant_id)
          FILTER (WHERE NOT ${CURRENT_SQL}) AS former_tenants_owing

      FROM tenant_charges

      INNER JOIN tenants
        ON tenants.id = tenant_charges.tenant_id

      INNER JOIN properties
        ON properties.id = tenant_charges.property_id

      WHERE tenant_charges.owner_id = $1
        AND tenant_charges.status IN ('open', 'partial')
        AND properties.status <> 'archived'
        AND ($2::TEXT IS NULL OR tenant_charges.property_id = $2)
    `,
    [owner_id, property_id || null]
  );

  const row = result.rows[0];

  return {
    owed: amount(row.owed),
    overdue: amount(row.overdue),
    tenants_owing: Number(row.tenants_owing),
    tenants_overdue: Number(row.tenants_overdue),
    former_owed: amount(row.former_owed),
    former_tenants_owing: Number(row.former_tenants_owing),
  };
}

module.exports = {
  OVERDUE_SQL,
  get_owed_summary,
};
