-- Backfill: refresh_cost_model_facts() has existed on prod+staging since Phase 2
-- (2026-06-12) but was never captured in a committed migration. The Phase 0
-- revoke migration (20260702160000) references it, so on a fresh rebuild it
-- must exist first — hence this file is timestamped BEFORE the revoke.
-- Idempotent: CREATE OR REPLACE + re-statable grants.
begin;

create or replace function public.refresh_cost_model_facts()
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  refresh materialized view concurrently public.fact_labor_monthly;
  refresh materialized view concurrently public.fact_capital_monthly;
end;
$fn$;

revoke execute on function public.refresh_cost_model_facts() from public, anon;
grant execute on function public.refresh_cost_model_facts() to authenticated, service_role;

commit;
