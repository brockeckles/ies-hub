/**
 * IES Hub v3 — Feedback System API / Persistence
 * Supabase interactions for the hub_feedback table.
 *
 * Schema (canonical — see Supabase pg):
 *   id (uuid), type (enum question|enhancement|bug|general),
 *   title (text), description (text), section (text),
 *   submitted_by (text, default 'Anonymous'),
 *   priority (enum nice_to_have|important|critical),
 *   status (enum new|under_review|in_progress|completed|declined),
 *   admin_response (text), upvotes (text[]), created_at, updated_at.
 *
 * RLS: anon + authenticated INSERT; authenticated SELECT.
 *
 * @module hub/feedback/api
 */

import { db } from '../../shared/supabase.js?v=20260429-demo-s3';

// ============================================================
// READS
// ============================================================

/**
 * List feedback rows from the live table, mapped to the UI shape used
 * by the legacy hub/feedback/ui.js (which predates the schema we landed
 * on). Adapter avoids a second invasive UI rewrite.
 *
 * @returns {Promise<Array>}
 */
export async function listFeedback() {
  const { data, error } = await db.from('hub_feedback')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(dbRowToUi);
}

/**
 * @param {string} id
 */
export async function getFeedback(id) {
  const row = await db.fetchById('hub_feedback', id);
  return row ? dbRowToUi(row) : null;
}

// ============================================================
// WRITES
// ============================================================

/**
 * Insert a new feedback row. Used by both the global FAB and any
 * page-level forms. submitted_by falls back to 'Anonymous' per RLS
 * column default.
 */
export async function submitFeedback(item) {
  return db.insert('hub_feedback', {
    title: item.title,
    description: item.description || null,
    type: item.type || 'general',
    status: 'new',
    priority: item.priority || 'nice_to_have',
    submitted_by: item.submittedBy || item.submitted_by || 'Anonymous',
    section: item.section || null,
  });
}

// ============================================================
// SHAPE ADAPTER (DB → UI)
// ============================================================

export function dbRowToUi(row) {
  return {
    id: row.id,
    title: row.title || '',
    description: row.description || '',
    type: mapTypeToUi(row.type),
    status: mapStatusToUi(row.status),
    priority: mapPriorityToUi(row.priority),
    submittedBy: row.submitted_by || 'Anonymous',
    submittedDate: row.created_at ? String(row.created_at).slice(0, 10) : '',
    tool: row.section || '',
    tags: [],
    upvotes: Array.isArray(row.upvotes) ? row.upvotes.length : 0,
    upvotedBy: Array.isArray(row.upvotes) ? row.upvotes : [],
    comments: row.admin_response
      ? [{
          id: row.id + '-r',
          author: 'IES team',
          content: row.admin_response,
          date: row.updated_at || row.created_at,
        }]
      : [],
  };
}

function mapTypeToUi(t) {
  // DB enum question|enhancement|bug|general → UI tags question|feature|bug|improvement
  switch (t) {
    case 'enhancement': return 'feature';
    case 'general':     return 'improvement';
    case 'question':    return 'question';
    case 'bug':         return 'bug';
    default:            return t || 'feature';
  }
}

function mapStatusToUi(s) {
  // DB enum new|under_review|in_progress|completed|declined →
  // UI status open|in-review|in-progress|completed|declined
  switch (s) {
    case 'new':           return 'open';
    case 'under_review':  return 'in-review';
    case 'in_progress':   return 'in-progress';
    case 'completed':     return 'completed';
    case 'declined':      return 'declined';
    default:              return s || 'open';
  }
}

function mapPriorityToUi(p) {
  // DB enum nice_to_have|important|critical → UI priority low|medium|high
  switch (p) {
    case 'nice_to_have': return 'low';
    case 'important':    return 'medium';
    case 'critical':     return 'high';
    default:             return p || 'medium';
  }
}
