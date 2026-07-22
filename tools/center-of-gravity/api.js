/**
 * IES Hub v3 — Center of Gravity API / Persistence
 * Supabase interactions for COG scenarios.
 *
 * @module tools/center-of-gravity/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import * as dealContext from '../../shared/deal-context.js?v=20260722-s1a';
import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';

// ============================================================
// SCENARIOS
// ============================================================

/**
 * List all saved COG scenarios.
 * @returns {Promise<import('./types.js?v=20260418-sP').CogScenario[]>}
 */
export async function listScenarios() {
  const { data, error } = await db.from('cog_scenarios')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single scenario by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sP').CogScenario|null>}
 */
export async function getScenario(id) {
  return db.fetchById('cog_scenarios', id);
}

/**
 * Save (insert or update) a COG scenario.
 * @param {import('./types.js?v=20260418-sP').CogScenario} scenario
 * @returns {Promise<import('./types.js?v=20260418-sP').CogScenario>}
 */
export async function saveScenario(scenario) {
  const payload = {
    name: scenario.name,
    scenario_data: {
      points: scenario.points,
      config: scenario.config,
      result: scenario.result || null,
    },
  };
  if (scenario.id) {
    const updated = await db.update('cog_scenarios', scenario.id, payload);
    recordAudit({ table: 'cog_scenarios', id: scenario.id, action: 'update', fields: { name: payload.name } });
    return updated;
  }
  // UX-1 D2 (2026-07-03): stamp new scenarios with the active deal context.
  const _ctx = dealContext.getActive();
  if (_ctx) payload.parent_deal_id = _ctx.id;
  if (_ctx && _ctx.siteId) payload.site_id = _ctx.siteId; // S1: site binding
  // Duplicate path (2026-07-22): explicit linkage on the scenario object wins
  // over the active-context stamp — a copy keeps its SOURCE row's deal/site/CM
  // linkage. Regular editor saves never pass these fields, so the ctx stamp
  // above still applies to them. Insert-only: updates never rebind.
  if (scenario.parent_deal_id !== undefined) payload.parent_deal_id = scenario.parent_deal_id;
  if (scenario.site_id !== undefined) payload.site_id = scenario.site_id;
  if (scenario.parent_cost_model_id !== undefined) payload.parent_cost_model_id = scenario.parent_cost_model_id;
  const inserted = await db.insert('cog_scenarios', payload);
  recordAudit({ table: 'cog_scenarios', id: inserted?.id, action: 'insert', fields: { name: payload.name } });
  return inserted;
}

/**
 * Delete a scenario.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteScenario(id) {
  await db.remove('cog_scenarios', id);
  recordAudit({ table: 'cog_scenarios', id, action: 'delete' });
}

/**
 * Link a COG scenario to a Cost Model.
 * @param {string} scenarioId
 * @param {string|number} cmId
 */
export async function linkToCm(scenarioId, cmId) {
  await db.update('cog_scenarios', scenarioId, { parent_cost_model_id: cmId });
}

/**
 * Unlink a COG scenario from its Cost Model.
 * @param {string} scenarioId
 */
export async function unlinkFromCm(scenarioId) {
  await db.update('cog_scenarios', scenarioId, { parent_cost_model_id: null });
}

/**
 * Duplicate a scenario.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sP').CogScenario>}
 */
export async function duplicateScenario(id) {
  const scenario = await getScenario(id);
  if (!scenario) throw new Error('Scenario not found');
  // RLS fix (2026-07-22): strip ALL row identity/ownership fields — id,
  // created_at, updated_at, owner_id, team_id, visibility. Carrying the
  // source owner_id defeats db.insert's owner stamping and trips the
  // cog_scenarios INSERT policy (WITH CHECK owner_id = auth.uid()) when
  // copying a teammate's shared scenario. Route through saveScenario
  // (same pattern as WSC duplicateConfig) so the copy is inserted as a
  // fresh owner-stamped row and the insert is audited. The copy keeps
  // the SOURCE row's deal/site/CM linkage — saveScenario's explicit-
  // linkage override skips the active-context re-stamp.
  const sd = scenario.scenario_data || {};
  return saveScenario({
    name: (scenario.name || 'COG') + ' (Copy)',
    points: sd.points,
    config: sd.config,
    result: sd.result || null,
    parent_deal_id: scenario.parent_deal_id ?? null,
    site_id: scenario.site_id ?? null,
    parent_cost_model_id: scenario.parent_cost_model_id ?? null,
  });
}

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load saved scenarios.
 * @returns {Promise<{ scenarios: import('./types.js?v=20260418-sP').CogScenario[] }>}
 */
export async function loadRefData() {
  const scenarios = await listScenarios();
  return { scenarios };
}
