const express = require("express");

const {
  rateLimit,
} = require("express-rate-limit");

const auth_controller = require("./auth_controller");

const {
  authenticate,
} = require("./auth_middleware");

const router = express.Router();

const otp_request_limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error:
      "Too many verification-code requests. Try again later.",
  },
});

const otp_verify_limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many verification attempts. Try again later.",
  },
});

router.post(
  "/request-otp",
  otp_request_limiter,
  auth_controller.request_otp
);

router.post(
  "/verify-otp",
  otp_verify_limiter,
  auth_controller.verify_otp
);

router.post(
  "/refresh-token",
  auth_controller.refresh_token
);

router.post(
  "/logout",
  auth_controller.logout
);

router.get(
  "/me",
  authenticate,
  auth_controller.me
);

module.exports = router;