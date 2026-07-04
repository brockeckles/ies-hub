/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) API / Persistence
 * Supabase interactions for deals, sites, DOS elements, and artifacts.
 *
 * @module tools/deal-manager/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';
// P2-1 (2026-07-03) — pure site-field→CM-column mapper
import { siteToCmColumns, NEW_SITE_DEFAULTS } from './calc.js?v=20260703-lw3';

// ============================================================
// DEALS
// ============================================================

/**
 * List all deals.
 * @returns {Promise<import('./types.js?v=20260418-sL').Deal[]>}
 */
export async function listDeals() {
  const { data, error } = await db.from('deal_deals')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single deal by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sL').Deal|null>}
 */
export async function getDeal(id) {
  return db.fetchById('deal_deals', id);
}

/**
 * Save (insert or update) a deal.
 * @param {import('./types.js?v=20260418-sL').Deal} deal
 * @returns {Promise<import('./types.js?v=20260418-sL').Deal>}
 */
export async function saveDeal(deal) {
  const payload = {
    deal_name: deal.dealName,
    client_name: deal.clientName,
    deal_owner: deal.dealOwner,
    status: deal.status,
    notes: deal.notes || null,
    contract_term_years: deal.contractTermYears || 5,
  };
  if (deal.id) {
    const updated = await db.update('deal_deals', deal.id, payload);
    recordAudit({ table: 'deal_deals', id: deal.id, action: 'update', fields: { name: payload.deal_name, status: payload.status } });
    return updated;
  }
  const inserted = await db.insert('deal_deals', payload);
  recordAudit({ table: 'deal_deals', id: inserted?.id, action: 'insert', fields: { name: payload.deal_name, status: payload.status } });
  return inserted;
}

// ============================================================
// STAGE TEMPLATES (MUL-F2 — DOS framework, DB-backed)
// ============================================================

/**
 * Fetch the active DOS stage template set: rows of stages plus their
 * element templates. Replaces the hardcoded `DOS_STAGES` constant in calc.js
 * (which now serves as fallback only).
 *
 * Read access on the underlying tables is gated by an "Authenticated users
 * can read ..." RLS policy on prod (verified 2026-04-27). Staging may not
 * have these tables yet (schema drift acknowledged in slice 4.3) — callers
 * should catch and fall back to the hardcoded constant.
 *
 * @returns {Promise<{
 *   templateVersion: { id:number, version:number, version_name:string|null }|null,
 *   stages: Array<{
 *     id:number, stage_number:number, stage_name:string,
 *     description:string|null, element_count:number,
 *     elements: Array<{
 *       id:number, element_name:string, description:string|null,
 *       responsible_workstream:string|null, element_type:string|null,
 *       sort_order:number
 *     }>
 *   }>
 * }>}
 */
/**
 * Load persisted DOS element statuses for a deal → { element_id: status }.
 * Same table + key vocabulary the hub deal-management tool writes
 * (deal_dos_status, element_id = `t<stage>-<templateRowId>`).
 * @param {string} dealId
 * @returns {Promise<Record<string, string>>}
 */
export async function loadDosStatus(dealId) {
  if (!dealId) return {};
  const { data, error } = await db.from('deal_dos_status')
    .select('element_id, status')
    .eq('deal_id', dealId);
  if (error) throw error;
  /** @type {Record<string, string>} */
  const out = {};
  for (const r of (data || [])) {
    if (r.element_id) out[r.element_id] = r.status;
  }
  return out;
}

export async function fetchStageTemplates() {
  // Pick the active template version (MVP: assume single active version).
  const { data: tvRows, error: tvErr } = await db.from('template_versions')
    .select('id, version, version_name')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1);
  if (tvErr) throw tvErr;
  const templateVersion = (tvRows && tvRows[0]) || null;

  // Pull active stages — filter to the active version when one exists, else
  // any active row (defensive against deployments where template_version_id
  // wasn't backfilled).
  let stagesQuery = db.from('stages')
    .select('id, stage_number, stage_name, description, template_version_id, is_active')
    .eq('is_active', true)
    .order('stage_number', { ascending: true });
  if (templateVersion) stagesQuery = stagesQuery.eq('template_version_id', templateVersion.id);
  const { data: stageRows, error: stagesErr } = await stagesQuery;
  if (stagesErr) throw stagesErr;
  if (!Array.isArray(stageRows) || stageRows.length === 0) {
    return { templateVersion, stages: [] };
  }

  // Pull element templates for these stages in one round-trip.
  const stageIds = stageRows.map(r => r.id);
  let elQuery = db.from('stage_element_templates')
    .select('id, stage_id, element_name, description, responsible_workstream, element_type, sort_order, is_template, template_version_id')
    .eq('is_template', true)
    .in('stage_id', stageIds)
    .order('sort_order', { ascending: true });
  if (templateVersion) elQuery = elQuery.eq('template_version_id', templateVersion.id);
  const { data: elementRows, error: elErr } = await elQuery;
  if (elErr) throw elErr;

  // Group elements per stage.
  const byStage = new Map(stageRows.map(s => [s.id, []]));
  for (const e of (elementRows || [])) {
    if (!byStage.has(e.stage_id)) continue;
    byStage.get(e.stage_id).push({
      id: e.id,
      element_name: e.element_name,
      description: e.description,
      responsible_workstream: e.responsible_workstream,
      element_type: e.element_type,
      sort_order: e.sort_order || 0,
    });
  }

  const stages = stageRows.map(s => {
    const els = byStage.get(s.id) || [];
    return {
      id: s.id,
      stage_number: s.stage_number,
      stage_name: s.stage_name,
      description: s.description,
      element_count: els.length,
      elements: els,
    };
  });

  return { templateVersion, stages };
}

