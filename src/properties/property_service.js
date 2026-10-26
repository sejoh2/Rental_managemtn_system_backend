const db = require("../config/db");

const {
  encrypt_json,
  decrypt_json,
} = require("../utils/crypto");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  sync_property_sender,
} = require("../sms/sender_approval_service");

const {
  get_access_token,
  register_c2b_urls,
} = require("../payments/mpesa/daraja_c2b_client");

const {
  new_callback_token,
  seal_callback_token,
  mask_callback_url,
  callback_token_matches,
} = require("../payments/mpesa/c2b_callback_security");

function public_account(account) {
  return {
    id: account.id,
    account_for: account.account_for,
    provider_code: account.provider_code,
    account_type: account.account_type,
    display_name: account.display_name,
    account_name: account.account_name,
    label: account.label,
    business_number: account.business_number,
    environment: account.environment,
    connection_status: account.connection_status,
    connection_error: account.connection_error,
    callback_registered_at:
      account.callback_registered_at,
    // Payment notices come to an address with this account's secret (never the secret itself).
    notice_address_secured: Boolean(
      account.c2b_callback_token_encrypted
    ),
  };
}

function public_property(
  property,
  accounts,
  overview = {}
) {
  return {
    id: property.id,
    owner_id: property.owner_id,

    name: property.name,
    location: property.location,
    property_type: property.property_type,
    expected_units: Number(property.expected_units),
    rent_due_day: Number(property.rent_due_day),
    move_in_billing: property.move_in_billing,
    move_out_billing: property.move_out_billing,

    water_billing_method: property.water_billing_method,
    water_rate_per_unit: Number(
      property.water_rate_per_unit
    ),
    water_fixed_fee: Number(property.water_fixed_fee),
    water_billing_day: property.water_billing_day,
    water_reading_due_days: Number(
      property.water_reading_due_days
    ),
    water_missed_reading_action:
      property.water_missed_reading_action,

    sms_sender_id: property.sms_sender_id,

    /*
      'pending', 'approved' or 'rejected' for the owner's own
      sender ID; null when the property uses the default. Only
      an approved sender ID is used for sending.
    */
    sms_sender_status: property.sms_sender_id
      ? property.sms_sender_status || "pending"
      : null,

    status: property.status,

    rent_account:
      accounts.find(
        (account) => account.account_for === "rent"
      ) || null,

    water_account:
      accounts.find(
        (account) => account.account_for === "water"
      ) || null,

    electricity_account:
      accounts.find(
        (account) =>
          account.account_for === "electricity"
      ) || null,

    service_account:
      accounts.find(
        (account) => account.account_for === "service"
      ) || null,

    /*
      The account tenants pay service charges and repairs into.
    */
    service_charge_account:
      property.service_charge_account,

    /*
      Lets the Properties page render its cards and details
      panel without extra requests per property.
    */
    summary: {
      total_units: Number(overview.total_units || 0),
      occupied_units: Number(
        overview.occupied_units || 0
      ),
      rent_collected_this_month: Number(
        overview.rent_collected_this_month || 0
      ),
    },

    caretaker: overview.caretaker_id
      ? {
        caretaker_id: overview.caretaker_id,

        full_name: [
          overview.caretaker_first_name,
          overview.caretaker_last_name,
        ]
          .filter(Boolean)
          .join(" "),

        phone: overview.caretaker_phone,

        permission_level:
          overview.caretaker_permission_level,

        // What the owner lets the caretaker do here, one switch each.
        permissions: overview.caretaker_permissions,
      }
      : null,

    created_at: property.created_at,
    updated_at: property.updated_at,
  };
}

function duplicate_name_error(error) {
  if (
    error.code === "23505" &&
    error.constraint === "properties_owner_id_name_key"
  ) {
    const friendly_error = new Error(
      "You already have a property with this name."
    );

    friendly_error.status_code = 409;
    return friendly_error;
  }

  return error;
}

