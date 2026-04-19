/**
 * IES Hub v3 — Cost Model API / Persistence
 * Supabase interactions for the Cost Model Builder.
 * Replaces v2's scattered cmFetchTable/cmApiPost/Patch/Delete calls.
 *
 * @module tools/cost-model/api
 */

import { db } from '../../shared/supabase.js?v=20260418-sK';

// ============================================================
// COST MODEL PROJECTS (CRUD)
// ============================================================

/**
 * Fetch all cost model projects (list view).
 * @returns {Promise<any[]>}
 */
export async function listModels() {
  return db.fetchAll('cost_model_projects', 'id, name, client_name, market_id, created_at, updated_at');
}

/**
 * Fetch a single cost model project by ID (full data).
 * @param {number} id
 * @returns {Promise<any|null>}
 */
export async function getModel(id) {
  return db.fetchById('cost_model_projects', id);
}

/**
 * Create a new cost model project.
 * @param {Object} data — project data to persist
 * @returns {Promise<any>}
 */
export async function createModel(data) {
  // Store flat fields that match the real cost_model_projects schema (market_id,
  // environment_type, contract_term_years). Everything else rides in project_data jsonb.
  const pd = data.projectDetails || {};
  const payload = {
    name: data.name || pd.name || 'Untitled Model',
    client_name: data.clientName || pd.clientName || '',
    market_id: data.market || pd.market || null,
    environment_type: data.environment || pd.environment || null,
    contract_term_years: Number(data.contractTerm || pd.contractTerm || 5),
    project_data: data, // Full JSON blob
  };
  const dealId = pd.dealId || data.dealId;
  if (dealId) payload.deal_deals_id = dealId;
  return db.insert('cost_model_projects', payload);
}

/**
 * Update an existing cost model project.
 * @param {number} id
 * @param {Object} data — updated project data
 * @returns {Promise<any>}
 */
export async function updateModel(id, data) {
  const pd = data.projectDetails || {};
  const payload = {
    name: data.name || pd.name || 'Untitled Model',
    client_name: data.clientName || pd.clientName || '',
    market_id: data.market || pd.market || null,
    environment_type: data.environment || pd.environment || null,
    contract_term_years: Number(data.contractTerm || pd.contractTerm || 5),
    project_data: data,
    updated_at: new Date().toISOString(),
  };
  payload.deal_deals_id = pd.dealId || data.dealId || null;
  return db.update('cost_model_projects', id, payload);
}

/**
 * Delete a cost model project.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteModel(id) {
  return db.remove('cost_model_projects', id);
}

/**
 * Duplicate a cost model project.
 * @param {number} id
 * @returns {Promise<any>}
 */
export async function duplicateModel(id) {
  const original = await getModel(id);
  if (!original) throw new Error(`Model ${id} not found`);

  const data = original.project_data || {};
  data.name = (data.name || original.name || 'Model') + ' (Copy)';
  if (data.projectDetails) data.projectDetails.name = data.name;

  return createModel(data);
}

/**
 * List all deals (for the Link-to-Deal selector in Setup).
 * Returns a light projection — id, deal_name, client_name — sorted by most-recent.
 * @returns {Promise<Array<{id:string, deal_name:string, client_name:string|null}>>}
 */
export async function listDeals() {
  try {
    const { data, error } = await db.from('deal_deals')
      .select('id, deal_name, client_name, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[CM] listDeals failed:', err);
    return [];
  }
}

// ============================================================
// REFERENCE DATA (read-only)
// ============================================================

/**
 * Fetch all markets.
 * @returns {Promise<any[]>}
 */
export async function fetchMarkets() {
  return db.fetchAll('ref_markets');
}

/**
 * Fetch labor rates, optionally filtered by market.
 * @param {string} [marketId]
 * @returns {Promise<any[]>}
 */
export async function fetchLaborRates(marketId) {
  if (marketId) {
    const { data, error } = await db.from('ref_labor_rates').select('*').eq('market_id', marketId);
    if (error) throw error;
    return data || [];
  }
  return db.fetchAll('ref_labor_rates');
}

/**
 * Fetch equipment catalog.
 * @returns {Promise<any[]>}
 */
export async function fetchEquipmentCatalog() {
  return db.fetchAll('ref_equipment');
}

/**
 * Fetch facility rates, optionally filtered by market.
 * @param {string} [marketId]
 * @returns {Promise<any[]>}
 */
export async function fetchFacilityRates(marketId) {
  if (marketId) {
    const { data, error } = await db.from('ref_facility_rates').select('*').eq('market_id', marketId);
    if (error) throw error;
    return data || [];
  }
  return db.fetchAll('ref_facility_rates');
}

/**
 * Fetch utility rates, optionally filtered by market.
 * @param {string} [marketId]
 * @returns {Promise<any[]>}
 */
export async function fetchUtilityRates(marketId) {
  if (marketId) {
    const { data, error } = await db.from('ref_utility_rates').select('*').eq('market_id', marketId);
    if (error) throw error;
    return data || [];
  }
  return db.fetchAll('ref_utility_rates');
}

/**
 * Fetch overhead reference rates.
 * @returns {Promise<any[]>}
 */
export async function fetchOverheadRates() {
  return db.fetchAll('ref_overhead_rates');
}

/**
 * Fetch MOST templates.
 * @returns {Promise<any[]>}
 */
export async function fetchMostTemplates() {
  return db.fetchAll('ref_most_templates');
}

/**
 * Fetch MOST elements for a template.
 * @param {string} templateId
 * @returns {Promise<any[]>}
 */
