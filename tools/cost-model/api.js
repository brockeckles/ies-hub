/**
 * IES Hub v3 — Cost Model API / Persistence
 * Supabase interactions for the Cost Model Builder.
 * Replaces v2's scattered cmFetchTable/cmApiPost/Patch/Delete calls.
 *
 * @module tools/cost-model/api
 */

import { db } from '../../shared/supabase.js?v=20260424-A1';
import { recordAudit } from '../../shared/audit.js?v=20260423-y7';
import {
  getOutboundChannels,
  getAggregateDerived,
  getAggregateInbound,
  getChannelDerived,
} from './calc.channels.js?v=20260429-vol11';

// ============================================================
// COST MODEL PROJECTS (CRUD)
// ============================================================

/**
 * Fetch all cost model projects (list view).
 * @returns {Promise<any[]>}
 */
export async function listModels() {
  // CM-LND-1 (2026-04-25): include deal_deals_id so the landing can group by deal.
  // 2026-04-27: also pull scenario_label, facility_sqft, target_margin_pct so cards can
  // visually fan out by scenario when a deal has multiple models attached.
  // 2026-04-29: embed cost_model_scenarios so the landing can group baseline + children
  // into a single 'scenario family' card. PostgREST returns array-of-one for the
  // unique FK. Renderer falls back to flat card when the embed is missing.
  return db.fetchAll('cost_model_projects', 'id, name, client_name, market_id, deal_deals_id, scenario_label, facility_sqft, target_margin_pct, created_at, updated_at, cost_model_scenarios!cost_model_scenarios_project_id_fkey(id, parent_scenario_id, is_baseline, scenario_label, status)');
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

// ============================================================
// MIGRATIONS / HYDRATION (pure, idempotent)
// ============================================================

/**
 * Map a legacy `category` string to a `line_type` enum value. Pure.
 * @param {string} category
 * @returns {('owned_mhe'|'rented_mhe'|'it_equipment'|'owned_facility')}
 */
function categoryToLineType(category) {
  const cat = String(category || '').trim().toLowerCase();
  if (cat === 'mhe') return 'owned_mhe';
  if (cat === 'it')  return 'it_equipment';
  // 'Racking' | 'Dock' | 'Charging' | 'Office' | 'Security' | 'Conveyor' | 'Other'
  return 'owned_facility';
}

/**
 * Phase 2a back-fill: assign a `line_type` to every EquipmentLine that lacks
 * one, deriving it from the legacy `category` field. Idempotent — lines that
 * already carry a valid `line_type` are left untouched.
 *
 * No cost math changes from this migration — it adds a classification field
 * that Phase 2b+ financing switches and 2d+ auto-gen splits key off of.
 * Legacy projects have no rented_mhe lines, so the back-fill is conservative:
 * all existing MHE rows become owned_mhe; the rental line type is only
 * created fresh via auto-gen after Phase 2d ships.
 *
 * @param {Object} model — Cost Model project data
 * @returns {number} count of lines that were updated (0 if all already typed)
 */
export function backfillEquipmentLineTypes(model) {
  if (!model || !Array.isArray(model.equipmentLines)) return 0;
  const VALID = new Set(['owned_mhe','rented_mhe','it_equipment','owned_facility']);
  let n = 0;
  for (const line of model.equipmentLines) {
    if (!line) continue;
    if (!VALID.has(line.line_type)) {
      line.line_type = categoryToLineType(line.category);
      n++;
    }
  }
  return n;
}

/**
 * Phase 1 of volumes-as-nucleus redesign (2026-04-29). Idempotent migration
 * that populates `model.channels[]` from legacy `volumeLines` + `orderProfile`
 * + `seasonalityProfile` + scattered assumptions. See
 * `project_volumes_nucleus_redesign.md` in auto-memory for architecture.
 *
 * Phase 1: Lossless and silent. Existing legacy fields are preserved on the
 * model so unmigrated calc consumers keep reading them. Channel-aware calc
 * accessors (tools/cost-model/calc.channels.js) read from channels[] only.
 *
 * Phase 3 will migrate every legacy-volumeLines consumer to call into the
 * accessors, after which volumeLines/orderProfile/seasonalityProfile can
 * be dropped from save.
 *
 * Single primary = the isOutboundPrimary row, falling back to the first row.
 * Other volumeLines rows are not represented in channels[] but are kept on
 * the model in case the designer wants to surface them for review.
 *
 * @param {Object} model — Cost Model project data (mutated in place)
 * @returns {boolean} true if a channel was synthesized this call, false if already present
 */
export function backfillChannelsFromLegacy(model) {
  if (!model) return false;
  if (Array.isArray(model.channels) && model.channels.length > 0) return false;

  const volumeLines = Array.isArray(model.volumeLines) ? model.volumeLines : [];
  const orderProfile = model.orderProfile || {};
  const seasonality = model.seasonalityProfile || null;

  const primaryRow = volumeLines.find(v => v && v.isOutboundPrimary) || volumeLines[0] || null;

  // UOM normalization mirrors calc.channels.js:normalizeUom — keep in sync.
  const normalizeUom = (uom) => {
    const u = String(uom || '').toLowerCase().trim();
    if (!u || u === 'each' || u === 'eaches' || u === 'unit') return 'units';
    if (u === 'case') return 'cases';
    if (u === 'pallet') return 'pallets';
    if (u === 'order') return 'orders';
    if (u === 'line') return 'lines';
    return u;
  };

  const primary = primaryRow
    ? {
        value: Number(primaryRow.volume) || 0,
        uom: normalizeUom(primaryRow.uom),
        activity: 'outbound',
        source: 'manual',
      }
    : { value: 0, uom: 'units', activity: 'outbound', source: 'manual' };

  // Conversions seeded from orderProfile where available, falling to neutral
  // mid-range defaults otherwise. Designers will tune these on first
  // walkthrough of the Phase 2 Volumes & Profile page.
  const conversions = {
    unitsPerCase: 12,
    casesPerPallet: 40,
    linesPerOrder: Number(orderProfile.linesPerOrder) || 2,
    unitsPerLine:  Number(orderProfile.unitsPerLine)  || 5,
    weightPerUnit: Number(orderProfile.avgOrderWeight) || 1,
    weightUnit: orderProfile.weightUnit || 'lbs',
  };

  // Structural assumptions are net-new model state. None of these existed
  // on legacy models, so seed neutral mid-range defaults that don't materially
  // change downstream output. Designer tunes per-channel during Phase 2.
  const assumptions = {
    returnsPercent: 5,
    inboundOutboundRatio: 1.0,
    peakSurgeFactor: 1.5,
  };

  const channelSeasonality = {
    preset: (seasonality && seasonality.preset) || 'flat',
    monthly_shares: (seasonality && Array.isArray(seasonality.monthly_shares) && seasonality.monthly_shares.length === 12)
      ? seasonality.monthly_shares.slice()
      : Array.from({ length: 12 }, () => 1 / 12),
  };

  model.channels = [{
    key: 'outbound',
    name: 'Outbound',
    archetypeId: null,
    sortOrder: 10,
    primary,
    conversions,
    assumptions,
    seasonality: channelSeasonality,
    overrides: [],
  }];

  // Mix state defaults to byVolume — single channel, mix is implicit 100%.
  if (!model.channelMix) {
    model.channelMix = { mode: 'byVolume' };
  }

  return true;
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
 * Fetch the master_channel_archetypes catalog (Phase 2.3 of volumes-as-nucleus).
 * Active rows only, sorted. Used by the Add Channel picker modal.
 *
 * @returns {Promise<any[]>}
 */
export async function fetchChannelArchetypes() {
  try {
    const { data, error } = await db.from('master_channel_archetypes')
      .select('id, archetype_key, name, description, default_conversions, default_assumptions, default_seasonality_preset, auto_derived_returns, icon, color, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[CM] fetchChannelArchetypes failed:', err);
    return [];
  }
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
  // Slice 3.9: fact_pnl_monthly is no longer exposed via the PostgREST API
  // (advisor: materialized_view_in_api). Call the SECURITY DEFINER RPC
  // `get_pnl_monthly` instead — it applies my/team/shared scoping by the
  // parent cost_model_projects row and returns the ordered monthly rows.
  const { data, error } = await db.rpc('get_pnl_monthly', { p_project_id: projectId });
  if (error) {
    console.warn('[CM] get_pnl_monthly RPC failed, falling back to raw tables:', error);
    // Fallback: join cost_model_cashflow_monthly with ref_periods. The
    // underlying tables already enforce Slice 3.3 owner/team/visibility RLS
    // via the parent cost_model_projects row, so this path stays safe.
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
 * Fetch all scenarios in the same family as the given project. The "family"
 * is defined by climbing the parent_scenario_id chain to a root, then
 * collecting that root + every descendant. All scenarios in a family typically
 * share the same deal_id (cloneScenario copies it), so we fetch the deal's
 * scenarios in one round-trip and walk the chain client-side.
 *
 * Each row carries the embedded project (id, name, scenario_label, sqft,
 * margin, updated_at) so the renderer doesn't need a second query.
 *
 * @param {number} projectId
 * @returns {Promise<any[]>}  scenarios in family, ordered baseline-first
 */
export async function listScenarioFamilyForProject(projectId) {
  if (!projectId) return [];
  const SELECT = 'id, parent_scenario_id, is_baseline, scenario_label, status, project_id, cost_model_projects!cost_model_scenarios_project_id_fkey(id, name, scenario_label, facility_sqft, target_margin_pct, updated_at)';
  // Step 1 — fetch the current scenario row by project_id
  const { data: cur, error: e1 } = await db.from('cost_model_scenarios')
    .select('id, parent_scenario_id')
    .eq('project_id', projectId).maybeSingle();
  if (e1 || !cur) return [];
  // Step 2 — climb parent_scenario_id to find the family root. We deliberately
  // do NOT filter by deal_id — historically some scenario rows had NULL deal_id
  // even though their project had deal_deals_id set, which silently dropped them
  // from the family. The parent-chain walk works regardless of deal_id state.
  let rootId = cur.id;
  let parentId = cur.parent_scenario_id;
  let guard = 0;
  while (parentId && guard++ < 10) {
    const { data: parent } = await db.from('cost_model_scenarios')
      .select('id, parent_scenario_id')
      .eq('id', parentId).maybeSingle();
    if (!parent) break;
    rootId = parent.id;
    parentId = parent.parent_scenario_id;
  }
  // Step 3 — collect root + direct children. Depth-1 covers the current data
  // shape (baseline + sibling scenarios). For deeper trees, future work can add
  // an RPC with a recursive CTE; that is not needed today.
  const { data, error: e2 } = await db.from('cost_model_scenarios')
    .select(SELECT)
    .or(`id.eq.${rootId},parent_scenario_id.eq.${rootId}`);
  if (e2 || !Array.isArray(data)) { console.warn('[CM] listScenarioFamilyForProject failed:', e2); return []; }
  // Sort: baseline first (by root id), then children oldest-first by id
  data.sort((a, b) => {
    if (a.id === rootId) return -1;
    if (b.id === rootId) return 1;
    return a.id - b.id;
  });
  return data;
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
// SHIFT PLANNER — ref_shift_archetype_defaults catalog
// ============================================================

/**
 * Fetch the shift archetype catalog (admin-editable % matrices by vertical).
 * Powers the "Apply Archetype" dropdown in the Shift Planning section.
 * @returns {Promise<any[]>}
 */
export async function fetchShiftArchetypes() {
  const { data, error } = await db.from('ref_shift_archetype_defaults')
    .select('*').eq('is_active', true).order('sort_order', { ascending: true });
  if (error) { console.warn('[CM] fetchShiftArchetypes failed:', error); return []; }
  return data || [];
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


/**
 * CM-LND-2 — partial-update helper used by drag-to-reassign on the landing
 * page. Patches only `deal_deals_id` + `updated_at` so we don't have to
 * round-trip the full project_data jsonb just to move a model between
 * deal groups.
 *
 * @param {number} modelId
 * @param {string|null} dealId — pass null to send the model back to "Unassigned"
 * @returns {Promise<any>}
 */
export async function reassignModelToDeal(modelId, dealId) {
  return db.update('cost_model_projects', modelId, {
    deal_deals_id: dealId || null,
    updated_at: new Date().toISOString(),
  });
}

// ============================================================
// CM-SET-2 — DEFAULT REFERENCE DATA SEEDS
// ============================================================

/**
 * CM-SET-2 — built-in reference defaults. Used to bootstrap a fresh Supabase
 * project so the Cost Model can run against real per-market rates rather
 * than hard-coded fallbacks. Idempotent: rows are matched by natural keys
 * before insert, so re-running is safe.
 *
 * @returns {Promise<{
 *   marketsAdded: number,
 *   laborRatesAdded: number,
 *   equipmentAdded: number,
 *   facilityRatesAdded: number,
 *   utilityRatesAdded: number,
 *   overheadRatesAdded: number
 * }>}
 */
export async function seedDefaultRefData() {
  const stats = { marketsAdded: 0, laborRatesAdded: 0, equipmentAdded: 0, facilityRatesAdded: 0, utilityRatesAdded: 0, overheadRatesAdded: 0 };

  // ── Markets ────────────────────────────────────────────────
  const defaultMarkets = [
    { market_id: 'mem', name: 'Memphis', state: 'TN' },
    { market_id: 'ind', name: 'Indianapolis', state: 'IN' },
    { market_id: 'chi', name: 'Chicago', state: 'IL' },
    { market_id: 'dal', name: 'Dallas-Fort Worth', state: 'TX' },
    { market_id: 'atl', name: 'Atlanta', state: 'GA' },
    { market_id: 'lax', name: 'Los Angeles', state: 'CA' },
    { market_id: 'njy', name: 'Northern NJ / NYC Metro', state: 'NJ' },
    { market_id: 'col', name: 'Columbus', state: 'OH' },
    { market_id: 'leh', name: 'Lehigh Valley', state: 'PA' },
    { market_id: 'sav', name: 'Savannah', state: 'GA' },
    { market_id: 'lou', name: 'Louisville', state: 'KY' },
    { market_id: 'pho', name: 'Phoenix', state: 'AZ' },
    { market_id: 'cin', name: 'Cincinnati', state: 'OH' },
    { market_id: 'rvs', name: 'Riverside / Inland Empire', state: 'CA' },
    { market_id: 'nas', name: 'Nashville', state: 'TN' },
    { market_id: 'hou', name: 'Houston', state: 'TX' },
    { market_id: 'kci', name: 'Kansas City', state: 'MO' },
    { market_id: 'rno', name: 'Reno', state: 'NV' },
    { market_id: 'cha', name: 'Charlotte', state: 'NC' },
    { market_id: 'sea', name: 'Seattle-Tacoma', state: 'WA' },
  ];
  try {
    const existing = await db.fetchAll('master_markets').catch(() => []);
    const have = new Set((existing || []).map(m => m.market_id || m.id));
    const toAdd = defaultMarkets.filter(m => !have.has(m.market_id));
    if (toAdd.length) {
      await db.from('master_markets').insert(toAdd);
      stats.marketsAdded = toAdd.length;
    }
  } catch (e) { console.warn('[seedDefaultRefData] markets:', e); }

  // ── Labor rates ────────────────────────────────────────────
  // Industry hourly base × per-market multiplier.
  const positions = [
    { name: 'Equipment Operator', base: 22.00 },
    { name: 'Material Handler', base: 18.00 },
    { name: 'Lead', base: 24.00 },
    { name: 'Supervisor', base: 35.00 },
    { name: 'Manager', base: 48.00 },
    { name: 'Clerk', base: 19.50 },
  ];
  const marketMult = {
    mem: 0.95, ind: 0.97, chi: 1.10, dal: 1.05, atl: 1.02, lax: 1.30,
    njy: 1.25, col: 0.97, leh: 1.05, sav: 0.92, lou: 0.94, pho: 1.04,
    cin: 0.95, rvs: 1.15, nas: 1.00, hou: 1.05, kci: 0.93, rno: 1.10,
    cha: 0.98, sea: 1.20,
  };
  try {
    const existing = await db.fetchAll('master_labor_rates').catch(() => []);
    const have = new Set((existing || []).map(r => `${r.market_id}|${r.position_name}`));
    const toAdd = [];
    for (const mid of Object.keys(marketMult)) {
      for (const p of positions) {
        const key = `${mid}|${p.name}`;
        if (have.has(key)) continue;
        toAdd.push({ market_id: mid, position_name: p.name, hourly_wage: +(p.base * marketMult[mid]).toFixed(2), effective_start_date: new Date().toISOString().slice(0, 10) });
      }
    }
    if (toAdd.length) {
      await db.from('master_labor_rates').insert(toAdd);
      stats.laborRatesAdded = toAdd.length;
    }
  } catch (e) { console.warn('[seedDefaultRefData] labor rates:', e); }

  // ── Equipment catalog ──────────────────────────────────────
  const equipment = [
    { equipment_name: 'Reach Truck',          category: 'MHE', acquisition_cost: 38000,  monthly_lease_cost: 1100, monthly_rental_cost: 1000, amort_years: 10 },
    { equipment_name: 'Sit-Down Forklift',    category: 'MHE', acquisition_cost: 32000,  monthly_lease_cost: 950,  monthly_rental_cost: 2500, amort_years: 10 },
    { equipment_name: 'Walkie Pallet Jack',   category: 'MHE', acquisition_cost: 4500,   monthly_lease_cost: 200,  monthly_rental_cost: 650,  amort_years: 7 },
    { equipment_name: 'Order Picker',         category: 'MHE', acquisition_cost: 36000,  monthly_lease_cost: 1050, monthly_rental_cost: 900,  amort_years: 10 },
    { equipment_name: 'Yard Jockey',          category: 'MHE', acquisition_cost: 95000,  monthly_lease_cost: 2800, monthly_rental_cost: 4500, amort_years: 8 },
    { equipment_name: 'RF Terminal',          category: 'IT',  acquisition_cost: 1800,   monthly_lease_cost: 65,   monthly_rental_cost: 0,    amort_years: 3 },
    { equipment_name: 'Label Printer',        category: 'IT',  acquisition_cost: 1200,   monthly_lease_cost: 45,   monthly_rental_cost: 0,    amort_years: 5 },
    { equipment_name: 'WiFi Access Point',    category: 'IT',  acquisition_cost: 600,    monthly_lease_cost: 0,    monthly_rental_cost: 0,    amort_years: 5 },
    { equipment_name: 'Network Switch',       category: 'IT',  acquisition_cost: 4500,   monthly_lease_cost: 0,    monthly_rental_cost: 0,    amort_years: 7 },
    { equipment_name: 'Workstation/PC',       category: 'IT',  acquisition_cost: 1500,   monthly_lease_cost: 0,    monthly_rental_cost: 0,    amort_years: 4 },
    { equipment_name: 'Selective Pallet Rack',category: 'Racking', acquisition_cost: 95, monthly_lease_cost: 0,    monthly_rental_cost: 0,    amort_years: 15 },
    { equipment_name: 'Drive-In Rack',        category: 'Racking', acquisition_cost: 130,monthly_lease_cost: 0,    monthly_rental_cost: 0,    amort_years: 15 },
    { equipment_name: 'Hydraulic Dock Leveler', category: 'Dock', acquisition_cost: 4200, monthly_lease_cost: 0,   monthly_rental_cost: 0,    amort_years: 12 },
    { equipment_name: 'Charging Station',     category: 'Charging', acquisition_cost: 2800, monthly_lease_cost: 0, monthly_rental_cost: 0,   amort_years: 10 },
    { equipment_name: 'Office Build-Out (sqft)', category: 'Office', acquisition_cost: 145, monthly_lease_cost: 0, monthly_rental_cost: 0,   amort_years: 10 },
    { equipment_name: 'Camera/Security System',category: 'Security', acquisition_cost: 8500, monthly_lease_cost: 0, monthly_rental_cost: 0,  amort_years: 8 },
    { equipment_name: 'Belt Conveyor (lin ft)',category: 'Conveyor', acquisition_cost: 220, monthly_lease_cost: 0, monthly_rental_cost: 0,   amort_years: 12 },
  ];
  try {
    const existing = await db.fetchAll('master_equipment_catalog').catch(() => []);
    const have = new Set((existing || []).map(r => r.equipment_name));
    const toAdd = equipment.filter(e => !have.has(e.equipment_name));
    if (toAdd.length) {
      await db.from('master_equipment_catalog').insert(toAdd);
      stats.equipmentAdded = toAdd.length;
    }
  } catch (e) { console.warn('[seedDefaultRefData] equipment catalog:', e); }

  // ── Facility rates ($/sqft/yr triple-net by market) ────────
  const facilityBase = 5.50;
  try {
    const existing = await db.fetchAll('master_facility_rates').catch(() => []);
    const have = new Set((existing || []).map(r => r.market_id));
    const toAdd = [];
    for (const mid of Object.keys(marketMult)) {
      if (have.has(mid)) continue;
      toAdd.push({
        market_id: mid,
        rate_per_sqft_yr: +(facilityBase * marketMult[mid]).toFixed(2),
        effective_start_date: new Date().toISOString().slice(0, 10),
      });
    }
    if (toAdd.length) {
      await db.from('master_facility_rates').insert(toAdd);
      stats.facilityRatesAdded = toAdd.length;
    }
  } catch (e) { console.warn('[seedDefaultRefData] facility rates:', e); }

  // ── Utility rates ($/kWh by market) ────────────────────────
  const kwh = { mem: 0.10, ind: 0.10, chi: 0.12, dal: 0.10, atl: 0.11, lax: 0.18, njy: 0.16, col: 0.10, leh: 0.13, sav: 0.11, lou: 0.10, pho: 0.13, cin: 0.10, rvs: 0.18, nas: 0.10, hou: 0.10, kci: 0.10, rno: 0.13, cha: 0.10, sea: 0.10 };
  try {
    const existing = await db.fetchAll('master_utility_rates').catch(() => []);
    const have = new Set((existing || []).map(r => r.market_id));
    const toAdd = Object.keys(kwh).filter(mid => !have.has(mid)).map(mid => ({
      market_id: mid,
      rate_per_kwh: kwh[mid],
      effective_start_date: new Date().toISOString().slice(0, 10),
    }));
    if (toAdd.length) {
      await db.from('master_utility_rates').insert(toAdd);
      stats.utilityRatesAdded = toAdd.length;
    }
  } catch (e) { console.warn('[seedDefaultRefData] utility rates:', e); }

  // ── Overhead rate categories ───────────────────────────────
  const overhead = [
    { overhead_category: 'Insurance',          monthly_cost: 4500 },
    { overhead_category: 'Office Supplies',    monthly_cost: 1200 },
    { overhead_category: 'IT Services',        monthly_cost: 6500 },
    { overhead_category: 'Janitorial',         monthly_cost: 3200 },
    { overhead_category: 'Pest Control',       monthly_cost: 350 },
    { overhead_category: 'Travel & Training',  monthly_cost: 2800 },
  ];
  try {
    const existing = await db.fetchAll('master_overhead_rates').catch(() => []);
    const have = new Set((existing || []).map(r => r.overhead_category));
    const toAdd = overhead.filter(o => !have.has(o.overhead_category));
    if (toAdd.length) {
      await db.from('master_overhead_rates').insert(toAdd);
      stats.overheadRatesAdded = toAdd.length;
    }
  } catch (e) { console.warn('[seedDefaultRefData] overhead rates:', e); }

  return stats;
}

// ============================================================
// CM <-> WSC INTEGRATION HELPERS
// ============================================================

/**
 * Build the CM->WSC launch payload from a cost-model state. Phase 4 Layer A
 * of volumes-as-nucleus (2026-04-29). Aggregates across non-reverse channels
 * via the Phase-1 channel accessors so WSC's volumes panel pre-fills with
 * cost-model-derived numbers instead of generic defaults.
 *
 * Used by:
 *   - tools/cost-model/ui.js  : 'launch-wsc' button handler, on click.
 *   - tools/warehouse-sizing/ui.js : 'Pull from CM' button on the Volumes panel.
 *
 * Every field is optional + additive on the WSC consumer side - WSC overwrites
 * its local volumes only when the corresponding payload value is positive.
 *
 * @param {Object} model - cost-model state (model.channels[] preferred; legacy volumeLines also supported via the channel accessors' synthesis).
 * @returns {Object} CmToWscPayload + at timestamp.
 */
export function buildWscLaunchPayload(model) {
  const facility = model?.facility || {};
  const opDays = Number(facility.opDaysPerYear) || 250;
  const annualPalletsInbound  = getAggregateInbound(model, 'pallets');
  const annualPalletsOutbound = getAggregateDerived(model, 'pallets');
  const avgDailyInbound  = annualPalletsInbound  / Math.max(1, opDays);
  const avgDailyOutbound = annualPalletsOutbound / Math.max(1, opDays);
  // A facility is sized to the busiest channel's peak day, not an average.
  const channels = getOutboundChannels(model);
  const peakMultiplier = channels.reduce((mx, c) =>
    Math.max(mx, Number(c.assumptions?.peakSurgeFactor) || 1.5), 1.5);
  // Sum each channel's peakDay-units (drives storage on-hand sizing in WSC).
  const peakUnitsPerDay = channels.reduce((sum, c) =>
    sum + (getChannelDerived(model, c, 'peakDay').value || 0), 0);
  // Phase 4 Layer B (volumes-as-nucleus, 2026-04-29): emit a per-channel
  // breakdown so WSC can size storage media per-channel. Each entry carries
  // the channel's peakDay units in physical units + an optional storageAllocation
  // override sourced from channel data. When the channel doesn't override,
  // WSC's calcStorageByType applies the facility-level zones.storageAllocation.
  const channelMixes = channels.map(c => {
    const peak = getChannelDerived(model, c, 'peakDay').value || 0;
    const out = {
      channelKey: c.key,
      name: c.name || c.key,
      peakUnitsPerDay: Math.round(peak),
    };
    if (c.storageAllocation && typeof c.storageAllocation === 'object') {
      out.storageAllocation = { ...c.storageAllocation };
    }
    return out;
  }).filter(m => m.peakUnitsPerDay > 0);
  return {
    clearHeight: facility.clearHeight || 0,
    totalSqft:   facility.totalSqft   || 0,
    totalPallets:    Math.round(annualPalletsInbound),
    avgDailyInbound: Math.round(avgDailyInbound),
    avgDailyOutbound: Math.round(avgDailyOutbound),
    peakMultiplier:  Number(peakMultiplier.toFixed(2)),
    peakUnitsPerDay: Math.round(peakUnitsPerDay),
    inventoryTurns:  Number(facility.inventoryTurns) || 12,
    totalSKUs:       Number(facility.totalSKUs) || 0,
    channelMixes,
    at: Date.now(),
  };
}

