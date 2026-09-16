# Octopus traffic logger

A small, standalone **Express** server that records every request to `/logging`
into a Supabase database, and shows them on a password-gated live dashboard.

It runs anywhere Node runs — Railway, Fly, Render, a VPS, or your own machine.
Nothing is tied to a specific host.

## What it does

```
GET/POST  /logging     save the request -> Supabase, return "ok"
GET       /dashboard   live viewer (asks for a password)
GET       /api/data    the viewer's data feed (password checked here)
anything else          static files, NOT logged
```

Only `/logging` is recorded. Each saved row holds the method, path, IP,
User-Agent, language, Client Hints, and the full header set. Traffic from the
octopus generator carries an `x-qa-test-id` header, so those rows are flagged
`is_synthetic = true`; everything else is organic.

## Files

| Path | What |
|---|---|
| `server.js` | the whole server |
| `public/dash.html` | the dashboard page |
| `db/schema.sql` | the database table |
| `db/SETUP.md` | one-time Supabase setup |
| `scripts/setup-db.js` | connects and creates the table |
| `scripts/test.js` | end-to-end test (boots the server, hits it, checks the DB) |

## Run it on your own machine

```bash
npm install
npm run setup-db     # once: creates the table in Supabase (reads db/credential.txt)
npm start            # starts the server on http://localhost:3000
```

Open **http://localhost:3000/dashboard**, enter your password, and watch traffic.
Send a test hit: open **http://localhost:3000/logging** — a row appears.

`.env` holds three values (all gitignored):

```
DATABASE_URL=...          # Supabase connection string (setup-db writes this)
DASHBOARD_PASSWORD=...    # password to open the dashboard
PORT=3000                 # optional; the host sets this in production
```

## Deploy it free (recommended: Railway — does not sleep)

1. Go to **https://railway.app** → sign in with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `Issamans007/logger`.
3. Railway detects Node and runs `npm start` automatically.
4. **Variables** tab → add:
   - `DATABASE_URL` — copy the value from your local `.env`
   - `DASHBOARD_PASSWORD` — your password
5. **Settings → Networking → Generate Domain** to get a public URL.

Your logger is then live at `https://your-app.up.railway.app/logging`, and the
dashboard at `.../dashboard`.

> **Fly.io** and **Render** work the same way (they honor `npm start` and the
> `Procfile`). Avoid Render's *free* tier for this — it sleeps after 15 min of
> no traffic and would miss the first request after each idle. Railway and Fly
> stay awake.

## Public collector, private dashboard (optional, more secure)

You can run the collector in the cloud but only ever open the dashboard on your
own PC. Since both read the same Supabase database, `npm start` locally shows the
exact same live data the cloud server is collecting. If you never open
`/dashboard` in the cloud, the admin screen never sits on the open internet.

## Test

```bash
npm test
```

Boots the server on a test port, sends real HTTP requests, and verifies each one
landed correctly in Supabase (then cleans up).
