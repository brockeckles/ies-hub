-- ============================================================
-- C1 — Deal-spine completion, schema half (Brock ruling s3
-- 2026-07-22: FULL Fleet/NetOpt spine join — supersedes the s2
-- "Fleet stamps no deal FK" ruling; see hub cohesion audit).
--
-- Extends the S1 site_id pattern (20260722160000 §3) to the two
-- design tables S1 skipped: netopt_configs and fleet_scenarios.
-- Nullable, FK to deal_sites, ON DELETE SET NULL — identical to
-- the four S1 columns. No backfill: neither tool has ever
-- stamped a site, so there is nothing to attach.
--
-- Code half (deal-context stamps on insert) ships in the same
-- C1 commit; columns land first so stamps can't race the schema.
-- ============================================================

alter table public.netopt_configs  add column if not exists site_id uuid references public.deal_sites(id) on delete set null;
alter table public.fleet_scenarios add column if not exists site_id uuid references public.deal_sites(id) on delete set null;

create index if not exists netopt_site_idx on public.netopt_configs(site_id);
create index if not exists fleet_site_idx  on public.fleet_scenarios(site_id);