/*
  The addresses Safaricom sends one account's payment notices to,
  with that account's secret (c2b_callback_security.js).
*/
function get_callback_urls(callback_token) {
  const public_api_url = String(
    process.env.PUBLIC_API_URL || ""
  ).replace(/\/$/, "");

  if (!public_api_url.startsWith("https://")) {
    throw new Error(
      "PUBLIC_API_URL must be a public HTTPS URL before registering M-Pesa C2B callback URLs."
    );
  }

  return {
    validation_url:
      `${public_api_url}/api/properties/c2b/validation/${callback_token}`,

    confirmation_url:
      `${public_api_url}/api/properties/c2b/confirmation/${callback_token}`,
  };
}

/*
  except_account_id lets a property keep its own business
  number when its payment account is being reconnected.
*/
async function ensure_business_number_available(
  business_number,
  except_account_id = null
) {
  const result = await db.query(
    `
      SELECT id
      FROM payment_accounts
      WHERE business_number = $1
        AND status = 'active'
        AND (
          $2::record_id IS NULL
          OR id <> $2
        )
      LIMIT 1
    `,
    [business_number, except_account_id]
  );

  if (result.rows.length) {
    const error = new Error(
      `M-Pesa business number ${business_number} is already assigned to another active property.`
    );

    error.status_code = 409;
    throw error;
  }
}

async function get_property_payment_account(
  client,
  owner_id,
  property_id,
  account_for,
  lock = false
) {
  const property_result = await client.query(
    `
      SELECT id, name
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status != 'archived'
    `,
    [property_id, owner_id]
  );

  if (!property_result.rows[0]) {
    const error = new Error("Property not found.");
    error.status_code = 404;
    throw error;
  }

  const account_result = await client.query(
    `
      SELECT *
      FROM payment_accounts
      WHERE property_id = $1
        AND account_for = $2
      ${lock ? "FOR UPDATE" : ""}
    `,
    [property_id, account_for]
  );

  return {
    property: property_result.rows[0],
    account: account_result.rows[0] || null,
  };
}

/*
  property_id is supplied only when an existing property is
  changing one of its payment accounts.
*/
async function validate_payment_account_connection(
  owner,
  account_for,
  account,
  ip_address,
  property_id = null
) {
  let current_account_id = null;

  if (property_id) {
    const current = await get_property_payment_account(
      db,
      owner.user_id,
      property_id,
      account_for
    );

    current_account_id = current.account?.id || null;
  }

  await ensure_business_number_available(
    account.business_number,
    current_account_id
  );

  /*
    This is what the frontend's Connect button calls.
    It validates the M-Pesa Consumer Key and Consumer Secret.
  */
  await get_access_token({
    consumer_key: account.credentials.consumer_key,
    consumer_secret: account.credentials.consumer_secret,
    environment: account.environment,
  });

  const expires_minutes =
    Number(
      process.env.PROPERTY_CONNECTION_EXPIRES_MINUTES
    ) || 10;

  const connection_result = await db.query(
    `
      INSERT INTO property_connection_checks (
        owner_id,
        account_for,
        provider_code,
        account_type,
        business_number,
        display_name,
        account_name,
        environment,
        encrypted_credentials,
        expires_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        CURRENT_TIMESTAMP + ($10 || ' minutes')::INTERVAL
      )
      RETURNING id
    `,
    [
      owner.user_id,
      account_for,
      account.provider_code,
      account.account_type,
      account.business_number,
      account.display_name || null,
      account.account_name || null,
      account.environment,
      encrypt_json(account.credentials),
      expires_minutes,
    ]
  );

  const connection_id = connection_result.rows[0].id;

  await log_audit({
    user_id: owner.user_id,
    action: "PROPERTY_PAYMENT_ACCOUNT_VALIDATED",
    entity_type: "property_connection_check",
    metadata: {
      account_for,
      business_number: account.business_number,
      account_type: account.account_type,
      environment: account.environment,
    },
    ip_address,
  });

  return {
    connection_id,
    account_for,
    business_number: account.business_number,
    connection_status: "validated",
    expires_in_seconds: expires_minutes * 60,
  };
}

