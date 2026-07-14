-- 2026-07-14 (Brock ruling): prune the two ref_design_heuristics rows the
-- engine never reads. Both were seeded 2026-04-19 from the standards doc
-- before resolveCalcHeuristics wiring settled; neither key appears in the
-- pick() list, so overriding them on the Assumptions page silently no-oped
-- ("display must match mechanism" — dead knobs are distractions):
--   * contract_term_years  — the real term is projectDetails.contractTerm
--     (Setup field → flat column); the heuristic was a shadow copy.
--   * default_seasonality  — seasonality comes from model.seasonalityProfile
--     / channel-archetype presets, never this enum.
-- Pre-delete audit (prod, 2026-07-14): zero project overrides used either
-- key; the only references are frozen approval snapshots (self-contained,
-- untouched by this delete). Applied to prod + staging via MCP same day;
-- this migration keeps fresh environments in step.
delete from ref_design_heuristics
 where key in ('contract_term_years', 'default_seasonality');
