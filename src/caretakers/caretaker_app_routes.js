const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");

const push_service = require("../push/push_service");

const caretaker_app_service = require("./caretaker_app_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  The guards are attached to each route, not to the whole
  router. This router is mounted on "/api" next to the others,
  and a router-wide check would also refuse requests meant for
  them.
*/
const caretaker_guard = [
  authenticate,
  require_role("caretaker"),
];

const owner_guard = [
  authenticate,
  require_role("owner"),
];

const permission_schema = z.object({
  allowed: z.boolean(),
});

/*
  The caretaker app: the properties I look after.
*/
router.get(
  "/caretaker/properties",
  caretaker_guard,
  async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await caretaker_app_service.list_my_properties(
          req.user
        ),
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
  The owner: may this property's caretaker record payments?
*/
router.put(
  "/properties/:property_id/caretaker/payment-permission",
  owner_guard,
  async (req, res, next) => {
    try {
      const property_id = Number(req.params.property_id);
      const body = permission_schema.safeParse(req.body);

      if (
        !Number.isInteger(property_id) ||
        property_id < 1 ||
        !body.success
      ) {
        const error = new Error(
          "Say whether the caretaker is allowed: allowed must be true or false."
        );

        error.status_code = 422;
        throw error;
      }

      return res.status(200).json({
        success: true,
        message: body.data.allowed
          ? "The caretaker can now record payments for this property."
          : "The caretaker can no longer record payments for this property.",
        data: await caretaker_app_service.set_payment_permission(
          req.user,
          property_id,
          body.data.allowed,
          req.ip
        ),
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
  The caretaker app's push address, after sign-in and whenever
  Firebase renews it; removed when they sign out. Per network
  address, far above normal use.
*/
const device_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});

const device_schema = z.object({
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(["android", "ios"]).default("android"),
}).strict();

function parse_device(body) {
  const result = device_schema.safeParse(body || {});

  if (!result.success) {
    const error = new Error("A push address (token) is required.");

    error.status_code = 422;
    throw error;
  }

  return result.data;
}

router.post(
  "/caretaker/push-devices",
  device_limiter,
  caretaker_guard,
  async (req, res, next) => {
    try {
      const { token, platform } = parse_device(req.body);

      return res.status(200).json({
        success: true,
        data: await push_service.register_device(req.user, token, platform),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  "/caretaker/push-devices",
  device_limiter,
  caretaker_guard,
  async (req, res, next) => {
    try {
      const { token } = parse_device(req.body);

      return res.status(200).json({
        success: true,
        data: await push_service.unregister_device(req.user, token),
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
