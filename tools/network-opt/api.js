/**
 * IES Hub v3 — Network Optimization API / Persistence
 * Supabase interactions for network configs, facilities, demand points, and scenarios.
 *
 * @module tools/network-opt/api
 */

import { db } from '../../shared/supabase.js?v=20260418-s9';

// ============================================================
// NETWORK CONFIGS (saved network scenarios)
// ============================================================

/**
 * List all saved network configs.
 * @returns {Promise<import('./types.js?v=20260418-s9').NetworkConfig[]>}
 */
export async function listConfigs() {
  const { data, error } = await db.from('netopt_configs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single network config by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-s9').NetworkConfig|null>}
 */
export async function getConfig(id) {
  return db.fetchById('netopt_configs', id);
}

/**
 * Save (insert or update) a network config.
 * Stores facilities, demands, modeMix, rateCard, serviceConfig as JSON.
 * @param {import('./types.js?v=20260418-s9').NetworkConfig} config
 * @returns {Promise<import('./types.js?v=20260418-s9').NetworkConfig>}
 */
export async function saveConfig(config) {
  const payload = {
    name: config.name,
    config_data: {
      facilities: config.facilities,
      demands: config.demands,
      modeMix: config.modeMix,
      rateCard: config.rateCard,
      serviceConfig: config.serviceConfig,
    },
  };

  if (config.id) {
    return db.update('netopt_configs', config.id, payload);
  }
  return db.insert('netopt_configs', payload);
}

/**
 * Delete a saved network config.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteConfig(id) {
  await db.remove('netopt_configs', id);
}

/**
 * Duplicate a network config.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-s9').NetworkConfig>}
 */
export async function duplicateConfig(id) {
  const config = await getConfig(id);
  if (!config) throw new Error('Config not found');

  const { id: _, created_at, updated_at, ...rest } = config;
  return db.insert('netopt_configs', {
    ...rest,
    name: (rest.name || 'Network') + ' (Copy)',
  });
}

// ============================================================
// SCENARIO RESULTS (saved scenario comparisons)
// ============================================================

/**
 * List saved scenario results for a config.
 * @param {string} configId
 * @returns {Promise<Array<{ id: string, name: string, result_data: object }>>}
 */
export async function listScenarioResults(configId) {
  const { data, error } = await db.from('netopt_scenario_results')
    .select('*')
    .eq('config_id', configId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Save a scenario result.
 * @param {string} configId
 * @param {string} name
 * @param {import('./types.js?v=20260418-s9').ScenarioResult} result
 * @returns {Promise<object>}
 */
export async function saveScenarioResult(configId, name, result) {
  return db.insert('netopt_scenario_results', {
    config_id: configId,
    name,
    result_data: result,
  });
}

/**
 * Delete a scenario result.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteScenarioResult(id) {
  await db.remove('netopt_scenario_results', id);
}

// ============================================================
// REFERENCE DATA — US metro area centroids for quick demos
// ============================================================

/**
 * Fetch US metro demand seed data (zip3 centroids with population weight).
 * Falls back to built-in data if table doesn't exist.
 * @returns {Promise<import('./types.js?v=20260418-s9').DemandPoint[]>}
 */
export async function fetchDemandSeedData() {
  try {
    const { data, error } = await db.from('ref_zip3_centroids')
      .select('zip3, lat, lng, population, city, state')
      .order('population', { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data || []).map(d => ({
      id: `zip-${d.zip3}`,
      zip3: d.zip3,
      lat: d.lat,
      lng: d.lng,
      annualDemand: Math.round(d.population / 500),
      maxDays: 3,
      avgWeight: 25,
    }));
  } catch {
    // Fallback: return empty — UI will use built-in demo data from calc.js
    return [];
  }
}

/**
 * Fetch common warehouse/DC locations for facility seed data.
 * @returns {Promise<import('./types.js?v=20260418-s9').Facility[]>}
 */
export async function fetchFacilitySeedData() {
  try {
    const { data, error } = await db.from('ref_facility_locations')
      .select('*')
      .order('name');
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load all reference + saved data in parallel.
 * @returns {Promise<{ configs: import('./types.js?v=20260418-s9').NetworkConfig[], demandSeed: import('./types.js?v=20260418-s9').DemandPoint[], facilitySeed: import('./types.js?v=20260418-s9').Facility[] }>}
 */
export async function loadRefData() {
  const [configs, demandSeed, facilitySeed] = await Promise.all([
    listConfigs(),
    fetchDemandSeedData(),
    fetchFacilitySeedData(),
  ]);
  return { configs, demandSeed, facilitySeed };
}

/**
 * Pull all freight_rates rows. Returns most-recent per index_name on the
 * caller's side. Used by Apply Market Rates.
 * @returns {Promise<any[]>}
 */
export async function fetchFreightRates() {
  try {
    return await db.fetchAll('freight_rates');
  } catch (err) {
    console.warn('[netopt] fetchFreightRates failed', err);
    return [];
  }
}
