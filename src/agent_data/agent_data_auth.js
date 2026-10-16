const crypto = require("crypto");

/*
  Only the customer agent (its own service, in its own repository)
  calls the agent data API. It sends AGENT_API_TOKEN as a Bearer
  token; there is no user, no session and no owner account.

  Without AGENT_API_TOKEN in .env the API is switched off.
*/
const MIN_TOKEN_LENGTH = 32;

/*
  Compared in constant time, byte for byte. A token of another length
  is refused first: that tells nothing useful, as the token is a long
  random value of a known length, not something a person chose.
*/
function same_token(given, expected) {
  const a = Buffer.from(String(given), "utf8");
  const b = Buffer.from(String(expected), "utf8");

  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

  if (!given || !same_token(given, expected)) {
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