async function get_connection_check(
  client,
  owner_id,
  connection_id,
  account_for
) {
  const result = await client.query(
    `
      SELECT *
      FROM property_connection_checks
      WHERE id = $1
        AND owner_id = $2
        AND account_for = $3
        AND status = 'validated'
        AND expires_at > CURRENT_TIMESTAMP
      FOR UPDATE
    `,
    [
      connection_id,
      owner_id,
      account_for,
    ]
  );

  const connection = result.rows[0];

  if (!connection) {
    const error = new Error(
      `${account_for} M-Pesa connection is missing, expired, or already used. Click Connect again.`
    );

    error.status_code = 400;
    throw error;
  }

  return connection;
}

async function create_payment_account(
  client,
  owner_id,
  property_id,
  account_for,
  connection,
  callback_token
) {
  const label = {
    rent: "Rent M-Pesa account",
    water: "Water M-Pesa account",
    electricity: "Electricity M-Pesa account",
    service: "Service charges M-Pesa account",
  }[account_for];

  const result = await client.query(
    `
      INSERT INTO payment_accounts (
        owner_id,
        property_id,
        account_for,
        provider_code,
        account_type,
        display_name,
        account_name,
        label,
        business_number,
        connection_status,
        callback_registered_at,
        last_connection_test_at,
        c2b_callback_token_encrypted
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        'connected',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        $10
      )
      RETURNING id
    `,
    [
      owner_id,
      property_id,
      account_for,
      connection.provider_code,
      connection.account_type,
      connection.display_name,
      connection.account_name,
      label,
      connection.business_number,
      seal_callback_token(callback_token),
    ]
  );

  await client.query(
    `
      INSERT INTO provider_credentials (
        payment_account_id,
        provider_code,
        environment,
        encrypted_credentials,
        connection_status,
        last_connected_at
      )
      VALUES ($1,$2,$3,$4,'connected',CURRENT_TIMESTAMP)
    `,
    [
      result.rows[0].id,
      connection.provider_code,
      connection.environment,
      connection.encrypted_credentials,
    ]
  );
}

async function create_property(owner, data, ip_address) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    /*
      Rent is required. Water and electricity accounts are
      optional; without one, those charges are paid through
      the rent account.
    */
    const connections = [];

    for (const [account_for, connection_id] of [
      ["rent", data.rent_connection_id],
      ["water", data.water_connection_id],
      ["electricity", data.electricity_connection_id],
      ["service", data.service_connection_id],
    ]) {
      if (!connection_id) {
        continue;
      }

      connections.push({
        account_for,
        connection_id,
        connection: await get_connection_check(
          client,
          owner.user_id,
          connection_id,
          account_for
        ),
      });
    }

    const business_numbers = connections.map(
      (item) => item.connection.business_number
    );

    if (
      new Set(business_numbers).size !==
      business_numbers.length
    ) {
      const error = new Error(
        "Each payment account must use a different M-Pesa business number."
      );

      error.status_code = 422;
      throw error;
    }

    for (const business_number of business_numbers) {
      await ensure_business_number_available(
        business_number
      );
    }

    /*
      Daraja registration occurs only now, once every Connect
      check succeeded and the property is actually being created.
      Each account gets its own secret notice address.
    */
    for (const item of connections) {
      const { connection } = item;

      item.callback_token = new_callback_token();

      const { validation_url, confirmation_url } =
        get_callback_urls(item.callback_token);

      const credentials = decrypt_json(
        connection.encrypted_credentials
      );

      await register_c2b_urls({
        consumer_key: credentials.consumer_key,
        consumer_secret: credentials.consumer_secret,
        business_number: connection.business_number,
        environment: connection.environment,
        validation_url,
        confirmation_url,
      });
    }

    const property_result = await client.query(
      `
        INSERT INTO properties (
          owner_id,
          created_by,
          name,
          location,
          property_type,
          expected_units,
          rent_due_day,
          move_in_billing,
          move_out_billing,
          water_billing_method,
          water_rate_per_unit,
          water_fixed_fee,
          water_billing_day,
          water_reading_due_days,
          water_missed_reading_action,
          sms_sender_id,
          service_charge_account
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17
        )
        RETURNING id
      `,
      [
        owner.user_id,
        owner.user_id,
        data.name,
        data.location,
        data.property_type,
        data.expected_units,
        data.rent_due_day,
        data.move_in_billing,
        data.move_out_billing,
        data.water_billing_method,
        data.water_rate_per_unit,
        data.water_fixed_fee,
        data.water_billing_day,
        data.water_reading_due_days,
        data.water_missed_reading_action,
        data.sms_sender_id || null,
        data.service_charge_account,
      ]
    );

    const property_id = property_result.rows[0].id;

    for (const item of connections) {
      await create_payment_account(
        client,
        owner.user_id,
        property_id,
        item.account_for,
        item.connection,
        item.callback_token
      );
    }

    await client.query(
      `
        UPDATE property_connection_checks
        SET
          status = 'used',
          used_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1)
      `,
      [
        connections.map(
          (item) => item.connection_id
        ),
      ]
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "PROPERTY_CREATED",
      entity_type: "property",
      entity_id: property_id,
      metadata: {
        property_name: data.name,
        payment_accounts: connections.map((item) => ({
          account_for: item.account_for,
          business_number:
            item.connection.business_number,
        })),
      },
      ip_address,
    });

    await sync_property_sender(
      owner.user_id,
      property_id,
      ip_address
    );

    return get_property_by_id(owner, property_id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw duplicate_name_error(error);
  } finally {
    client.release();
  }
}

