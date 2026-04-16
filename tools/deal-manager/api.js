/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) API / Persistence
 * Supabase interactions for deals, sites, DOS elements, and artifacts.
 *
 * @module tools/deal-manager/api
 */

import { db } from '../../shared/supabase.js';

// ============================================================
// DEALS
// ============================================================

/**
 * List all deals.
 * @returns {Promise<import('./types.js').Deal[]>}
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
 * @returns {Promise<import('./types.js').Deal|null>}
 */
export async function getDeal(id) {
  return db.fetchById('deal_deals', id);
}

/**
 * Save (insert or update) a deal.
 * @param {import('./types.js').Deal} deal
 * @returns {Promise<import('./types.js').Deal>}
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
    return db.update('deal_deals', deal.id, payload);
  }
  return db.insert('deal_deals', payload);
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
 * @returns {Promise<import('./types.js').Site[]>}
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
}

/**
 * Unlink a cost model project from a deal.
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export async function unlinkSite(projectId) {
  await db.update('cost_model_projects', projectId, { deal_deals_id: null });
}

/**
 * List unlinked cost model projects (available to add to deals).
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listUnlinkedProjects() {
  const { data, error } = await db.from('cost_model_projects')
    .select('id, name, total_sqft, total_annual_cost')
    .is('deal_deals_id', null)
    .order('name');
  if (error) throw error;
  return data || [];
}

/**
 * Map a cost_model_projects row to our Site type.
 * @param {object} row
 * @returns {import('./types.js').Site}
 */
function mapCmProjectToSite(row) {
  return {
    id: row.id,
    name: row.name || 'Unnamed Site',
    market: row.market || '',
    environment: row.environment_type || '',
    sqft: row.total_sqft || 0,
    annualCost: row.total_annual_cost || 0,
    targetMarginPct: row.target_margin_pct || 0,
    startupCost: row.startup_cost || 0,
    pricingModel: row.pricing_model || 'cost-plus',
    annualVolume: row.annual_volume || 0,
  };
}

// ============================================================
// DOS ELEMENTS
// ============================================================

/**
 * List DOS elements for a deal (from opportunity_tasks).
 * @param {string} dealId
 * @returns {Promise<import('./types.js').DosStage[]>}
 */
export async function listDosElements(dealId) {
  const { data, error } = await db.from('opportunity_tasks')
    .select('*')
    .eq('opportunity_id', dealId)
    .order('sort_order');
  if (error) throw error;

  // Group by stage
  const stageMap = new Map();
  for (const row of (data || [])) {
    const sn = row.dos_stage_number || 1;
    if (!stageMap.has(sn)) {
      stageMap.set(sn, {
        stageNumber: sn,
        stageName: row.dos_stage_name || `Stage ${sn}`,
        elements: [],
      });
    }
    stageMap.get(sn).elements.push({
      id: row.id,
      name: row.name,
      elementType: row.element_type || 'other',
      workstream: row.workstream || 'solutions',
      description: row.description || '',
      status: row.status || 'not_started',
      assignedTo: row.assigned_to || '',
      dueDate: row.due_date || '',
    });
  }

  return Array.from(stageMap.values()).sort((a, b) => a.stageNumber - b.stageNumber);
}

/**
 * Update a DOS element's status.
 * @param {string} elementId
 * @param {string} status
 * @returns {Promise<void>}
 */
export async function updateElementStatus(elementId, status) {
  await db.update('opportunity_tasks', elementId, { status });
}

// ============================================================
// ARTIFACTS
// ============================================================

/**
 * List artifacts linked to a deal.
 * @param {string} dealId
 * @returns {Promise<import('./types.js').DealArtifact[]>}
 */
export async function listArtifacts(dealId) {
  const { data, error } = await db.from('deal_artifacts')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Link an artifact to a deal.
 * @param {string} dealId
 * @param {string} artifactType
 * @param {string} artifactId
 * @param {string} [artifactName]
 * @returns {Promise<import('./types.js').DealArtifact>}
 */
export async function linkArtifact(dealId, artifactType, artifactId, artifactName) {
  return db.insert('deal_artifacts', {
    deal_id: dealId,
    artifact_type: artifactType,
    artifact_id: artifactId,
    artifact_name: artifactName || null,
  });
}

/**
 * Remove an artifact link.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function unlinkArtifact(id) {
  await db.remove('deal_artifacts', id);
}

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load all deal-related data.
 * @returns {Promise<{ deals: import('./types.js').Deal[] }>}
 */
export async function loadRefData() {
  const deals = await listDeals();
  return { deals };
}
