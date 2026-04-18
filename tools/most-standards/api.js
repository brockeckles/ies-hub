/**
 * IES Hub v3 — MOST Labor Standards API / Persistence
 * Supabase interactions for templates, elements, allowances, and analyses.
 *
 * @module tools/most-standards/api
 */

import { db } from '../../shared/supabase.js?v=20260418-sB';

// ============================================================
// TEMPLATES
// ============================================================

/**
 * List all active MOST templates.
 * @param {Object} [filters]
 * @param {string} [filters.process_area]
 * @param {string} [filters.labor_category]
 * @returns {Promise<import('./types.js?v=20260418-sB').MostTemplate[]>}
 */
export async function listTemplates(filters = {}) {
  let query = db.from('ref_most_templates').select('*').eq('is_active', true);
  if (filters.process_area) query = query.eq('process_area', filters.process_area);
  if (filters.labor_category) query = query.eq('labor_category', filters.labor_category);
  const { data, error } = await query.order('process_area').order('name');
  if (error) throw error;
  return data || [];
}

/**
 * Get a single template by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sB').MostTemplate|null>}
 */
export async function getTemplate(id) {
  return db.fetchById('ref_most_templates', id);
}

/**
 * Create a new template.
 * @param {Partial<import('./types.js?v=20260418-sB').MostTemplate>} data
 * @returns {Promise<import('./types.js?v=20260418-sB').MostTemplate>}
 */
export async function createTemplate(data) {
  return db.insert('ref_most_templates', { ...data, is_active: true });
}

/**
 * Update an existing template.
 * @param {string} id
 * @param {Partial<import('./types.js?v=20260418-sB').MostTemplate>} data
 * @returns {Promise<import('./types.js?v=20260418-sB').MostTemplate>}
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
 * @returns {Promise<import('./types.js?v=20260418-sB').MostTemplate>}
 */
export async function duplicateTemplate(id) {
  const template = await getTemplate(id);
  if (!template) throw new Error('Template not found');
  const elements = await listElements(id);

  const { id: _, created_at, updated_at, ...tplData } = template;
  const newTpl = await createTemplate({ ...tplData, name: tplData.name + ' (Copy)' });

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
 * @returns {Promise<import('./types.js?v=20260418-sB').MostElement[]>}
 */
export async function listElements(templateId) {
  const { data, error } = await db.from('ref_most_elements')
    .select('*')
    .eq('template_id', templateId)
    .order('sequence');
  if (error) throw error;
  return data || [];
}

/**
 * Create a new element.
 * @param {Partial<import('./types.js?v=20260418-sB').MostElement>} data
 * @returns {Promise<import('./types.js?v=20260418-sB').MostElement>}
 */
export async function createElement(data) {
  return db.insert('ref_most_elements', data);
}

/**
 * Update an element.
 * @param {string} id
 * @param {Partial<import('./types.js?v=20260418-sB').MostElement>} data
 * @returns {Promise<import('./types.js?v=20260418-sB').MostElement>}
 */
export async function updateElement(id, data) {
  return db.update('ref_most_elements', id, data);
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
    await db.update('ref_most_elements', u.id, { sequence: u.sequence });
  }
}

// ============================================================
// ALLOWANCE PROFILES
// ============================================================

/**
 * List all allowance profiles.
 * @returns {Promise<import('./types.js?v=20260418-sB').AllowanceProfile[]>}
 */
export async function listAllowanceProfiles() {
  return db.fetchAll('ref_allowance_profiles');
}

// ============================================================
// LABOR ANALYSES (saved analyses)
// ============================================================

/**
 * List saved labor analyses.
 * @returns {Promise<import('./types.js?v=20260418-sB').LaborAnalysis[]>}
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
 * @returns {Promise<import('./types.js?v=20260418-sB').LaborAnalysis|null>}
 */
export async function getAnalysis(id) {
  return db.fetchById('most_analyses', id);
}

/**
 * Save (insert or update) a labor analysis.
 * @param {import('./types.js?v=20260418-sB').LaborAnalysis} analysis
 * @returns {Promise<import('./types.js?v=20260418-sB').LaborAnalysis>}
 */
export async function saveAnalysis(analysis) {
  const payload = {
    name: analysis.name,
    pfd_pct: analysis.pfd_pct,
    shift_hours: analysis.shift_hours,
    operating_days: analysis.operating_days,
    hourly_rate: analysis.hourly_rate,
    allowance_profile_id: analysis.allowance_profile_id || null,
    analysis_data: { lines: analysis.lines },
  };

  if (analysis.id) {
    return db.update('most_analyses', analysis.id, payload);
  }
  return db.insert('most_analyses', payload);
}

/**
 * Delete a saved analysis.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteAnalysis(id) {
  await db.remove('most_analyses', id);
}

// ============================================================
// BULK LOAD
// ============================================================

/**
 * Load all reference data in parallel.
 * @returns {Promise<{ templates: import('./types.js?v=20260418-sB').MostTemplate[], allowanceProfiles: import('./types.js?v=20260418-sB').AllowanceProfile[] }>}
 */
export async function loadRefData() {
  const [templates, allowanceProfiles] = await Promise.all([
    listTemplates(),
    listAllowanceProfiles(),
  ]);
  return { templates, allowanceProfiles };
}
