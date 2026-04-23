/**
 * IES Hub v3 — Center of Gravity API / Persistence
 * Supabase interactions for COG scenarios.
 *
 * @module tools/center-of-gravity/api
 */

import { db } from '../../shared/supabase.js?v=20260423-y1';
import { recordAudit } from '../../shared/audit.js?v=20260423-y2';

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
  const { id: _, created_at, ...rest } = scenario;
  return db.insert('cog_scenarios', { ...rest, name: (rest.name || 'COG') + ' (Copy)' });
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