/**
 * Delete a deal and unlink its sites.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteDeal(id) {
  // Unlink sites
  await db.from('cost_model_projects')
    .update({ deal_deals_id: null })
    .eq('deal_deals_id', id);
  // Delete artifacts
  await db.from('deal_artifacts').delete().eq('deal_id', id);
  // Delete deal
  await db.remove('deal_deals', id);
}

// ============================================================
// SITES (cost_model_projects linked to deal)
// ============================================================

/**
 * List sites linked to a deal.
 * @param {string} dealId
 * @returns {Promise<import('./types.js?v=20260418-sL').Site[]>}
 */
export async function listSites(dealId) {
  const { data, error } = await db.from('cost_model_projects')
    .select('*')
    .eq('deal_deals_id', dealId)
    .order('name');
  if (error) throw error;
  return (data || []).map(mapCmProjectToSite);
}

/**
 * Link a cost model project to a deal.
 * @param {string} projectId
 * @param {string} dealId
 * @returns {Promise<void>}
 */
export async function linkSite(projectId, dealId) {
  await db.update('cost_model_projects', projectId, { deal_deals_id: dealId });
  recordAudit({ table: 'cost_model_projects', id: projectId, action: 'link', fields: { deal_deals_id: dealId } });
}

/**
 * P2-1 (2026-07-03) — create a new site on a deal. Sites ARE
 * cost_model_projects rows, so this inserts a skeleton CM project already
 * linked via deal_deals_id ('+ Add Empty Site' previously pushed an
 * in-memory object that vanished on Back).
 * @param {string|number} dealId
 * @param {Object} [site] — partial Site fields; NEW_SITE_DEFAULTS fill gaps
 * @returns {Promise<import('./types.js?v=20260418-sL').Site>}
 */
export async function createSite(dealId, site = {}) {
  const cols = siteToCmColumns({ ...NEW_SITE_DEFAULTS, ...site });
  const row = await db.insert('cost_model_projects', {
    ...cols,
    deal_deals_id: dealId,
    status: 'draft',
    description: 'Created in Multi-Site Analyzer',
  });
  recordAudit({ table: 'cost_model_projects', id: row?.id, action: 'insert', fields: { deal_deals_id: dealId, source: 'dm-site' } });
  return mapCmProjectToSite(row);
}

/**
 * P2-1 (2026-07-03) — persist edits to a site's headline fields. Writes the
 * linked cost_model_projects row (unknown fields dropped by the mapper).
 * NOTE for CM-authored projects: total_annual_cost is recomputed by CM on
 * its next save — DM edits to it are a manual override until then.
 * @param {string|number} siteId — cost_model_projects.id
 * @param {Object} patch — partial Site fields
 * @returns {Promise<import('./types.js?v=20260418-sL').Site>}
 */
export async function updateSite(siteId, patch) {
  const cols = siteToCmColumns(patch);
  if (Object.keys(cols).length === 0) return null;
  const row = await db.update('cost_model_projects', siteId, cols);
  recordAudit({ table: 'cost_model_projects', id: siteId, action: 'update', fields: { source: 'dm-site', keys: Object.keys(cols).join(',') } });
  return mapCmProjectToSite(row);
}

/**
 * Unlink a cost model project from a deal.
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export async function unlinkSite(projectId) {
  await db.update('cost_model_projects', projectId, { deal_deals_id: null });
  recordAudit({ table: 'cost_model_projects', id: projectId, action: 'unlink' });
}

/**
 * List unlinked cost model projects (available to add to deals).
 * Returns the canonical CM columns we expose to the picker.
 * @returns {Promise<Array<{ id: number, name: string, total_sqft: number, total_annual_cost: number }>>}
 */
