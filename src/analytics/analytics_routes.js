const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");

const analytics = require("./analytics_service");
const token_service = require("../security/token_service");

const {
  authenticate,
} = require("../auth/auth_middleware");

const {
  require_role,
} = require("../middleware/role_middleware");

/*
  Kodi's own analytics.
  POST /events   what the web app sends (anyone, signed in or not)
  GET  /summary  Admin > Analytics (the admin only)
*/
const router = express.Router();

// Per network address, far above what one browser sends (one batch every few seconds).
const events_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});

const admin_limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a minute." },
});

const random_id = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

const batch_schema = z.object({
  visitor_id: random_id,
  session_id: random_id,
  events: z.array(
    z.object({
      kind: z.enum(["page", "click", "step", "error", "leave"]),
      path: z.string().max(500),
      name: z.string().max(300).nullable().optional(),
      at: z.string().max(40).optional(),
      source: z.string().max(40).nullable().optional(),
      device: z.enum(["mobile", "tablet", "desktop"]).nullable().optional(),
      duration_ms: z.number().int().min(0).nullable().optional(),
    }).strict()
  ).min(1).max(30),
}).strict();

/*
  Who sent it, if signed in. A missing or expired sign-in is not an
  error here: the events are kept without a person.
*/
function viewer(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) return null;

  try {
    const decoded = token_service.verify_access_token(header.slice(7));

    return { user_id: decoded.user_id, role: decoded.role };
  } catch {
    return null;
  }
}

router.post("/events", events_limiter, async (req, res, next) => {
  try {
    const parsed = batch_schema.safeParse(req.body || {});

    if (!parsed.success) {
      return res.status(422).json({ success: false, error: "Analytics data is invalid." });
    }

    await analytics.record_events(parsed.data, viewer(req));

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.get(
  "/summary",
  admin_limiter,
  authenticate,
  require_role("admin"),
  async (req, res, next) => {
    try {
      return res.status(200).json({
        success: true,
        data: await analytics.summary(req.query.days),
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