export async function fetchMostElements(templateId) {
  const { data, error } = await db.from('ref_most_elements').select('*').eq('template_id', templateId);
  if (error) throw error;
  return data || [];
}

/**
 * Fetch allowance profiles.
 * @returns {Promise<any[]>}
 */
export async function fetchAllowanceProfiles() {
  return db.fetchAll('ref_allowance_profiles');
}

/**
 * Fetch pricing assumptions (escalation data).
 * @returns {Promise<any[]>}
 */
export async function fetchPricingAssumptions() {
  return db.fetchAll('pricing_assumptions');
}

// ============================================================
// BATCH REFERENCE LOAD
// ============================================================

/**
 * Load all reference data needed by the Cost Model Builder.
 * Called once on tool initialization.
 * @param {string} [marketId] — pre-filter by market if known
 * @returns {Promise<Object>}
 */
export async function loadAllRefData(marketId) {
  const [markets, laborRates, equipment, facilityRates, utilityRates, overheadRates, mostTemplates, allowanceProfiles, pricingAssumptions] = await Promise.all([
    fetchMarkets(),
    fetchLaborRates(marketId),
    fetchEquipmentCatalog(),
    fetchFacilityRates(marketId),
    fetchUtilityRates(marketId),
    fetchOverheadRates(),
    fetchMostTemplates(),
    fetchAllowanceProfiles(),
    fetchPricingAssumptions(),
  ]);

  return {
    markets,
    laborRates,
    equipment,
    facilityRates,
    utilityRates,
    overheadRates,
    mostTemplates,
    allowanceProfiles,
    pricingAssumptions,
  };
}

// ============================================================
// PHASE 1 — Monthly fact tables + materialized view
// ============================================================

/**
 * Fetch the global ref_periods table (cached for the session). The monthly
 * engine needs this as its time axis.
 * @returns {Promise<Object[]>}
 */
let _cachedPeriods = null;
export async function fetchRefPeriods() {
  if (_cachedPeriods) return _cachedPeriods;
  const { data, error } = await db.from('ref_periods')
    .select('*')
    .eq('period_type', 'month')
    .order('period_index', { ascending: true });
  if (error) throw error;
  _cachedPeriods = data || [];
  return _cachedPeriods;
}

/**
 * Persist a monthly bundle to the three fact tables. Strategy: per-project
 * DELETE-then-INSERT (Phase 1 treats each save as an atomic rewrite). After
 * the writes complete, calls refresh_pnl_for_project(project_id) via RPC
 * so the dashboard read-model is current.
 *
 * Fire-and-forget friendly — if the RPC fails, we emit cm:pnl-refresh-failed
 * but don't fail the user-facing save.
 *
 * @param {number} projectId
 * @param {{ periods: Object[], revenue: Object[], expense: Object[], cashflow: Object[] }} bundle
 * @returns {Promise<{ wrote: { revenue: number, expense: number, cashflow: number } }>}
 */
export async function persistMonthlyFacts(projectId, bundle) {
  // Clear prior facts for this project
  await Promise.all([
    db.from('cost_model_revenue_monthly').delete().eq('project_id', projectId),
    db.from('cost_model_expense_monthly').delete().eq('project_id', projectId),
    db.from('cost_model_cashflow_monthly').delete().eq('project_id', projectId),
  ]);

  const revRows = (bundle.revenue  || []).map(r => ({ ...r, project_id: projectId }));
  const expRows = (bundle.expense  || []).map(r => ({ ...r, project_id: projectId }));
  const cfRows  = (bundle.cashflow || []).map(r => ({ ...r, project_id: projectId }));

  if (revRows.length) {
    const { error } = await db.from('cost_model_revenue_monthly').insert(revRows);
    if (error) console.warn('[CM] revenue_monthly insert failed:', error);
  }
  if (expRows.length) {
    const { error } = await db.from('cost_model_expense_monthly').insert(expRows);
    if (error) console.warn('[CM] expense_monthly insert failed:', error);
  }
  if (cfRows.length) {
    const { error } = await db.from('cost_model_cashflow_monthly').insert(cfRows);
    if (error) console.warn('[CM] cashflow_monthly insert failed:', error);
  }

  // Refresh the materialized view. Fire-and-forget: never block the save.
  try {
    const { error } = await db.rpc('refresh_pnl_for_project', { p_project_id: projectId });
    if (error) console.warn('[CM] fact_pnl_monthly refresh failed:', error);
  } catch (err) {
    console.warn('[CM] refresh_pnl_for_project threw:', err);
  }

  return { wrote: { revenue: revRows.length, expense: expRows.length, cashflow: cfRows.length } };
}

/**
 * Fetch the monthly view (fact_pnl_monthly) for a project. Prefers the
 * materialized view for speed; falls back to joining cashflow + periods
 * directly if the view happens to be empty for this project.
 *
 * @param {number} projectId
 * @returns {Promise<Object[]>}
 */
export async function fetchMonthlyProjections(projectId) {
  const { data, error } = await db.from('fact_pnl_monthly')
    .select('*')
    .eq('project_id', projectId)
    .order('period_index', { ascending: true });
  if (error) {
    console.warn('[CM] fact_pnl_monthly read failed, falling back to raw tables:', error);
    // Fallback: join cost_model_cashflow_monthly with ref_periods
    const { data: cfData } = await db.from('cost_model_cashflow_monthly')
      .select('*, ref_periods(period_index, calendar_year, calendar_month, customer_fy_index, label, is_pre_go_live)')
      .eq('project_id', projectId);
    return cfData || [];
  }
  return data || [];
}
