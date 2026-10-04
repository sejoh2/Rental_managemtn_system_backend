const { Pool } = require("pg");

const ssl =
  process.env.DB_SSL === "true"
    ? { rejectUnauthorized: false }
    : false;

const config = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl,
    }
  : {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl,
    };

const pool = new Pool({
  ...config,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (error) => {
  console.error("[DATABASE] Unexpected pool error:", error.message);
});

async function test_connection() {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      NOW() AS connected_at
  `);

  return result.rows[0];
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  get_client: () => pool.connect(),
  test_connection,
};