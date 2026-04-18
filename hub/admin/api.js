/**
 * IES Hub v3 — Admin Panel API / Persistence
 * Supabase interactions for master data, users, escalations, and audit log.
 *
 * @module hub/admin/api
 */

import { db } from '../../shared/supabase.js?v=20260418-s6';

// ============================================================
// MASTER DATA
// ============================================================

/**
 * List records from a master table.
 * @param {string} tableName
 * @returns {Promise<any[]>}
 */
export async function listMasterRecords(tableName) {
  const { data, error } = await db.from(tableName).select('*').order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Save (insert or update) a master record.
 * @param {string} tableName
 * @param {string|null} id
 * @param {Record<string, any>} payload
 * @returns {Promise<any>}
 */
export async function saveMasterRecord(tableName, id, payload) {
  if (id) return db.update(tableName, id, payload);
  return db.insert(tableName, payload);
}

/**
 * Delete a master record.
 * @param {string} tableName
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteMasterRecord(tableName, id) {
  await db.remove(tableName, id);
}

// ============================================================
// USERS
// ============================================================

/**
 * List user accounts.
 * @returns {Promise<import('./types.js?v=20260418-s6').UserAccount[]>}
 */
export async function listUsers() {
  const { data, error } = await db.from('user_accounts').select('*').order('display_name');
  if (error) throw error;
  return data || [];
}

/**
 * Update user role or active status.
 * @param {string} id
 * @param {{ role?: string, active?: boolean }} updates
 * @returns {Promise<void>}
 */
export async function updateUser(id, updates) {
  await db.update('user_accounts', id, updates);
}

// ============================================================
// ESCALATION RULES
// ============================================================

/**
 * List escalation rules.
 * @returns {Promise<import('./types.js?v=20260418-s6').EscalationRule[]>}
 */
export async function listEscalations() {
  const { data, error } = await db.from('escalation_rules').select('*').order('created_at');
  if (error) throw error;
  return data || [];
}

/**
 * Save (insert or update) an escalation rule.
 * @param {import('./types.js?v=20260418-s6').EscalationRule} rule
 * @returns {Promise<any>}
 */
export async function saveEscalation(rule) {
  const payload = {
    name: rule.name,
    metric: rule.metric,
    condition: rule.condition,
    threshold: rule.threshold,
    severity: rule.severity,
    active: rule.active,
    notify_email: rule.notifyEmail || null,
  };
  if (rule.id) return db.update('escalation_rules', rule.id, payload);
  return db.insert('escalation_rules', payload);
}

/**
 * Delete an escalation rule.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteEscalation(id) {
  await db.remove('escalation_rules', id);
}

// ============================================================
// AUDIT LOG
// ============================================================

/**
 * List audit log entries.
 * @param {number} [limit=100]
 * @returns {Promise<import('./types.js?v=20260418-s6').AuditLogEntry[]>}
 */
export async function listAuditLog(limit = 100) {
  const { data, error } = await db.from('audit_log').select('*').order('timestamp', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Write an audit log entry.
 * @param {Omit<import('./types.js?v=20260418-s6').AuditLogEntry, 'id'>} entry
 * @returns {Promise<void>}
 */
export async function writeAuditEntry(entry) {
  await db.insert('audit_log', entry);
}

// ============================================================
// LOAD ALL
// ============================================================

/**
 * Load all admin data.
 * @returns {Promise<{ users: any[], escalations: any[], auditLog: any[] }>}
 */
export async function loadRefData() {
  const [users, escalations, auditLog] = await Promise.all([
    listUsers(),
    listEscalations(),
    listAuditLog(),
  ]);
  return { users, escalations, auditLog };
}
