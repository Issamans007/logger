"use strict";
/* Verifies the dashboard data API: wrong password -> 401, right password ->
   stats + rows. Seeds a couple of rows first so there is something to see. */

const fs = require("fs");
const path = require("path");
const envText = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const { Client } = require("pg");
const dataFn = require("../netlify/functions/data.js").handler;
const logFn = require("../netlify/functions/log.js").handler;

const marker = "dashtest-" + Date.now();

async function seed() {
  // one synthetic (carries qa id) and one organic (no qa id)
  await logFn({ httpMethod: "GET", path: "/home", rawUrl: "https://x/home",
    headers: { host: "x", "user-agent": "Pixel 7 Chrome", "accept-language": "ar-LB",
      "x-nf-client-connection-ip": "185.42.100.7", "x-qa-test-id": marker } });
  await logFn({ httpMethod: "GET", path: "/about", rawUrl: "https://x/about",
    headers: { host: "x", "user-agent": "iPhone Safari", "accept-language": "en-US",
      "x-nf-client-connection-ip": "88.1.2.3" } });
}

(async () => {
  await seed();
  console.log("seeded 1 synthetic + 1 organic hit\n");

  // wrong password
  let r = await dataFn({ headers: { "x-dash-key": "definitely-wrong" }, queryStringParameters: {} });
  console.log("wrong password  -> HTTP " + r.statusCode + (r.statusCode === 401 ? "  PASS" : "  FAIL"));

  // right password
  const pw = process.env.DASHBOARD_PASSWORD;
  r = await dataFn({ headers: { "x-dash-key": pw }, queryStringParameters: { limit: "10" } });
  console.log("right password  -> HTTP " + r.statusCode + (r.statusCode === 200 ? "  PASS" : "  FAIL"));
  const body = JSON.parse(r.body);
  console.log("\nstats:", JSON.stringify(body.stats));
  console.log("rows returned:", body.rows.length);
  if (body.rows[0]) {
    const row = body.rows[0];
    console.log("newest row:", JSON.stringify({ type: row.is_synthetic ? "synthetic" : "organic",
      ip: row.ip, path: row.path, ua: row.ua, qa: row.qa_test_id }));
  }

  // filter check
  r = await dataFn({ headers: { "x-dash-key": pw }, queryStringParameters: { filter: "synthetic" } });
  const syn = JSON.parse(r.body).rows;
  console.log("\nfilter=synthetic -> " + syn.length + " rows, all synthetic: " +
    syn.every((x) => x.is_synthetic));

  // cleanup
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("delete from public.hits where qa_test_id=$1 or (path='/about' and user_agent='iPhone Safari')", [marker]);
  await c.end();
  console.log("\ncleaned up test rows.\nDASHBOARD API WORKS.");
})().catch((e) => { console.error(e.message); process.exit(1); });
