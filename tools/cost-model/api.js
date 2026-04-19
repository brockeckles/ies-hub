/**
 * IES Hub v3 — Cost Model API / Persistence
 * Supabase interactions for the Cost Model Builder.
 * Replaces v2's scattered cmFetchTable/cmApiPost/Patch/Delete calls.
 *
 * @module tools/cost-model/api
 */

import { db } from '../../shared/supabase.js?v=20260418-sK';
import { recordAudit } from '../../shared/audit.js?v=20260419-sZ';

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
// LINKED DESIGN SCENARIOS (reverse linkage from CM)
// ============================================================

/**
 * Fetch all design-tool scenarios linked to a given Cost Model project via
 * `parent_cost_model_id`. Returns a small projection per row, keyed by tool.
 * Each tool table is queried independently so a single failure doesn't break
 * the whole panel.
 *
 * @param {number|string} cmId
 * @returns {Promise<{ wsc:Array, cog:Array, netopt:Array, fleet:Array }>}
 */
export async function listLinkedDesignScenarios(cmId) {
  if (!cmId) return { wsc: [], cog: [], netopt: [], fleet: [] };
  const out = { wsc: [], cog: [], netopt: [], fleet: [] };
  const tables = [
    { key: 'wsc',    table: 'wsc_facility_configs',  nameKey: 'name' },
    { key: 'cog',    table: 'cog_scenarios',         nameKey: 'name' },
    { key: 'netopt', table: 'netopt_configs',        nameKey: 'name' },
    { key: 'fleet',  table: 'fleet_scenarios',       nameKey: 'name' },
  ];
  await Promise.all(tables.map(async ({ key, table, nameKey }) => {
    try {
      const { data, error } = await db.from(table)
        .select(`id, ${nameKey}, updated_at, created_at, parent_cost_model_id`)
        .eq('parent_cost_model_id', cmId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      out[key] = (data || []).map(r => ({ id: r.id, name: r[nameKey] || 'Untitled', updated: r.updated_at || r.created_at }));
    } catch (err) {
      console.warn(`[CM] listLinkedDesignScenarios(${table}) failed:`, err);
      out[key] = [];
    }
  }));
  return out;
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
  // db.rpc throws on error (doesn't return {data,error}); just catch.
  try {
    await db.rpc('refresh_pnl_for_project', { p_project_id: projectId });
  } catch (err) {
    console.warn('[CM] refresh_pnl_for_project failed:', err);
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

// ============================================================
// PHASE 3 — SCENARIOS + SCD + HEURISTICS
// ============================================================

/**
 * List all scenarios for a deal. Returns newest first so the sidebar
 * shows the most-recent child at top.
 * @param {string} dealId   deal_deals.id (uuid)
 * @returns {Promise<any[]>}
 */
export async function listScenarios(dealId) {
  const q = db.from('cost_model_scenarios').select('*').order('created_at', { ascending: false });
  const { data, error } = dealId ? await q.eq('deal_id', dealId) : await q;
  if (error) { console.warn('[CM] listScenarios failed:', error); return []; }
  return data || [];
}

/**
 * Fetch the scenario row for a specific project_id (1:1). Used to show
 * status chip on the tool header.
 * @param {number} projectId
 * @returns {Promise<any|null>}
 */
export async function getScenarioByProject(projectId) {
  if (!projectId) return null;
  const { data, error } = await db.from('cost_model_scenarios')
    .select('*').eq('project_id', projectId).maybeSingle();
  if (error) { console.warn('[CM] getScenarioByProject failed:', error); return null; }
  return data;
}

/**
 * Create or update a scenario row. Called whenever the user edits the
 * scenario_label, description, or changes status from draft→review.
 * @param {Object} payload — partial cost_model_scenarios row
 * @returns {Promise<any>}
 */
export async function saveScenario(payload) {
  if (!payload) throw new Error('saveScenario: payload required');
  const clean = { ...payload, updated_at: new Date().toISOString() };
  let row;
  if (clean.id) {
    const { data, error } = await db.from('cost_model_scenarios')
      .update(clean).eq('id', clean.id).select().single();
    if (error) throw error;
    row = data;
    recordAudit({ table: 'cost_model_scenarios', id: row.id, action: 'update', fields: clean }).catch(() => {});
  } else {
    const { data, error } = await db.from('cost_model_scenarios')
      .insert(clean).select().single();
    if (error) throw error;
    row = data;
    recordAudit({ table: 'cost_model_scenarios', id: row.id, action: 'insert', fields: clean }).catch(() => {});
  }
  return row;
}

/**
 * Approve a scenario. Fires the approve_scenario RPC which snapshots
 * all rate cards + heuristics atomically and transitions status.
 * @param {number} scenarioId
 * @param {string|null} userEmail
 * @returns {Promise<Object>} RPC result (counts per rate type)
 */
export async function approveScenarioRpc(scenarioId, userEmail) {
  const payload = { p_scenario_id: Number(scenarioId), p_user_email: userEmail || null };
  const data = await db.rpc('approve_scenario', payload);
  recordAudit({ table: 'cost_model_scenarios', id: scenarioId, action: 'update', fields: { status: 'approved', approved_by: userEmail } }).catch(() => {});
  return data;
}

/**
 * Archive a scenario (status='archived'). Preserves snapshots.
 * @param {number} scenarioId
 * @returns {Promise<any>}
 */
export async function archiveScenario(scenarioId) {
  const { data, error } = await db.from('cost_model_scenarios')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', scenarioId).select().single();
  if (error) throw error;
  recordAudit({ table: 'cost_model_scenarios', id: scenarioId, action: 'update', fields: { status: 'archived' } }).catch(() => {});
  return data;
}

/**
 * Clone a scenario (copy-on-write). Deep-copies the source project row
 * and every line-table row, then creates a new scenario pointing at the
 * new project with parent_scenario_id = source. Used when the user
 * edits an approved scenario.
 *
 * @param {number} sourceScenarioId
 * @param {string|null} newLabel
 * @returns {Promise<{ scenario: any, projectId: number }>}
 */
export async function cloneScenario(sourceScenarioId, newLabel) {
  // 1. Load source scenario + project + line tables
  const { data: srcScen, error: scErr } = await db.from('cost_model_scenarios')
    .select('*').eq('id', sourceScenarioId).single();
  if (scErr) throw scErr;
  const srcProjectId = srcScen.project_id;
  if (!srcProjectId) throw new Error('source scenario has no project');

  const [srcProj, laborRows, eqRows, ohRows, vasRows, volRows] = await Promise.all([
    db.fetchById('cost_model_projects', srcProjectId),
    db.fetchAll('cost_model_labor', '*').catch(() => []).then(rs => rs.filter(r => r.project_id === srcProjectId)),
    db.fetchAll('cost_model_equipment', '*').catch(() => []).then(rs => rs.filter(r => r.project_id === srcProjectId)),
    db.fetchAll('cost_model_overhead', '*').catch(() => []).then(rs => rs.filter(r => r.project_id === srcProjectId)),
    db.fetchAll('cost_model_vas', '*').catch(() => []).then(rs => rs.filter(r => r.project_id === srcProjectId)),
    db.fetchAll('cost_model_volumes', '*').catch(() => []).then(rs => rs.filter(r => r.project_id === srcProjectId)),
  ]);
  if (!srcProj) throw new Error('source project missing');

  // 2. Insert a new project with same data, fresh id, and "(child)" label tacked on
  const newProjPayload = { ...srcProj };
  delete newProjPayload.id;
  delete newProjPayload.created_at;
  delete newProjPayload.updated_at;
  newProjPayload.name = (srcProj.name || 'Model') + ' — ' + (newLabel || 'Child');
  newProjPayload.status = 'draft';
  newProjPayload.scenario_label = newLabel || 'Child';
  const { data: newProj, error: npErr } = await db.from('cost_model_projects')
    .insert(newProjPayload).select().single();
  if (npErr) throw npErr;
  const newProjectId = newProj.id;

  // 3. Clone line tables (strip id + project_id, set new project_id)
  const cloneRows = (rows) => rows.map(r => {
    const c = { ...r };
    delete c.id; delete c.created_at; delete c.updated_at;
    c.project_id = newProjectId;
    return c;
  });
  const copies = [
    ['cost_model_labor', cloneRows(laborRows)],
    ['cost_model_equipment', cloneRows(eqRows)],
    ['cost_model_overhead', cloneRows(ohRows)],
    ['cost_model_vas', cloneRows(vasRows)],
    ['cost_model_volumes', cloneRows(volRows)],
  ];
  for (const [tbl, rows] of copies) {
    if (!rows.length) continue;
    const { error } = await db.from(tbl).insert(rows);
    if (error) console.warn(`[CM] clone ${tbl} failed:`, error);
  }

  // 4. Create the new scenario row with parent_scenario_id set
  const newScen = await saveScenario({
    deal_id: srcScen.deal_id,
    project_id: newProjectId,
    parent_scenario_id: sourceScenarioId,
    scenario_label: newLabel || `${srcScen.scenario_label || 'Scenario'} (child)`,
    is_baseline: false,
    status: 'draft',
  });
  recordAudit({ table: 'cost_model_scenarios', id: newScen.id, action: 'insert', fields: { parent_scenario_id: sourceScenarioId, via: 'clone' } }).catch(() => {});
  return { scenario: newScen, projectId: newProjectId };
}

/**
 * Fetch all rate snapshots for a scenario, grouped by type. Used when a
 * scenario is reopened in Archive view.
 * @param {number} scenarioId
 * @returns {Promise<Object<string, any[]>>}   { labor: [...], facility: [...], ... }
 */
export async function fetchSnapshots(scenarioId) {
  if (!scenarioId) return {};
  const { data, error } = await db.from('cost_model_rate_snapshots')
    .select('*').eq('scenario_id', scenarioId);
  if (error) { console.warn('[CM] fetchSnapshots failed:', error); return {}; }
  const out = {};
  for (const r of data || []) {
    if (!out[r.rate_card_type]) out[r.rate_card_type] = [];
    // unwrap snapshot_json for easy consumption
    out[r.rate_card_type].push({ ...(r.snapshot_json || {}), _version_hash: r.rate_card_version_hash, _captured_at: r.captured_at, _rate_card_id: r.rate_card_id });
  }
  return out;
}

// ============================================================
// REVISION LOG
// ============================================================

/**
 * List all revisions for a scenario (most-recent first).
 * @param {number} scenarioId
 * @returns {Promise<any[]>}
 */
export async function listRevisions(scenarioId) {
  if (!scenarioId) return [];
  const { data, error } = await db.from('cost_model_revisions')
    .select('*').eq('scenario_id', scenarioId)
    .order('revision_number', { ascending: false });
  if (error) { console.warn('[CM] listRevisions failed:', error); return []; }
  return data || [];
}

/**
 * Write a revision row. Caller supplies the fully-formed row (from
 * calc.scenarios.buildRevisionRow).
 * @param {Object} row
 * @returns {Promise<any>}
 */
export async function writeRevision(row) {
  if (!row || !row.scenario_id) throw new Error('writeRevision: scenario_id required');
  const { data, error } = await db.from('cost_model_revisions').insert(row).select().single();
  if (error) throw error;
  return data;
}

/**
 * Return the current max revision_number for a scenario, or 0 if none.
 * Used to auto-increment on saveRevision.
 * @param {number} scenarioId
 * @returns {Promise<number>}
 */
export async function getLatestRevisionNumber(scenarioId) {
  const { data, error } = await db.from('cost_model_revisions')
    .select('revision_number').eq('scenario_id', scenarioId)
    .order('revision_number', { ascending: false }).limit(1).maybeSingle();
  if (error) return 0;
  return data?.revision_number || 0;
}

// ============================================================
// HEURISTICS CATALOG + OVERRIDES
// ============================================================

/**
 * Fetch the ref_design_heuristics catalog.
 * @returns {Promise<any[]>}
 */
export async function fetchDesignHeuristics() {
  const { data, error } = await db.from('ref_design_heuristics')
    .select('*').eq('is_active', true).order('sort_order', { ascending: true });
  if (error) { console.warn('[CM] fetchDesignHeuristics failed:', error); return []; }
  return data || [];
}

/**
 * Save the per-project heuristic_overrides jsonb. Overwrites the whole
 * map; callers pass the full desired map (not a diff).
 * @param {number} projectId
 * @param {Object} overrides
 * @returns {Promise<any>}
 */
export async function saveHeuristicOverrides(projectId, overrides) {
  if (!projectId) throw new Error('saveHeuristicOverrides: projectId required');
  const payload = { heuristic_overrides: overrides || {}, updated_at: new Date().toISOString() };
  const { data, error } = await db.from('cost_model_projects')
    .update(payload).eq('id', projectId).select('id, heuristic_overrides').single();
  if (error) throw error;
  recordAudit({ table: 'cost_model_projects', id: projectId, action: 'update', fields: { heuristic_overrides: overrides } }).catch(() => {});
  return data;
}

// ============================================================
// PLANNING RATIOS (ref_planning_ratios + overrides)
// ============================================================
// Separate from the 26-row ref_design_heuristics system. Richer schema:
//   applicability filters (vertical/env/automation/market_tier), SCD
//   versioning (effective_date/effective_end_date), structured values
//   (array/lookup/tiered), source + citation.

/**
 * Fetch the planning-ratios category dictionary.
 * @returns {Promise<any[]>}
 */
export async function fetchPlanningRatioCategories() {
  const { data, error } = await db.from('ref_heuristic_categories')
    .select('*').order('sort_order', { ascending: true });
  if (error) { console.warn('[CM] fetchPlanningRatioCategories failed:', error); return []; }
  return data || [];
}

/**
 * Fetch all active planning ratios (the full catalog).
 * @returns {Promise<any[]>}
 */
export async function fetchPlanningRatios() {
  const { data, error } = await db.from('ref_planning_ratios')
    .select('*').eq('is_active', true).order('sort_order', { ascending: true });
  if (error) { console.warn('[CM] fetchPlanningRatios failed:', error); return []; }
  return data || [];
}

/**
 * Save the per-project planning_ratio_overrides jsonb. Full-map overwrite.
 * Shape: { 'ratio_code': { value, note?, updated_at? } }
 * @param {number} projectId
 * @param {Object} overrides
 * @returns {Promise<any>}
 */
export async function savePlanningRatioOverrides(projectId, overrides) {
  if (!projectId) throw new Error('savePlanningRatioOverrides: projectId required');
  const payload = { planning_ratio_overrides: overrides || {}, updated_at: new Date().toISOString() };
  const { data, error } = await db.from('cost_model_projects')
    .update(payload).eq('id', projectId).select('id, planning_ratio_overrides').single();
  if (error) throw error;
  recordAudit({ table: 'cost_model_projects', id: projectId, action: 'update', fields: { planning_ratio_overrides: overrides } }).catch(() => {});
  return data;
}

// ============================================================
// SCD — supersede-and-insert helper
// ============================================================

// ============================================================
// PHASE 4c — LABOR MARKET PROFILES
// ============================================================

/**
 * Fetch the labor market profile for a specific market_id, or null if
 * none exists. Used by the Labor section's "Use market defaults" button.
 * @param {string} marketId
 * @returns {Promise<any|null>}
 */
export async function fetchLaborMarketProfile(marketId) {
  if (!marketId) return null;
  const { data, error } = await db.from('ref_labor_market_profiles')
    .select('*').eq('market_id', marketId).maybeSingle();
  if (error) { console.warn('[CM] fetchLaborMarketProfile failed:', error); return null; }
  return data;
}

/**
 * List all labor market profiles (for admin panel).
 * @returns {Promise<any[]>}
 */
export async function listLaborMarketProfiles() {
  const { data, error } = await db.from('ref_labor_market_profiles')
    .select('*, ref_markets(name, state)')
    .order('id', { ascending: true });
  if (error) { console.warn('[CM] listLaborMarketProfiles failed:', error); return []; }
  return data || [];
}

/**
 * Save (upsert) the monthly OT/absence profile for a labor row.
 * Fire-and-forget audit. Used when the user hits Save in the per-row
 * profile editor.
 * @param {number} laborId
 * @param {{ monthly_overtime_profile?: number[]|null, monthly_absence_profile?: number[]|null }} profiles
 * @returns {Promise<any>}
 */
export async function saveLaborMonthlyProfile(laborId, profiles) {
  if (!laborId) throw new Error('saveLaborMonthlyProfile: laborId required');
  const payload = {
    monthly_overtime_profile: profiles?.monthly_overtime_profile ?? null,
    monthly_absence_profile:  profiles?.monthly_absence_profile  ?? null,
  };
  const { data, error } = await db.from('cost_model_labor')
    .update(payload).eq('id', laborId).select().single();
  if (error) throw error;
  recordAudit({ table: 'cost_model_labor', id: laborId, action: 'update', fields: payload }).catch(() => {});
  return data;
}

/**
 * Close out a current rate row by setting its effective_end_date and
 * inserting a replacement. Used by the Admin panel when editing rates
 * on an approved-scenarios-present tenant.
 *
 * @param {string} table       one of ref_labor_rates / facility / utility / overhead / equipment
 * @param {string} oldId       the uuid of the row being replaced
 * @param {Object} newRow      the replacement row data (no id)
 * @returns {Promise<{ retired: any, created: any }>}
 */
export async function superseRateCardRow(table, oldId, newRow) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: insertedRow, error: insErr } = await db.from(table).insert(newRow).select().single();
  if (insErr) throw insErr;
  const { data: retiredRow, error: retErr } = await db.from(table)
    .update({ effective_end_date: today, superseded_by_id: insertedRow.id })
    .eq('id', oldId).select().single();
  if (retErr) throw retErr;
  recordAudit({ table, id: oldId, action: 'update', fields: { effective_end_date: today, superseded_by_id: insertedRow.id } }).catch(() => {});
  return { retired: retiredRow, created: insertedRow };
}

