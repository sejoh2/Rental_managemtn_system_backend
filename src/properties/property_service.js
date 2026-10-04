const crypto = require("crypto");

const db = require("../config/db");

const {
  encrypt_json,
  decrypt_json,
} = require("../utils/crypto");

const {
  log_audit,
} = require("../audit/audit_service");

const {
  get_access_token,
  register_c2b_urls,
} = require("../payments/mpesa/daraja_c2b_client");

function public_account(account) {
  return {
    id: Number(account.id),
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
  };
}

function public_property(property, accounts) {
  return {
    id: Number(property.id),
    owner_id: Number(property.owner_id),

    name: property.name,
    location: property.location,
    property_type: property.property_type,
    expected_units: Number(property.expected_units),
    rent_due_day: property.rent_due_day,

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
    status: property.status,

    rent_account:
      accounts.find(
        (account) => account.account_for === "rent"
      ) || null,

    water_account:
      accounts.find(
        (account) => account.account_for === "water"
      ) || null,

    created_at: property.created_at,
    updated_at: property.updated_at,
  };
}

function get_callback_urls() {
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
      `${public_api_url}/api/properties/c2b/validation`,

    confirmation_url:
      `${public_api_url}/api/properties/c2b/confirmation`,
  };
}

async function ensure_business_number_available(
  business_number
) {
  const result = await db.query(
    `
      SELECT id
      FROM payment_accounts
      WHERE business_number = $1
        AND status = 'active'
      LIMIT 1
    `,
    [business_number]
  );

  if (result.rows.length) {
    const error = new Error(
      `M-Pesa business number ${business_number} is already assigned to another active property.`
    );

    error.status_code = 409;
    throw error;
  }
}

async function validate_payment_account_connection(
  owner,
  account_for,
  account,
  ip_address
) {
  await ensure_business_number_available(
    account.business_number
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

  const connection_id = crypto.randomUUID();

  const expires_minutes =
    Number(
      process.env.PROPERTY_CONNECTION_EXPIRES_MINUTES
    ) || 10;

  await db.query(
    `
      INSERT INTO property_connection_checks (
        id,
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
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        CURRENT_TIMESTAMP + ($11 || ' minutes')::INTERVAL
      )
    `,
    [
      connection_id,
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
  connection
) {
  const label =
    account_for === "rent"
      ? "Rent M-Pesa account"
      : "Water M-Pesa account";

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
        last_connection_test_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        'connected',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
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

    const rent_connection = await get_connection_check(
      client,
      owner.user_id,
      data.rent_connection_id,
      "rent"
    );

    const water_connection = await get_connection_check(
      client,
      owner.user_id,
      data.water_connection_id,
      "water"
    );

    if (
      rent_connection.business_number ===
      water_connection.business_number
    ) {
      const error = new Error(
        "Rent and water accounts must use different M-Pesa business numbers."
      );

      error.status_code = 422;
      throw error;
    }

    await ensure_business_number_available(
      rent_connection.business_number
    );

    await ensure_business_number_available(
      water_connection.business_number
    );

    const { validation_url, confirmation_url } =
      get_callback_urls();

    /*
      Daraja registration occurs only now, once both Connect
      checks succeeded and the property is actually being created.
    */
    for (const connection of [
      rent_connection,
      water_connection,
    ]) {
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
          water_billing_method,
          water_rate_per_unit,
          water_fixed_fee,
          water_billing_day,
          water_reading_due_days,
          water_missed_reading_action,
          sms_sender_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14
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
        data.water_billing_method,
        data.water_rate_per_unit,
        data.water_fixed_fee,
        data.water_billing_day,
        data.water_reading_due_days,
        data.water_missed_reading_action,
        data.sms_sender_id || null,
      ]
    );

    const property_id = property_result.rows[0].id;

    await create_payment_account(
      client,
      owner.user_id,
      property_id,
      "rent",
      rent_connection
    );

    await create_payment_account(
      client,
      owner.user_id,
      property_id,
      "water",
      water_connection
    );

    await client.query(
      `
        UPDATE property_connection_checks
        SET
          status = 'used',
          used_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1)
      `,
      [
        [
          data.rent_connection_id,
          data.water_connection_id,
        ],
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
        rent_business_number:
          rent_connection.business_number,
        water_business_number:
          water_connection.business_number,
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

  return public_property(
    property,
    account_result.rows.map(public_account)
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

  const {
    validation_url,
    confirmation_url,
  } = get_callback_urls();

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
        validation_url,
        confirmation_url,
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
        connection_error = NULL,
        callback_registered_at = CURRENT_TIMESTAMP,
        last_connection_test_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [account.id]
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
      validation_url,
      confirmation_url,
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
    callback_urls: {
      validation_url,
      confirmation_url,
    },
    daraja_response,
  };
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
  get_property_by_id,
  list_properties,
  archive_property,
  reregister_payment_account_c2b_urls,
  save_c2b_callback,
};