/*
  Edits the descriptive property details only.
  Water rules, payment accounts, and the caretaker keep
  their own dedicated endpoints.
*/
async function update_property(
  owner,
  property_id,
  data,
  ip_address
) {
  const editable_fields = [
    "name",
    "location",
    "property_type",
    "expected_units",
    "rent_due_day",
    "move_in_billing",
    "move_out_billing",
    "sms_sender_id",
    "service_charge_account",
  ];

  const updated_fields = editable_fields.filter(
    (field) => data[field] !== undefined
  );

  /*
    Service charges can only be paid into an account the
    property actually has.
  */
  if (
    data.service_charge_account &&
    data.service_charge_account !== "rent"
  ) {
    const { account } = await get_property_payment_account(
      db,
      owner.user_id,
      property_id,
      data.service_charge_account
    );

    if (!account || account.status !== "active") {
      const error = new Error(
        "Connect that account first, or have service charges paid into the rent account."
      );

      error.status_code = 422;
      throw error;
    }
  }

  const assignments = updated_fields.map(
    (field, index) => `${field} = $${index + 1}`
  );

  const values = updated_fields.map((field) =>
    field === "sms_sender_id"
      ? data[field] || null
      : data[field]
  );

  let result;

  try {
    result = await db.query(
      `
        UPDATE properties
        SET ${assignments.join(", ")}
        WHERE id = $${values.length + 1}
          AND owner_id = $${values.length + 2}
          AND status != 'archived'
        RETURNING id
      `,
      [...values, property_id, owner.user_id]
    );
  } catch (error) {
    throw duplicate_name_error(error);
  }

  if (!result.rows[0]) {
    const error = new Error("Property not found.");
    error.status_code = 404;
    throw error;
  }

  await log_audit({
    user_id: owner.user_id,
    action: "PROPERTY_UPDATED",
    entity_type: "property",
    entity_id: property_id,
    metadata: { updated_fields },
    ip_address,
  });

  if (updated_fields.includes("sms_sender_id")) {
    await sync_property_sender(
      owner.user_id,
      property_id,
      ip_address
    );
  }

  return get_property_by_id(owner, property_id);
}

