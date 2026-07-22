/**
 * IES Hub v3 — Warehouse Sizing API / Persistence
 * Supabase interactions for facility configurations.
 *
 * @module tools/warehouse-sizing/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import * as dealContext from '../../shared/deal-context.js?v=20260722-s1a';

// ============================================================
// FACILITY CONFIGS
// ============================================================

/**
 * List all saved facility configs.
 * @returns {Promise<import('./types.js?v=20260418-sL').FacilityConfig[]>}
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
 * @returns {Promise<import('./types.js?v=20260418-sL').FacilityConfig|null>}
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
  // UX-1 D2 (2026-07-03): new scenarios born while a deal context is active
  // are stamped with the deal — the spine link the landing's "Deal:" chip
  // and the deal workspace both read. Insert-only: updates never rebind.
  const _ctx = dealContext.getActive();
  if (_ctx) payload.parent_deal_id = _ctx.id;
  if (_ctx && _ctx.siteId) payload.site_id = _ctx.siteId; // S1: site binding
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
 * Link a WSC scenario to a Cost Model.
 * @param {string} scenarioId
 * @param {string|number} cmId
 * @returns {Promise<void>}
 */
export async function linkToCm(scenarioId, cmId) {
  await db.update('wsc_facility_configs', scenarioId, { parent_cost_model_id: cmId });
}

/**
 * Unlink a WSC scenario from its Cost Model.
 * @param {string} scenarioId
 * @returns {Promise<void>}
 */
export async function unlinkFromCm(scenarioId) {
  await db.update('wsc_facility_configs', scenarioId, { parent_cost_model_id: null });
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

// ============================================================
// N2 (2026-07-04) — WSC design-factor catalog (ref_planning_ratios)
// ============================================================

/**
 * Fetch the live WSC factor catalog (wsc_* categories, active rows).
 * Scenario-side pinning/drift lives in factors-calc.js.
 * @returns {Promise<any[]>}
 */
export async function fetchWscFactors() {
  const { data, error } = await db.from('ref_planning_ratios')
    .select('category_code, ratio_code, display_name, description, value_type, numeric_value, value_unit, value_jsonb, source, source_detail, source_date, sort_order, notes')
    .in('category_code', ['wsc_media_selection', 'wsc_dynamics', 'wsc_layout_compliance', 'wsc_profile_defaults'])
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) { console.warn('[WSC] fetchWscFactors failed:', error); return []; }
  return data || [];
}
