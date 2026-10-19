const express = require("express");
const { z } = require("zod");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

const subscriptions = require("./subscription_service");
const payments = require("./subscription_payment_service");
const mpesa = require("./subscription_mpesa");
const dates = require("./subscription_dates");
const { send_receipt, parse, respond } = require("./subscription_routes");

/*
  The admin's Billing page: every landlord's account, and the
  changes only the admin may make. Each change needs a reason and
  is recorded with what it was before and after.
*/
const router = express.Router();

router.use(authenticate);
router.use(require_role("admin"));

const id_param = z.coerce.number().int().positive();
const reason = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(500);

router.get(
  "/",
  respond(async () => ({
    settings: await subscriptions.get_settings(),
    plans: await subscriptions.list_plans(),
    accounts: await subscriptions.list_accounts(),
    mpesa: { configured: mpesa.configured(), environment: mpesa.env() },
  }))
);

router.put(
  "/settings",
  respond((req) =>
    subscriptions.update_settings(
      req.user,
      parse(
        z
          .object({
            monthly_price: z.number().int().min(1).max(1000000).optional(),
            grace_days: z.number().int().min(0).max(30).optional(),
            reason,
          })
          .strict()
          .refine((value) => value.monthly_price !== undefined || value.grace_days !== undefined, "Change the price or the grace days."),
        req.body || {}
      ),
      req.ip
    )
  )
);

router.put(
  "/plans/:months",
  respond((req) =>
    subscriptions.update_plan(
      req.user,
      parse(z.coerce.number().int().min(1).max(24), req.params.months),
      parse(
        z
          .object({
            name: z.string().trim().min(1).max(40).optional(),
            tagline: z.string().trim().max(160).nullable().optional(),
            features: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
            most_popular: z.boolean().optional(),
            discount_percent: z.number().min(0).max(90).optional(),
            enabled: z.boolean().optional(),
            offer_percent: z.number().gt(0).max(90).nullable().optional(),
            offer_label: z.string().trim().max(60).nullable().optional(),
            offer_ends_on: z.string().date().nullable().optional(),
            reason: reason.optional(),
          })
          .strict(),
        req.body || {}
      ),
      req.ip
    )
  )
);

router.get("/owners/:owner_id", respond((req) => subscriptions.account_detail(parse(id_param, req.params.owner_id))));

const months_schema = z.object({ months: z.number().int().min(1).max(12), reason }).strict();

router.post(
  "/owners/:owner_id/extend-trial",
  respond((req) => subscriptions.extend_trial(req.user, parse(id_param, req.params.owner_id), parse(months_schema, req.body || {}), req.ip))
);

router.post(
  "/owners/:owner_id/end-grace",
  respond((req) => subscriptions.end_grace(req.user, parse(id_param, req.params.owner_id), parse(z.object({ reason }).strict(), req.body || {}), req.ip))
);

router.post(
  "/owners/:owner_id/end-trial",
  respond((req) =>
    subscriptions.end_trial(
      req.user,
      parse(id_param, req.params.owner_id),
      parse(z.object({ first_bill: z.enum(["full", "prorated", "next_month"]), reason }).strict(), req.body || {}),
      req.ip
    )
  )
);

router.post(
  "/owners/:owner_id/free-months",
  respond((req) => subscriptions.give_free_months(req.user, parse(id_param, req.params.owner_id), parse(months_schema, req.body || {}), req.ip))
);

router.post(
  "/owners/:owner_id/discounts",
  respond((req) =>
    subscriptions.create_discount(
      req.user,
      parse(id_param, req.params.owner_id),
      parse(
        z
          .object({
            kind: z.enum(["percent", "amount"]),
            value: z.number().int().min(1).max(1000000),
            months: z.number().int().min(1).max(36).nullable().optional(),
            reason,
          })
          .strict()
          .refine((value) => value.kind !== "percent" || value.value <= 100, "A percentage is at most 100."),
        req.body || {}
      ),
      req.ip
    )
  )
);

router.post(
  "/discounts/:discount_id/end",
  respond((req) => subscriptions.end_discount(req.user, parse(id_param, req.params.discount_id), parse(z.object({ reason }).strict(), req.body || {}), req.ip))
);

router.put(
  "/invoices/:invoice_id/amount",
  respond((req) =>
    subscriptions.set_invoice_amount(
      req.user,
      parse(id_param, req.params.invoice_id),
      parse(z.object({ amount: z.number().int().min(1).max(10000000), remainder: z.enum(["forgive", "carry"]), reason }).strict(), req.body || {}),
      req.ip
    )
  )
);

router.post(
  "/invoices/:invoice_id/payments",
  respond(async (req) => {
    const body = parse(
      z
        .object({
          amount: z.number().int().min(1).max(10000000),
          method: z.enum(["cash", "bank", "mpesa_other", "other"]),
          reference: z.string().trim().max(100).optional(),
          paid_on: z.string().date(),
          note: reason,
        })
        .strict(),
      req.body || {}
    );
    const result = await subscriptions.record_manual_payment(req.user, parse(id_param, req.params.invoice_id), body, req.ip);

    await payments.notify_owner(
      result.payment.owner_id,
      `Kodi: payment received, ${payments.money(body.amount)}. Paid until ${dates.label(result.settled.paid_through)}. Your receipt is in Kodi, Settings, Billing. Thank you!`
    );

    return result;
  })
);

// Sends the M-Pesa prompt for a landlord's current bill.
router.post(
  "/owners/:owner_id/request-payment",
  respond((req) => {
    const body = parse(z.object({ phone: z.string().trim().max(20).optional() }).strict(), req.body || {});

    return payments.request_payment({ owner_id: parse(id_param, req.params.owner_id), phone_input: body.phone, requested_by: req.user.user_id, ip_address: req.ip, show_details: true });
  })
);

router.get("/receipts/:payment_id", async (req, res, next) => {
  try {
    return await send_receipt(res, parse(id_param, req.params.payment_id));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
