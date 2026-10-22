const db = require("../config/db");

/*
  Kodi's own analytics: what the web app sends, and what the admin
  sees on Admin > Analytics. Everything stays in Kodi's database.

  Kept out on purpose: names, phone numbers, IP addresses, what
  people type, and the admin's own use. Numbers of 5 digits or
  more in a button's words (a phone, an amount) become "#".
*/

const KEEP_DAYS = 90;
const TZ = "Africa/Nairobi";

/*
  The path of a page without what could identify a record or a
  person: no query string, and IDs as ":id".
*/
function clean_path(value) {
  const path = String(value || "/").split(/[?#]/)[0] || "/";

  return (
    path
      .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/:id")
      .replace(/\/\d+(?=\/|$)/g, "/:id")
      .slice(0, 200) || "/"
  );
}

function clean_name(value) {
  if (value === null || value === undefined) return null;

  const name = String(value).replace(/\s+/g, " ").trim().replace(/\d{5,}/g, "#");

  return name ? name.slice(0, 120) : null;
}

/*
  A batch from one browser. Event times are the browser's, kept
  only when within the last day (a wrong clock gets "now").
*/
async function record_events({ visitor_id, session_id, events }, viewer) {
  if (viewer?.role === "admin") return { stored: 0 };

  const now = Date.now();
  const rows = events.map((event) => {
    const at = event.at ? Date.parse(event.at) : NaN;
    const occurred_at =
      Number.isFinite(at) && at <= now + 60 * 1000 && at >= now - 24 * 3600 * 1000
        ? new Date(at)
        : new Date(now);

    return [
      occurred_at,
      visitor_id,
      session_id,
      viewer?.user_id || null,
      viewer?.role || null,
      event.kind,
      clean_path(event.path),
      clean_name(event.name),
      event.source ? String(event.source).slice(0, 40) : null,
      event.device || null,
      Number.isInteger(event.duration_ms) ? Math.min(event.duration_ms, 6 * 3600 * 1000) : null,
    ];
  });

  if (!rows.length) return { stored: 0 };

  const values = [];
  const params = [];

  rows.forEach((row, index) => {
    const base = index * row.length;

    values.push(`(${row.map((_, i) => `$${base + i + 1}`).join(", ")})`);
    params.push(...row);
  });

  await db.query(
    `
      INSERT INTO analytics_events (
        occurred_at, visitor_id, session_id, user_id, role,
        kind, path, name, source, device, duration_ms
      )
      VALUES ${values.join(", ")}
    `,
    params
  );

  return { stored: rows.length };
}

/*
  The steps to becoming a Kodi owner, in order. A visitor counts at
  a step once, in the period shown.
*/
const FUNNEL = [
  { key: "home", label: "Visited the home page", where: "kind = 'page' AND path = '/'" },
  { key: "pricing", label: "Saw the prices", where: "kind = 'step' AND name = 'pricing_seen'" },
  { key: "get_account", label: "Tapped “Get an account”", where: "kind = 'step' AND name = 'get_account'" },
  { key: "code", label: "Asked for a sign-in code", where: "kind = 'step' AND name = 'code_requested'" },
  { key: "signed_in", label: "Signed in", where: "kind = 'step' AND name = 'signed_in'" },
  { key: "owner", label: "Used Kodi as an owner", where: "role = 'owner'" },
];

/*
  Everything on Admin > Analytics, for the last [days] days
  (at most 90: older clicks are no longer kept).
*/
async function summary(days) {
  const span = Math.min(Math.max(Number(days) || 30, 1), KEEP_DAYS);
  // The period is a value ($1), never part of the query's text.
  const since = "CURRENT_TIMESTAMP - make_interval(days => $1::INT)";
  const q = (sql, params = [span]) => db.query(sql, params).then((result) => result.rows);

  const [
    totals,
    daily,
    sources,
    devices,
    pages,
    clicks,
    exits,
    features,
    errors,
    funnel,
    monthly,
  ] = await Promise.all([
    q(`
      SELECT
        COUNT(DISTINCT visitor_id)::INT AS visitors,
        COUNT(DISTINCT session_id)::INT AS visits,
        COUNT(*) FILTER (WHERE kind = 'page')::INT AS page_views,
        COUNT(*) FILTER (WHERE kind = 'click')::INT AS clicks,
        COUNT(DISTINCT user_id) FILTER (WHERE role = 'owner')::INT AS active_owners,
        COUNT(*) FILTER (WHERE kind = 'error')::INT AS errors
      FROM analytics_events
      WHERE occurred_at >= ${since}
    `),
    q(`
      SELECT
        TO_CHAR((occurred_at AT TIME ZONE '${TZ}')::DATE, 'YYYY-MM-DD') AS day,
        COUNT(DISTINCT visitor_id)::INT AS visitors,
        COUNT(DISTINCT session_id)::INT AS visits,
        COUNT(*) FILTER (WHERE kind = 'page')::INT AS page_views
      FROM analytics_events
      WHERE occurred_at >= ${since}
      GROUP BY 1
      ORDER BY 1
    `),
    q(`
      SELECT COALESCE(source, 'direct') AS source, COUNT(DISTINCT session_id)::INT AS visits
      FROM analytics_events
      WHERE occurred_at >= ${since} AND kind = 'page'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 12
    `),
    q(`
      SELECT COALESCE(device, 'unknown') AS device, COUNT(DISTINCT session_id)::INT AS visits
      FROM analytics_events
      WHERE occurred_at >= ${since}
      GROUP BY 1
      ORDER BY 2 DESC
    `),
    q(`
      SELECT
        path,
        COUNT(*) FILTER (WHERE kind = 'page')::INT AS views,
        COUNT(DISTINCT visitor_id) FILTER (WHERE kind = 'page')::INT AS visitors,
        ROUND(AVG(duration_ms) FILTER (WHERE kind = 'leave') / 1000.0)::INT AS seconds
      FROM analytics_events
      WHERE occurred_at >= ${since} AND kind IN ('page', 'leave')
      GROUP BY path
      HAVING COUNT(*) FILTER (WHERE kind = 'page') > 0
      ORDER BY views DESC
      LIMIT 25
    `),
    q(`
      SELECT name, path, COUNT(*)::INT AS clicks, COUNT(DISTINCT visitor_id)::INT AS visitors
      FROM analytics_events
      WHERE occurred_at >= ${since} AND kind = 'click' AND name IS NOT NULL
      GROUP BY name, path
      ORDER BY clicks DESC
      LIMIT 25
    `),
    // The page each visit ended on: where people stop.
    q(`
      WITH last_page AS (
        SELECT DISTINCT ON (session_id) session_id, path
        FROM analytics_events
        WHERE occurred_at >= ${since} AND kind = 'page'
        ORDER BY session_id, occurred_at DESC
      ),
      page_counts AS (
        SELECT session_id, COUNT(*) AS pages
        FROM analytics_events
        WHERE occurred_at >= ${since} AND kind = 'page'
        GROUP BY session_id
      )
      SELECT
        last_page.path,
        COUNT(*)::INT AS exits,
        COUNT(*) FILTER (WHERE page_counts.pages = 1)::INT AS single_page
      FROM last_page
      INNER JOIN page_counts USING (session_id)
      GROUP BY last_page.path
      ORDER BY exits DESC
      LIMIT 20
    `),
    q(`
      SELECT path, COUNT(DISTINCT user_id)::INT AS owners, COUNT(*)::INT AS views
      FROM analytics_events
      WHERE occurred_at >= ${since} AND kind = 'page' AND role = 'owner'
      GROUP BY path
      ORDER BY owners DESC, views DESC
      LIMIT 40
    `),
    q(`
      SELECT name, path, COUNT(*)::INT AS times, COUNT(DISTINCT visitor_id)::INT AS visitors
      FROM analytics_events
      WHERE occurred_at >= ${since} AND kind = 'error'
      GROUP BY name, path
      ORDER BY times DESC
      LIMIT 20
    `),
    Promise.all(
      FUNNEL.map((step) =>
        q(`
          SELECT COUNT(DISTINCT visitor_id)::INT AS visitors
          FROM analytics_events
          WHERE occurred_at >= ${since} AND ${step.where}
        `).then((rows) => ({ key: step.key, label: step.label, visitors: rows[0].visitors }))
      )
    ),
    // All time, by month: the kept daily totals, plus the days not totalled yet.
    q(`
      SELECT month, SUM(page_views)::INT AS page_views, SUM(clicks)::INT AS clicks
      FROM (
        SELECT TO_CHAR(day, 'YYYY-MM') AS month,
          SUM(events) FILTER (WHERE kind = 'page') AS page_views,
          SUM(events) FILTER (WHERE kind = 'click') AS clicks
        FROM analytics_daily
        GROUP BY 1
        UNION ALL
        SELECT TO_CHAR((occurred_at AT TIME ZONE '${TZ}')::DATE, 'YYYY-MM') AS month,
          COUNT(*) FILTER (WHERE kind = 'page') AS page_views,
          COUNT(*) FILTER (WHERE kind = 'click') AS clicks
        FROM analytics_events
        WHERE (occurred_at AT TIME ZONE '${TZ}')::DATE NOT IN (SELECT day FROM analytics_rollups)
        GROUP BY 1
      ) AS months
      GROUP BY month
      ORDER BY month DESC
      LIMIT 24
    `, []),
  ]);

  return {
    days: span,
    kept_days: KEEP_DAYS,
    totals: totals[0],
    daily,
    sources,
    devices,
    pages,
    clicks,
    exits,
    features,
    errors,
    funnel,
    monthly,
  };
}

/*
  Each finished day (Nairobi time) is totalled into analytics_daily
  once; then events older than 90 days are removed, but only from
  days already totalled.
*/
async function roll_up_and_trim() {
  const client = await db.get_client();

  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext('analytics_rollup')) AS locked");

    if (!rows[0].locked) return { days: 0, removed: 0 };

    const due = await client.query(`
      SELECT DISTINCT (occurred_at AT TIME ZONE '${TZ}')::DATE AS day
      FROM analytics_events
      WHERE (occurred_at AT TIME ZONE '${TZ}')::DATE < (CURRENT_TIMESTAMP AT TIME ZONE '${TZ}')::DATE
        AND (occurred_at AT TIME ZONE '${TZ}')::DATE NOT IN (SELECT day FROM analytics_rollups)
      ORDER BY day
    `);

    for (const { day } of due.rows) {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO analytics_daily (day, kind, path, name, source, device, role, events, visitors)
          SELECT
            $1::DATE, kind, path, COALESCE(name, ''), COALESCE(source, ''),
            COALESCE(device, ''), COALESCE(role, ''), COUNT(*), COUNT(DISTINCT visitor_id)
          FROM analytics_events
          WHERE (occurred_at AT TIME ZONE '${TZ}')::DATE = $1::DATE
          GROUP BY kind, path, COALESCE(name, ''), COALESCE(source, ''), COALESCE(device, ''), COALESCE(role, '')
          ON CONFLICT (day, kind, path, name, source, device, role)
          DO UPDATE SET events = EXCLUDED.events, visitors = EXCLUDED.visitors
        `,
        [day]
      );
      await client.query("INSERT INTO analytics_rollups (day) VALUES ($1) ON CONFLICT DO NOTHING", [day]);
      await client.query("COMMIT");
    }

    const removed = await client.query(`
      DELETE FROM analytics_events
      WHERE occurred_at < CURRENT_TIMESTAMP - make_interval(days => ${Number(KEEP_DAYS)})
        AND (occurred_at AT TIME ZONE '${TZ}')::DATE IN (SELECT day FROM analytics_rollups)
    `);

    return { days: due.rows.length, removed: removed.rowCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('analytics_rollup'))").catch(() => {});
    client.release();
  }
}

let scheduler_started = false;

function start_analytics_scheduler() {
  if (scheduler_started) return;

  scheduler_started = true;

  const run = () =>
    roll_up_and_trim().catch((error) => console.error("[ANALYTICS] Daily totals failed:", error.message));

  setTimeout(run, 30 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = {
  KEEP_DAYS,
  clean_path,
  clean_name,
  record_events,
  summary,
  roll_up_and_trim,
  start_analytics_scheduler,
};
