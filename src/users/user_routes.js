const express = require("express");

const user_controller = require("./user_controller");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

router.use(authenticate);
router.use(require_role("admin"));

router.get("/", user_controller.list_users);

router.get("/:user_id", user_controller.get_user);

router.post(
  "/:user_id/promote-owner",
  user_controller.promote_to_owner
);

router.post(
  "/:user_id/deactivate",
  user_controller.deactivate_user
);

router.post(
  "/:user_id/activate",
  user_controller.activate_user
);

module.exports = router;