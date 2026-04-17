/**
 * IES Hub v3 — Warehouse Sizing API / Persistence
 * Supabase interactions for facility configurations.
 *
 * @module tools/warehouse-sizing/api
 */

import { db } from '../../shared/supabase.js?v=20260416-s2';

// ============================================================
// FACILITY CONFIGS
// ============================================================

/**
 * List all saved facility configs.
 * @returns {Promise<import('./types.js').FacilityConfig[]>}
 */
export async function listConfigs() {
  const { data, error } = await db.from('wsc_facility_configs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single facility config by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js').FacilityConfig|null>}
 */
export async function getConfig(id) {
  return db.fetchById('wsc_facility_configs', id);
}

/**
 * Save (insert or update) a facility config.
 * @param {Object} config — facility + zone + volume data
 * @returns {Promise<Object>}
 */
export async function saveConfig(config) {
  const payload = {
    name: config.name || 'Untitled',
    config_data: config,
  };

  if (config.id) {
    return db.update('wsc_facility_configs', config.id, payload);
  }
  return db.insert('wsc_facility_configs', payload);
}

/**
 * Delete a facility config.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteConfig(id) {
  await db.remove('wsc_facility_configs', id);
}

/**
 * Duplicate a facility config.
 * @param {string} id
 * @returns {Promise<Object>}
 */
export async function duplicateConfig(id) {
  const original = await getConfig(id);
  if (!original) throw new Error('Config not found');
  const { id: _, created_at, updated_at, ...data } = original;
  return saveConfig({ ...data.config_data, name: (data.config_data?.name || 'Config') + ' (Copy)' });
}

// ============================================================
// REFERENCE DATA
// ============================================================

/**
 * Fetch facility market rates (shared with CM).
 * @param {string} [marketId]
 * @returns {Promise<Array>}
 */
export async function fetchFacilityRates(marketId) {
  let query = db.from('ref_facility_rates').select('*');
  if (marketId) query = query.eq('market_id', marketId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
