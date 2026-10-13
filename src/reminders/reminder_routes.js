const express = require("express");
const { z } = require("zod");

const reminder_service = require("./reminder_service");

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

const settings_schema = z.object({
  enabled: z.boolean(),

  /*
    Days before the rent due day; 0 is the due day itself.
  */
  days_before: z.array(
    z.coerce.number()
      .int()
      .refine((days) =>
        reminder_service.days_before_choices.includes(days)
      )
  ).max(reminder_service.days_before_choices.length),

  /*
    The hour of the day in Kenya, 6 AM to 8 PM, so nobody is
    sent a message at night.
  */
  hour: z.coerce.number()
    .int()
    .min(6)
    .max(20),

  late_enabled: z.boolean(),

  late_days_after: z.coerce.number()
    .int()
    .refine((days) =>
      reminder_service.late_days_choices.includes(days)
    ),
}).refine(
  (data) => !data.enabled || data.days_before.length > 0,
  {
    path: ["days_before"],
    message:
      "Choose at least one day to send the reminder on.",
  }
);

function property_id_or_throw(value) {
  const id = Number(value);

  if (!Number.isInteger(id) || id < 1) {
    const error = new Error(
      "A valid property ID is required."
    );

    error.status_code = 422;
    throw error;
  }

  return id;
}

router.get(
  "/properties/:property_id/reminders",
  guard,
  async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await reminder_service.get_reminder_settings(
          req.user,
          property_id_or_throw(req.params.property_id)
        ),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  "/properties/:property_id/reminders",
  guard,
  async (req, res, next) => {
    try {
      const result = settings_schema.safeParse(req.body);

      if (!result.success) {
        const error = new Error(
          "Reminder settings are invalid."
        );

        error.status_code = 422;

        error.details = result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));

        throw error;
      }

      return res.status(200).json({
        success: true,
        message: "Reminder settings saved.",
        data: await reminder_service.update_reminder_settings(
          req.user,
          property_id_or_throw(req.params.property_id),
          result.data,
          req.ip
        ),
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
