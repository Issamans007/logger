"use strict";
/* Calls the logger function locally with a fake request, then reads the row
   back — proves the whole path (function -> Supabase) works before deploying. */

const fs = require("fs");
const path = require("path");

// load .env
const envText = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const { handler } = require("../netlify/functions/log.js");
const { Client } = require("pg");

const marker = "test-" + Date.now();

const fakeEvent = {
  httpMethod: "GET",
  path: "/pricing",
  rawQuery: "utm_source=probe",
  rawUrl: "https://listener.example/pricing?utm_source=probe",
  headers: {
    host: "octopus-listener.netlify.app",
    "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/144 Mobile Safari/537.36",
    "accept-language": "ar-LB,ar;q=0.9,en;q=0.7",
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-site": "none",
    "sec-fetch-mode": "navigate",
    "x-nf-client-connection-ip": "185.42.100.7",
    "x-forwarded-for": "185.42.100.7, 100.64.0.1",
    "x-qa-test-id": marker,
  },
};

(async () => {
  console.log("calling handler with a fake Android request (qa_test_id=" + marker + ") ...");
  const res = await handler(fakeEvent);
  console.log("handler returned:", res.statusCode);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    "select id, received_at, is_synthetic, host(ip) as ip, method, path, qa_test_id, left(user_agent,40) as ua from public.hits where qa_test_id=$1",
    [marker]
  );
  if (!rows.length) {
    console.error("FAIL: no row was written");
    process.exit(1);
  }
  console.log("\nrow landed in Supabase:");
  console.log(rows[0]);
  console.log("\nis_synthetic =", rows[0].is_synthetic, "(true because the qa_test_id join key was present)");

  await client.query("delete from public.hits where qa_test_id=$1", [marker]);
  console.log("cleaned up the test row.");
  await client.end();
  console.log("\nLOGGER WORKS end to end.");
})().catch((e) => { console.error(e.message); process.exit(1); });
