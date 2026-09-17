-- ===========================================================================
-- Octopus traffic listener — Supabase schema
--
-- Run this once: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- One row per HTTP hit the Netlify listener receives. Columns are split into
-- "promoted" signals (the ones you will actually filter and group by) plus a
-- `headers` jsonb catch-all that keeps everything verbatim, so nothing is lost
-- even before you decide it matters.
--
-- What the edge CAN capture: method, path, query, IP, UA, Client Hints,
-- Sec-Fetch-*, Accept-Language, Referer, and (via a later enrichment pass)
-- geo/ASN from the IP.
-- What it CANNOT: JA3/TLS fingerprint and true header order — Netlify
-- terminates TLS and normalizes headers before your function runs. Those
-- columns exist but stay null until a raw-socket collector fills them.
-- ===========================================================================

create table if not exists public.hits (
  id            bigint generated always as identity primary key,
  received_at   timestamptz not null default now(),

  -- request line ----------------------------------------------------------
  method        text,
  host          text,
  path          text,
  query         text,

  -- who / where -----------------------------------------------------------
  ip            inet,          -- best-guess client IP (x-nf-client-connection-ip)
  ip_chain      text,          -- full x-forwarded-for, for auditing the hops
  geo_country   text,
  geo_region    text,
  geo_city      text,
  geo_asn       integer,       -- filled later: IP -> ASN enrichment
  geo_org       text,          -- ASN owner / ISP name
  is_datacenter boolean,       -- filled later: the signal that actually matters

  -- client identity signals (L7) ------------------------------------------
  user_agent          text,
  accept_language     text,
  referer             text,
  sec_ch_ua           text,
  sec_ch_ua_mobile    text,
  sec_ch_ua_platform  text,
  sec_fetch_site      text,
  sec_fetch_mode      text,
  sec_fetch_dest      text,
  sec_fetch_user      text,

  -- reserved for a future raw-socket tier (null on Netlify) ---------------
  tls_version   text,
  ja3           text,
  header_order  text[],

  -- the join key the octopus generator sends; null for organic traffic ----
  qa_test_id    text,

  -- manual labelling from the dashboard (bot / benign / attack / …) --------
  label         text,
  note          text,

  -- browser fingerprint, posted by fp.js from the visitor's browser --------
  -- (canvas, webgl/GPU, audio, fonts, cores, webdriver, timezone, …)
  fp            jsonb,

  -- everything else, verbatim ---------------------------------------------
  headers       jsonb,

  -- derived: synthetic traffic carries the join key, organic does not ------
  is_synthetic  boolean generated always as (qa_test_id is not null) stored
);

-- indexes for the queries you will actually run -----------------------------
create index if not exists hits_received_at_idx on public.hits (received_at desc);
create index if not exists hits_ip_idx          on public.hits (ip);
create index if not exists hits_qa_idx          on public.hits (qa_test_id) where qa_test_id is not null;
create index if not exists hits_synthetic_idx   on public.hits (is_synthetic, received_at desc);
create index if not exists hits_label_idx        on public.hits (label) where label is not null;

-- ---------------------------------------------------------------------------
-- Security: RLS ON, and deliberately NO policies.
--
-- The Netlify function writes using the SERVICE_ROLE key, which bypasses RLS
-- entirely. The public/anon key can then neither read nor write this table, so
-- the data cannot leak through the client API. Never ship the service_role key
-- to a browser.
-- ---------------------------------------------------------------------------
alter table public.hits enable row level security;

-- convenience view for eyeballing recent traffic ----------------------------
create or replace view public.recent as
select
  id,
  received_at,
  is_synthetic,
  host(ip)                as ip,
  geo_country,
  geo_org,
  method,
  path,
  left(user_agent, 70)    as ua,
  qa_test_id
from public.hits
order by received_at desc
limit 200;
