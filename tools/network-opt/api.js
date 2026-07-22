/**
 * IES Hub v3 — Network Optimization API / Persistence
 * Supabase interactions for network configs, facilities, demand points, and scenarios.
 *
 * @module tools/network-opt/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import { auth } from '../../shared/auth.js?v=20260705-u1a';
import * as dealContext from '../../shared/deal-context.js?v=20260722-s1a';
import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';

// ============================================================
// NETWORK CONFIGS (saved network scenarios)
// ============================================================

/**
 * List all saved network configs.
 * @returns {Promise<import('./types.js?v=20260418-sM').NetworkConfig[]>}
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
 * @returns {Promise<import('./types.js?v=20260418-sM').NetworkConfig|null>}
 */
export async function getConfig(id) {
  return db.fetchById('netopt_configs', id);
}

/**
 * Save (insert or update) a network config.
 * Stores facilities, demands, modeMix, rateCard, serviceConfig as JSON.
 * @param {import('./types.js?v=20260418-sM').NetworkConfig} config
 * @returns {Promise<import('./types.js?v=20260418-sM').NetworkConfig>}
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
    // Updates NEVER rebind: parent_cost_model_id / parent_deal_id / site_id
    // are stamped on INSERT only (deal-spine convention). linkToCm /
    // unlinkFromCm below are the explicit rebind path for the CM linkage.
    const updated = await db.update('netopt_configs', config.id, payload);
    recordAudit({ table: 'netopt_configs', id: config.id, action: 'update', fields: { name: payload.name } }).catch(() => {});
    return updated;
  }
  // C1 deal-spine stamp (insert only): explicit config value wins, then the
  // hub-wide active deal context, then null. 2026-04-30 (G12): top-level
  // columns so reload's savedRow.parent_cost_model_id picks up the linkage.
  const _ctx = dealContext.getActive();
  payload.parent_cost_model_id = config.parent_cost_model_id ?? null;
  payload.parent_deal_id = config.parent_deal_id ?? _ctx?.id ?? null;
  payload.site_id = config.site_id ?? _ctx?.siteId ?? null; // S1: site binding
  // 2026-04-25 (PM fix): RLS INSERT policy on netopt_configs is
  //   WITH CHECK (owner_id = auth.uid())
  // so we MUST set owner_id at insert time. Without this, every save
  // fails with 'new row violates row-level security policy'.
  // Earlier same-day fix used `import * as auth` which gave a module
  // namespace where `auth.getUser` was undefined — the optional
  // chaining swallowed it silently and owner_id was never stamped.
  // Now using named import + hard failure if no user.
  const u = auth.getUser();
  if (!u?.id) {
    throw new Error('Save failed: you are not signed in. Please sign in and try again.');
  }
  payload.owner_id = u.id;
  const inserted = await db.insert('netopt_configs', payload);
  recordAudit({ table: 'netopt_configs', id: inserted?.id, action: 'insert', fields: { name: payload.name } }).catch(() => {});
  return inserted;
}

/**
 * Delete a saved network config.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteConfig(id) {
  await db.remove('netopt_configs', id);
  recordAudit({ table: 'netopt_configs', id, action: 'delete' }).catch(() => {});
}

/**
 * Link a NetOpt config to a Cost Model.
 * @param {string} scenarioId
 * @param {string|number} cmId
 */
export async function linkToCm(scenarioId, cmId) {
  await db.update('netopt_configs', scenarioId, { parent_cost_model_id: cmId });
  recordAudit({ table: 'netopt_configs', id: scenarioId, action: 'link', fields: { parent_cost_model_id: cmId } }).catch(() => {});
}

/**
 * Unlink a NetOpt config from its Cost Model.
 * @param {string} scenarioId
 */
export async function unlinkFromCm(scenarioId) {
  await db.update('netopt_configs', scenarioId, { parent_cost_model_id: null });
  recordAudit({ table: 'netopt_configs', id: scenarioId, action: 'unlink' }).catch(() => {});
}

/**
 * Duplicate a network config.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sM').NetworkConfig>}
 */
export async function duplicateConfig(id) {
  const config = await getConfig(id);
  if (!config) throw new Error('Scenario not found');

  const { id: _, created_at, updated_at, ...rest } = config;
  const u = auth.getUser();
  if (!u?.id) {
    throw new Error('Duplicate failed: you are not signed in. Please sign in and try again.');
  }
  const copy = await db.insert('netopt_configs', {
    ...rest,
    name: (rest.name || 'Network') + ' (Copy)',
    owner_id: u.id,
  });
  recordAudit({ table: 'netopt_configs', id: copy?.id, action: 'insert', fields: { name: copy?.name } }).catch(() => {});
  return copy;
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
 * @param {import('./types.js?v=20260418-sM').ScenarioResult} result
 * @returns {Promise<object>}
 */
export async function saveScenarioResult(configId, name, result) {
  const inserted = await db.insert('netopt_scenario_results', {
    config_id: configId,
    name,
    result_data: result,
  });
  recordAudit({ table: 'netopt_scenario_results', id: inserted?.id, action: 'insert', fields: { name } }).catch(() => {});
  return inserted;
}

/**
 * Delete a scenario result.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteScenarioResult(id) {
  await db.remove('netopt_scenario_results', id);
  recordAudit({ table: 'netopt_scenario_results', id, action: 'delete' }).catch(() => {});
}

// ============================================================
// REFERENCE DATA — US metro area centroids for quick demos
// ============================================================

/**
 * Fetch US metro demand seed data (zip3 centroids with population weight).
 * Falls back to built-in data if table doesn't exist.
 * @returns {Promise<import('./types.js?v=20260418-sM').DemandPoint[]>}
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
 * @returns {Promise<import('./types.js?v=20260418-sM').Facility[]>}
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
 * @returns {Promise<{ configs: import('./types.js?v=20260418-sM').NetworkConfig[], demandSeed: import('./types.js?v=20260418-sM').DemandPoint[], facilitySeed: import('./types.js?v=20260418-sM').Facility[] }>}
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
