/**
 * IES Hub v3 — Fleet Modeler API / Persistence
 * Supabase interactions for fleet scenarios and lanes.
 *
 * @module tools/fleet-modeler/api
 */

import { db } from '../../shared/supabase.js?v=20260423-y1';
import { recordAudit } from '../../shared/audit.js?v=20260423-y3';

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
    const updated = await db.update('fleet_scenarios', scenario.id, payload);
    recordAudit({ table: 'fleet_scenarios', id: scenario.id, action: 'update', fields: { name: payload.name } });
    return updated;
  }
  const inserted = await db.insert('fleet_scenarios', payload);
  recordAudit({ table: 'fleet_scenarios', id: inserted?.id, action: 'insert', fields: { name: payload.name } });
  return inserted;
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
 * Link a Fleet scenario to a Cost Model.
 * @param {string} scenarioId
 * @param {string|number} cmId
 */
export async function linkToCm(scenarioId, cmId) {
  await db.update('fleet_scenarios', scenarioId, { parent_cost_model_id: cmId });
}

/**
 * Unlink a Fleet scenario from its Cost Model.
 * @param {string} scenarioId
 */
export async function unlinkFromCm(scenarioId) {
  await db.update('fleet_scenarios', scenarioId, { parent_cost_model_id: null });
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
 * @returns {Promise<import('./types.js?v=20260418-sM').Lane[]>}
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
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
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
// CARRIER RATE DECK (ref_fleet_carrier_rates)
// ============================================================

/**
 * @typedef {Object} CarrierRate
 * @property {number} id
 * @property {string} vehicle_type — stable key (e.g. 'dry-van')
 * @property {string} display_name
 * @property {number} base_rate_per_mile
 * @property {number} fuel_surcharge_pct
 * @property {number} min_charge
 * @property {string} [notes]
 * @property {boolean} is_active
 */

/**
 * List the active carrier rate deck. Falls back to in-memory defaults
 * when the network is unavailable.
 * @returns {Promise<CarrierRate[]>}
 */
export async function listCarrierRates() {
  try {
    const { data, error } = await db.from('ref_fleet_carrier_rates')
      .select('*')
      .eq('is_active', true)
      .order('display_name');
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[Fleet] listCarrierRates fallback to defaults:', e);
    return DEFAULT_CARRIER_RATES;
  }
}

/**
 * Update a carrier rate row. Returns the saved row.
 * @param {number|string} id
 * @param {Partial<CarrierRate>} patch
 * @returns {Promise<CarrierRate>}
 */
export async function updateCarrierRate(id, patch) {
  const allowed = ['display_name', 'base_rate_per_mile', 'fuel_surcharge_pct', 'min_charge', 'notes', 'is_active'];
  const payload = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  payload.updated_at = new Date().toISOString();
  const row = await db.update('ref_fleet_carrier_rates', id, payload);
  recordAudit({ table: 'ref_fleet_carrier_rates', id, action: 'update', fields: payload });
  return row;
}

/**
 * Insert a new carrier rate row.
 * @param {Partial<CarrierRate>} data
 * @returns {Promise<CarrierRate>}
 */
export async function createCarrierRate(data) {
  return db.insert('ref_fleet_carrier_rates', {
    vehicle_type: data.vehicle_type,
    display_name: data.display_name || data.vehicle_type,
    base_rate_per_mile: data.base_rate_per_mile ?? 3.00,
    fuel_surcharge_pct: data.fuel_surcharge_pct ?? 0.18,
    min_charge: data.min_charge ?? 0,
    notes: data.notes || null,
    is_active: data.is_active !== false,
  });
}

/**
 * Soft-delete a carrier rate (sets is_active=false). Hard delete kept
 * out so historical scenario calcs can still resolve a rate by key.
 * @param {number|string} id
 */
export async function deactivateCarrierRate(id) {
  return db.update('ref_fleet_carrier_rates', id, { is_active: false, updated_at: new Date().toISOString() });
}

/** Defaults used when Supabase is unreachable — match the migration seed. */
export const DEFAULT_CARRIER_RATES = [
  { id: -1, vehicle_type: 'dry-van',  display_name: "Dry Van (53')",      base_rate_per_mile: 3.50, fuel_surcharge_pct: 0.18, min_charge: 350, is_active: true },
  { id: -2, vehicle_type: 'reefer',   display_name: 'Refrigerated',        base_rate_per_mile: 4.00, fuel_surcharge_pct: 0.20, min_charge: 450, is_active: true },
  { id: -3, vehicle_type: 'flatbed',  display_name: 'Flatbed',             base_rate_per_mile: 3.80, fuel_surcharge_pct: 0.18, min_charge: 425, is_active: true },
  { id: -4, vehicle_type: 'straight', display_name: 'Straight Truck',      base_rate_per_mile: 2.80, fuel_surcharge_pct: 0.15, min_charge: 175, is_active: true },
  { id: -5, vehicle_type: 'sprinter', display_name: 'Sprinter / Cargo Van',base_rate_per_mile: 2.20, fuel_surcharge_pct: 0.12, min_charge: 95,  is_active: true },
];

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
