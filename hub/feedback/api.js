/**
 * IES Hub v3 — Feedback System API / Persistence
 * Supabase interactions for feedback items and votes.
 *
 * @module hub/feedback/api
 */

import { db } from '../../shared/supabase.js?v=20260418-sG';

/**
 * List all feedback items.
 * @returns {Promise<import('./types.js?v=20260418-sG').FeedbackItem[]>}
 */
export async function listFeedback() {
  const { data, error } = await db.from('hub_feedback').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single feedback item.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260418-sG').FeedbackItem|null>}
 */
export async function getFeedback(id) {
  return db.fetchById('hub_feedback', id);
}

/**
 * Submit new feedback.
 * @param {Omit<import('./types.js?v=20260418-sG').FeedbackItem, 'id' | 'upvotes' | 'upvotedBy' | 'comments'>} item
 * @returns {Promise<import('./types.js?v=20260418-sG').FeedbackItem>}
 */
export async function submitFeedback(item) {
  return db.insert('hub_feedback', {
    title: item.title,
    description: item.description || '',
    type: item.type || 'feature',
    status: 'open',
    priority: item.priority || 'medium',
    submitted_by: item.submittedBy || 'Anonymous',
    submitted_date: item.submittedDate || new Date().toISOString().slice(0, 10),
    tool: item.tool || null,
    tags: item.tags || [],
    upvotes: 0,
    upvoted_by: [],
    comments: [],
  });
}

/**
 * Update feedback status.
 * @param {string} id
 * @param {string} status
 * @returns {Promise<void>}
 */
export async function updateStatus(id, status) {
  await db.update('hub_feedback', id, { status });
}

/**
 * Toggle upvote for a feedback item.
 * @param {string} feedbackId
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function toggleUpvote(feedbackId, userId) {
  const item = await getFeedback(feedbackId);
  if (!item) throw new Error('Feedback not found');

  const upvotedBy = item.upvotedBy || [];
  const idx = upvotedBy.indexOf(userId);
  if (idx >= 0) {
    upvotedBy.splice(idx, 1);
  } else {
    upvotedBy.push(userId);
  }

  await db.update('hub_feedback', feedbackId, {
    upvotes: upvotedBy.length,
    upvoted_by: upvotedBy,
  });
}

/**
 * Add a comment to a feedback item.
 * @param {string} feedbackId
 * @param {{ author: string, content: string }} comment
 * @returns {Promise<void>}
 */
export async function addComment(feedbackId, comment) {
  const item = await getFeedback(feedbackId);
  if (!item) throw new Error('Feedback not found');

  const comments = item.comments || [];
  comments.push({
    id: `fc-${Date.now()}`,
    author: comment.author,
    content: comment.content,
    date: new Date().toISOString(),
  });

  await db.update('hub_feedback', feedbackId, { comments });
}

/**
 * Delete a feedback item.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteFeedback(id) {
  await db.remove('hub_feedback', id);
}

/**
 * Load all feedback data.
 * @returns {Promise<{ items: import('./types.js?v=20260418-sG').FeedbackItem[] }>}
 */
export async function loadRefData() {
  const items = await listFeedback();
  return { items };
}
