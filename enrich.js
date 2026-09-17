"use strict";
/* ---------------------------------------------------------------------------
   IP enrichment.

   Turns a bare client IP into the network signals a firewall actually acts on:
   ASN, ISP/org, geo, and — most importantly — whether the IP is a
   datacenter/hosting range, a mobile carrier, or a proxy/VPN.

   Uses ip-api.com's free batch endpoint (no key, up to 100 IPs per call, and it
   returns the hosting/mobile/proxy flags for free). Runs as a periodic job on
   the VM (systemd timer) over rows that have not been enriched yet.

   Note: ip-api free is HTTP-only and for non-commercial use. For production or
   higher volume, swap in a MaxMind GeoLite2 ASN database (offline) or a paid
   ip-api / ipinfo key — the update logic below stays the same.
--------------------------------------------------------------------------- */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const FIELDS = "status,message,query,as,asname,isp,org,country,regionName,city,mobile,proxy,hosting";
const BATCH = 100;

async function enrichOnce() {
  // distinct IPs we haven't looked up yet
  const { rows } = await pool.query(
    "select distinct host(ip) as ip from public.hits where ip is not null and enriched_at is null limit $1",
    [BATCH]
  );
  if (!rows.length) return 0;
  const ips = rows.map((r) => r.ip);

  let data;
  try {
    const res = await fetch("http://ip-api.com/batch?fields=" + FIELDS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ips),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error("ip-api HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    console.error("lookup failed:", e.message);
    return 0;
  }

  let ok = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] || {};
    const ip = d.query || ips[i];
    if (d.status !== "success") {
      // mark attempted so we don't loop on it forever
      await pool.query("update public.hits set enriched_at = now() where host(ip) = $1 and enriched_at is null", [ip]);
      continue;
    }
    const asn = parseInt(String(d.as || "").replace(/^AS/i, "").split(" ")[0], 10) || null;
    const org = d.isp || d.org || d.asname || null;
    await pool.query(
      `update public.hits set
         geo_asn = $1, geo_org = $2, geo_country = coalesce(geo_country, $3),
         geo_region = $4, geo_city = $5,
         is_datacenter = $6, is_proxy = $7, is_mobile = $8, enriched_at = now()
       where host(ip) = $9`,
      [asn, org, d.country || null, d.regionName || null, d.city || null,
       !!d.hosting, !!d.proxy, !!d.mobile, ip]
    );
    ok++;
  }
  return ok;
}

async function main() {
  const loop = process.argv.includes("--loop");
  do {
    const n = await enrichOnce();
    if (n) console.log(new Date().toISOString(), "enriched", n, "IP(s)");
    if (loop && n === BATCH) {
      // more waiting; ip-api batch limit ~15/min, so pace ourselves
      await new Promise((r) => setTimeout(r, 5000));
    } else break;
  } while (true);
  await pool.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
