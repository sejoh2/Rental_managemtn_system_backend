const crypto = require("crypto");

/*
  Only the customer agent (its own service, in its own repository)
  calls the agent data API. It sends AGENT_API_TOKEN as a Bearer
  token; there is no user, no session and no owner account.

  Without AGENT_API_TOKEN in .env the API is switched off.
*/
const MIN_TOKEN_LENGTH = 32;

function token_hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function authenticate_agent(req, res, next) {
  const expected = process.env.AGENT_API_TOKEN || "";

  if (expected.length < MIN_TOKEN_LENGTH) {
    return res.status(503).json({
      success: false,
      error: "The agent data API is not switched on.",
    });
  }

  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";

  // Both sides hashed first, so the comparison takes the same time whatever was sent.
  if (
    !given ||
    !crypto.timingSafeEqual(token_hash(given), token_hash(expected))
  ) {
    return res.status(401).json({
      success: false,
      error: "Not allowed.",
    });
  }

  return next();
}

module.exports = {
  authenticate_agent,
  MIN_TOKEN_LENGTH,
};
