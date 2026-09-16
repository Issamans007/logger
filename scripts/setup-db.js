"use strict";
/* Connects to the Supabase Postgres database and runs db/schema.sql.
   Reads the connection details from db/credential.txt so no secret is ever
   typed on the command line or printed. */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const CRED = path.join(__dirname, "..", "db", "credential.txt");
const SCHEMA = path.join(__dirname, "..", "db", "schema.sql");

function parseCred(text) {
  // Accepts either a full "postgresql://..." line, or "password: xxx" plus a
  // template connection string with [YOUR-PASSWORD] in it.
  const lines = text.split("\n").map((l) => l.trim());
  let url = lines.find((l) => l.startsWith("postgres"));
  const pwLine = lines.find((l) => /^password\s*:/i.test(l));
  const password = pwLine ? pwLine.split(/:(.+)/)[1].trim() : null;

  if (!url) throw new Error("No postgres connection string found in credential.txt");
  if (url.includes("[YOUR-PASSWORD]")) {
    if (!password) throw new Error("Connection string has [YOUR-PASSWORD] but no password line to fill it");
    url = url.replace("[YOUR-PASSWORD]", encodeURIComponent(password));
  }
  return { url, password };
}

// Build a pg config object from the URL so special characters in the password
// (/, *, etc.) never need manual URL-encoding.
function toConfig(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: (u.pathname || "/postgres").slice(1) || "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  };
}

// Supabase pooler (Supavisor) is IPv4-friendly. It lives at a region-specific
// host, and the user is "postgres.<project-ref>". We don't always know the
// region, so probe the common ones until one authenticates.
const REGIONS = [
  "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3",
  "us-east-1", "us-east-2", "us-west-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ca-central-1", "sa-east-1",
];

async function tryConnect(cfg, label) {
  const client = new Client(cfg);
  try {
    await client.connect();
    console.log(`Connected via ${label}`);
    return client;
  } catch (e) {
    await client.end().catch(() => {});
    return { error: e.message };
  }
}

async function main() {
  const { url, password } = parseCred(fs.readFileSync(CRED, "utf8"));
  const direct = toConfig(url);
  const ref = direct.host.match(/db\.([a-z0-9]+)\.supabase\.co/)?.[1]
           || direct.host.split(".")[0];
  const schema = fs.readFileSync(SCHEMA, "utf8");
  const pw = password || direct.password;

  let client = null;

  // 1. try the direct host as given
  console.log(`Trying direct host ${direct.host}:${direct.port} ...`);
  let r = await tryConnect(direct, "direct connection");
  if (r instanceof Client) client = r;
  else console.log("  direct failed (" + r.error.split("\n")[0] + ") — falling back to the IPv4 pooler");

  // 2. probe the pooler across regions (session mode, port 5432, runs a full script)
  if (!client) {
    for (const region of REGIONS) {
      const host = `aws-0-${region}.pooler.supabase.com`;
      const cfg = {
        host, port: 5432, user: `postgres.${ref}`, password: pw,
        database: "postgres", ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
      };
      process.stdout.write(`  pooler ${region} ... `);
      r = await tryConnect(cfg, `pooler ${region}`);
      if (r instanceof Client) { client = r; break; }
      console.log(r.error.split("\n")[0].slice(0, 50));
    }
  }

  if (!client) {
    console.error(
      "\nCould not connect on any endpoint. Grab the exact string yourself:\n" +
      "  Supabase dashboard -> Project Settings -> Database ->\n" +
      "  Connection string -> 'Session pooler' -> copy the postgresql://... line\n" +
      "  into db/credential.txt (replace [YOUR-PASSWORD] with your password) and rerun."
    );
    process.exit(1);
  }

  try {
    await client.query(schema);
    console.log("Schema applied.");

    const t = await client.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='hits' order by ordinal_position"
    );
    console.log(`\nTable public.hits created with ${t.rows.length} columns:`);
    console.log("  " + t.rows.map((r) => r.column_name).join(", "));

    const idx = await client.query(
      "select indexname from pg_indexes where schemaname='public' and tablename='hits'"
    );
    console.log(`\nIndexes: ${idx.rows.map((r) => r.indexname).join(", ")}`);

    const rls = await client.query(
      "select relrowsecurity from pg_class where relname='hits'"
    );
    console.log(`Row-level security enabled: ${rls.rows[0] && rls.rows[0].relrowsecurity}`);

    // Emit the .env the Netlify function needs. If we connected through the
    // pooler, reuse that host but switch to the transaction port (6543), which
    // is the one meant for short-lived serverless connections.
    const wc = client.connectionParameters;
    if (/pooler\.supabase\.com$/.test(wc.host)) {
      const enc = encodeURIComponent(pw);
      const dbUrl = `postgresql://${wc.user}:${enc}@${wc.host}:6543/postgres`;
      const envPath = path.join(__dirname, "..", ".env");
      fs.writeFileSync(envPath, `DATABASE_URL=${dbUrl}\n`, "utf8");
      console.log("\nWrote .env with DATABASE_URL (transaction pooler, port 6543).");
      console.log("That is the value you paste into Netlify later. .env is gitignored.");
    }

    console.log("\nDatabase is configured.");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
