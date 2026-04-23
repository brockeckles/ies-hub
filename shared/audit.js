/**
 * IES Hub v3 — shared audit-log writer (X15 closed in Slice 3.4)
 *
 * Records mutations to a central public.audit_log table. With Slice 3.2
 * auth wired, every row now carries a real `user_id uuid` when the user
 * is signed in via email/password; code-mode sessions write NULL user_id
 * + NULL user_email (they're pre-identity by design — Slice 3.5 removes
 * code-mode entirely).
 *
 * Usage:
 *   import { recordAudit } from '../../shared/audit.js?v=20260423-y1';
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
 * Entra-swap seam: identity is read via auth.getUser().id which resolves
 * to auth.uid() — that claim survives the OIDC swap unchanged.
 *
 * @module shared/audit
 */

import { db } from './supabase.js?v=20260423-y1';
import { auth } from './auth.js?v=20260423-y1';

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
 * Legacy email mirror. auth.js writes sessionStorage['ies_user_email']
 * on sign-in so older read-sites keep working; we read it as a fallback
 * here for consistency but the true source is auth.getUser().
 * @returns {string|null}
 */
function mirroredEmail() {
  try {
    return sessionStorage.getItem('ies_user_email')
      || localStorage.getItem('ies_user_email')
      || null;
  } catch {
    return null;
  }
}

/**
 * Read identity for the current audit row. Password-mode → {id, email};
 * code-mode (or signed out) → {id: null, email: null}. Never throws.
 * @returns {{ id: string|null, email: string|null }}
 */
function currentIdentity() {
  try {
    const u = auth?.getUser?.();
    if (u && u.id) {
      return { id: u.id, email: u.email || mirroredEmail() || null };
    }
  } catch { /* auth module not ready — fall through */ }
  // Code-mode or pre-bootstrap: no UUID to attribute. Email stays null
  // too; the legacy mirror is only populated by password sign-in now.
  return { id: null, email: mirroredEmail() };
}

/**
 * Record an audit-log entry. Fire-and-forget; never throws.
 * @param {{ table:string, id?:string|number|null, action:'insert'|'update'|'delete'|'link'|'unlink', fields?:Object }} entry
 */
export async function recordAudit(entry) {
  try {
    if (!entry || !entry.table || !entry.action) return;
    const who = currentIdentity();
    // IMPORTANT: do NOT chain .select() here. Under Slice 3.3 RLS (tightened
    // 2026-04-23) anon has no SELECT policy on audit_log — admin-only — so a
    // `return=representation` insert would fail. A bare .insert() uses
    // Prefer: return=minimal and works for both anon (code-mode) and authed.
    const { error } = await db.from('audit_log').insert({
      entity_table: entry.table,
      entity_id: entry.id != null ? String(entry.id) : null,
      action: entry.action,
      changed_fields: entry.fields ? entry.fields : null,
      session_id: sessionId(),
      user_id: who.id,            // uuid | null — real identity (Slice 3.4)
      user_email: who.email,      // display mirror only
      user_agent: typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 200) : null,
    });
    if (error) throw error;
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
