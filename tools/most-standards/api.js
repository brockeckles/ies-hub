/**
 * IES Hub v3 — MOST Labor Standards API / Persistence
 * Supabase interactions for templates, elements, allowances, and analyses.
 *
 * @module tools/most-standards/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';
// P2-2 (2026-07-02) — pure element sanitation lives in calc.js
import { sanitizeElementForWrite, serializeWorkflow } from './calc.js?v=20260703-ux0';

// ============================================================
// TEMPLATES
// ============================================================

/**
 * List all active MOST templates.
 * @param {Object} [filters]
 * @param {string} [filters.process_area]
 * @param {string} [filters.labor_category]
 * @returns {Promise<import('./types.js?v=20260418-sM').MostTemplate[]>}
 */
export async function listTemplates(filters = {}) {
  let query = db.from('ref_most_templates').select('*').eq('is_active', true);
  if (filters.process_area) query = query.eq('process_area', filters.process_area);
  if (filters.labor_category) query = query.eq('labor_category', filters.labor_category);
  const { data, error } = await query.order('process_area').order('activity_name');
  if (error) throw error;
  const templates = data || [];
  // 2026-07-03 — element_count is derived, not a column; without this the
  // editor list rendered 0 for every template. One lightweight query, counted
  // client-side (avoids PostgREST aggregate-support assumptions).
  try {
    const { data: elRows } = await db.from('ref_most_elements').select('template_id');
    const counts = {};
    for (const r of (elRows || [])) counts[r.template_id] = (counts[r.template_id] || 0) + 1;
    for (const t of templates) t.element_count = counts[t.id] || 0;
  } catch { /* count is cosmetic — never fail the list for it */ }
  return templates;
}

/**
 * Get a single template by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sM').MostTemplate|null>}
 */
export async function getTemplate(id) {
  return db.fetchById('ref_most_templates', id);
}

/**
 * Create a new template.
 * @param {Partial<import('./types.js?v=20260418-sM').MostTemplate>} data
 * @returns {Promise<import('./types.js?v=20260418-sM').MostTemplate>}
 */
export async function createTemplate(data) {
  return db.insert('ref_most_templates', { ...data, is_active: true });
}

/**
 * Update an existing template.
 * @param {string} id
 * @param {Partial<import('./types.js?v=20260418-sM').MostTemplate>} data
 * @returns {Promise<import('./types.js?v=20260418-sM').MostTemplate>}
 */
export async function updateTemplate(id, data) {
  return db.update('ref_most_templates', id, data);
}

/**
 * Soft-delete a template (set is_active = false).
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteTemplate(id) {
  await db.update('ref_most_templates', id, { is_active: false });
}

/**
 * Duplicate a template (with its elements).
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sM').MostTemplate>}
 */
export async function duplicateTemplate(id) {
  const template = await getTemplate(id);
  if (!template) throw new Error('Template not found');
  const elements = await listElements(id);

  // P2-2 fix: the column is activity_name — inserting `name` 400'd every
  // Duplicate click (and read undefined off the source row).
  const { id: _, created_at, updated_at, ...tplData } = template;
  const newTpl = await createTemplate({ ...tplData, activity_name: (tplData.activity_name || 'Template') + ' (Copy)' });

  // Copy elements to new template
  for (const el of elements) {
    const { id: eid, template_id, ...elData } = el;
    await createElement({ ...elData, template_id: newTpl.id });
  }

  return newTpl;
}

// ============================================================
// ELEMENTS
// ============================================================

/**
 * List elements for a template, ordered by sequence.
 * @param {string} templateId
 * @returns {Promise<import('./types.js?v=20260418-sM').MostElement[]>}
 */
export async function listElements(templateId) {
  const { data, error } = await db.from('ref_most_elements')
    .select('*')
    .eq('template_id', templateId)
    .order('sequence_order');
  if (error) throw error;
  return data || [];
}

/**
 * Create a new element.
 * @param {Partial<import('./types.js?v=20260418-sM').MostElement>} data
 * @returns {Promise<import('./types.js?v=20260418-sM').MostElement>}
 */
