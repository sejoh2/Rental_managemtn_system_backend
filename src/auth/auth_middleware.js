const token_service = require("../security/token_service");

const {
  get_user_by_id,
} = require("./auth_service");

async function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication token is required.",
      });
    }

    const access_token = authorization.slice(7);

    const decoded =
      token_service.verify_access_token(access_token);

    if (decoded.type !== "access") {
      throw new Error("Invalid token type.");
    }

    const user = await get_user_by_id(decoded.user_id);

    if (!user || user.status !== "active") {
      throw new Error("User is unavailable.");
    }

    req.user = user;

    return next();
  } catch {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token.",
    });
  }
}

module.exports = {
  authenticate,
};