-- C4 (2026-07-22): schema retirement wave. APPLIED: staging 2026-07-22, prod
-- 2026-07-22 (after C4/C5 code deploy + Brock walk + hard-refresh gate).
--
-- 1) cost_model_projects.in_bid — the legacy ★ mirror boolean. Authority has
--    been deal_sites.in_bid_model_id since S1/C1 (2026-07-22); C1 made the
--    column WRITE-ONLY (repo-wide no-read scan pinned by
--    test-dm-star-authority.mjs); C4 code removed the last mirror writes and
--    flipped the pin to zero-references. Dropped only after the C4 code
--    deploy was live and clients refreshed (stale tabs running pre-C4 JS
--    would 400 on ★ toggles after this drop).
--
-- 2) Dead v2 objects — verified zero code references at HEAD (grep across
--    index.html/shared/hub/tools/supabase/functions) AND row-count checked
--    in prod 2026-07-22:
--      · projects (0 rows)                      — superseded by cost_model_projects
--      · project_elements + deal_qualifications (0 rows) — empty v2 children
--        of projects (FK dependents), dropped first so projects goes without
--        CASCADE
--      · instantiate_stage_elements / add_sub_element — v2 DOS-framework
--        functions depending on project_elements' row type (prod-only; zero
--        code refs, zero trigger refs)
--      · deal_deals.dos_project_id — prod-only vestigial all-null FK column
--        into projects; zero code/migration refs
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

drop function if exists public.instantiate_stage_elements(bigint, bigint);
drop function if exists public.add_sub_element(bigint, text, text, uuid);

alter table public.deal_deals drop column if exists dos_project_id;

drop table if exists public.network_optimization_scenarios;
drop table if exists public.deal_qualifications;
drop table if exists public.project_elements;
drop table if exists public.projects;
drop table if exists public.vertical_spotlight_deals;