/*
  Switches a property's rent or water account to a newly
  validated M-Pesa connection.

  The existing payment_accounts row is updated in place so
  earlier payments keep pointing at their account.
*/
async function replace_payment_account(
  owner,
  property_id,
  account_for,
  connection_id,
  ip_address
) {
  const client = await db.get_client();

  try {
    await client.query("BEGIN");

    const { account } = await get_property_payment_account(
      client,
      owner.user_id,
      property_id,
      account_for,
      true
    );

    const connection = await get_connection_check(
      client,
      owner.user_id,
      connection_id,
      account_for
    );

    await ensure_business_number_available(
      connection.business_number,
      account?.id || null
    );

    const callback_token = new_callback_token();

    const { validation_url, confirmation_url } =
      get_callback_urls(callback_token);

    const credentials = decrypt_json(
      connection.encrypted_credentials
    );

    try {
      await register_c2b_urls({
        consumer_key: credentials.consumer_key,
        consumer_secret: credentials.consumer_secret,
        business_number: connection.business_number,
        environment: connection.environment,
        validation_url,
        confirmation_url,
      });
    } catch (error) {
      const daraja_message = String(
        error.response?.data?.errorMessage ||
          error.response?.data?.ResponseDescription ||
          error.message ||
          "Daraja did not accept the C2B URL registration request."
      );

      const public_error = new Error(
        `Daraja C2B URL registration failed: ${daraja_message}`
      );

      public_error.status_code = 502;
      throw public_error;
    }

    if (account) {
      await client.query(
        `
          UPDATE payment_accounts
          SET
            provider_code = $1,
            account_type = $2,
            display_name = $3,
            account_name = $4,
            business_number = $5,
            connection_status = 'connected',
            connection_error = NULL,
            callback_registered_at = CURRENT_TIMESTAMP,
            last_connection_test_at = CURRENT_TIMESTAMP,
            status = 'active',
            c2b_callback_token_encrypted = $7
          WHERE id = $6
        `,
        [
          connection.provider_code,
          connection.account_type,
          connection.display_name,
          connection.account_name,
          connection.business_number,
          account.id,
          seal_callback_token(callback_token),
        ]
      );

      await client.query(
        `
          INSERT INTO provider_credentials (
            payment_account_id,
            provider_code,
            environment,
            encrypted_credentials,
            connection_status,
            last_connected_at
          )
          VALUES ($1,$2,$3,$4,'connected',CURRENT_TIMESTAMP)
          ON CONFLICT (payment_account_id)
          DO UPDATE SET
            provider_code = EXCLUDED.provider_code,
            environment = EXCLUDED.environment,
            encrypted_credentials =
              EXCLUDED.encrypted_credentials,
            connection_status = 'connected',
            last_connected_at = CURRENT_TIMESTAMP
        `,
        [
          account.id,
          connection.provider_code,
          connection.environment,
          connection.encrypted_credentials,
        ]
      );
    } else {
      await create_payment_account(
        client,
        owner.user_id,
        property_id,
        account_for,
        connection,
        callback_token
      );
    }

    await client.query(
      `
        UPDATE property_connection_checks
        SET
          status = 'used',
          used_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [connection_id]
    );

    await client.query("COMMIT");

    await log_audit({
      user_id: owner.user_id,
      action: "PROPERTY_PAYMENT_ACCOUNT_CHANGED",
      entity_type: "property",
      entity_id: property_id,
      metadata: {
        account_for,
        previous_business_number:
          account?.business_number || null,
        business_number: connection.business_number,
        account_type: connection.account_type,
        environment: connection.environment,
      },
      ip_address,
    });

    return get_property_by_id(owner, property_id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
  Removes a property's optional water, electricity or service
  charge account. Those charges are then paid through the
  rent account.

  The row is kept and marked inactive so earlier payments keep
  pointing at it, and its business number becomes free again.
*/
async function remove_payment_account(
  owner,
  property_id,
  account_for,
  ip_address
) {
  const { account } = await get_property_payment_account(
    db,
    owner.user_id,
    property_id,
    account_for
  );

  if (!account || account.status !== "active") {
    const error = new Error(
      `This property does not have a separate ${account_for} account.`
    );

    error.status_code = 404;
    throw error;
  }

  await db.query(
    `
      UPDATE payment_accounts
      SET
        status = 'inactive',
        connection_status = 'not_connected'
      WHERE id = $1
    `,
    [account.id]
  );

  /*
    Service charges that were paid into this account go
    back to the rent account.
  */
  await db.query(
    `
      UPDATE properties
      SET service_charge_account = 'rent'
      WHERE id = $1
        AND service_charge_account = $2
    `,
    [property_id, account_for]
  );

  await log_audit({
    user_id: owner.user_id,
    action: "PROPERTY_PAYMENT_ACCOUNT_REMOVED",
    entity_type: "property",
    entity_id: property_id,
    metadata: {
      account_for,
      business_number: account.business_number,
    },
    ip_address,
  });

  return get_property_by_id(owner, property_id);
}

async function get_property_by_id(owner, property_id) {
  const property_result = await db.query(
    `
      SELECT *
      FROM properties
      WHERE id = $1
        AND owner_id = $2
        AND status != 'archived'
    `,
    [property_id, owner.user_id]
  );

  const property = property_result.rows[0];

  if (!property) {
    return null;
  }

  const account_result = await db.query(
    `
      SELECT
        payment_accounts.*,
        provider_credentials.environment
      FROM payment_accounts
      LEFT JOIN provider_credentials
        ON provider_credentials.payment_account_id =
          payment_accounts.id
      WHERE payment_accounts.property_id = $1
        AND payment_accounts.status = 'active'
      ORDER BY payment_accounts.account_for
    `,
    [property_id]
  );

  /*
    Rent collected follows the Reports definition:
    allocations to rent charges, so deposits are excluded.
  */
  const overview_result = await db.query(
    `
      SELECT
        (
          SELECT COUNT(*)
          FROM units
          WHERE units.property_id = $1
            AND units.status <> 'inactive'
        ) AS total_units,

        (
          SELECT COUNT(*)
          FROM units
          WHERE units.property_id = $1
            AND units.status = 'occupied'
        ) AS occupied_units,

        (
          SELECT COALESCE(
            SUM(payment_allocations.amount),
            0
          )
          FROM payment_allocations
          INNER JOIN payments
            ON payments.id =
              payment_allocations.payment_id
          INNER JOIN tenant_charges
            ON tenant_charges.id =
              payment_allocations.tenant_charge_id
          WHERE payments.property_id = $1
            AND payments.status = 'matched'
            AND tenant_charges.charge_type = 'rent'
            AND payments.received_at >= DATE_TRUNC(
              'month',
              CURRENT_TIMESTAMP
            )
        ) AS rent_collected_this_month,

        caretaker.caretaker_id,
        caretaker.caretaker_first_name,
        caretaker.caretaker_last_name,
        caretaker.caretaker_phone,
        caretaker.caretaker_permission_level,
        caretaker.caretaker_permissions

      FROM (SELECT 1) AS single_row

      LEFT JOIN LATERAL (
        SELECT
          users.user_id AS caretaker_id,
          users.first_name AS caretaker_first_name,
          users.last_name AS caretaker_last_name,
          users.phone AS caretaker_phone,
          property_caretaker_assignments.permission_level
            AS caretaker_permission_level,
          json_build_object(
            'can_read_meters', property_caretaker_assignments.can_read_meters,
            'can_enter_electricity', property_caretaker_assignments.can_enter_electricity,
            'can_manage_maintenance', property_caretaker_assignments.can_manage_maintenance,
            'can_add_expenses', property_caretaker_assignments.can_add_expenses,
            'can_view_tenants', property_caretaker_assignments.can_view_tenants,
            'can_manage_tenants', property_caretaker_assignments.can_manage_tenants,
            'can_record_payments', property_caretaker_assignments.can_record_payments
          ) AS caretaker_permissions
        FROM property_caretaker_assignments
        INNER JOIN users
          ON users.user_id =
            property_caretaker_assignments.caretaker_id
        WHERE property_caretaker_assignments.property_id = $1
          AND property_caretaker_assignments.status = 'active'
        LIMIT 1
      ) AS caretaker ON TRUE
    `,
    [property_id]
  );

  return public_property(
    property,
    account_result.rows.map(public_account),
    overview_result.rows[0]
  );
}

async function list_properties(owner) {
  const result = await db.query(
    `
      SELECT id
      FROM properties
      WHERE owner_id = $1
        AND status != 'archived'
      ORDER BY created_at DESC
    `,
    [owner.user_id]
  );

  return Promise.all(
    result.rows.map((row) =>
      get_property_by_id(owner, row.id)
    )
  );
}

async function archive_property(owner, property_id, ip_address) {
  const property = await get_property_by_id(
    owner,
    property_id
  );

  if (!property) {
    const error = new Error("Property not found.");
    error.status_code = 404;
    throw error;
  }

  await db.query(
    `
      UPDATE properties
      SET
        status = 'archived',
        archived_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND owner_id = $2
    `,
    [property_id, owner.user_id]
  );

  await db.query(
    `
      UPDATE payment_accounts
      SET status = 'inactive'
      WHERE property_id = $1
    `,
    [property_id]
  );

  await log_audit({
    user_id: owner.user_id,
    action: "PROPERTY_ARCHIVED",
    entity_type: "property",
    entity_id: property_id,
    metadata: { property_name: property.name },
    ip_address,
  });
}

async function reregister_payment_account_c2b_urls(
  owner,
  property_id,
  payment_account_id,
  ip_address
) {
  const result = await db.query(
    `
      SELECT
        payment_accounts.*,
        provider_credentials.environment,
        provider_credentials.encrypted_credentials
      FROM payment_accounts
      INNER JOIN properties
        ON properties.id = payment_accounts.property_id
      INNER JOIN provider_credentials
        ON provider_credentials.payment_account_id =
          payment_accounts.id
      WHERE payment_accounts.id = $1
        AND payment_accounts.property_id = $2
        AND properties.owner_id = $3
        AND properties.status != 'archived'
        AND payment_accounts.status = 'active'
      LIMIT 1
    `,
    [
      payment_account_id,
      property_id,
      owner.user_id,
    ]
  );

  const account = result.rows[0];

  if (!account) {
    const error = new Error(
      "Active payment account not found for this property."
    );

    error.status_code = 404;
    throw error;
  }

  if (account.provider_code !== "mpesa") {
    const error = new Error(
      "Only M-Pesa payment accounts support C2B URL registration."
    );

    error.status_code = 422;
    throw error;
  }

  // A new secret each time, so an address that leaked stops working.
  const callback_token = new_callback_token();

  const {
    validation_url,
    confirmation_url,
  } = get_callback_urls(callback_token);

  let daraja_response;

  try {
    const credentials = decrypt_json(
      account.encrypted_credentials
    );

    daraja_response = await register_c2b_urls({
      consumer_key: credentials.consumer_key,
      consumer_secret: credentials.consumer_secret,
      business_number: account.business_number,
      environment: account.environment,
      validation_url,
      confirmation_url,
    });
  } catch (error) {
    const daraja_message = String(
      error.response?.data?.errorMessage ||
        error.response?.data?.ResponseDescription ||
        error.message ||
        "Daraja did not accept the C2B URL registration request."
    );

    await db.query(
      `
        UPDATE payment_accounts
        SET
          connection_status = 'failed',
          connection_error = $2,
          last_connection_test_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [
        account.id,
        daraja_message.slice(0, 2000),
      ]
    );

    await db.query(
      `
        UPDATE provider_credentials
        SET
          connection_status = 'failed',
          last_connected_at = CURRENT_TIMESTAMP
        WHERE payment_account_id = $1
      `,
      [account.id]
    );

    await log_audit({
      user_id: owner.user_id,
      action:
        "PROPERTY_PAYMENT_ACCOUNT_C2B_URL_REGISTRATION_FAILED",
      entity_type: "payment_account",
      entity_id: account.id,
      metadata: {
        property_id,
        account_for: account.account_for,
        business_number: account.business_number,
        environment: account.environment,
        validation_url: mask_callback_url(validation_url),
        confirmation_url: mask_callback_url(confirmation_url),
        error: daraja_message,
      },
      ip_address,
    });

    const public_error = new Error(
      `Daraja C2B URL registration failed: ${daraja_message}`
    );

    public_error.status_code = 502;
    throw public_error;
  }

  await db.query(
    `
      UPDATE payment_accounts
      SET
        connection_status = 'connected',
        connection_error = $2,
        callback_registered_at = CURRENT_TIMESTAMP,
        last_connection_test_at = CURRENT_TIMESTAMP,
        c2b_callback_token_encrypted = $3
      WHERE id = $1
    `,
    [
      account.id,
      daraja_response?.already_registered
        ? "Safaricom says this number's notice address was already registered. If payments stop appearing, ask Safaricom to remove the old address (Daraja portal) and register again."
        : null,
      seal_callback_token(callback_token),
    ]
  );

  await db.query(
    `
      UPDATE provider_credentials
      SET
        connection_status = 'connected',
        last_connected_at = CURRENT_TIMESTAMP
      WHERE payment_account_id = $1
    `,
    [account.id]
  );

  await log_audit({
    user_id: owner.user_id,
    action:
      "PROPERTY_PAYMENT_ACCOUNT_C2B_URLS_REREGISTERED",
    entity_type: "payment_account",
    entity_id: account.id,
    metadata: {
      property_id,
      account_for: account.account_for,
      business_number: account.business_number,
      environment: account.environment,
      validation_url: mask_callback_url(validation_url),
      confirmation_url: mask_callback_url(confirmation_url),
      daraja_response,
    },
    ip_address,
  });

  return {
    payment_account: public_account({
      ...account,
      connection_status: "connected",
      connection_error: null,
      callback_registered_at: new Date(),
    }),
    // The secret stays on the server.
    callback_urls: {
      validation_url: mask_callback_url(validation_url),
      confirmation_url: mask_callback_url(confirmation_url),
    },
    daraja_response,
  };
}

