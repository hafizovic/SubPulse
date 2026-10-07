"use strict";
// SubPulse server: static frontend, Google sign-in and a small JSON API.
// Usage: node server/index.js  →  http://localhost:5173
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./db");
const auth = require("./auth");
const sync = require("./sync");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 10_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(config.publicDir, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(config.publicDir + path.sep)) return json(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, config.baseUrl);
  const route = `${req.method} ${url.pathname}`;

  // Cross-site request protection for anything that changes state.
  if (req.method === "POST" && req.headers.origin !== config.baseUrl) return json(res, 403, { error: "bad_origin" });

  if (route === "GET /api/me") {
    if (!config.configured) return json(res, 200, { configured: false });
    const userId = await auth.currentUserId(req);
    const user = userId && (await db.getUser(userId));
    return json(res, 200, {
      configured: true,
      signedIn: Boolean(user),
      lastSyncAt: user?.lastSyncAt ?? null,
      canUnsubscribe: Boolean(user?.scopes.includes(auth.MANAGE_SCOPE)),
      quota: { used: await db.getUnits(sync.quotaDay()), limit: config.quotaLimit },
    });
  }

  if (url.pathname.startsWith("/auth/") && !config.configured) return json(res, 503, { error: "not_configured" });
  if (route === "GET /auth/login") return auth.startLogin(res, { upgrade: url.searchParams.get("upgrade") === "manage" });
  if (route === "GET /auth/callback") return auth.handleCallback(req, res, url);
  if (route === "POST /auth/logout") return auth.logout(req, res);

  if (url.pathname.startsWith("/api/")) {
    const userId = await auth.currentUserId(req);
    if (!userId) return json(res, 401, { error: "signed_out" });

    if (route === "GET /api/stats") return json(res, 200, { rows: await db.getUserStats(userId) });
    if (route === "GET /api/sync") return json(res, 200, { job: sync.getJob(userId) });
    if (route === "POST /api/sync") return json(res, 202, { job: sync.startSync(userId) });
    if (route === "POST /api/account/delete") return auth.deleteAccount(userId, res);
    if (route === "POST /api/unsubscribe") {
      const { channelId } = await readJson(req);
      if (typeof channelId !== "string" || !/^UC[\w-]{1,62}$/.test(channelId)) return json(res, 400, { error: "bad_channel" });
      const result = await sync.unsubscribe(userId, channelId);
      return json(res, result.status, result.body);
    }
    return json(res, 404, { error: "not_found" });
  }

  if (req.method === "GET") return serveStatic(req, res, decodeURIComponent(url.pathname));
  return json(res, 405, { error: "method_not_allowed" });
}

async function start() {
  await db.init(config.dbPath);
  await db.purge(Date.now() - config.maxDataAgeMs, Date.now());
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err.status === 400 || err.status === 413) return json(res, err.status, { error: err.message });
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: "server_error" });
      else res.end();
    });
  });
  await new Promise((resolve) => server.listen(config.port, "localhost", resolve));
  console.log(`SubPulse running at ${config.baseUrl}`);
  if (!config.configured) console.log("⚠ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in .env — see README.md");
  return server;
}

if (require.main === module) start();

module.exports = { start };
