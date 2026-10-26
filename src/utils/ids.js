const db = require("../config/db");

/*
  Record IDs (decided 2026-10-26): every record has one ID, text, like
  "tnt_01JB8X3K5M0A1F7Q2STVWX":
  - a three-letter prefix for the kind of record (PREFIX below) and "_";
  - 10 characters of the time it was made (milliseconds), then 4 of a
    counter, so sorting IDs sorts by age, also for records made in the
    same millisecond. The money logic relies on this ("oldest bill
    first");
  - 8 random characters, so an ID cannot be guessed.
  Crockford's base32 (no I, L, O, U), in ASCII order, compared with the
  "C" collation (the record_id type), so text order is time order.

  The database makes them (DEFAULT new_id('tnt')); the API only checks
  their shape. No numeric ID is accepted or shown anywhere.
*/

const PREFIX = {
  user: "usr",
  otp_code: "otp",
  refresh_token: "ses",
  audit_log: "aud",
  property: "prp",
  payment_account: "pac",
  provider_credential: "pcr",
  connection_check: "chk",
  mpesa_callback_event: "mce",
  unit: "unt",
  tenant: "tnt",
  tenant_charge: "chg",
  payment: "pay",
  payment_allocation: "pal",
  tenant_credit: "crd",
  deposit_settlement: "dst",
  deposit_application: "dap",
  caretaker_assignment: "cta",
  expense: "exp",
  file: "fil",
  maintenance_request: "mnt",
  water_reading: "wrd",
  service_charge: "svc",
  service_charge_unit: "scu",
  agreement_template: "agt",
  agreement: "agr",
  sms_template: "smt",
  sms_broadcast: "smb",
  sms_message: "sms",
  sms_sender_approval: "ssa",
  sms_auto_reminder: "sar",
  push_device: "pdv",
  push_outbox: "pob",
  analytics_event: "ane",
  subscription_discount: "dsc",
  subscription_invoice: "inv",
  subscription_payment: "spy",
  subscription_stk_request: "stk",
  subscription_stk_event: "ste",
};

const ID_PATTERN = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{22}$/;

const is_id = (value, prefix = null) =>
  typeof value === "string" && ID_PATTERN.test(value) && (!prefix || value.startsWith(`${prefix}_`));

/*
  A record ID from a request (path, query or body), or a 422. prefix
  (optional) is the kind expected, so a tenant's ID cannot be passed
  where a property's is wanted.
*/
function id_or_throw(value, label = "record", prefix = null) {
  const text = typeof value === "string" ? value.trim() : value;

  if (!is_id(text, prefix)) {
    const error = new Error(`A valid ${label} ID is required.`);

    error.status_code = 422;
    throw error;
  }

  return text;
}

// The same as a zod field, for schemas: zid("tnt").
function zid(prefix = null, label = "record") {
  const { z } = require("zod");

  return z
    .string({ error: `A valid ${label} ID is required.` })
    .trim()
    .refine((value) => is_id(value, prefix), { message: `A valid ${label} ID is required.` });
}

/*
  The type and function every table uses. Run first, before any table.
  Safe to run again.
*/
async function init_id_function() {
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_id') THEN
        CREATE DOMAIN record_id AS TEXT COLLATE "C";
      END IF;
    END
    $$;

    CREATE SEQUENCE IF NOT EXISTS record_id_counter;

    CREATE OR REPLACE FUNCTION new_id(prefix TEXT)
    RETURNS record_id
    LANGUAGE plpgsql
    VOLATILE
    AS $$
    DECLARE
      alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      ms BIGINT := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000);
      counter BIGINT := nextval('record_id_counter') % 1048576;
      noise BYTEA := decode(replace(gen_random_uuid()::TEXT, '-', ''), 'hex');
      body TEXT := '';
      i INT;
    BEGIN
      FOR i IN REVERSE 9..0 LOOP
        body := body || substr(alphabet, ((ms >> (i * 5)) & 31)::INT + 1, 1);
      END LOOP;

      FOR i IN REVERSE 3..0 LOOP
        body := body || substr(alphabet, ((counter >> (i * 5)) & 31)::INT + 1, 1);
      END LOOP;

      FOR i IN 0..7 LOOP
        body := body || substr(alphabet, (get_byte(noise, i) & 31) + 1, 1);
      END LOOP;

      RETURN (prefix || '_' || body)::record_id;
    END
    $$;
  `);
}

module.exports = {
  PREFIX,
  ID_PATTERN,
  is_id,
  id_or_throw,
  zid,
  init_id_function,
};
