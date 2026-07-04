-- UX-1 D1 phase 2 (2026-07-03): ★-in-bid scenario marker.
-- A deal's site group (models collapsed by market|name) should have exactly
-- one scenario marked in-bid; deal rollups aggregate in-bid rows only and
-- fall back to all rows when none is marked. Exclusivity enforced app-side
-- per site group (partial unique index not possible on the derived group key).
-- Applied to prod + staging via MCP 2026-07-03 (same session it was written).
alter table public.cost_model_projects
  add column if not exists in_bid boolean not null default false;
comment on column public.cost_model_projects.in_bid is
  'UX-1 D1p2: one scenario per site group marked in-bid; deal rollups read in-bid rows only (fallback: all rows when none marked).';
