
-- Enable pg_cron (scheduler) + pg_net (async HTTP) so we can drive the ingest
-- edge functions on a recurring schedule. Previously these functions ran
-- ad-hoc / externally, leaving fuel_prices / freight_rates / rfp_signals /
-- labor_markets stale for ~20 days.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Grant usage so cron jobs can invoke net.http_post
GRANT USAGE ON SCHEMA extensions TO postgres;

-- Schedule 5 public (verify_jwt=false) ingest functions on weekdays 6:30am ET.
-- ET 6:30am = UTC 10:30 (EST) or UTC 11:30 (EDT). Use 11:30 UTC which is
-- safest for the 5 Apr–Nov DST months; GXO ops is US-business-hours focused.
-- Jobs only run Mon–Fri (cron 'min hour day month dow' where dow 1–5).

-- Diesel prices (EIA weekly)
SELECT cron.schedule(
  'ingest-eia-diesel',
  '30 11 * * 1-5',
  $$
  SELECT extensions.http_post(
    url := 'https://dklnwcshrpamzsybjlzb.supabase.co/functions/v1/ingest-eia-diesel',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Freight / intel feed
SELECT cron.schedule(
  'ingest-intel-feed',
  '35 11 * * 1-5',
  $$
  SELECT extensions.http_post(
    url := 'https://dklnwcshrpamzsybjlzb.supabase.co/functions/v1/ingest-intel-feed',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- BLS warehouse wages
SELECT cron.schedule(
  'ingest-bls-wages',
  '40 11 * * 1-5',
  $$
  SELECT extensions.http_post(
    url := 'https://dklnwcshrpamzsybjlzb.supabase.co/functions/v1/ingest-bls-wages',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Labor market watch (unemployment, availability, turnover)
SELECT cron.schedule(
  'ingest-labor-watch',
  '45 11 * * 1-5',
  $$
  SELECT extensions.http_post(
    url := 'https://dklnwcshrpamzsybjlzb.supabase.co/functions/v1/ingest-labor-watch',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Hub orchestrator (builds hub_alerts from source tables)
SELECT cron.schedule(
  'hub-aggregate',
  '55 11 * * 1-5',
  $$
  SELECT extensions.http_post(
    url := 'https://dklnwcshrpamzsybjlzb.supabase.co/functions/v1/hub',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
