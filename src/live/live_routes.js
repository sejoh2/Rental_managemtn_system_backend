const express = require("express");

const live_service = require("./live_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const router = express.Router();

/*
  The guard is attached to each route, not to the whole router.
  This router is mounted on "/api" next to the others, and a
  router-wide check would also refuse requests meant for them.
*/

/*
  A one-minute pass for opening the live connection.
  ?for=admin (the admin's bell) or ?for=owner (the owner's bell).
*/
router.post(
  "/live/ticket",
  authenticate,
  (req, res, next) => {
    try {
      const scope = req.query.for === "admin" ? "admin" : "owner";

      return res.status(200).json({
        success: true,
        data: {
          ticket: live_service.create_ticket(req, scope),
          expires_in_seconds: 60,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

/*
  The live connection itself. The pass is checked inside: a
  browser cannot send the sign-in token on this kind of
  connection.
*/
router.get("/live/stream", async (req, res, next) => {
  try {
    await live_service.open_stream(req, res);
  } catch (error) {
    if (!res.headersSent) next(error);
  }
});

module.exports = router;
