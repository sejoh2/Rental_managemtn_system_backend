const express = require("express");

const property_controller = require("./property_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  These are public because Safaricom calls them.
  They must appear before router.use(authenticate).
*/
router.post(
  "/c2b/validation/:callback_token",
  property_controller.c2b_validation
);

router.post(
  "/c2b/confirmation/:callback_token",
  property_controller.c2b_confirmation
);

/*
  The old addresses, without a secret: kept so Safaricom gets an
  answer, but they no longer record payments (see
  c2b_callback_security.js).
*/
router.post(
  "/c2b/validation",
  property_controller.c2b_validation
);

router.post(
  "/c2b/confirmation",
  property_controller.legacy_c2b_confirmation
);

/*
  Only owners may create, connect, view, or archive their properties.
*/
router.use(authenticate);

/*
  A caretaker has nothing on this router, but other routers
  serve paths that start the same way, such as
  /api/properties/:property_id/tenants. A caretaker is passed
  on to them instead of being refused here.
*/
router.use((req, res, next) =>
  req.user.role === "caretaker" ? next("router") : next()
);

router.use(require_role("owner"));

router.post(
  "/payment-accounts/connect",
  property_controller.connect_payment_account
);

router.put(
  "/:property_id/payment-accounts/:account_for",
  property_controller.replace_payment_account
);

router.delete(
  "/:property_id/payment-accounts/:account_for",
  property_controller.remove_payment_account
);

router.post(
  "/:property_id/payment-accounts/:payment_account_id/register-c2b-urls",
  property_controller.reregister_payment_account_c2b_urls
);

router.get(
  "/",
  property_controller.list_properties
);

router.get(
  "/:property_id",
  property_controller.get_property
);

router.post(
  "/",
  property_controller.create_property
);

router.patch(
  "/:property_id",
  property_controller.update_property
);

router.delete(
  "/:property_id",
  property_controller.archive_property
);

module.exports = router;