# Deploy the listener to Netlify (free)

The database is already set up and the logger is tested. This puts it online.

## What you're deploying

A tiny website. Every visit to any path on it gets written as one row in your
Supabase `hits` table, then the visitor sees a plain "ok" page. That's it.

## One-time: install the Netlify tool

```bash
npm install -g netlify-cli
```

## Deploy

From the `listener/` folder:

```bash
netlify login          # opens your browser, sign in / create a free account
netlify deploy --prod  # uploads the site + the logger function
```

When it asks, choose **"Create & configure a new site"**, pick your team, and
give it a name like `octopus-listener`. It reads `netlify.toml` automatically.

At the end it prints your URL, e.g. `https://octopus-listener.netlify.app`.

## Give it the database secret

The function needs `DATABASE_URL` (already in your local `.env`). Upload it:

```bash
netlify env:import .env
```

Then redeploy once so the function picks it up:

```bash
netlify deploy --prod
```

## Check it works

1. Open your Netlify URL in a browser — you'll see "ok".
2. In Supabase → SQL Editor, run:
   ```sql
   select * from public.recent;
   ```
   You should see your visit as a row (with your real UA, IP, language).

Done. It now logs everything that reaches it.

## Notes

- **Free limits:** 125,000 function calls and 100 GB traffic per month. Far more
  than you need for testing.
- **The secret:** `DATABASE_URL` lives only in Netlify's env settings and your
  gitignored `.env`. Never commit it.
- **Pointing traffic at it:** to test the collector, add your Netlify URL to the
  octopus generator's target allowlist and aim a run at it — every session shows
  up in `hits`, tagged `is_synthetic = true` via the `x-qa-test-id` header. To
  capture organic visitors later, embed a 1-pixel beacon on any site you own
  that requests your Netlify /logging URL.
