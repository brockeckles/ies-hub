/**
 * IES Hub v3 — Deal FK spelling map (DOCUMENTATION + test fodder).
 *
 * The deal FK is spelled THREE ways across the schema (cohesion audit,
 * Brock ruling 2026-07-22):
 *
 *   1. `deal_deals_id`  — cost_model_projects only. Added 2026-03-31
 *      (20260331165909_add_deal_deals_id_to_cost_model_projects.sql) after
 *      the earlier `deal_id` column on the same table drifted (prod=bigint,
 *      staging=uuid — see supabase/migrations/README.md "type mismatches").
 *      This is the ACTIVE deal spine for cost models; every reader/writer
 *      (tools/cost-model/api.js, tools/deal-manager/api.js,
 *      hub/deal-management/api.js) uses it.
 *
 *   2. `parent_deal_id` — the five design-tool scenario tables
 *      (wsc_facility_configs, netopt_configs, cog_scenarios, most_analyses,
 *      fleet_scenarios). Added 2026-04-18
 *      (20260418133833_v3_scenario_parent_links.sql) as a TEXT column (deal
 *      uuid as text), stamped insert-only from the active deal context.
 *
 *   3. `deal_id`        — the canonical spelling. Used by every deal-child
 *      table (deal_sites, deal_strategy, deal_artifacts, deal_dos_status,
 *      deal_bid_meta, deal_outcomes) and by cost_model_scenarios.
 *
 * RULING (Brock, cohesion audit 2026-07-22): DOCUMENT, don't rename.
 * NO rename migrations, NO code behavior changes — renames would churn every
 * api file + RLS policy + index for zero user value, and the prod/staging
 * drift on cost_model_projects.deal_id makes a blind consolidation actively
 * dangerous. Instead this map is the single source of truth, pinned by
 * test-c4-deal-fk-map.mjs.
 *
 * CANONICAL-FOR-NEW-TABLES RULE: any NEW table that carries a deal FK MUST
 * spell it `deal_id` (uuid REFERENCES public.deal_deals(id)). Add the table
 * to DEAL_FK below and the pinning test's floor list in the same change.
 *
 * KNOWN WART (documented, not fixed): cost_model_projects physically carries
 * THREE deal columns —
 *   - deal_deals_id  (active spine, the one in this map)
 *   - deal_id        (vestigial, added 20260331023143_create_deal_tables.sql;
 *                     no code reads or writes it; prod/staging type drift)
 *   - parent_deal_id (dormant text alias, added 20260418133833; no code
 *                     reads or writes it on this table)
 * Only deal_deals_id counts. Do not start using the other two.
 *
 * SITE FK: verified uniform — the site FK is spelled `site_id` everywhere it
 * exists (cost_model_projects, wsc_facility_configs, most_analyses,
 * cog_scenarios per 20260722160000_s1_deal_sites.sql; netopt_configs,
 * fleet_scenarios per 20260722200000_c1_network_site_ids.sql; deal_sites is
 * the parent). No tri-spelling → no SITE_FK map needed; keep it that way.
 *
 * This module has NO runtime consumers by design (api files are frozen for
 * this wave); it exists to document the ruling and feed the pinning test.
 *
 * @module shared/deal-fk
 */

/**
 * Per-table deal FK column map. Key = table name, value = the column on that
 * table which references public.deal_deals(id).
 * @type {Readonly<Record<string, 'deal_deals_id'|'parent_deal_id'|'deal_id'>>}
 */
export const DEAL_FK = Object.freeze({
  // -- spelling 1: deal_deals_id (cost-model spine) -------------------------
  cost_model_projects:  'deal_deals_id',

  // -- spelling 2: parent_deal_id (design-tool scenario tables, text) -------
  wsc_facility_configs: 'parent_deal_id',
  netopt_configs:       'parent_deal_id',
  cog_scenarios:        'parent_deal_id',
  most_analyses:        'parent_deal_id',
  fleet_scenarios:      'parent_deal_id',

  // -- spelling 3: deal_id (canonical — all deal-child tables + CM scenarios)
  cost_model_scenarios: 'deal_id',
  deal_sites:           'deal_id',
  deal_strategy:        'deal_id',
  deal_artifacts:       'deal_id',
  deal_dos_status:      'deal_id',
  deal_bid_meta:        'deal_id',
  deal_outcomes:        'deal_id',
});

/** The three legal spellings, for validation. */
export const DEAL_FK_SPELLINGS = Object.freeze(['deal_deals_id', 'parent_deal_id', 'deal_id']);

/** Canonical spelling for NEW tables (ruled 2026-07-22). */
export const DEAL_FK_CANONICAL = 'deal_id';
