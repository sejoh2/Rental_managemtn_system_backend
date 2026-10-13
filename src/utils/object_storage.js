const crypto = require("crypto");

/*
  Private file storage on Cloudflare R2, which speaks the S3
  protocol. Only three operations are needed, so the requests
  are signed here (AWS Signature Version 4) instead of loading
  the large AWS SDK.

  The bucket is private. A file is only ever reached through
  the backend: it uploads and deletes with its own key, and
  hands the browser a link that works for a few minutes.

  Settings, all from the environment and never sent to anyone:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_BUCKET.
*/
const REGION = "auto";
const SERVICE = "s3";

function settings() {
  const config = {
    account_id: process.env.R2_ACCOUNT_ID,
    access_key_id: process.env.R2_ACCESS_KEY_ID,
    secret_access_key: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  };

  if (Object.values(config).some((value) => !value)) {
    const error = new Error(
      "File storage is not set up on this server yet."
    );

    error.status_code = 503;
    throw error;
  }

  return {
    ...config,
    host: `${config.account_id}.r2.cloudflarestorage.com`,
  };
}

function is_configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function sha256_hex(data) {
  return crypto
    .createHash("sha256")
    .update(data)
    .digest("hex");
}

function hmac(key, data) {
  return crypto
    .createHmac("sha256", key)
    .update(data)
    .digest();
}

/*
  RFC 3986 encoding, which the signature requires: everything
  except letters, digits and - _ . ~
*/
function encode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function object_path(config, key) {
  return `/${config.bucket}/${key
    .split("/")
    .map(encode)
    .join("/")}`;
}

function timestamps() {
  const amz_date = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");

  return {
    amz_date,
    date: amz_date.slice(0, 8),
  };
}

function signature(config, date, string_to_sign) {
  const key = [date, REGION, SERVICE, "aws4_request"].reduce(
    (current, part) => hmac(current, part),
    `AWS4${config.secret_access_key}`
  );

  return hmac(key, string_to_sign).toString("hex");
}

function string_to_sign(amz_date, date, canonical_request) {
  return [
    "AWS4-HMAC-SHA256",
    amz_date,
    `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256_hex(canonical_request),
  ].join("\n");
}

/*
  A request the backend itself sends, signed in its headers.
*/
async function signed_request(method, key, body = null, content_type = null) {
  const config = settings();
  const { amz_date, date } = timestamps();
  const path = object_path(config, key);
  const payload_hash = sha256_hex(body || "");

  const headers = {
    host: config.host,
    "x-amz-content-sha256": payload_hash,
    "x-amz-date": amz_date,
  };

  if (content_type) {
    headers["content-type"] = content_type;
  }

  const names = Object.keys(headers).sort();

  const canonical_request = [
    method,
    path,
    "",
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    names.join(";"),
    payload_hash,
  ].join("\n");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.access_key_id}/${date}/${REGION}/${SERVICE}/aws4_request, ` +
    `SignedHeaders=${names.join(";")}, ` +
    `Signature=${signature(
      config,
      date,
      string_to_sign(amz_date, date, canonical_request)
    )}`;

  const response = await fetch(`https://${config.host}${path}`, {
    method,
    headers: {
      ...headers,
      authorization,
    },
    body: body || undefined,
  });

  if (!response.ok) {
    /*
      The storage's own answer goes to the server log only.
    */
    console.error(
      `[STORAGE] ${method} failed with ${response.status}:`,
      (await response.text()).slice(0, 300)
    );

    const error = new Error(
      "The file storage could not complete this. Please try again."
    );

    error.status_code = 502;
    throw error;
  }

  return response;
}

async function put_object(key, body, content_type) {
  await signed_request("PUT", key, body, content_type);
}

async function delete_object(key) {
  await signed_request("DELETE", key);
}

/*
  A link the browser can open for a short time. filename is
  what the browser shows or saves the file as; the file opens
  in the browser where it can, and downloads otherwise.
*/
function signed_download_url(
  key,
  { filename, content_type, expires_seconds = 300 } = {}
) {
  const config = settings();
  const { amz_date, date } = timestamps();
  const path = object_path(config, key);

  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.access_key_id}/${date}/${REGION}/${SERVICE}/aws4_request`,
    "X-Amz-Date": amz_date,
    "X-Amz-Expires": String(expires_seconds),
    "X-Amz-SignedHeaders": "host",
  };

  if (filename) {
    query["response-content-disposition"] =
      `inline; filename="${filename.replace(/["\\\r\n]/g, "")}"`;
  }

  if (content_type) {
    query["response-content-type"] = content_type;
  }

  const canonical_query = Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(query[name])}`)
    .join("&");

  const canonical_request = [
    "GET",
    path,
    canonical_query,
    `host:${config.host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const signed = signature(
    config,
    date,
    string_to_sign(amz_date, date, canonical_request)
  );

  return `https://${config.host}${path}?${canonical_query}&X-Amz-Signature=${signed}`;
}

module.exports = {
  is_configured,
  put_object,
  delete_object,
  signed_download_url,
};
