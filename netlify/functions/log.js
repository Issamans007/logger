"use strict";
/* ---------------------------------------------------------------------------
   The listener.

   Every request to the site is routed here (see netlify.toml). It reads what
   the edge can see about the caller, writes one row to the Supabase `hits`
   table, and returns a tiny page. Nothing about the caller is trusted or acted
   on — it is only recorded.

   It connects straight to Postgres through the Supabase transaction pooler
   using DATABASE_URL, so it needs no Supabase API keys — just the one
   connection string, set as a Netlify environment variable.
--------------------------------------------------------------------------- */

const { Client } = require("pg");

// Pull a header case-insensitively (Netlify lowercases them, but be safe).
function h(headers, name) {
  if (!headers) return null;
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// Best-guess client IP. Netlify sets x-nf-client-connection-ip to the real one;
// x-forwarded-for is the full chain (client, proxies...). We keep both.
function clientIp(headers) {
  const nf = h(headers, "x-nf-client-connection-ip");
  if (nf) return nf.trim();
  const xff = h(headers, "x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return null;
}

const PAGE =
  "<!doctype html><meta charset=utf-8><title>ok</title>" +
  "<body style='font:14px system-ui;padding:2rem'>ok</body>";

exports.handler = async (event) => {
  const headers = event.headers || {};
  const ip = clientIp(headers);
  const xff = h(headers, "x-forwarded-for");

  const row = {
    method: event.httpMethod || null,
    host: h(headers, "host"),
    path: event.path || null,
    query: event.rawQuery || (event.rawUrl ? event.rawUrl.split("?")[1] || null : null),
    ip: ip,
    ip_chain: xff,
    geo_country: h(headers, "x-country") || h(headers, "x-nf-geo-country"),
    geo_city: h(headers, "x-nf-geo-city"),
    user_agent: h(headers, "user-agent"),
    accept_language: h(headers, "accept-language"),
    referer: h(headers, "referer"),
    sec_ch_ua: h(headers, "sec-ch-ua"),
    sec_ch_ua_mobile: h(headers, "sec-ch-ua-mobile"),
    sec_ch_ua_platform: h(headers, "sec-ch-ua-platform"),
    sec_fetch_site: h(headers, "sec-fetch-site"),
    sec_fetch_mode: h(headers, "sec-fetch-mode"),
    sec_fetch_dest: h(headers, "sec-fetch-dest"),
    sec_fetch_user: h(headers, "sec-fetch-user"),
    qa_test_id: h(headers, "x-qa-test-id"),
    headers: JSON.stringify(headers),
  };

  const cols = Object.keys(row);
  const params = cols.map((_, i) => "$" + (i + 1));
  const sql =
    "insert into public.hits (" + cols.join(",") + ") values (" + params.join(",") + ")";

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
  });

  try {
    await client.connect();
    await client.query(sql, cols.map((c) => row[c]));
  } catch (e) {
    // Never fail the response because logging failed — just record it server-side.
    console.error("log insert failed:", e.message);
  } finally {
    await client.end().catch(() => {});
  }

  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: PAGE,
  };
};
