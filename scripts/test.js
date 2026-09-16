"use strict";
/* Real end-to-end test: boots the Express app on a test port, makes actual HTTP
   requests, and checks the results in Supabase. Node 22 has global fetch. */

require("dotenv").config();
const { app, pool } = require("../server.js");

const PORT = 3999;
const base = "http://127.0.0.1:" + PORT;
const marker = "exptest-" + Date.now();
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  PASS " + n + (x ? "  " + x : "")))
                            : (fail++, console.log("  FAIL " + n + (x ? "  " + x : ""))); };

(async () => {
  const server = app.listen(PORT);
  await new Promise((r) => server.once("listening", r));

  // 1. /logging records a hit (synthetic — carries the qa header)
  let r = await fetch(base + "/logging", {
    headers: {
      "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/144 Mobile",
      "accept-language": "ar-LB",
      "x-forwarded-for": "185.42.100.7, 10.0.0.1",
      "x-qa-test-id": marker,
    },
  });
  ok("/logging returns 200", r.status === 200);
  ok("/logging returns ok body", (await r.text()).includes("ok"));

  // 2. a plain path is NOT logged (served static / 404)
  r = await fetch(base + "/not-logging");
  ok("/not-logging is not the logger", r.status === 404 || !(await r.text()).includes("ok\n"));

  await new Promise((res) => setTimeout(res, 400)); // let the async insert land

  // 3. the row is in the database
  const got = (await pool.query("select is_synthetic, host(ip) as ip, path, qa_test_id from public.hits where qa_test_id=$1", [marker])).rows;
  ok("hit saved to Supabase", got.length === 1, JSON.stringify(got[0] || {}));
  ok("marked synthetic (qa tag present)", got[0] && got[0].is_synthetic === true);
  ok("client IP extracted from x-forwarded-for", got[0] && got[0].ip === "185.42.100.7", got[0] && got[0].ip);

  // 4. /api/data rejects a wrong password
  r = await fetch(base + "/api/data", { headers: { "x-dash-key": "nope" } });
  ok("/api/data wrong password -> 401", r.status === 401);

  // 5. /api/data returns data with the right password
  r = await fetch(base + "/api/data?limit=5", { headers: { "x-dash-key": process.env.DASHBOARD_PASSWORD } });
  ok("/api/data right password -> 200", r.status === 200);
  const body = await r.json();
  ok("data feed has stats + rows", body.stats && Array.isArray(body.rows), "total=" + (body.stats && body.stats.total));

  // 6. dashboard page serves
  r = await fetch(base + "/dashboard");
  ok("/dashboard serves the page", r.status === 200 && (await r.text()).includes("Octopus Traffic Monitor"));

  // cleanup
  await pool.query("delete from public.hits where qa_test_id=$1", [marker]);
  console.log("\ncleaned up test row.");

  server.close();
  await pool.end();
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
