-- 2026-07-14 (Brock ruling): perm mix + agency markup are DEAL-WIDE labor
-- attributes, not per-activity. The per-line UI fields are retired; the
-- deal-wide agency markup rides the existing temp_markup_pct heuristic,
-- and perm mix gets its own heuristic row (default 100 = the engines' own
-- fallback, so existing models reprice nowhere). Applied to prod + staging
-- via MCP same day; this migration keeps fresh environments in step.
insert into ref_design_heuristics (key, label, description, category, data_type, unit, default_value, min_value, max_value, sort_order, source_citation, notes, is_active)
select 'perm_mix_pct', 'Permanent Mix %', 'Deal-wide % of direct-labor hours staffed by permanent employees; the remainder is priced as temp agency at the agency markup (no wage load). Editable on Labor Factors; the What-If temp-share lever shifts it transiently.', 'labor', 'number', '%', 100, 0, 100, 245, 'IES Hub standard', 'Added 2026-07-14 (Brock ruling): perm mix + agency markup are deal-wide attributes, not per-activity.', true
where not exists (select 1 from ref_design_heuristics where key = 'perm_mix_pct');