export async function listUnlinkedProjects() {
  const { data, error } = await db.from('cost_model_projects')
    .select('id, name, facility_sqft, total_annual_cost')
    .is('deal_deals_id', null)
    .order('name');
  if (error) throw error;
  // Normalise the column name so callers can use total_sqft uniformly.
  // id → String to match mapCmProjectToSite — the link-modal compares this
  // against dataset.cmId (always a string); raw BIGSERIAL numbers made the
  // freshly-linked site render as 'Linked CM' with zeroed stats (2026-07-03).
  return (data || []).map(r => ({
    id: String(r.id),
    name: r.name,
    total_sqft: r.facility_sqft || 0,
    total_annual_cost: r.total_annual_cost || 0,
  }));
}

/**
 * Map a cost_model_projects row to our Site type.
 * @param {object} row
 * @returns {import('./types.js?v=20260418-sL').Site}
 */
function mapCmProjectToSite(row) {
  return {
    id: String(row.id),
    name: row.name || 'Unnamed Site',
    market: row.client_name || '',                  // CM table tracks client_name, not market
    environment: row.environment_type || '',
    sqft: row.facility_sqft || 0,                   // canonical column is facility_sqft
    annualCost: row.total_annual_cost || 0,
    targetMarginPct: row.target_margin_pct || 0,
    startupCost: row.startup_cost || 0,
    pricingModel: row.pricing_model || 'cost-plus',
    annualVolume: row.vol_pallets_received || 0,    // closest proxy: inbound pallet volume
    costModelId: String(row.id),
  };
}

/**
 * Fetch cost model details and populate a CostBreakdown for a site.
 *
 * Priority order:
 *  1) cost_model_summary (one row per project — canonical aggregated totals)
 *  2) Sum the per-section detail tables (cost_model_labor / equipment / overhead / vas)
 *
 * Facility cost has no detail table — it's only ever in cost_model_summary, so a project
 * with only detail rows will show facility = 0 (which is correct for that project state).
 *
 * @param {string|number} costModelId
 * @returns {Promise<import('./types.js?v=20260418-sL').CostBreakdown|null>}
 */
export async function fetchCostModelBreakdown(costModelId) {
  // CM project ids are bigints in Postgres
  const idVal = typeof costModelId === 'string' && /^\d+$/.test(costModelId)
    ? Number(costModelId)
    : costModelId;

  /** @type {import('./types.js?v=20260418-sL').CostBreakdown} */
  const breakdown = {
    labor: 0,
    facility: 0,
    equipment: 0,
    overhead: 0,
    vas: 0,
    transportation: 0,  // populated below from linkedCogFacts when a COG scenario has written back
  };

  // P4-1 (2026-07-03): transportation from the COG writeback — read side of
  // the linkedCogFacts contract (write-only since 2026-05-28 G2). Fetched
  // FIRST so every return path below carries it.
  try {
    const { data: proj } = await db.from('cost_model_projects')
      .select('project_data')
      .eq('id', idVal)
      .maybeSingle();
    const cog = proj?.project_data?.linkedCogFacts;
    const t = Number(cog?.totalCost);
    if (Number.isFinite(t) && t > 0) breakdown.transportation = t;
  } catch { /* transport stays 0 — benchmark only */ }

  try {
    // 1) Canonical summary
    const { data: summary } = await db.from('cost_model_summary')
      .select('total_labor_cost,total_facility_cost,total_equipment_cost,total_overhead_cost,total_vas_cost')
      .eq('project_id', idVal)
      .maybeSingle();

    if (summary) {
      breakdown.labor     = Number(summary.total_labor_cost     || 0);
      breakdown.facility  = Number(summary.total_facility_cost  || 0);
      breakdown.equipment = Number(summary.total_equipment_cost || 0);
      breakdown.overhead  = Number(summary.total_overhead_cost  || 0);
      breakdown.vas       = Number(summary.total_vas_cost       || 0);
      const total = breakdown.labor + breakdown.facility + breakdown.equipment + breakdown.overhead + breakdown.vas;
      if (total > 0) return breakdown;
    }

    // 2) Aggregate detail tables (parallel — faster than serial)
    const [labor, equipment, overhead, vas] = await Promise.all([
      db.from('cost_model_labor').select('total_annual_cost').eq('project_id', idVal),
      db.from('cost_model_equipment').select('total_annual_cost').eq('project_id', idVal),
      db.from('cost_model_overhead').select('total_annual_cost,annual_cost').eq('project_id', idVal),
      db.from('cost_model_vas').select('total_annual_cost,total_cost').eq('project_id', idVal),
    ]);
    breakdown.labor     = sumColumn(labor.data, ['total_annual_cost']);
    breakdown.equipment = sumColumn(equipment.data, ['total_annual_cost']);
    breakdown.overhead  = sumColumn(overhead.data, ['total_annual_cost', 'annual_cost']);
    breakdown.vas       = sumColumn(vas.data, ['total_annual_cost', 'total_cost']);

    return breakdown;
  } catch (e) {
    console.warn('Cost breakdown fetch failed:', e);
    return null;
  }
}

