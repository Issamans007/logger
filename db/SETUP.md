# Supabase setup — Octopus traffic listener

Do this once. Takes about 5 minutes. You need a browser; I can't create the
project for you (it needs your Supabase login).

## 1. Create the project

1. Go to **https://supabase.com** → sign in (GitHub login is easiest).
2. **New project**.
   - **Name:** `octopus-listener`
   - **Database password:** generate a strong one and save it (you rarely need
     it, but you can't recover it — only reset it).
   - **Region:** pick the one closest to where issamansour.com's real visitors
     are. For Lebanon, **Frankfurt (eu-central-1)** is the usual best latency.
   - **Plan:** Free.
3. Wait ~2 minutes for it to provision.

## 2. Create the table

1. Left sidebar → **SQL Editor** → **New query**.
2. Open `schema.sql` (next to this file), copy all of it, paste, and press
   **Run** (or Ctrl/Cmd+Enter).
3. You should see `Success. No rows returned`.

## 3. Grab the two secrets the listener needs

Left sidebar → **Project Settings** (gear) → **API**:

| Copy this | Used as | Secret? |
|---|---|---|
| **Project URL** (`https://xxxx.supabase.co`) | `SUPABASE_URL` | no |
| **service_role** key (under *Project API keys*, click *Reveal*) | `SUPABASE_SERVICE_KEY` | **YES — never put in a browser or commit it** |

These become environment variables on Netlify when we build the function.
The `anon` / `publishable` key is **not** used here — the listener writes with
`service_role` so the data table can stay fully private.

## 4. Verify it works

Back in the SQL Editor, run a manual insert and read it back:

```sql
insert into public.hits (method, path, user_agent, qa_test_id)
values ('GET', '/verify', 'setup-smoke-test', 'setup-1');

select * from public.recent;
```

You should see one row, with `is_synthetic = true` (because it has a
`qa_test_id`). Then clean it up:

```sql
delete from public.hits where qa_test_id = 'setup-1';
```

## Free-tier facts worth knowing

- **500 MB database.** A hit row is ~1–2 KB, so ~250k–500k hits before it fills.
  Add a retention job later (`delete from hits where received_at < now() -
  interval '30 days'`) once you know your volume.
- **Pauses after 7 days of no activity.** A paused project stops accepting
  writes until you un-pause it in the dashboard. Real traffic keeps it awake; if
  you go quiet, check it's not paused before a test run.
- **RLS is on with no policies**, so nothing is readable through the public API —
  only the service_role key (server-side) can touch the data. That is the intended
  state; don't add a public read policy.

## What's next (not this step)

Once the two secrets exist, the Netlify function is small: it receives each
request, pulls the promoted headers, and inserts one `hits` row using
`SUPABASE_SERVICE_KEY`. Geo/ASN enrichment (the `is_datacenter` signal — the one
that actually separates residential from hosting) runs as a later pass over rows
where `geo_asn is null`.
