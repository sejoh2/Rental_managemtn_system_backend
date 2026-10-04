const crypto = require("crypto");

function generate_otp(length = 6) {
  if (!Number.isInteger(length) || length < 4 || length > 10) {
    throw new Error("OTP length must be between 4 and 10 digits.");
  }

  const minimum = 10 ** (length - 1);
  const maximum = (10 ** length) - 1;

  return String(
    crypto.randomInt(minimum, maximum + 1)
  );
}

module.exports = {
  generate_otp,
};