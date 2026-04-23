/**
 * IES Hub v3 — Admin Panel API / Persistence
 * Supabase interactions for master data, users, escalations, and audit log.
 *
 * @module hub/admin/api
 */

import { db } from '../../shared/supabase.js?v=20260423-y1';
import { recordAudit } from '../../shared/audit.js?v=20260423-y5';

// ============================================================
// MASTER DATA
// ============================================================

/** Tables that don't have a sort_order column — fall back to a stable alternative. */
const ORDER_BY = {
  ref_multisite_grade_thresholds: 'metric_name',
  ref_fleet_carrier_rates: 'display_name',
  ref_design_heuristics: 'sort_order',
  ref_labor_market_profiles: 'id',
  ref_fleet_dedicated_benchmarks: 'id',
  accounts: 'company_name',
  competitors: 'name',
  master_markets: 'market_code',
};

/**
 * List records from a master table. Defaults to sort_order; falls back to
 * a per-table column from ORDER_BY for tables without a sort_order column.
 * @param {string} tableName
 * @returns {Promise<any[]>}
 */
export async function listMasterRecords(tableName) {
  const orderCol = ORDER_BY[tableName] || 'sort_order';
  const { data, error } = await db.from(tableName).select('*').order(orderCol, { ascending: true });
  if (error) {
    // Fallback: try without ordering if the column doesn't exist
    const { data: data2, error: err2 } = await db.from(tableName).select('*');
    if (err2) throw err2;
    return data2 || [];
  }
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
  if (id) {
    const row = await db.update(tableName, id, payload);
    recordAudit({ table: tableName, id, action: 'update', fields: payload });
    return row;
  }
  const inserted = await db.insert(tableName, payload);
  recordAudit({ table: tableName, id: inserted?.id, action: 'insert', fields: payload });
  return inserted;
}

/**
 * Delete a master record.
 * @param {string} tableName
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteMasterRecord(tableName, id) {
  await db.remove(tableName, id);
  recordAudit({ table: tableName, id, action: 'delete' });
}

// ============================================================
// USERS
// ============================================================

/**
 * List user accounts.
 * @returns {Promise<import('./types.js?v=20260418-sP').UserAccount[]>}
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
 * @returns {Promise<import('./types.js?v=20260418-sP').EscalationRule[]>}
 */
export async function listEscalations() {
  const { data, error } = await db.from('escalation_rules').select('*').order('created_at');
  if (error) throw error;
  return data || [];
}

/**
 * Save (insert or update) an escalation rule.
 * @param {import('./types.js?v=20260418-sP').EscalationRule} rule
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
 * List audit log entries. Schema cols: id, ts, entity_table, entity_id,
 * action (insert|update|delete|link|unlink), changed_fields jsonb,
 * session_id, user_email, user_agent.
 *
 * @param {Object} [filter]
 * @param {number} [filter.limit=200]
 * @param {string} [filter.entityTable]   exact match on entity_table
 * @param {string} [filter.action]        exact match on action enum
 * @param {string} [filter.since]         ISO date string; rows ts >= since
 * @returns {Promise<any[]>}
 */
export async function listAuditLog(filter = {}) {
  const { limit = 200, entityTable, action, since } = (typeof filter === 'number' ? { limit: filter } : filter) || {};
  let q = db.from('audit_log').select('*').order('ts', { ascending: false }).limit(limit);
  if (entityTable) q = q.eq('entity_table', entityTable);
  if (action)      q = q.eq('action', action);
  if (since)       q = q.gte('ts', since);
  const { data, error } = await q;
  if (error) { console.warn('[admin] listAuditLog failed:', error); return []; }
  return data || [];
}

/**
 * Distinct entity_table + action values so the filter dropdowns can
 * self-populate. Cheap DISTINCT query.
 * @returns {Promise<{ tables: string[], actions: string[] }>}
 */
export async function listAuditFacets() {
  const { data, error } = await db.from('audit_log').select('entity_table, action').limit(2000);
  if (error) return { tables: [], actions: [] };
  const tables = new Set();
  const actions = new Set();
  for (const r of data || []) {
    if (r.entity_table) tables.add(r.entity_table);
    if (r.action) actions.add(r.action);
  }
  return { tables: Array.from(tables).sort(), actions: Array.from(actions).sort() };
}

/**
 * Write an audit log entry.
 * @param {Omit<import('./types.js?v=20260418-sP').AuditLogEntry, 'id'>} entry
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
