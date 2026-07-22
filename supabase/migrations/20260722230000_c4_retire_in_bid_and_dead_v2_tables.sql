-- C4 (2026-07-22): schema retirement wave.
--
-- 1) cost_model_projects.in_bid — the legacy ★ mirror boolean. Authority has
--    been deal_sites.in_bid_model_id since S1/C1 (2026-07-22); C1 made the
--    column WRITE-ONLY (repo-wide no-read scan pinned by
--    test-dm-star-authority.mjs); C4 code (this commit) removed the last
--    mirror writes and flipped the pin to zero-references. Safe to drop once
--    the C4 code deploy is live and clients have refreshed (stale tabs
--    running pre-C4 JS would 400 on ★ toggles after this drop).
--
-- 2) Dead v2 tables — verified zero code references at HEAD (grep across
--    index.html/shared/hub/tools/supabase/functions) AND row-count checked
--    in prod 2026-07-22:
--      · projects (0 rows)                      — superseded by cost_model_projects
--      · vertical_spotlight_deals (0 rows)      — empty join table, never wired
--      · network_optimization_scenarios (1 row) — predecessor of netopt_configs;
--        sole row was a 2026-04-05 smoke test ("Test1", 10 hardcoded cities,
--        all result_* zero). Preserved here for the record; nothing links to it.
--    NOTE: the 2026-04-01 orphan audit also listed cost_model_labor/equipment/
--    overhead/vas/summary as droppable — that is STALE. They are actively read
--    by tools/deal-manager/api.js (summary fallback) and tools/cost-model/api.js
--    (duplicate flow). They stay.
--    shared/supabase.js's table allowlist still names
--    network_optimization_scenarios; harmless (permits a nonexistent table) —
--    remove opportunistically next time supabase.js takes a pin bump.

alter table public.cost_model_projects drop column if exists in_bid;

drop table if exists public.network_optimization_scenarios;
-- deal_qualifications + project_elements: v2 children of projects (FK
-- dependents discovered on staging apply) — zero rows, zero code refs,
-- appear only in past RLS/search-path hygiene sweeps. Dropped first so
-- projects can go without CASCADE.
drop table if exists public.deal_qualifications;
drop table if exists public.project_elements;
drop table if exists public.projects;
drop table if exists public.vertical_spotlight_deals;
