const dotenv = require("dotenv");

dotenv.config();

const app = require("./app");

const db = require("./src/config/db");

const {
  init_auth_tables,
} = require("./src/auth/auth_tables");
const {
  init_property_tables,
} = require("./src/properties/property_tables");
const {
  init_unit_tables,
} = require("./src/units/unit_tables");
const {
  init_tenant_tables,
} = require("./src/tenants/tenant_tables");
const {
  init_payment_tables,
} = require("./src/payments/payment_tables");
const {
  init_water_tables,
} = require("./src/water/water_tables");
const {
  init_expense_tables,
} = require("./src/expenses/expense_tables");
const {
  init_maintenance_tables,
} = require("./src/maintenance/maintenance_tables");const {
  init_caretaker_tables,
} = require("./src/caretakers/caretaker_tables");
const {
  init_agreement_tables,
} = require("./src/agreements/agreement_tables");
const {
  init_sms_tables,
} = require("./src/sms/sms_tables");
const {
  start_sms_scheduler,
} = require("./src/sms/sms_service");
const {
  init_settings_tables,
} = require("./src/settings/settings_tables");


function require_environment_variable(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required in .env.`);
  }
}

async function start_server() {
  try {
    console.log("[STARTUP] Checking environment...");

    require_environment_variable("JWT_ACCESS_SECRET");
    require_environment_variable("JWT_REFRESH_SECRET");
    require_environment_variable("ADMIN_PHONE");

    if (process.env.SMS_MODE === "live") {
      require_environment_variable("AFRICASTALKING_USERNAME");
      require_environment_variable("AFRICASTALKING_API_KEY");
    }

    console.log("[STARTUP] Connecting to PostgreSQL...");

    require_environment_variable(
  "PAYMENT_CREDENTIAL_ENCRYPTION_KEY"
);

    const database = await db.test_connection();

    console.log(
      `[DATABASE] Connected successfully: ${database.database_name} as ${database.database_user}`
    );

    console.log("[STARTUP] Initializing authentication tables...");

    await init_auth_tables();
    await init_property_tables();
    await init_unit_tables();
    await init_tenant_tables();
    await init_payment_tables();
    await init_water_tables();
    await init_expense_tables();
    await init_maintenance_tables();
    await init_caretaker_tables();
    await init_agreement_tables();
    await init_sms_tables();
    await init_settings_tables();

    console.log("[PAYMENTS] Tables are ready.");

    console.log("[WATER] Tables are ready.");

    console.log("[EXPENSES] Tables are ready.");

    console.log("[MAINTENANCE] Tables are ready.");

    console.log("[CARETAKERS] Tables are ready.");

    console.log("[AGREEMENTS] Tables are ready.");

    console.log("[SMS] SMS Centre tables are ready.");

    console.log("[SETTINGS] Settings tables are ready.");
    
    start_sms_scheduler();

    console.log("[TENANTS] Tables are ready.");

    console.log("[UNITS] Tables are ready.");

    console.log("[PROPERTIES] Tables are ready.");
    console.log("[AUTH] Tables, indexes, triggers, and admin user are ready.");

    const port = Number(process.env.PORT) || 8080;

    app.listen(port, () => {
      console.log("");
      console.log("========================================");
      console.log("Rental Management Backend is running");
      console.log("========================================");
      console.log(`Local API: http://localhost:${port}`);
      console.log(`Health URL: http://localhost:${port}/health`);
      console.log("Active module: Authentication");
      console.log(`SMS mode: ${process.env.SMS_MODE || "console"}`);
      console.log("========================================");
      console.log("");
    });
  } catch (error) {
    console.error("");
    console.error("========================================");
    console.error("[STARTUP FAILED]", error.message);
    console.error("========================================");
    console.error("");

    process.exit(1);
  }
}

start_server();