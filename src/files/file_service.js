const crypto = require("crypto");

const db = require("../config/db");

const {
  log_audit,
} = require("../audit/audit_service");

const storage = require("../utils/object_storage");

const { PREFIX, is_id } = require("../utils/ids");

/*
  Files an owner attaches to a record: a tenant's documents,
  an expense's receipt, a water reading's meter photo.

  The files live in private storage. The database keeps who
  owns each one and what it is attached to, and every request
  is checked against that before the storage is touched.
*/
const kinds = {
  tenant_document: {
    table: "tenants",
    label: "tenant",
    prefix: PREFIX.tenant,
  },
  expense_receipt: {
    table: "expenses",
    label: "expense",
    prefix: PREFIX.expense,
  },
  meter_photo: {
    table: "water_meter_readings",
    label: "water reading",
    prefix: PREFIX.water_reading,
  },
};

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_RECORD = 20;

/*
  What may be uploaded, and how each type starts. The first
  bytes are checked, so a file cannot pass as a picture by its
  name or label alone.
*/
const file_types = {
  "image/jpeg": {
    extension: "jpg",
    matches: (bytes) =>
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  "image/png": {
    extension: "png",
    matches: (bytes) =>
      bytes.subarray(0, 8).toString("hex") ===
      "89504e470d0a1a0a",
  },
  "image/webp": {
    extension: "webp",
    matches: (bytes) =>
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP",
  },
  "application/pdf": {
    extension: "pdf",
    matches: (bytes) =>
      bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  },
};

function service_error(message, status_code = 400) {
  const error = new Error(message);
  error.status_code = status_code;
  return error;
}

async function init_file_tables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS files (
      id record_id PRIMARY KEY DEFAULT new_id('fil'),

      owner_id record_id NOT NULL
        REFERENCES users(user_id)
        ON DELETE CASCADE,

      property_id record_id
        REFERENCES properties(id)
        ON DELETE SET NULL,

      kind VARCHAR(30) NOT NULL
        CHECK (
          kind IN (
            'tenant_document',
            'expense_receipt',
            'meter_photo'
          )
        ),

      /*
        The tenant, expense or water reading it belongs to.
      */
      target_id record_id NOT NULL,

      original_name VARCHAR(255) NOT NULL,
      label VARCHAR(120),
      content_type VARCHAR(100) NOT NULL,
      size_bytes INTEGER NOT NULL,

      storage_key VARCHAR(500) NOT NULL UNIQUE,

      uploaded_by record_id
        REFERENCES users(user_id)
        ON DELETE SET NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

      deleted_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_files_target
      ON files(kind, target_id)
      WHERE deleted_at IS NULL;
  `);

  console.log("[FILES] Tables initialized.");
}

function public_file(file) {
  return {
    id: file.id,
    kind: file.kind,
    target_id: file.target_id,
    name: file.original_name,
    label: file.label || null,
    content_type: file.content_type,
    size_bytes: Number(file.size_bytes),
    uploaded_by_name: file.uploaded_by_name || null,
    created_at: file.created_at,
  };
}

/*
  The record a file is attached to must belong to this owner.
*/
async function get_target_or_throw(owner, kind, target_id) {
  const config = kinds[kind];

  if (!config) {
    throw service_error("Unknown kind of file.", 422);
  }

  if (!is_id(target_id, config.prefix)) {
    throw service_error(`A valid ${config.label} ID is required.`, 422);
  }

  const result = await db.query(
    `
      SELECT id, property_id
      FROM ${config.table}
      WHERE id = $1
        AND owner_id = $2
    `,
    [target_id, owner.user_id]
  );

  if (!result.rows[0]) {
    throw service_error(
      `That ${config.label} was not found or you do not have access to it.`,
      404
    );
  }

  return result.rows[0];
}

async function list_files(owner, kind, target_id) {
  await get_target_or_throw(owner, kind, target_id);

  const result = await db.query(
    `
      SELECT
        files.*,
        NULLIF(
          TRIM(
            CONCAT(
              users.first_name,
              ' ',
              users.last_name
            )
          ),
          ''
        ) AS uploaded_by_name
      FROM files
      LEFT JOIN users
        ON users.user_id = files.uploaded_by
      WHERE files.owner_id = $1
        AND files.kind = $2
        AND files.target_id = $3
        AND files.deleted_at IS NULL
      ORDER BY files.created_at DESC
    `,
    [owner.user_id, kind, target_id]
  );

  return result.rows.map(public_file);
}

/*
  How many files each record has, for a page that lists many
  records. -> { "<target_id>": count }
*/
async function count_files(owner, kind, target_ids) {
  /*
    A caretaker counts only in the properties they look after.
  */
  const caretaker_id =
    owner.role === "caretaker" ? owner.user_id : null;

  const account_id =
    owner.role === "caretaker"
      ? owner.owner_id
      : owner.user_id;

  if (!kinds[kind]) {
    throw service_error("Unknown kind of file.", 422);
  }

  const result = await db.query(
    `
      SELECT target_id, COUNT(*) AS total
      FROM files
      WHERE owner_id = $1
        AND kind = $2
        AND target_id = ANY($3::record_id[])
        AND deleted_at IS NULL
        AND (
          $4::record_id IS NULL
          OR property_id IN (
            SELECT property_id
            FROM property_caretaker_assignments
            WHERE caretaker_id = $4
              AND owner_id = $1
              AND status = 'active'
          )
        )
      GROUP BY target_id
    `,
    [account_id, kind, target_ids, caretaker_id]
  );

  return Object.fromEntries(
    result.rows.map((row) => [
      row.target_id,
      Number(row.total),
    ])
  );
}

function clean_name(name) {
  const cleaned = String(name || "")
    .replace(/[\\/]/g, " ")
    .replace(/[\u0000-\u001f"]/g, "")
    .trim()
    .slice(0, 200);

  return cleaned || "file";
}

async function upload_file(
  owner,
  { kind, target_id, name, label },
  body,
  content_type,
  ip_address
) {
  const target = await get_target_or_throw(
    owner,
    kind,
    target_id
  );

  const type = file_types[content_type];

  if (!type) {
    throw service_error(
      "Only photos (JPG, PNG, WEBP) and PDF files can be uploaded.",
      415
    );
  }

  if (!Buffer.isBuffer(body) || !body.length) {
    throw service_error("The file is empty.", 422);
  }

  if (body.length > MAX_BYTES) {
    throw service_error(
      "That file is too large. The limit is 5 MB.",
      413
    );
  }

  if (!type.matches(body)) {
    throw service_error(
      "This file is not a valid photo or PDF. It may be damaged or of another type.",
      415
    );
  }

  const existing = await db.query(
    `
      SELECT COUNT(*) AS total
      FROM files
      WHERE owner_id = $1
        AND kind = $2
        AND target_id = $3
        AND deleted_at IS NULL
    `,
    [owner.user_id, kind, target_id]
  );

  if (Number(existing.rows[0].total) >= MAX_FILES_PER_RECORD) {
    throw service_error(
      `A ${kinds[kind].label} can have at most ${MAX_FILES_PER_RECORD} files. Delete one first.`,
      409
    );
  }

  /*
    The name in storage is random, so a link cannot be guessed
    and the original name never meets the storage's path rules.
  */
  const storage_key = [
    `owner-${owner.user_id}`,
    kind,
    String(target_id),
    `${crypto.randomUUID()}.${type.extension}`,
  ].join("/");

  await storage.put_object(storage_key, body, content_type);

  let file;

  try {
    const result = await db.query(
      `
        INSERT INTO files (
          owner_id,
          property_id,
          kind,
          target_id,
          original_name,
          label,
          content_type,
          size_bytes,
          storage_key,
          uploaded_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `,
      [
        owner.user_id,
        target.property_id || null,
        kind,
        target_id,
        clean_name(name),
        label ? String(label).trim().slice(0, 120) : null,
        content_type,
        body.length,
        storage_key,
        owner.acting_caretaker_id || owner.user_id,
      ]
    );

    file = result.rows[0];
  } catch (error) {
    /*
      Nothing may be left in storage that the database does
      not know about.
    */
    await storage.delete_object(storage_key).catch(() => {});

    throw error;
  }

  await log_audit({
    user_id: owner.user_id,
    action: "FILE_UPLOADED",
    entity_type: kinds[kind].table === "tenants"
      ? "tenant"
      : kinds[kind].table === "expenses"
        ? "expense"
        : "water_reading",
    entity_id: target_id,
    metadata: {
      file_id: file.id,
      kind,
      name: file.original_name,
      label: file.label,
      size_bytes: file.size_bytes,
    },
    ip_address,
  });

  return public_file(file);
}

async function get_file_or_throw(owner, file_id) {
  const result = await db.query(
    `
      SELECT *
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND deleted_at IS NULL
    `,
    [file_id, owner.user_id]
  );

  if (!result.rows[0]) {
    throw service_error(
      "File not found or you do not have access to it.",
      404
    );
  }

  return result.rows[0];
}

/*
  A link that opens the file for five minutes. Opening a file
  is recorded, since these can be identity documents.
*/
async function get_file_link(owner, file_id, ip_address) {
  const file = await get_file_or_throw(owner, file_id);

  const url = storage.signed_download_url(file.storage_key, {
    filename: file.original_name,
    content_type: file.content_type,
    expires_seconds: 300,
  });

  await log_audit({
    user_id: owner.user_id,
    action: "FILE_OPENED",
    entity_type: "file",
    entity_id: file.id,
    metadata: {
      kind: file.kind,
      target_id: file.target_id,
      name: file.original_name,
    },
    ip_address,
  });

  return {
    url,
    expires_in_seconds: 300,
  };
}

async function delete_file(owner, file_id, ip_address) {
  const file = await get_file_or_throw(owner, file_id);

  await storage.delete_object(file.storage_key);

  await db.query(
    `
      UPDATE files
      SET deleted_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [file.id]
  );

  await log_audit({
    user_id: owner.user_id,
    action: "FILE_DELETED",
    entity_type: "file",
    entity_id: file.id,
    metadata: {
      kind: file.kind,
      target_id: file.target_id,
      name: file.original_name,
    },
    ip_address,
  });
}

module.exports = {
  MAX_BYTES,
  kinds,
  get_target_or_throw,
  get_file_or_throw,
  init_file_tables,
  list_files,
  count_files,
  upload_file,
  get_file_link,
  delete_file,
};
