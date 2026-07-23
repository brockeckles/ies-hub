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
 *   admin_response (text), upvotes (text[] — LEGACY/DEAD, never written;
 *   real votes live in feedback_votes), created_at, updated_at.
 *
 * RLS: anon + authenticated INSERT; authenticated SELECT.
 *
 * Voting (2026-07-23, feedback_votes migration 20260723150000): one row per
 * (feedback_id, user_id), unique-constrained. Toggle = insert/delete own row
 * (no UPDATE policy). listVotes() aggregates counts client-side (board scale
 * is small) and toggleVote() flips the caller's vote. Identity comes from the
 * shared/auth.js seam ONLY (test-auth-seam.mjs).
 *
 * @module hub/feedback/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import { auth } from '../../shared/auth.js?v=20260705-u1a';

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
  const items = (data || []).map(dbRowToUi);
  // Overlay real vote counts (feedback_votes) onto the item shape —
  // calc.js computeStats / sortFeedback('upvotes') / topVoted consume
  // item.upvotes unchanged; item.hasMyVote drives the pill's active state.
  const { countsById, myVotes } = await listVotes();
  for (const item of items) {
    item.upvotes = countsById[item.id] ?? 0;
    item.hasMyVote = myVotes.has(item.id);
  }
  return items;
}

/**
 * @param {string} id
 */
export async function getFeedback(id) {
  const row = await db.fetchById('hub_feedback', id);
  if (!row) return null;
  const item = dbRowToUi(row);
  const { countsById, myVotes } = await listVotes();
  item.upvotes = countsById[item.id] ?? 0;
  item.hasMyVote = myVotes.has(item.id);
  return item;
}

/**
 * List every vote row (board-scale is small — this is a two-column scan of
 * a table with one row per user per item, not a fan-out query) and fold it
 * into aggregate counts plus the signed-in user's own vote set.
 *
 * Fail-soft: any error (network, RLS while signed out) resolves to empty
 * structures so the board still renders with zero counts.
 *
 * @returns {Promise<{countsById: Object<string, number>, myVotes: Set<string>}>}
 */
export async function listVotes() {
  const countsById = {};
  const myVotes = new Set();
  try {
    const { data, error } = await db.from('feedback_votes')
      .select('feedback_id,user_id');
    if (error) throw error;
    const me = auth.getUser(); // seam — never the client auth namespace directly
    for (const row of data || []) {
      countsById[row.feedback_id] = (countsById[row.feedback_id] ?? 0) + 1;
      if (me && row.user_id === me.id) myVotes.add(row.feedback_id);
    }
  } catch (err) {
    console.warn('[feedback] listVotes failed (rendering zero counts):', err);
  }
  return { countsById, myVotes };
}

/**
 * Toggle the signed-in user's vote on a feedback item: delete the vote row
 * if one exists, insert one if not (unique(feedback_id, user_id) backs this
 * at the DB layer). Fail-soft tuple return — the UI reverts its optimistic
 * flip on { ok: false }.
 *
 * @param {string} feedbackId
 * @returns {Promise<{ok: boolean, hasMyVote?: boolean, error?: string}>}
 */
export async function toggleVote(feedbackId) {
  const me = auth.getUser(); // seam — signed-out gets a typed refusal
  if (!me || !me.id) return { ok: false, error: 'not_signed_in' };
  try {
    const { data, error } = await db.from('feedback_votes')
      .select('id')
      .eq('feedback_id', feedbackId)
      .eq('user_id', me.id)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      await db.remove('feedback_votes', data.id); // un-vote = delete own row
      return { ok: true, hasMyVote: false };
    }
    await db.insert('feedback_votes', { feedback_id: feedbackId, user_id: me.id });
    return { ok: true, hasMyVote: true };
  } catch (err) {
    console.error('[feedback] toggleVote failed:', err);
    return { ok: false, error: err?.message || 'vote_failed' };
  }
}

// ============================================================
// WRITES
// ============================================================

/**
 * Insert a new feedback row. Single write path for hub_feedback — the
 * global FAB (shared/feedback-fab.js) routes through here. submitted_by
 * falls back to 'Anonymous' per column default.
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
    // Real counts come from feedback_votes (listVotes overlay) — NOT the
    // legacy hub_feedback.upvotes TEXT[] column (dead: never written).
    upvotes: 0,
    hasMyVote: false,
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
