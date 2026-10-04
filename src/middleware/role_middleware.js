function require_role(...allowed_roles) {
  return function role_middleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    if (!allowed_roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: "You do not have permission to perform this action.",
      });
    }

    return next();
  };
}

module.exports = {
  require_role,
};