/*
  The account a payment notice belongs to, checked against the
  secret in the address it came to. -> { account } or { reason }
*/
async function check_c2b_notice(payload, callback_token) {
  const business_number = String(payload?.BusinessShortCode || "").trim();

  if (!business_number || !/^[A-Z0-9]{6,20}$/.test(String(payload?.TransID || ""))) {
    return { reason: "The notice is not a valid M-Pesa payment notice." };
  }

  const account = (
    await db.query(
      `
        SELECT
          payment_accounts.id,
          payment_accounts.owner_id,
          payment_accounts.c2b_callback_token_encrypted
        FROM payment_accounts
        WHERE payment_accounts.business_number = $1
          AND payment_accounts.provider_code = 'mpesa'
          AND payment_accounts.status = 'active'
        LIMIT 1
      `,
      [business_number]
    )
  ).rows[0];

  if (!account) {
    return { reason: "No active payment account has this business number." };
  }

  if (!callback_token_matches(account.c2b_callback_token_encrypted, callback_token)) {
    return {
      account,
      reason: account.c2b_callback_token_encrypted
        ? "The notice came to the wrong address for this account."
        : "This account has no secret notice address yet: re-register its addresses.",
    };
  }

  return { account };
}

async function save_c2b_callback(event_type, payload) {
  await db.query(
    `
      INSERT INTO mpesa_c2b_callback_events (
        event_type,
        business_number,
        payload
      )
      VALUES ($1,$2,$3)
    `,
    [
      event_type,
      payload.BusinessShortCode
        ? String(payload.BusinessShortCode)
        : null,
      JSON.stringify(payload),
    ]
  );
}

module.exports = {
  validate_payment_account_connection,
  create_property,
  update_property,
  replace_payment_account,
  remove_payment_account,
  get_property_by_id,
  list_properties,
  archive_property,
  reregister_payment_account_c2b_urls,
  save_c2b_callback,
  check_c2b_notice,
};