export async function createElement(data) {
  // P2-2: sanitize — id is BIGSERIAL; editor-local UUID placeholder ids and
  // UI scratch keys must never reach the insert.
  return db.insert('ref_most_elements', sanitizeElementForWrite(data));
}

/**
 * Update an element.
 * @param {string} id
 * @param {Partial<import('./types.js?v=20260418-sM').MostElement>} data
 * @returns {Promise<import('./types.js?v=20260418-sM').MostElement>}
 */
export async function updateElement(id, data) {
  // P2-2: sanitize — never write id/created_at back into the row.
  return db.update('ref_most_elements', id, sanitizeElementForWrite(data));
}

/**
 * Delete an element.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteElement(id) {
  await db.remove('ref_most_elements', id);
}

/**
 * Batch-update element sequence numbers after reorder.
 * @param {Array<{ id: string, sequence: number }>} updates
 * @returns {Promise<void>}
 */
export async function reorderElements(updates) {
  for (const u of updates) {
    // P2-2 fix: column is sequence_order (writing `sequence` 400'd).
    await db.update('ref_most_elements', u.id, { sequence_order: u.sequence });
  }
}

// ============================================================
// ALLOWANCE PROFILES
// ============================================================

/**
 * List all allowance profiles.
 * @returns {Promise<import('./types.js?v=20260418-sM').AllowanceProfile[]>}
 */
export async function listAllowanceProfiles() {
  return db.fetchAll('ref_allowance_profiles');
}

/**
 * Create a new allowance profile.
 * MOS-F5: CRUD support for the Analysis-tab profile picker.
 * @param {{ profile_name: string, personal_pct?: number, fatigue_pct?: number, delay_pct?: number, environment_type?: string, notes?: string }} data
 */
export async function createAllowanceProfile(data) {
  const row = {
    profile_name: data.profile_name,
    personal_pct: data.personal_pct == null ? 0 : Number(data.personal_pct),
    fatigue_pct:  data.fatigue_pct  == null ? 0 : Number(data.fatigue_pct),
    delay_pct:    data.delay_pct    == null ? 0 : Number(data.delay_pct),
    environment_type: data.environment_type || 'ambient',
    notes: data.notes || null,
    is_default: false,
  };
  const { data: result, error } = await db.from('ref_allowance_profiles').insert(row).select().single();
  if (error) throw error;
  try { await recordAudit({ entity: 'most_allowance_profile', entityId: String(result.id), action: 'create', meta: { profile_name: row.profile_name } }); } catch (_) {}
  return result;
}

/**
 * Update an allowance profile.
 * @param {number|string} id
 * @param {object} patch — any subset of profile fields
 */
export async function updateAllowanceProfile(id, patch) {
  const { data: result, error } = await db.from('ref_allowance_profiles').update(patch).eq('id', id).select().single();
  if (error) throw error;
  try { await recordAudit({ entity: 'most_allowance_profile', entityId: String(id), action: 'update', meta: { fields: Object.keys(patch) } }); } catch (_) {}
  return result;
}

/**
 * Delete an allowance profile.
 * @param {number|string} id
 */
export async function deleteAllowanceProfile(id) {
  const { error } = await db.from('ref_allowance_profiles').delete().eq('id', id);
  if (error) throw error;
  try { await recordAudit({ entity: 'most_allowance_profile', entityId: String(id), action: 'delete' }); } catch (_) {}
  return true;
}

// ============================================================
// LABOR ANALYSES (saved analyses)
// ============================================================

/**
 * List saved labor analyses.
 * @returns {Promise<import('./types.js?v=20260418-sM').LaborAnalysis[]>}
 */
