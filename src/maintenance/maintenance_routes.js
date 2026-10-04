const express = require("express");

const maintenance_controller = require(
  "./maintenance_controller"
);

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

router.use(authenticate);

router.use(
  require_role("owner", "caretaker")
);

router.get(
  "/maintenance/counts",
  maintenance_controller.get_status_counts
);

router.get(
  "/maintenance",
  maintenance_controller.list_requests
);

router.get(
  "/maintenance/:request_id",
  maintenance_controller.get_request
);

router.post(
  "/properties/:property_id/maintenance",
  maintenance_controller.create_request
);

router.patch(
  "/maintenance/:request_id",
  maintenance_controller.update_request
);

module.exports = router;