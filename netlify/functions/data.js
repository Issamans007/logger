"use strict";
/* ---------------------------------------------------------------------------
   Protected read API for the dashboard.

   The browser must NEVER hold the database key, so the dashboard cannot query
   Supabase directly. Instead it calls this function, which:
     1. checks the password (compared to DASHBOARD_PASSWORD, timing-safe),
     2. if it matches, reads recent hits + a few stats from Postgres,
     3. returns them as JSON.

   The password travels over HTTPS (encrypted) in the x-dash-key header. It is
   never stored in the database and never sent to the browser.
--------------------------------------------------------------------------- */

const crypto = require("crypto");
const { Client } = require("pg");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const json = (code, obj) => ({
  statusCode: code,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return json(500, { error: "DASHBOARD_PASSWORD is not set on the server" });

  const headers = event.headers || {};
  const key = headers["x-dash-key"] || (event.queryStringParameters || {}).key;
  if (!safeEqual(key, expected)) return json(401, { error: "wrong password" });

  const q = event.queryStringParameters || {};
  const limit = Math.min(500, Math.max(1, parseInt(q.limit || "100", 10)));
  const filter = q.filter; // "synthetic" | "organic" | undefined

  let where = "";
  if (filter === "synthetic") where = "where is_synthetic = true";
  else if (filter === "organic") where = "where is_synthetic = false";

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
  });

  try {
    await client.connect();

    const stats = (await client.query(
      `select
         count(*)::int                                        as total,
         count(*) filter (where is_synthetic)::int            as synthetic,
         count(*) filter (where not is_synthetic)::int        as organic,
         count(distinct ip)::int                              as unique_ips,
         count(*) filter (where received_at > now() - interval '5 minutes')::int as last5m,
         max(received_at)                                     as last_hit
       from public.hits`
    )).rows[0];

    const rows = (await client.query(
      `select id, received_at, is_synthetic,
              host(ip) as ip, geo_country, geo_org,
              method, path, left(user_agent, 90) as ua, qa_test_id
       from public.hits
       ${where}
       order by received_at desc
       limit $1`,
      [limit]
    )).rows;

    return json(200, { stats, rows, serverTime: new Date().toISOString() });
  } catch (e) {
    return json(500, { error: e.message });
  } finally {
    await client.end().catch(() => {});
  }
};
