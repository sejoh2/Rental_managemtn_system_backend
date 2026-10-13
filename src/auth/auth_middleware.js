const token_service = require("../security/token_service");

const {
  get_user_by_id,
} = require("./auth_service");

const {
  run_as_admin,
} = require("../audit/acting_context");

const {
  idempotency,
} = require("../middleware/idempotency");

/*
  The admin's own pages. The acting-owner header is ignored
  here, so the admin stays an admin on them.
*/
const admin_own_paths = /^\/api\/(auth|users|admin)(\/|\?|$)/;

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

    /*
      A repeat of a request that was already carried out (same
      Idempotency-Key) is answered here and goes no further.
    */
    let proceed;

    try {
      proceed = await idempotency(req, res, user.user_id);
    } catch (error) {
      return next(error);
    }

    if (!proceed) {
      return undefined;
    }

    /*
      A system admin may open any owner's account. The request
      then runs as that owner, so every owner screen and rule
      works unchanged, while the audit log records the admin
      as the person who acted.
    */
    const acting_owner_id = Number(
      req.headers["x-acting-owner-id"]
    );

    if (
      user.role === "admin" &&
      acting_owner_id &&
      !admin_own_paths.test(req.originalUrl)
    ) {
      const owner = await get_user_by_id(acting_owner_id);

      if (!owner || owner.role !== "owner") {
        return res.status(404).json({
          success: false,
          error: "Owner account not found.",
        });
      }

      req.admin = user;

      req.user = {
        ...owner,
        acting_admin_id: user.user_id,
      };

      return run_as_admin(
        {
          admin_id: user.user_id,
          owner_id: owner.user_id,
        },
        next
      );
    }

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