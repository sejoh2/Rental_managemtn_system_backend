const express = require("express");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");

const agent_data_service = require("./agent_data_service");
const { authenticate_agent } = require("./agent_data_auth");
const { log_audit } = require("../audit/audit_service");

/*
  The agent data API: read-only figures for the customer agent's
  reports and morning brief (agent_data_service.js). Every read is
  in the audit log as AGENT_DATA_READ.
*/
const router = express.Router();

const agent_limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests from the agent." },
});

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error = new Error("Invalid request.");

    error.status_code = 422;
    error.details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw error;
  }

  return result.data;
}

const days = z.coerce.number().int().min(1).max(365).default(30);

const summary_schema = z.object({ days }).strict();

const landlords_schema = z
  .object({
    days,
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(Object.keys(agent_data_service.SORTS)).default("active"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const landlord_schema = z.object({ landlord_id: z.coerce.number().int().positive() });

async function record_read(req, what, details) {
  await log_audit({
    action: "AGENT_DATA_READ",
    entity_type: "agent_data",
    metadata: { what, ...details },
    ip_address: req.ip,
  });
}

router.use(agent_limiter, authenticate_agent);

router.get("/summary", async (req, res) => {
  const query = validate(summary_schema, req.query);
  const result = await agent_data_service.summary(query);

  await record_read(req, "summary", query);

  return res.status(200).json({ success: true, ...result });
});

router.get("/landlords", async (req, res) => {
  const query = validate(landlords_schema, req.query);
  const result = await agent_data_service.landlords(query);

  await record_read(req, "landlords", { ...query, returned: result.landlords.length });

  return res.status(200).json({ success: true, ...result });
});

router.get("/landlords/:landlord_id", async (req, res) => {
  const { landlord_id } = validate(landlord_schema, req.params);
  const { days: period } = validate(summary_schema, req.query);
  const result = await agent_data_service.landlords({ days: period, owner_id: landlord_id, limit: 1, sort: "active" });

  if (!result.landlords.length) {
    return res.status(404).json({ success: false, error: "Landlord not found." });
  }

  await record_read(req, "landlord", { landlord_id, days: period });

  return res.status(200).json({ success: true, period_days: period, landlord: result.landlords[0] });
});

module.exports = router;
