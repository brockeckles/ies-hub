/**
 * IES Hub v3 — Change Management API / Persistence
 * Supabase interactions for change initiatives.
 *
 * @module hub/change-mgmt/api
 */

import { db } from '../../shared/supabase.js?v=20260418-s4';

/**
 * List all change initiatives with nested data.
 * @returns {Promise<import('./types.js?v=20260418-s4').ChangeInitiative[]>}
 */
export async function listInitiatives() {
  const { data, error } = await db.from('change_initiatives').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single initiative by ID.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-s4').ChangeInitiative|null>}
 */
export async function getInitiative(id) {
  return db.fetchById('change_initiatives', id);
}

/**
 * Save (insert or update) an initiative.
 * @param {import('./types.js?v=20260418-s4').ChangeInitiative} initiative
 * @returns {Promise<import('./types.js?v=20260418-s4').ChangeInitiative>}
 */
export async function saveInitiative(initiative) {
  const payload = {
    title: initiative.title,
    description: initiative.description || '',
    status: initiative.status || 'planning',
    priority: initiative.priority || 'medium',
    owner: initiative.owner || '',
    start_date: initiative.startDate,
    target_date: initiative.targetDate,
    tags: initiative.tags || [],
    milestones: initiative.milestones || [],
    stakeholders: initiative.stakeholders || [],
    communications: initiative.communications || [],
  };
  if (initiative.id) return db.update('change_initiatives', initiative.id, payload);
  return db.insert('change_initiatives', payload);
}

/**
 * Delete an initiative.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteInitiative(id) {
  await db.remove('change_initiatives', id);
}

/**
 * Update milestone status within an initiative.
 * @param {string} initiativeId
 * @param {string} milestoneId
 * @param {'pending' | 'completed' | 'overdue'} status
 * @returns {Promise<void>}
 */
export async function updateMilestoneStatus(initiativeId, milestoneId, status) {
  const initiative = await getInitiative(initiativeId);
  if (!initiative) throw new Error('Initiative not found');

  const milestones = (initiative.milestones || []).map(m =>
    m.id === milestoneId ? { ...m, status, completedDate: status === 'completed' ? new Date().toISOString().slice(0, 10) : m.completedDate } : m
  );

  await db.update('change_initiatives', initiativeId, { milestones });
}

/**
 * Update communication status within an initiative.
 * @param {string} initiativeId
 * @param {string} commId
 * @param {'planned' | 'sent' | 'completed'} status
 * @returns {Promise<void>}
 */
export async function updateCommunicationStatus(initiativeId, commId, status) {
  const initiative = await getInitiative(initiativeId);
  if (!initiative) throw new Error('Initiative not found');

  const communications = (initiative.communications || []).map(c =>
    c.id === commId ? { ...c, status } : c
  );

  await db.update('change_initiatives', initiativeId, { communications });
}

/**
 * Load all change management data.
 * @returns {Promise<{ initiatives: import('./types.js?v=20260418-s4').ChangeInitiative[] }>}
 */
export async function loadRefData() {
  const initiatives = await listInitiatives();
  return { initiatives };
}