export async function listAnalyses() {
  const { data, error } = await db.from('most_analyses')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single analysis by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sM').LaborAnalysis|null>}
 */
export async function getAnalysis(id) {
  return db.fetchById('most_analyses', id);
}

/**
 * Save (insert or update) a labor analysis.
 * @param {import('./types.js?v=20260418-sM').LaborAnalysis} analysis
 * @returns {Promise<import('./types.js?v=20260418-sM').LaborAnalysis>}
 */
export async function saveAnalysis(analysis) {
  const payload = {
    name: analysis.name,
    pfd_pct: analysis.pfd_pct,
    shift_hours: analysis.shift_hours,
    operating_days: analysis.operating_days,
    hourly_rate: analysis.hourly_rate,
    allowance_profile_id: analysis.allowance_profile_id || null,
    // productivity_pct has no dedicated column — stash it inside the jsonb
    // payload so we don't need a schema migration. Loader maps it back out.
    analysis_data: {
      lines: analysis.lines,
      productivity_pct: analysis.productivity_pct == null ? null : Number(analysis.productivity_pct),
      // MOS-E3: per-category rate map (manual/mhe/hybrid). Stashed in jsonb so
      // we don't need a schema migration; loader maps it back out.
      rates_by_category: analysis.rates_by_category || null,
      // MOS-B5: learning-curve productivity index (100 = mature operator).
      learning_curve_pct: analysis.learning_curve_pct == null ? null : Number(analysis.learning_curve_pct),
    },
  };

  if (analysis.id) {
    const updated = await db.update('most_analyses', analysis.id, payload);
    recordAudit({ table: 'most_analyses', id: analysis.id, action: 'update', fields: { name: payload.name, line_count: (analysis.lines || []).length } });
    return updated;
  }
  const inserted = await db.insert('most_analyses', payload);
  recordAudit({ table: 'most_analyses', id: inserted?.id, action: 'insert', fields: { name: payload.name, line_count: (analysis.lines || []).length } });
  return inserted;
}

/**
 * P2-3a (2026-07-02) — save a Workflow Composer scenario. Persists in
 * most_analyses (jsonb-stash pattern, no migration) discriminated by
 * analysis_data.kind='workflow'. listAnalyses returns both kinds; the UI
 * partitions on the discriminator.
 * @param {Object} workflow — composer state ({id?} for update-in-place)
 * @returns {Promise<Object>} the saved row
 */
export async function saveWorkflow(workflow) {
  const payload = {
    name: workflow.name || 'Untitled Workflow',
    pfd_pct: workflow.pfd_pct ?? null,
    shift_hours: workflow.shift_hours ?? null,
    analysis_data: serializeWorkflow(workflow),
  };
  if (workflow.id) {
    const updated = await db.update('most_analyses', workflow.id, payload);
    recordAudit({ table: 'most_analyses', id: workflow.id, action: 'update', fields: { name: payload.name, kind: 'workflow', step_count: (workflow.steps || []).length } });
    return updated;
  }
  const inserted = await db.insert('most_analyses', payload);
  recordAudit({ table: 'most_analyses', id: inserted?.id, action: 'insert', fields: { name: payload.name, kind: 'workflow', step_count: (workflow.steps || []).length } });
  return inserted;
}

/**
 * Delete a saved analysis.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteAnalysis(id) {
  await db.remove('most_analyses', id);
  recordAudit({ table: 'most_analyses', id, action: 'delete' });
}

/**
 * Link a MOST analysis to a Cost Model.
 * @param {string} analysisId
 * @param {string|number} cmId
 */
export async function linkToCm(analysisId, cmId) {
  await db.update('most_analyses', analysisId, { parent_cost_model_id: cmId });
}

/**
 * Unlink a MOST analysis from its Cost Model.
 * @param {string} analysisId
 */
export async function unlinkFromCm(analysisId) {
  await db.update('most_analyses', analysisId, { parent_cost_model_id: null });
}

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load all reference data in parallel.
 * @returns {Promise<{ templates: import('./types.js?v=20260418-sM').MostTemplate[], allowanceProfiles: import('./types.js?v=20260418-sM').AllowanceProfile[] }>}
 */
export async function loadRefData() {
  const [templates, allowanceProfiles] = await Promise.all([
    listTemplates(),
    listAllowanceProfiles(),
  ]);
  return { templates, allowanceProfiles };
}
