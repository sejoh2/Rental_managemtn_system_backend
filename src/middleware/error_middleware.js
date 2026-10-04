function not_found(req, res) {
  return res.status(404).json({
    success: false,
    error: "Route not found.",
  });
}

function error_handler(error, req, res, next) {
  console.error("[ERROR]", error);

  return res.status(error.status_code || 400).json({
    success: false,
    error: error.message || "Request failed.",
    details: error.details || undefined,
  });
}

module.exports = {
  not_found,
  error_handler,
};