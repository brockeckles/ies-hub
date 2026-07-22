/**
 * IES Hub v3 — Feedback System Calculation Engine
 * PURE FUNCTIONS ONLY — stats, filtering, sorting, trends.
 *
 * @module hub/feedback/calc
 */

// ============================================================
// STATS
// ============================================================

/**
 * Compute feedback stats.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @returns {import('./types.js?v=20260722-s4e').FeedbackStats}
 */
export function computeStats(items) {
  const totalUpvotes = items.reduce((s, i) => s + (i.upvotes || 0), 0);
  const types = ['bug', 'feature', 'improvement', 'question'];
  const statuses = ['open', 'in-review', 'in-progress', 'completed', 'declined'];

  return {
    totalItems: items.length,
    openItems: items.filter(i => i.status === 'open').length,
    completedItems: items.filter(i => i.status === 'completed').length,
    declinedItems: items.filter(i => i.status === 'declined').length,
    totalUpvotes,
    avgUpvotes: items.length > 0 ? Math.round((totalUpvotes / items.length) * 10) / 10 : 0,
    byType: types.map(t => ({ type: t, count: items.filter(i => i.type === t).length })),
    byStatus: statuses.map(s => ({ status: s, count: items.filter(i => i.status === s).length })),
  };
}

// ============================================================
// FILTERING
// ============================================================

/**
 * Filter feedback by type.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @param {string} type
 * @returns {import('./types.js?v=20260722-s4e').FeedbackItem[]}
 */
export function filterByType(items, type) {
  if (!type || type === 'all') return items;
  return items.filter(i => i.type === type);
}

/**
 * Filter feedback by status.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @param {string} status
 * @returns {import('./types.js?v=20260722-s4e').FeedbackItem[]}
 */
export function filterByStatus(items, status) {
  if (!status || status === 'all') return items;
  return items.filter(i => i.status === status);
}

/**
 * Filter feedback by tool.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @param {string} tool
 * @returns {import('./types.js?v=20260722-s4e').FeedbackItem[]}
 */
export function filterByTool(items, tool) {
  if (!tool || tool === 'all') return items;
  return items.filter(i => i.tool === tool);
}

/**
 * Search feedback items.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @param {string} query
 * @returns {import('./types.js?v=20260722-s4e').FeedbackItem[]}
 */
export function searchFeedback(items, query) {
  if (!query || query.trim().length === 0) return [];
  const q = query.toLowerCase();
  return items.filter(i =>
    (i.title || '').toLowerCase().includes(q) ||
    (i.description || '').toLowerCase().includes(q) ||
    (i.tags || []).some(t => t.toLowerCase().includes(q))
  );
}

// ============================================================
// SORTING
// ============================================================

/**
 * Sort feedback items.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @param {'upvotes' | 'date' | 'priority' | 'status'} sortBy
 * @param {'asc' | 'desc'} [dir='desc']
 * @returns {import('./types.js?v=20260722-s4e').FeedbackItem[]}
 */
export function sortFeedback(items, sortBy, dir = 'desc') {
  const sorted = [...items];
  const mult = dir === 'asc' ? 1 : -1;
  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  const statusOrder = { open: 1, 'in-review': 2, 'in-progress': 3, completed: 4, declined: 5 };

  sorted.sort((a, b) => {
    switch (sortBy) {
      case 'upvotes': return mult * ((a.upvotes || 0) - (b.upvotes || 0));
      case 'date': return mult * (a.submittedDate || '').localeCompare(b.submittedDate || '');
      case 'priority': return mult * ((priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0));
      case 'status': return mult * ((statusOrder[a.status] || 0) - (statusOrder[b.status] || 0));
      default: return 0;
    }
  });

  return sorted;
}

// ============================================================
// TRENDS
// ============================================================

/**
 * Compute monthly trends.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @returns {import('./types.js?v=20260722-s4e').FeedbackTrend[]}
 */
export function computeTrends(items) {
  const monthMap = new Map();

  for (const item of items) {
    const month = (item.submittedDate || '').slice(0, 7); // 'YYYY-MM'
    if (!month) continue;
    if (!monthMap.has(month)) monthMap.set(month, { month, submitted: 0, resolved: 0 });
    monthMap.get(month).submitted++;
    if (item.status === 'completed' || item.status === 'declined') {
      monthMap.get(month).resolved++;
    }
  }

  return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Get top voted items.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @param {number} [limit=5]
 * @returns {import('./types.js?v=20260722-s4e').FeedbackItem[]}
 */
export function topVoted(items, limit = 5) {
  return [...items].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0)).slice(0, limit);
}

/**
 * Get unique tools from feedback items.
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @returns {string[]}
 */
export function uniqueTools(items) {
  const tools = new Set();
  for (const item of items) {
    if (item.tool) tools.add(item.tool);
  }
  return Array.from(tools).sort();
}

/**
 * Compute resolution rate (completed / (completed + declined + open that are old)).
 * @param {import('./types.js?v=20260722-s4e').FeedbackItem[]} items
 * @returns {number} 0-100
 */
export function resolutionRate(items) {
  const actionable = items.filter(i => i.status !== 'declined');
  if (actionable.length === 0) return 0;
  const resolved = actionable.filter(i => i.status === 'completed').length;
  return Math.round((resolved / actionable.length) * 100);
}

// ============================================================
// FORMATTING
// ============================================================

/** @param {string} dateStr */
export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** @param {string} type */
export function typeBadgeColor(type) {
  const colors = { bug: '#dc2626', feature: '#2563eb', improvement: '#16a34a', question: '#7c3aed' };
  return colors[type] || '#6b7280';
}

/** @param {string} status */
export function statusBadgeColor(status) {
  const colors = {
    open: '#6b7280', 'in-review': '#d97706',
    'in-progress': '#7c3aed', completed: '#16a34a', declined: '#dc2626',
  };
  return colors[status] || '#6b7280';
}

/** @param {string} priority */
export function priorityBadgeColor(priority) {
  const colors = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#6b7280' };
  return colors[priority] || '#6b7280';
}

/** @param {string} type */
export function typeIcon(type) {
  const icons = { bug: '🐛', feature: '✨', improvement: '🔧', question: '❓' };
  return icons[type] || '📝';
}
