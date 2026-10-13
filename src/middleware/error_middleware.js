function not_found(req, res) {
  return res.status(404).json({
    success: false,
    error: "Route not found.",
  });
}

/*
  The database refused or could not give a connection in time.
  The person gets a plain sentence, not the database's own
  message.
*/
function is_database_busy(error) {
  return (
    ["53300", "53400", "57P03"].includes(error.code) ||
    /timeout exceeded when trying to connect/i.test(
      error.message || ""
    )
  );
}

function error_handler(error, req, res, next) {
  console.error("[ERROR]", error);

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      error: "That file is too large. The limit is 5 MB.",
    });
  }

  if (is_database_busy(error)) {
    return res.status(503).json({
      success: false,
      error:
        "The server is busy right now. Please try again in a moment.",
    });
  }

  return res.status(error.status_code || 400).json({
    success: false,
    error: error.message || "Request failed.",
    details: error.details || undefined,
    attempts_remaining: error.attempts_remaining,
  });
}

module.exports = {
  not_found,
  error_handler,
};