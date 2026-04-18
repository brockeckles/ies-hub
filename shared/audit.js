/**
 * IES Hub v3 — shared audit-log writer (X15)
 *
 * Records mutations to a central public.audit_log table. Until real
 * auth is wired we use a per-session id (random uuid stashed in
 * sessionStorage) so rows from one browser session can be grouped.
 *
 * Usage:
 *   import { recordAudit } from '../../shared/audit.js?v=20260418-sP';
 *
 *   await recordAudit({
 *     table: 'most_analyses',
 *     id: row.id,
 *     action: 'update',          // 'insert' | 'update' | 'delete' | 'link' | 'unlink'
 *     fields: { name, pfd_pct }, // optional — fields that changed
 *   });
 *
 * Failures are swallowed (with a console.warn). The audit write must
 * NEVER block the actual user mutation — every saveX call wraps it
 * in fire-and-forget so a flaky network doesn't degrade the editor.
 *
 * @module shared/audit
 */

import { db } from './supabase.js?v=20260418-sP';

/**
 * Get-or-create the per-browser session identifier.
 * @returns {string}
 */
export function sessionId() {
  try {
    let id = sessionStorage.getItem('ies_session_id');
    if (!id) {
      id = (crypto?.randomUUID?.() || `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      sessionStorage.setItem('ies_session_id', id);
    }
    return id;
  } catch {
    return `s-${Date.now()}`;
  }
}

/**
 * Pull a user email if one is present. Today the auth gate just sets
 * a code in sessionStorage; if/when SSO lands this becomes the real id.
 * @returns {string|null}
 */
function currentUserEmail() {
  try {
    return sessionStorage.getItem('ies_user_email')
      || localStorage.getItem('ies_user_email')
      || null;
  } catch {
    return null;
  }
}

/**
 * Record an audit-log entry. Fire-and-forget; never throws.
 * @param {{ table:string, id?:string|number|null, action:'insert'|'update'|'delete'|'link'|'unlink', fields?:Object }} entry
 */
export async function recordAudit(entry) {
  try {
    if (!entry || !entry.table || !entry.action) return;
    await db.insert('audit_log', {
      entity_table: entry.table,
      entity_id: entry.id != null ? String(entry.id) : null,
      action: entry.action,
      changed_fields: entry.fields ? entry.fields : null,
      session_id: sessionId(),
      user_email: currentUserEmail(),
      user_agent: typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 200) : null,
    });
  } catch (err) {
    // Audit writes are best-effort. Log and move on so the user's save
    // doesn't get blocked by network/RLS failures.
    if (typeof console !== 'undefined') console.warn('[audit] recordAudit failed:', err?.message || err);
  }
}

/**
 * List recent audit entries (used by the admin viewer).
 * @param {{ table?:string, id?:string, limit?:number }} [filter]
 * @returns {Promise<Array<{id:number,ts:string,entity_table:string,entity_id:string|null,action:string,changed_fields:any,session_id:string|null,user_email:string|null}>>}
 */
export async function listAudit(filter = {}) {
  try {
    let q = db.from('audit_log').select('*').order('ts', { ascending: false }).limit(filter.limit || 100);
    if (filter.table) q = q.eq('entity_table', filter.table);
    if (filter.id) q = q.eq('entity_id', String(filter.id));
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[audit] listAudit failed:', err?.message || err);
    return [];
  }
}

export default { recordAudit, listAudit, sessionId };
