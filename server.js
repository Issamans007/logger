"use strict";
/* ---------------------------------------------------------------------------
   Octopus traffic logger — a plain Express server.

   Three jobs, one process:
     GET/POST /logging   record the request into Supabase, return "ok"
     GET      /dashboard the password-gated live viewer (public/dash.html)
     GET      /api/data  the viewer's data feed (password checked here)
   everything else        static files from public/, not logged

   It keeps ONE database connection pool alive for the life of the process, so
   inserts are fast and Supabase sees few connections. Runs anywhere Node runs:
   Railway, Fly, Render, a VPS, or your own machine. Nothing is Netlify-specific.
--------------------------------------------------------------------------- */

require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy it from .env / your host's env vars.");
  process.exit(1);
}

// One pool for the whole process. The pooler endpoint (port 6543) is fine here;
// Express is long-lived, so connections are reused instead of reopened per hit.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});
pool.on("error", (e) => console.error("pg pool error:", e.message));

const app = express();
// Behind Railway/Fly/Render/etc the real client IP is in x-forwarded-for.
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" })); // for the dashboard's POST bodies

// -- helpers ---------------------------------------------------------------
function pick(headers, name) {
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.ip || null;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Gate for every /api/* route. Returns true if the caller is allowed; otherwise
// it has already sent the 401/500 and the caller must stop.
function authed(req, res) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) { res.status(500).json({ error: "DASHBOARD_PASSWORD not set on the server" }); return false; }
  const key = req.headers["x-dash-key"] || req.query.key;
  if (!safeEqual(key, expected)) { res.status(401).json({ error: "wrong password" }); return false; }
  return true;
}

// Build a WHERE clause from a filter name. Returns "" for none.
function filterClause(filter) {
  if (filter === "synthetic") return "where is_synthetic = true";
  if (filter === "organic") return "where is_synthetic = false";
  if (filter === "labeled") return "where label is not null";
  if (filter === "unlabeled") return "where label is null";
  return "";
}

// -- 1. the logger ---------------------------------------------------------
async function logHit(req, res) {
  const H = req.headers;
  // header order — preserved by Node's rawHeaders when we terminate TLS
  // ourselves (no proxy in front re-serialising them). This is the signal
  // Render/Netlify could never give us.
  const order = [];
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) order.push(raw[i]);

  const row = {
    method: req.method,
    host: pick(H, "host"),
    path: req.originalUrl.split("?")[0],
    query: req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : null,
    ip: clientIp(req),
    ip_chain: pick(H, "x-forwarded-for"),
    header_order: order,
    ja3: pick(H, "x-ja3") || pick(H, "x-ja3-hash"),   // filled by a JA3 front, if present
    geo_country: pick(H, "cf-ipcountry") || pick(H, "x-country") || pick(H, "fly-region"),
    user_agent: pick(H, "user-agent"),
    accept_language: pick(H, "accept-language"),
    referer: pick(H, "referer"),
    sec_ch_ua: pick(H, "sec-ch-ua"),
    sec_ch_ua_mobile: pick(H, "sec-ch-ua-mobile"),
    sec_ch_ua_platform: pick(H, "sec-ch-ua-platform"),
    sec_fetch_site: pick(H, "sec-fetch-site"),
    sec_fetch_mode: pick(H, "sec-fetch-mode"),
    sec_fetch_dest: pick(H, "sec-fetch-dest"),
    sec_fetch_user: pick(H, "sec-fetch-user"),
    qa_test_id: pick(H, "x-qa-test-id"),
    headers: JSON.stringify(H),
  };
  const cols = Object.keys(row);
  const sql =
    "insert into public.hits (" + cols.join(",") + ") values (" +
    cols.map((_, i) => "$" + (i + 1)).join(",") + ") returning id";
  let id = null;
  try {
    id = (await pool.query(sql, cols.map((c) => row[c]))).rows[0].id;
  } catch (e) {
    console.error("log insert failed:", e.message);
  }

  // For a real page load (GET), return a page that runs fp.js, so the browser
  // computes and posts back its fingerprint, keyed to this row. A beacon POST
  // just gets "ok" — it isn't executing scripts.
  if (req.method === "GET" && id != null) {
    res
      .status(200)
      .set("cache-control", "no-store")
      // ask the browser to include high-entropy UA hints on later requests too
      .set("Accept-CH", "Sec-CH-UA-Arch, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Bitness")
      .type("html")
      .send(
        "<!doctype html><meta charset=utf-8><title>ok</title>" +
        "<script>window.__oid=" + Number(id) + ";</script><script src=\"/fp.js\"></script>" +
        "<body style=\"font:14px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0b0f12;color:#8b97a0\">ok</body>"
      );
  } else {
    res.status(200).set("cache-control", "no-store").type("html").send("<!doctype html><meta charset=utf-8>ok");
  }
}
app.all("/logging", logHit);
app.all("/logging/*", logHit);

// The browser posts its computed fingerprint here, keyed to the hit's id.
// Public (like /logging) — it only adds fingerprint data to an existing row.
app.post("/fp", async (req, res) => {
  const { id, fp } = req.body || {};
  if (!id || typeof fp !== "object" || Array.isArray(fp)) return res.status(400).json({ error: "need id + fp object" });
  const json = JSON.stringify(fp);
  if (json.length > 100000) return res.status(413).json({ error: "fingerprint too large" });
  try {
    await pool.query("update public.hits set fp = $1 where id = $2", [json, Number(id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- 2. the dashboard page -------------------------------------------------
app.get("/dashboard", (_req, res) => res.sendFile(path.join(PUBLIC, "dash.html")));

// -- 3. the protected data feed --------------------------------------------
app.get("/api/data", async (req, res) => {
  if (!authed(req, res)) return;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "100", 10)));
  const where = filterClause(req.query.filter);

  try {
    const stats = (await pool.query(
      `select
         count(*)::int as total,
         count(*) filter (where is_synthetic)::int as synthetic,
         count(*) filter (where not is_synthetic)::int as organic,
         count(*) filter (where label is not null)::int as labeled,
         count(distinct ip)::int as unique_ips,
         count(*) filter (where received_at > now() - interval '5 minutes')::int as last5m,
         max(received_at) as last_hit
       from public.hits`
    )).rows[0];

    const rows = (await pool.query(
      `select id, received_at, is_synthetic, host(ip) as ip, ip_chain, geo_country, geo_org,
              method, path, query, user_agent as ua, accept_language, referer,
              sec_ch_ua_platform, qa_test_id, label, note, fp, ja3, header_order
       from public.hits ${where}
       order by received_at desc limit $1`,
      [limit]
    )).rows;

    res.set("cache-control", "no-store").json({ stats, rows, serverTime: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- 3b. bulk DELETE -------------------------------------------------------
// body: { ids: [1,2,3] }  OR  { all: true, filter: "organic" } to clear a view
app.post("/api/delete", async (req, res) => {
  if (!authed(req, res)) return;
  const { ids, all, filter } = req.body || {};
  try {
    let result;
    if (Array.isArray(ids) && ids.length) {
      result = await pool.query("delete from public.hits where id = any($1::bigint[])", [ids]);
    } else if (all) {
      const where = filterClause(filter);
      result = await pool.query(`delete from public.hits ${where}`);
    } else {
      return res.status(400).json({ error: "pass ids:[...] or all:true" });
    }
    res.json({ deleted: result.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- 3c. bulk LABEL / note update ------------------------------------------
// body: { ids: [..], label: "bot", note: "optional" }  (label:null clears it)
app.post("/api/label", async (req, res) => {
  if (!authed(req, res)) return;
  const { ids, label, note } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "pass ids:[...]" });
  try {
    const sets = ["label = $2"];
    const params = [ids, label == null || label === "" ? null : String(label).slice(0, 60)];
    if (note !== undefined) { sets.push("note = $3"); params.push(note ? String(note).slice(0, 500) : null); }
    const result = await pool.query(
      `update public.hits set ${sets.join(", ")} where id = any($1::bigint[])`, params
    );
    res.json({ updated: result.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- 3d. EXPORT (full dataset, or filtered) as CSV or JSON -----------------
app.get("/api/export", async (req, res) => {
  if (!authed(req, res)) return;
  const format = req.query.format === "json" ? "json" : "csv";
  const where = filterClause(req.query.filter);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  try {
    const rows = (await pool.query(
      `select id, received_at, is_synthetic, label, note, host(ip) as ip, ip_chain,
              geo_country, geo_asn, geo_org, method, path, query, user_agent,
              accept_language, referer, sec_ch_ua, sec_ch_ua_mobile, sec_ch_ua_platform,
              sec_fetch_site, qa_test_id
       from public.hits ${where} order by received_at desc`
    )).rows;

    if (format === "json") {
      res.set("content-disposition", `attachment; filename="hits-${stamp}.json"`)
         .type("application/json").send(JSON.stringify(rows, null, 2));
      return;
    }
    // CSV
    const cols = rows.length ? Object.keys(rows[0]) : ["id"];
    const esc = (v) => '"' + String(v == null ? "" : v).split('"').join('""') + '"';
    const lines = [cols.join(",")];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
    res.set("content-disposition", `attachment; filename="hits-${stamp}.csv"`)
       .type("text/csv").send(lines.join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- 4. everything else: static files, not logged --------------------------
app.use(express.static(PUBLIC));
app.use((_req, res) => res.status(404).type("txt").send("not found"));

// -- start (unless imported by a test) -------------------------------------
if (require.main === module) {
  const fs = require("fs");
  const http = require("http");
  const https = require("https");
  const certPath = process.env.TLS_CERT, keyPath = process.env.TLS_KEY;

  let server;
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    // We terminate TLS ourselves -> req.rawHeaders keeps the real header order.
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
      .listen(PORT, () => console.log(`octopus logger HTTPS on :${PORT}`));
    // plain HTTP on 80 just redirects to HTTPS
    const httpPort = Number(process.env.HTTP_PORT || 80);
    http.createServer((req, res) => {
      res.writeHead(301, { Location: "https://" + (req.headers.host || "").replace(/:\d+$/, "") + req.url });
      res.end();
    }).listen(httpPort, () => console.log(`HTTP redirect on :${httpPort}`));
  } else {
    server = app.listen(PORT, () => console.log(`octopus logger HTTP on :${PORT}`));
  }
  console.log(`  log endpoint : /logging   dashboard : /dashboard`);

  const shutdown = () => { server.close(() => pool.end().then(() => process.exit(0))); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { app, pool };
