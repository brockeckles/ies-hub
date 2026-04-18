/**
 * IES Hub v3 — Shared Record Actions
 *
 * Generic copy/delete helpers used by every tool's landing page so we don't
 * reimplement the same prompt + Supabase call five times.
 *
 * Usage:
 *   import { copyRecord, deleteRecord } from './shared/record-actions.js?v=20260418-sJ';
 *
 *   await copyRecord({
 *     record,
 *     nameField: 'name',
 *     list: () => api.listModels(),
 *     create: (clone) => api.createModel(clone),
 *     onDone: () => refresh(),
 *   });
 *
 *   await deleteRecord({
 *     record,
 *     label: record.name,
 *     remove: (id) => api.deleteModel(id),
 *     onDone: () => refresh(),
 *   });
 *
 * @module shared/record-actions
 */

import { showToast } from './toast.js?v=20260418-sJ';

/**
 * Shallow-clones the given record, strips id/timestamps, appends " (Copy)" to
 * the name field, and calls the provided create() hook.
 *
 * @template T
 * @param {{
 *   record: T,
 *   nameField?: string,
 *   create: (clone: Partial<T>) => Promise<any>,
 *   list?: () => Promise<any[]>,
 *   onDone?: (created: any) => void,
 *   label?: string,
 * }} opts
 */
export async function copyRecord(opts) {
  const { record, nameField = 'name', create, onDone, label = 'record' } = opts || {};
  if (!record || typeof create !== 'function') {
    showToast('Copy failed — missing record', 'error');
    return null;
  }
  try {
    const clone = { ...record };
    delete clone.id;
    delete clone.created_at;
    delete clone.updated_at;
    const origName = record[nameField] || `Untitled ${label}`;
    clone[nameField] = `${origName} (Copy)`;
    const created = await create(clone);
    showToast(`${capitalize(label)} copied`, 'success');
    if (typeof onDone === 'function') onDone(created);
    return created;
  } catch (err) {
    console.error('[record-actions] copy failed', err);
    showToast(`Copy failed: ${err?.message || err}`, 'error');
    return null;
  }
}

/**
 * Confirms deletion (one browser confirm dialog — we keep the modal thin to
 * avoid new shared-UI surface this session), then calls remove().
 *
 * @param {{
 *   record: any,
 *   label?: string,
 *   remove: (id: any) => Promise<void>,
 *   onDone?: () => void,
 *   skipConfirm?: boolean,
 * }} opts
 */
export async function deleteRecord(opts) {
  const { record, label = record?.name || 'this record', remove, onDone, skipConfirm = false } = opts || {};
  if (!record || typeof remove !== 'function') {
    showToast('Delete failed — missing record', 'error');
    return false;
  }
  if (!skipConfirm) {
    // eslint-disable-next-line no-alert
    const ok = window.confirm(`Delete "${label}"? This cannot be undone.`);
    if (!ok) return false;
  }
  try {
    await remove(record.id);
    showToast(`Deleted "${label}"`, 'success');
    if (typeof onDone === 'function') onDone();
    return true;
  } catch (err) {
    console.error('[record-actions] delete failed', err);
    showToast(`Delete failed: ${err?.message || err}`, 'error');
    return false;
  }
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default { copyRecord, deleteRecord };
