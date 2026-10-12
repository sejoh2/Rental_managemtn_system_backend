const express = require("express");

const electricity_service = require(
  "./electricity_service"
);

const {
  validate_list_bills,
  validate_save_bills,
  validate_property_id,
} = require("./electricity_validator");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const router = express.Router();

/*
  The guard is attached to each route, not to the whole router.
  This router is mounted on "/api" next to the others, and a
  router-wide check would also refuse requests meant for them.
*/
const guard = [
  authenticate,
  require_role("owner"),
];

router.get(
  "/properties/:property_id/electricity-bills",
  guard,
  async (req, res, next) => {
    try {
      const property_id = validate_property_id(
        req.params.property_id
      );

      const { period } = validate_list_bills(req.query);

      const result = await electricity_service.list_bills(
        req.user,
        property_id,
        period
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  "/properties/:property_id/electricity-bills",
  guard,
  async (req, res, next) => {
    try {
      const property_id = validate_property_id(
        req.params.property_id
      );

      const data = validate_save_bills(req.body);

      const result = await electricity_service.save_bills(
        req.user,
        property_id,
        data,
        req.ip
      );

      return res.status(200).json({
        success: true,
        message: "Electricity bills saved successfully.",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