/**
 * Sum a set of columns across an array of rows, taking the first non-null value per row.
 * Used to handle CM tables that have both `total_annual_cost` and a redundant `annual_cost`.
 * @param {any[]|null|undefined} rows
 * @param {string[]} cols
 * @returns {number}
 */
function sumColumn(rows, cols) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((acc, row) => {
    for (const col of cols) {
      const v = row?.[col];
      if (v != null && v !== '') {
        return acc + Number(v);
      }
    }
    return acc;
  }, 0);
}

// ============================================================
// DOS ELEMENTS
// ============================================================

// ============================================================
// ARTIFACTS
// ============================================================

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load all deal-related data.
 * @returns {Promise<{ deals: import('./types.js?v=20260418-sL').Deal[] }>}
 */
export async function loadRefData() {
  const deals = await listDeals();
  return { deals };
}

// ============================================================
// HOURS TRACKING
// ============================================================

// ============================================================
// TASKS
// ============================================================

function mapTaskRow(row) {
  return {
    id: row.id,
    opportunity_id: row.opportunity_id,
    title: row.title,
    description: row.description,
    status: row.status || 'todo',
    priority: row.priority || 'medium',
    due_date: row.due_date,
    estimated_hours: row.estimated_hours,
    actual_hours: row.actual_hours,
    assignee: row.assignee,
    dos_stage_number: row.dos_stage_number,
    dos_stage_name: row.dos_stage_name,
    sort_order: row.sort_order,
  };
}

// ============================================================
// WEEKLY UPDATES
// ============================================================

// ============================================================
// LOCALSTORAGE FALLBACKS
// ============================================================

function getHoursFromLocalStorage(oppId) {
  const all = JSON.parse(localStorage.getItem('deal_hours') || '{}');
  return all[oppId] || [];
}

function saveHoursToLocalStorage(entry) {
  const all = JSON.parse(localStorage.getItem('deal_hours') || '{}');
  if (!all[entry.opportunity_id]) all[entry.opportunity_id] = [];
  const id = entry.id || 'h-' + Date.now();
  all[entry.opportunity_id].push({ ...entry, id });
  localStorage.setItem('deal_hours', JSON.stringify(all));
  return { ...entry, id };
}

function removeHoursFromLocalStorage(id) {
  const all = JSON.parse(localStorage.getItem('deal_hours') || '{}');
  Object.keys(all).forEach(oppId => {
    all[oppId] = all[oppId].filter(h => h.id !== id);
  });
  localStorage.setItem('deal_hours', JSON.stringify(all));
}

function getTasksFromLocalStorage(oppId) {
  const all = JSON.parse(localStorage.getItem('deal_tasks') || '{}');
  return all[oppId] || [];
}

function saveTaskToLocalStorage(task) {
  const all = JSON.parse(localStorage.getItem('deal_tasks') || '{}');
  if (!all[task.opportunity_id]) all[task.opportunity_id] = [];
  const id = task.id || 't-' + Date.now();
  all[task.opportunity_id].push({ ...task, id });
  localStorage.setItem('deal_tasks', JSON.stringify(all));
  return { ...task, id };
}

function updateTaskInLocalStorage(id, fields) {
  const all = JSON.parse(localStorage.getItem('deal_tasks') || '{}');
  Object.keys(all).forEach(oppId => {
    const task = all[oppId].find(t => t.id === id);
    if (task) Object.assign(task, fields);
  });
  localStorage.setItem('deal_tasks', JSON.stringify(all));
}

function removeTaskFromLocalStorage(id) {
  const all = JSON.parse(localStorage.getItem('deal_tasks') || '{}');
  Object.keys(all).forEach(oppId => {
    all[oppId] = all[oppId].filter(t => t.id !== id);
  });
  localStorage.setItem('deal_tasks', JSON.stringify(all));
}

function getUpdatesFromLocalStorage(oppId) {
  const all = JSON.parse(localStorage.getItem('deal_updates') || '{}');
  return all[oppId] || [];
}

function saveUpdateToLocalStorage(update) {
  const all = JSON.parse(localStorage.getItem('deal_updates') || '{}');
  if (!all[update.opportunity_id]) all[update.opportunity_id] = [];
  const id = update.id || 'u-' + Date.now();
  all[update.opportunity_id].push({ ...update, id });
  localStorage.setItem('deal_updates', JSON.stringify(all));
  return { ...update, id };
}

function removeUpdateFromLocalStorage(id) {
  const all = JSON.parse(localStorage.getItem('deal_updates') || '{}');
  Object.keys(all).forEach(oppId => {
    all[oppId] = all[oppId].filter(u => u.id !== id);
  });
  localStorage.setItem('deal_updates', JSON.stringify(all));
}
