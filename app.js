const path = require("path");
const fs = require("fs");
const YAML = require("yaml");
const swagger_ui = require("swagger-ui-express");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const auth_routes = require("./src/auth/auth_routes");
const user_routes = require("./src/users/user_routes");
const property_routes = require("./src/properties/property_routes");
const unit_routes = require("./src/units/unit_routes");
const tenant_routes = require("./src/tenants/tenant_routes");
const payment_routes = require("./src/payments/payment_routes");
const water_routes = require("./src/water/water_routes");
const expense_routes = require("./src/expenses/expense_routes");
const service_charge_routes = require("./src/service_charges/service_charge_routes");
const electricity_routes = require("./src/electricity/electricity_routes");
const deposit_routes = require("./src/deposits/deposit_routes");
const maintenance_routes = require("./src/maintenance/maintenance_routes");
const caretaker_routes = require("./src/caretakers/caretaker_routes");
const agreement_routes = require("./src/agreements/agreement_routes");
const sms_routes = require("./src/sms/sms_routes");
const report_routes = require("./src/reports/report_routes");
const settings_routes = require("./src/settings/settings_routes");
const admin_routes = require("./src/admin/admin_routes");

const {
  not_found,
  error_handler,
} = require("./src/middleware/error_middleware");

const openapi_document = YAML.parse(
  fs.readFileSync(
    path.join(__dirname, "docs", "openapi.yaml"),
    "utf8"
  )
);

const app = express();

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use(helmet());

app.use(
  cors({
    origin: process.env.FRONTEND_URL || true,
    exposedHeaders: ["Content-Disposition"],
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

/*
  Swagger documentation must be registered before not_found.
*/
app.use(
  "/api-docs",
  swagger_ui.serve,
  swagger_ui.setup(openapi_document)
);

app.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    status: "healthy",
    message: "Rental Management Backend is running",
  });
});

app.use("/api/auth", auth_routes);
app.use("/api/users", user_routes);
app.use("/api/properties", property_routes);

/*
  Must stay above the routers mounted on "/api": those apply
  their owner-only check to every path that reaches them.
*/
app.use("/api/admin", admin_routes);
app.use("/api", unit_routes);
app.use("/api", tenant_routes);
app.use("/api", payment_routes);
app.use("/api", water_routes);
app.use("/api", expense_routes);
app.use("/api", service_charge_routes);
app.use("/api", electricity_routes);
app.use("/api", deposit_routes);
app.use("/api", maintenance_routes);
app.use("/api", caretaker_routes);
app.use("/api", agreement_routes);
app.use("/api", sms_routes);
app.use("/api", report_routes);
app.use("/api", settings_routes);

app.use(not_found);
app.use(error_handler);

module.exports = app;