/**
 * IES Hub v3 — Fleet Modeler API / Persistence
 * Supabase interactions for fleet scenarios and lanes.
 *
 * @module tools/fleet-modeler/api
 */

import { db } from '../../shared/supabase.js?v=20260416-s2';

// ============================================================
// SCENARIOS
// ============================================================

/**
 * List all saved fleet scenarios.
 * @returns {Promise<Array<{ id: string, name: string, config: object, results: object, created_at: string }>>}
 */
export async function listScenarios() {
  const { data, error } = await db.from('fleet_scenarios')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single scenario by ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getScenario(id) {
  return db.fetchById('fleet_scenarios', id);
}

/**
 * Save (insert or update) a fleet scenario.
 * @param {{ id?: string, name: string, config: object, results: object }} scenario
 * @returns {Promise<object>}
 */
export async function saveScenario(scenario) {
  const payload = {
    name: scenario.name,
    config: scenario.config,
    results: scenario.results,
  };
  if (scenario.id) {
    return db.update('fleet_scenarios', scenario.id, payload);
  }
  return db.insert('fleet_scenarios', payload);
}

/**
 * Delete a scenario and its associated lanes.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteScenario(id) {
  // Delete lanes first (FK constraint)
  await db.from('fleet_lanes').delete().eq('scenario_id', id);
  await db.remove('fleet_scenarios', id);
}

/**
 * Duplicate a fleet scenario.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function duplicateScenario(id) {
  const scenario = await getScenario(id);
  if (!scenario) throw new Error('Scenario not found');
  const { id: _, created_at, ...rest } = scenario;
  return db.insert('fleet_scenarios', { ...rest, name: (rest.name || 'Fleet') + ' (Copy)' });
}

// ============================================================
// LANES
// ============================================================

/**
 * List lanes for a scenario.
 * @param {string} scenarioId
 * @returns {Promise<import('./types.js').Lane[]>}
 */
export async function listLanes(scenarioId) {
  const { data, error } = await db.from('fleet_lanes')
    .select('*')
    .eq('scenario_id', scenarioId)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

/**
 * Save lanes for a scenario (replaces existing).
 * @param {string} scenarioId
 * @param {import('./types.js').Lane[]} lanes
 * @returns {Promise<void>}
 */
export async function saveLanes(scenarioId, lanes) {
  // Delete existing
  await db.from('fleet_lanes').delete().eq('scenario_id', scenarioId);
  // Insert new
  for (const lane of lanes) {
    await db.insert('fleet_lanes', {
      scenario_id: scenarioId,
      origin: lane.origin,
      destination: lane.destination,
      weekly_shipments: lane.weeklyShipments,
      avg_weight_lbs: lane.avgWeightLbs,
      avg_cube_ft3: lane.avgCubeFt3,
      distance_miles: lane.distanceMiles,
      delivery_window: lane.deliveryWindow || null,
    });
  }
}

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load all saved scenarios.
 * @returns {Promise<{ scenarios: Array<object> }>}
 */
export async function loadRefData() {
  const scenarios = await listScenarios();
  return { scenarios };
}
