const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  default_template_content,
  render_agreement_template,
} = require("./agreement_template_service");

function public_template(template) {
  if (!template) {
    return null;
  }

  return {
    id: Number(template.id),
    owner_id: Number(template.owner_id),
    property_id: template.property_id
      ? Number(template.property_id)
      : null,
    name: template.name,
    content: template.content,
    notice_period_days: Number(
      template.notice_period_days
    ),
    version: Number(template.version),
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

function public_agreement(agreement) {
  return {
    id: Number(agreement.id),
    owner_id: Number(agreement.owner_id),
    property_id: Number(agreement.property_id),
    unit_id: Number(agreement.unit_id),
    tenant_id: Number(agreement.tenant_id),

    tenant_name: agreement.tenant_name || null,
    property_name: agreement.property_name || null,
    unit_number: agreement.unit_number || null,

    template_id: agreement.template_id
      ? Number(agreement.template_id)
      : null,

    template_name: agreement.template_name,
    template_version: Number(
      agreement.template_version
    ),

    rendered_content: agreement.rendered_content,

    status: agreement.status,
    signed_at: agreement.signed_at,
    signed_notes: agreement.signed_notes,

    generated_at: agreement.generated_at,
    created_at: agreement.created_at,
    updated_at: agreement.updated_at,

    download_url: `/api/agreements/${agreement.id}/download`,
  };
}

async function ensure_owner_owns_property(
  client,
  owner_id,
  property_id
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

async function get_default_template(client, owner_id) {
  const result = await client.query(
    `
      SELECT *
      FROM agreement_templates
      WHERE owner_id = $1
        AND property_id IS NULL
      LIMIT 1
    `,
    [owner_id]
  );

  return result.rows[0] || null;
}

async function get_or_create_default_template(
  client,
  owner_id
) {
  const existing = await get_default_template(
    client,
    owner_id
  );

  if (existing) {
    return existing;
  }

  await client.query(
    `
      INSERT INTO agreement_templates (
        owner_id,
        property_id,
        name,
        content,
        notice_period_days
      )
      VALUES (
        $1,
        NULL,
        'Default tenancy agreement',
        $2,
        30
      )
      ON CONFLICT DO NOTHING
    `,
    [
      owner_id,
      default_template_content,
    ]
  );

  return get_default_template(client, owner_id);
}

async function get_property_template(
  client,
  owner_id,
  property_id
) {
  const result = await client.query(
    `
      SELECT *
      FROM agreement_templates
      WHERE owner_id = $1
        AND property_id = $2
      LIMIT 1
    `,
    [owner_id, property_id]
  );

  return result.rows[0] || null;
}

async function get_effective_template(
  client,
  owner_id,
  property_id
) {
  const property_template =
    await get_property_template(
      client,
      owner_id,
      property_id
    );

  if (property_template) {
    return property_template;
  }

  return get_or_create_default_template(
    client,
    owner_id
  );
}

async function save_template(
  owner,
  property_id,
  data,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    if (property_id) {
      await ensure_owner_owns_property(
        client,
        owner.user_id,
        property_id
      );
    }

    const existing = property_id
      ? await get_property_template(
        client,
        owner.user_id,
        property_id
      )
      : await get_default_template(
        client,
        owner.user_id
      );

    const name =
      data.name ||
      existing?.name ||
      (property_id
        ? "Property tenancy agreement"
        : "Default tenancy agreement");

    let result;

    if (property_id) {
      result = await client.query(
        `
          INSERT INTO agreement_templates (
            owner_id,
            property_id,
            name,
            content,
            notice_period_days
          )
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (owner_id, property_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            content = EXCLUDED.content,
            notice_period_days =
              EXCLUDED.notice_period_days,
            version =
              agreement_templates.version + 1
          RETURNING *
        `,
        [
          owner.user_id,
          property_id,
          name,
          data.content,
          data.notice_period_days,
        ]
      );
    } else {
      result = await client.query(
        `
          INSERT INTO agreement_templates (
            owner_id,
            property_id,
            name,
            content,
            notice_period_days
          )
          VALUES ($1,NULL,$2,$3,$4)
          ON CONFLICT (owner_id)
            WHERE property_id IS NULL
          DO UPDATE SET
            name = EXCLUDED.name,
            content = EXCLUDED.content,
            notice_period_days =
              EXCLUDED.notice_period_days,
            version =
              agreement_templates.version + 1
          RETURNING *
        `,
        [
          owner.user_id,
          name,
          data.content,
          data.notice_period_days,
        ]
      );
    }

    await client.query("COMMIT");

    const template = result.rows[0];

    await log_audit({
      user_id: owner.user_id,
      action: property_id
        ? "PROPERTY_AGREEMENT_TEMPLATE_SAVED"
        : "DEFAULT_AGREEMENT_TEMPLATE_SAVED",
      entity_type: "agreement_template",
      entity_id: template.id,
      metadata: {
        property_id: property_id || null,
        version: template.version,
      },
      ip_address,
    });

    return public_template(template);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_default_template_for_owner(owner) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const template =
      await get_or_create_default_template(
        client,
        owner.user_id
      );

    await client.query("COMMIT");

    return public_template(template);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get_templates_for_property(
  owner,
  property_id
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    await ensure_owner_owns_property(
      client,
      owner.user_id,
      property_id
    );

    const property_template =
      await get_property_template(
        client,
        owner.user_id,
        property_id
      );

    const default_template =
      await get_or_create_default_template(
        client,
        owner.user_id
      );

    await client.query("COMMIT");

    return {
      property_template:
        public_template(property_template),

      effective_template: public_template(
        property_template || default_template
      ),

      using_default: !property_template,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function delete_property_template(
  owner,
  property_id,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    await ensure_owner_owns_property(
      client,
      owner.user_id,
      property_id
    );

    const result = await client.query(
      `
        DELETE FROM agreement_templates
        WHERE owner_id = $1
          AND property_id = $2
        RETURNING id
      `,
      [owner.user_id, property_id]
    );

    if (!result.rows[0]) {
      const error = new Error(
        "This property does not have an agreement-template override."
      );

      error.status_code = 404;
      throw error;
    }

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "PROPERTY_AGREEMENT_TEMPLATE_DELETED",
      entity_type: "agreement_template",
      entity_id: result.rows[0].id,
      metadata: { property_id },
      ip_address,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function create_agreement_for_new_tenant(
  client,
  tenant_id
) {
  const tenant_result = await client.query(
    `
      SELECT
        tenants.*,
        units.unit_number,
        properties.name AS property_name,
        properties.rent_due_day,
        users.first_name AS owner_first_name,
        users.last_name AS owner_last_name,
        users.phone AS owner_phone
      FROM tenants
      INNER JOIN units
        ON units.id = tenants.unit_id
      INNER JOIN properties
        ON properties.id = tenants.property_id
      INNER JOIN users
        ON users.user_id = tenants.owner_id
      WHERE tenants.id = $1
      FOR UPDATE OF tenants
    `,
    [tenant_id]
  );

  const tenant = tenant_result.rows[0];

  if (!tenant) {
    const error = new Error(
      "Tenant not found while generating agreement."
    );

    error.status_code = 404;
    throw error;
  }

  const existing_result = await client.query(
    `
      SELECT id
      FROM agreements
      WHERE tenant_id = $1
      LIMIT 1
    `,
    [tenant.id]
  );

  if (existing_result.rows[0]) {
    const error = new Error(
      "This tenant already has an agreement."
    );

    error.status_code = 409;
    throw error;
  }

  const template = await get_effective_template(
    client,
    tenant.owner_id,
    tenant.property_id
  );

  const rendered_content = render_agreement_template({
    content: template.content,
    tenant: {
      full_name: tenant.full_name,
      unit_number: tenant.unit_number,
      monthly_rent: tenant.monthly_rent,
      rent_deposit_due: tenant.rent_deposit_due,
      move_in_date: tenant.move_in_date,
    },
    property: {
      name: tenant.property_name,
      rent_due_day: tenant.rent_due_day,
    },
    owner: {
      first_name: tenant.owner_first_name,
      last_name: tenant.owner_last_name,
      phone: tenant.owner_phone,
    },
    notice_period_days:
      template.notice_period_days,
  });

  const agreement_result = await client.query(
    `
      INSERT INTO agreements (
        owner_id,
        property_id,
        unit_id,
        tenant_id,
        template_id,
        template_name,
        template_version,
        template_content,
        rendered_content,
        status
      )
      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,
        'awaiting_signature'
      )
      RETURNING *
    `,
    [
      tenant.owner_id,
      tenant.property_id,
      tenant.unit_id,
      tenant.id,
      template.id,
      template.name,
      template.version,
      template.content,
      rendered_content,
    ]
  );

  return public_agreement({
    ...agreement_result.rows[0],
    tenant_name: tenant.full_name,
    property_name: tenant.property_name,
    unit_number: tenant.unit_number,
  });
}

async function generate_agreement_for_existing_tenant(
  owner,
  tenant_id,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const tenant_result = await client.query(
      `
        SELECT id
        FROM tenants
        WHERE id = $1
          AND owner_id = $2
        FOR UPDATE
      `,
      [tenant_id, owner.user_id]
    );

    if (!tenant_result.rows[0]) {
      const error = new Error(
        "Tenant not found or you do not have access to them."
      );

      error.status_code = 404;
      throw error;
    }

    const agreement =
      await create_agreement_for_new_tenant(
        client,
        tenant_id
      );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "TENANT_AGREEMENT_GENERATED",
      entity_type: "agreement",
      entity_id: agreement.id,
      metadata: {
        tenant_id,
        property_id: agreement.property_id,
        template_id: agreement.template_id,
      },
      ip_address,
    });

    return agreement;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function list_agreements(owner, filters) {
  const result = await db.query(
    `
      SELECT
        agreements.*,
        tenants.full_name AS tenant_name,
        properties.name AS property_name,
        units.unit_number
      FROM agreements
      INNER JOIN tenants
        ON tenants.id = agreements.tenant_id
      INNER JOIN properties
        ON properties.id = agreements.property_id
      INNER JOIN units
        ON units.id = agreements.unit_id
      WHERE agreements.owner_id = $1
        AND (
          $2::BIGINT IS NULL
          OR agreements.property_id = $2
        )
        AND (
          $3::VARCHAR IS NULL
          OR agreements.status = $3
        )
      ORDER BY agreements.generated_at DESC
    `,
    [
      owner.user_id,
      filters.property_id || null,
      filters.status || null,
    ]
  );

  return result.rows.map(public_agreement);
}

async function get_agreement_by_id(
  owner,
  agreement_id
) {
  const result = await db.query(
    `
      SELECT
        agreements.*,
        tenants.full_name AS tenant_name,
        properties.name AS property_name,
        units.unit_number
      FROM agreements
      INNER JOIN tenants
        ON tenants.id = agreements.tenant_id
      INNER JOIN properties
        ON properties.id = agreements.property_id
      INNER JOIN units
        ON units.id = agreements.unit_id
      WHERE agreements.id = $1
        AND agreements.owner_id = $2
      LIMIT 1
    `,
    [agreement_id, owner.user_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "Agreement not found or you do not have access to it."
    );

    error.status_code = 404;
    throw error;
  }

  return public_agreement(result.rows[0]);
}

async function get_tenant_agreement(
  owner,
  tenant_id
) {
  const result = await db.query(
    `
      SELECT
        agreements.*,
        tenants.full_name AS tenant_name,
        properties.name AS property_name,
        units.unit_number
      FROM agreements
      INNER JOIN tenants
        ON tenants.id = agreements.tenant_id
      INNER JOIN properties
        ON properties.id = agreements.property_id
      INNER JOIN units
        ON units.id = agreements.unit_id
      WHERE agreements.tenant_id = $1
        AND agreements.owner_id = $2
      LIMIT 1
    `,
    [tenant_id, owner.user_id]
  );

  if (!result.rows[0]) {
    const error = new Error(
      "This tenant does not have an agreement yet."
    );

    error.status_code = 404;
    throw error;
  }

  return public_agreement(result.rows[0]);
}

async function mark_agreement_signed(
  owner,
  agreement_id,
  data,
  ip_address
) {
  const existing = await get_agreement_by_id(
    owner,
    agreement_id
  );

  const result = await db.query(
    `
      UPDATE agreements
      SET
        status = 'signed',
        signed_at = COALESCE(
          $1,
          CURRENT_DATE
        ),
        signed_notes = $2
      WHERE id = $3
        AND owner_id = $4
      RETURNING *
    `,
    [
      data.signed_at || null,
      Object.prototype.hasOwnProperty.call(
        data,
        "signed_notes"
      )
        ? data.signed_notes
        : existing.signed_notes,
      agreement_id,
      owner.user_id,
    ]
  );

  const agreement = result.rows[0];

  await log_audit({
    user_id: owner.user_id,
    action: "TENANT_AGREEMENT_MARKED_SIGNED",
    entity_type: "agreement",
    entity_id: agreement.id,
    metadata: {
      tenant_id: agreement.tenant_id,
      signed_at: agreement.signed_at,
    },
    ip_address,
  });

  return get_agreement_by_id(owner, agreement.id);
}

module.exports = {
  create_agreement_for_new_tenant,
  generate_agreement_for_existing_tenant,

  get_default_template_for_owner,
  get_templates_for_property,
  save_template,
  delete_property_template,

  list_agreements,
  get_agreement_by_id,
  get_tenant_agreement,
  mark_agreement_signed,
};