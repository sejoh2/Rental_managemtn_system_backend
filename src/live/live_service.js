const { Client } = require("pg");

const db = require("../config/db");
const token_service = require("../security/token_service");

const {
  get_user_for_session,
} = require("../auth/auth_service");

/*
  Live bells. A browser keeps one connection open (Server-Sent
  Events); when the database announces that a bell changed (see
  live_tables.js), every open connection for that bell is told
  "look again", and the browser then fetches the counts the
  normal, signed-in way. No data travels on the live connection.

  Every running server listens to the database, so this works
  with more than one server on the same database.
*/

const CHANNEL = "bell_changed";

// Keeps proxies (Cloudflare closes after about 100 seconds of silence) from closing it.
const HEARTBEAT_MS = 25 * 1000;

// How often a connection's sign-in session is checked again, so signing out ends it.
const SESSION_CHECK_MS = 5 * 60 * 1000;

// More than this many open connections for one person are refused.
const MAX_PER_USER = 10;

const clients = new Set();

let listener = null;
let reconnect_timer = null;
let reconnect_delay_ms = 5000;

function send(client, event) {
  try {
    client.res.write(`event: ${event}\ndata: {}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function deliver(message) {
  for (const client of clients) {
    const for_admin =
      message.to === "admin" && client.scope === "admin";

    const for_owner =
      message.to === "owner" &&
      client.scope === "owner" &&
      String(client.owner_id) === String(message.owner_id);

    if (for_admin || for_owner) {
      send(client, "bell");
    }
  }
}

/*
  Announcements made while the listener was down were missed:
  every bell looks again once it is back.
*/
function tell_everyone_to_look_again() {
  for (const client of clients) {
    send(client, "bell");
  }
}

function schedule_reconnect() {
  if (reconnect_timer) return;

  listener = null;

  reconnect_timer = setTimeout(() => {
    reconnect_timer = null;
    start_live_listener();
  }, reconnect_delay_ms);

  reconnect_delay_ms = Math.min(reconnect_delay_ms * 2, 60000);
}

/*
  One dedicated database connection, outside the pool, that only
  listens. It reconnects by itself if the database drops it.
*/
async function start_live_listener() {
  const client = new Client({
    ...db.config,
    application_name: "kodi-backend-live",
  });

  client.on("notification", (notification) => {
    try {
      deliver(JSON.parse(notification.payload));
    } catch {
      // An announcement that cannot be read is ignored.
    }
  });

  client.on("error", (error) => {
    console.error("[LIVE] Listener connection lost:", error.message);
    client.end().catch(() => {});
    schedule_reconnect();
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);

    const was_reconnect = reconnect_delay_ms > 5000;

    listener = client;
    reconnect_delay_ms = 5000;

    if (was_reconnect) {
      tell_everyone_to_look_again();
    }

    console.log("[LIVE] Listening for bell changes.");
  } catch (error) {
    console.error("[LIVE] Could not start listening:", error.message);
    client.end().catch(() => {});
    schedule_reconnect();
  }
}

/*
  Heartbeats, and closing connections whose sign-in has ended.
*/
let ticks = 0;

const ticks_per_session_check = Math.round(
  SESSION_CHECK_MS / HEARTBEAT_MS
);

setInterval(async () => {
  ticks += 1;

  for (const client of clients) {
    try {
      client.res.write(": ping\n\n");
    } catch {
      clients.delete(client);
    }
  }

  if (ticks % ticks_per_session_check !== 0) return;

  for (const client of [...clients]) {
    try {
      const user = await get_user_for_session(
        client.user_id,
        client.session_id
      );

      if (!user || user.status !== "active") {
        clients.delete(client);
        client.res.end();
      }
    } catch {
      // The database is busy; checked again next time.
    }
  }
}, HEARTBEAT_MS).unref();

/*
  A short-lived pass for opening the live connection. Browsers
  cannot send the sign-in token on such a connection, and putting
  the token itself in the address would leave it in server logs;
  this pass works for one minute and for nothing else.

  scope "admin": the admin's bell. scope "owner": the bell of the
  owner account in use (an admin inside an owner's account gets
  that owner's bell).
*/
function create_ticket(req, scope) {
  const signed_in = req.admin || req.user;

  if (scope === "admin") {
    if (signed_in.role !== "admin") {
      const error = new Error("Only the administrator has this bell.");

      error.status_code = 403;
      throw error;
    }

    return token_service.create_live_ticket({
      user_id: signed_in.user_id,
      session_id: req.session_id,
      scope: "admin",
      owner_id: null,
    });
  }

  if (req.user.role !== "owner") {
    const error = new Error("Only owners have this bell.");

    error.status_code = 403;
    throw error;
  }

  return token_service.create_live_ticket({
    user_id: signed_in.user_id,
    session_id: req.session_id,
    scope: "owner",
    owner_id: req.user.user_id,
  });
}

async function open_stream(req, res) {
  let ticket;

  try {
    ticket = token_service.verify_live_ticket(
      String(req.query.ticket || "")
    );
  } catch {
    return res.status(401).json({
      success: false,
      error: "The live connection pass is missing or has run out.",
    });
  }

  const user = await get_user_for_session(
    ticket.user_id,
    ticket.sid
  );

  if (
    !user ||
    user.status !== "active" ||
    (ticket.scope === "admin" && user.role !== "admin")
  ) {
    return res.status(401).json({
      success: false,
      error: "Sign in again to receive live notifications.",
    });
  }

  const open_for_user = [...clients].filter(
    (client) => String(client.user_id) === String(ticket.user_id)
  ).length;

  if (open_for_user >= MAX_PER_USER) {
    return res.status(429).json({
      success: false,
      error: "Too many live connections are open. Close some tabs.",
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tells proxies not to hold messages back.
    "X-Accel-Buffering": "no",
  });

  // How long the browser waits before reconnecting by itself.
  res.write("retry: 10000\n\n");

  const client = {
    res,
    scope: ticket.scope,
    owner_id: ticket.owner_id,
    user_id: ticket.user_id,
    session_id: ticket.sid,
  };

  clients.add(client);
  send(client, "ready");

  req.on("close", () => {
    clients.delete(client);
  });

  return undefined;
}

function live_status() {
  return {
    listening: Boolean(listener),
    open_connections: clients.size,
  };
}

module.exports = {
  start_live_listener,
  create_ticket,
  open_stream,
  live_status,
};
