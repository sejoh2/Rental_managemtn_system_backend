const crypto = require("crypto");

function get_encryption_key() {
  const value =
    process.env.PAYMENT_CREDENTIAL_ENCRYPTION_KEY;

  if (!value) {
    throw new Error(
      "PAYMENT_CREDENTIAL_ENCRYPTION_KEY is required."
    );
  }

  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "PAYMENT_CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes."
    );
  }

  return key;
}

function encrypt_json(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    get_encryption_key(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decrypt_json(value) {
  const [iv_value, auth_tag_value, ciphertext] =
    String(value).split(":");

  if (!iv_value || !auth_tag_value || !ciphertext) {
    throw new Error("Stored payment credentials are invalid.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    get_encryption_key(),
    Buffer.from(iv_value, "base64")
  );

  decipher.setAuthTag(
    Buffer.from(auth_tag_value, "base64")
  );

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(ciphertext, "base64")
    ),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

module.exports = {
  encrypt_json,
  decrypt_json,
};