/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) API / Persistence
 * Supabase interactions for deals, sites, DOS elements, and artifacts.
 *
 * @module tools/deal-manager/api
 */

import { db } from '../../shared/supabase.js?v=20260417-mB';

// ============================================================
// DEALS
// ============================================================

/**
 * List all deals.
 * @returns {Promise<import('./types.js?v=20260417-mB').Deal[]>}
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
 * @returns {Promise<import('./types.js?v=20260417-mB').Deal|null>}
 */
export async function getDeal(id) {
  return db.fetchById('deal_deals', id);
}

/**
 * Save (insert or update) a deal.
 * @param {import('./types.js?v=20260417-mB').Deal} deal
 * @returns {Promise<import('./types.js?v=20260417-mB').Deal>}
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
 * @returns {Promise<import('./types.js?v=20260417-mB').Site[]>}
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
 * @returns {import('./types.js?v=20260417-mB').Site}
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
 * @returns {Promise<import('./types.js?v=20260417-mB').DosStage[]>}
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
 * @returns {Promise<import('./types.js?v=20260417-mB').DealArtifact[]>}
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
 * @returns {Promise<import('./types.js?v=20260417-mB').DealArtifact>}
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
 * @returns {Promise<{ deals: import('./types.js?v=20260417-mB').Deal[] }>}
 */
export async function loadRefData() {
  const deals = await listDeals();
  return { deals };
}

// ============================================================
// HOURS TRACKING
// ============================================================

/**
 * Fetch hours for an opportunity.
 * @param {string} opportunityId
 * @returns {Promise<import('./types.js?v=20260417-mB').HoursEntry[]>}
 */
export async function fetchHours(opportunityId) {
  try {
    const { data, error } = await db.from('project_hours')
      .select('*')
      .eq('opportunity_id', opportunityId)
      .order('week_start', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('Hours fetch failed; using localStorage fallback:', e);
    return getHoursFromLocalStorage(opportunityId);
  }
}

/**
 * Log new hours entry.
 * @param {import('./types.js?v=20260417-mB').HoursEntry} entry
 * @returns {Promise<import('./types.js?v=20260417-mB').HoursEntry>}
 */
export async function logHours(entry) {
  try {
    const payload = {
      opportunity_id: entry.opportunity_id,
      week_start: entry.week_start,
      hours_type: entry.hours_type,
      hours: entry.hours,
      resource: entry.resource || null,
      category: entry.category || 'actual',
      notes: entry.notes || null,
    };
    return db.insert('project_hours', payload);
  } catch (e) {
    console.warn('Hours log failed; using localStorage fallback:', e);
    return saveHoursToLocalStorage(entry);
  }
}

/**
 * Delete hours entry.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteHours(id) {
  try {
    await db.remove('project_hours', id);
  } catch (e) {
    console.warn('Hours delete failed; using localStorage fallback:', e);
    removeHoursFromLocalStorage(id);
  }
}

// ============================================================
// TASKS
// ============================================================

/**
 * Fetch tasks for an opportunity.
 * @param {string} opportunityId
 * @returns {Promise<import('./types.js?v=20260417-mB').Task[]>}
 */
export async function fetchTasks(opportunityId) {
  try {
    const { data, error } = await db.from('opportunity_tasks')
      .select('*')
      .eq('opportunity_id', opportunityId)
      .order('sort_order');
    if (error) throw error;
    return (data || []).map(mapTaskRow);
  } catch (e) {
    console.warn('Tasks fetch failed; using localStorage fallback:', e);
    return getTasksFromLocalStorage(opportunityId);
  }
}

/**
 * Create a new task.
 * @param {import('./types.js?v=20260417-mB').Task} task
 * @returns {Promise<import('./types.js?v=20260417-mB').Task>}
 */
export async function createTask(task) {
  try {
    const payload = {
      opportunity_id: task.opportunity_id,
      title: task.title,
      description: task.description || null,
      status: task.status || 'todo',
      priority: task.priority || 'medium',
      due_date: task.due_date || null,
      estimated_hours: task.estimated_hours || null,
      actual_hours: task.actual_hours || null,
      assignee: task.assignee || null,
      dos_stage_number: task.dos_stage_number || null,
      dos_stage_name: task.dos_stage_name || null,
      sort_order: task.sort_order || 0,
    };
    return db.insert('opportunity_tasks', payload);
  } catch (e) {
    console.warn('Task create failed; using localStorage fallback:', e);
    return saveTaskToLocalStorage(task);
  }
}

/**
 * Update a task.
 * @param {string} id
 * @param {Partial<import('./types.js?v=20260417-mB').Task>} fields
 * @returns {Promise<void>}
 */
export async function updateTask(id, fields) {
  try {
    const payload = {};
    if (fields.title !== undefined) payload.title = fields.title;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.status !== undefined) payload.status = fields.status;
    if (fields.priority !== undefined) payload.priority = fields.priority;
    if (fields.due_date !== undefined) payload.due_date = fields.due_date;
    if (fields.estimated_hours !== undefined) payload.estimated_hours = fields.estimated_hours;
    if (fields.actual_hours !== undefined) payload.actual_hours = fields.actual_hours;
    if (fields.assignee !== undefined) payload.assignee = fields.assignee;
    await db.update('opportunity_tasks', id, payload);
  } catch (e) {
    console.warn('Task update failed; using localStorage fallback:', e);
    updateTaskInLocalStorage(id, fields);
  }
}

/**
 * Delete a task.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteTask(id) {
  try {
    await db.remove('opportunity_tasks', id);
  } catch (e) {
    console.warn('Task delete failed; using localStorage fallback:', e);
    removeTaskFromLocalStorage(id);
  }
}

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

/**
 * Fetch updates for an opportunity.
 * @param {string} opportunityId
 * @returns {Promise<import('./types.js?v=20260417-mB').WeeklyUpdate[]>}
 */
export async function fetchUpdates(opportunityId) {
  try {
    const { data, error } = await db.from('project_updates')
      .select('*')
      .eq('opportunity_id', opportunityId)
      .order('update_date', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('Updates fetch failed; using localStorage fallback:', e);
    return getUpdatesFromLocalStorage(opportunityId);
  }
}

/**
 * Create a new update.
 * @param {import('./types.js?v=20260417-mB').WeeklyUpdate} update
 * @returns {Promise<import('./types.js?v=20260417-mB').WeeklyUpdate>}
 */
export async function createUpdate(update) {
  try {
    const payload = {
      opportunity_id: update.opportunity_id,
      update_date: update.update_date,
      author: update.author || null,
      body: update.body,
      next_steps: update.next_steps || null,
      blockers: update.blockers || null,
    };
    return db.insert('project_updates', payload);
  } catch (e) {
    console.warn('Update create failed; using localStorage fallback:', e);
    return saveUpdateToLocalStorage(update);
  }
}

/**
 * Delete an update.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteUpdate(id) {
  try {
    await db.remove('project_updates', id);
  } catch (e) {
    console.warn('Update delete failed; using localStorage fallback:', e);
    removeUpdateFromLocalStorage(id);
  }
}

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
