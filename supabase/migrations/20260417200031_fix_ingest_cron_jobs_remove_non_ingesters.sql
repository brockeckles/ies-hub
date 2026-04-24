
-- Remove jobs targeting endpoints that aren't actual ingesters:
--   hub             — serves HTML (the frontend proxy), not an ingester
--   ingest-intel-feed — POST endpoint for external feeds to push data IN,
--                       won't refresh anything when called empty
-- Keep the 3 that actually fetch external data:
--   ingest-eia-diesel  (blocked on EIA_API_KEY secret — see note)
--   ingest-bls-wages   (BLS API, no key needed)
--   ingest-labor-watch (internal rollup)
SELECT cron.unschedule('hub-aggregate');
SELECT cron.unschedule('ingest-intel-feed');
