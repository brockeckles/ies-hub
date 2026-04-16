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
 * @param {import('./types.js').FeedbackItem[]} items
 * @returns {import('./types.js').FeedbackStats}
 */
export function computeStats(items) {
  const totalUpvotes = items.reduce((s, i) => s + (i.upvotes || 0), 0);
  const types = ['bug', 'feature', 'improvement', 'question'];
  const statuses = ['open', 'in-review', 'planned', 'in-progress', 'completed', 'declined'];

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
 * @param {import('./types.js').FeedbackItem[]} items
 * @param {string} type
 * @returns {import('./types.js').FeedbackItem[]}
 */
export function filterByType(items, type) {
  if (!type || type === 'all') return items;
  return items.filter(i => i.type === type);
}

/**
 * Filter feedback by status.
 * @param {import('./types.js').FeedbackItem[]} items
 * @param {string} status
 * @returns {import('./types.js').FeedbackItem[]}
 */
export function filterByStatus(items, status) {
  if (!status || status === 'all') return items;
  return items.filter(i => i.status === status);
}

/**
 * Filter feedback by tool.
 * @param {import('./types.js').FeedbackItem[]} items
 * @param {string} tool
 * @returns {import('./types.js').FeedbackItem[]}
 */
export function filterByTool(items, tool) {
  if (!tool || tool === 'all') return items;
  return items.filter(i => i.tool === tool);
}

/**
 * Search feedback items.
 * @param {import('./types.js').FeedbackItem[]} items
 * @param {string} query
 * @returns {import('./types.js').FeedbackItem[]}
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
 * @param {import('./types.js').FeedbackItem[]} items
 * @param {'upvotes' | 'date' | 'priority' | 'status'} sortBy
 * @param {'asc' | 'desc'} [dir='desc']
 * @returns {import('./types.js').FeedbackItem[]}
 */
export function sortFeedback(items, sortBy, dir = 'desc') {
  const sorted = [...items];
  const mult = dir === 'asc' ? 1 : -1;
  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  const statusOrder = { open: 1, 'in-review': 2, planned: 3, 'in-progress': 4, completed: 5, declined: 6 };

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
 * @param {import('./types.js').FeedbackItem[]} items
 * @returns {import('./types.js').FeedbackTrend[]}
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
 * @param {import('./types.js').FeedbackItem[]} items
 * @param {number} [limit=5]
 * @returns {import('./types.js').FeedbackItem[]}
 */
export function topVoted(items, limit = 5) {
  return [...items].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0)).slice(0, limit);
}

/**
 * Get unique tools from feedback items.
 * @param {import('./types.js').FeedbackItem[]} items
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
 * @param {import('./types.js').FeedbackItem[]} items
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
    open: '#6b7280', 'in-review': '#d97706', planned: '#2563eb',
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

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js').FeedbackItem[]} */
export const DEMO_FEEDBACK = [
  {
    id: 'fb1', title: 'Add PDF export to Cost Model Summary', description: 'Would be helpful to export the Summary tab as a PDF for client presentations without using deck generation.',
    type: 'feature', status: 'planned', priority: 'high', submittedBy: 'Design Engineer 1', submittedDate: '2026-03-15',
    tool: 'Cost Model Builder', tags: ['export', 'pdf', 'cost-model'], upvotes: 12, upvotedBy: ['u1', 'u2', 'u3'],
    comments: [{ id: 'fc1', author: 'Brock Eckles', content: 'Great idea — adding to Phase 7 backlog.', date: '2026-03-16T10:00:00Z' }],
  },
  {
    id: 'fb2', title: 'WSC 3D view doesn\'t render on Safari', description: 'WebGL canvas shows blank on Safari 17.4. Works fine on Chrome and Edge. Might be a Three.js compatibility issue.',
    type: 'bug', status: 'in-progress', priority: 'high', submittedBy: 'Design Engineer 2', submittedDate: '2026-04-02',
    tool: 'Warehouse Sizing Calculator', tags: ['3d', 'safari', 'webgl', 'bug'], upvotes: 8, upvotedBy: ['u2', 'u4'],
    comments: [{ id: 'fc2', author: 'Brock Eckles', content: 'Investigating — likely needs a WebGL2 fallback check.', date: '2026-04-03T09:00:00Z' }],
  },
  {
    id: 'fb3', title: 'Network Optimizer should support Canadian provinces', description: 'Currently only supports US zip codes for demand points. Need Canadian postal code support for cross-border network designs.',
    type: 'feature', status: 'open', priority: 'medium', submittedBy: 'Operations Manager', submittedDate: '2026-04-10',
    tool: 'Network Optimizer', tags: ['canada', 'international', 'network'], upvotes: 5, upvotedBy: ['u4'],
    comments: [],
  },
  {
    id: 'fb4', title: 'MOST template search is slow with large library', description: 'When the template library exceeds ~200 templates, the search filter takes 2-3 seconds to respond. Needs debouncing or indexing.',
    type: 'improvement', status: 'completed', priority: 'medium', submittedBy: 'Design Engineer 1', submittedDate: '2026-02-20',
    tool: 'MOST Labor Standards', tags: ['performance', 'search', 'most'], upvotes: 6, upvotedBy: ['u2', 'u3'],
    comments: [{ id: 'fc3', author: 'Brock Eckles', content: 'Fixed in v3 with debounced input and pre-computed search index.', date: '2026-03-01T14:00:00Z' }],
  },
  {
    id: 'fb5', title: 'How do I link multiple cost models to a deal?', description: 'I have 3 sites for a deal but can only see one cost model linked in Deal Manager. Is multi-site supported?',
    type: 'question', status: 'completed', priority: 'low', submittedBy: 'New Engineer', submittedDate: '2026-04-05',
    tool: 'Deal Manager', tags: ['deal-manager', 'multi-site', 'help'], upvotes: 2, upvotedBy: [],
    comments: [{ id: 'fc4', author: 'Brock Eckles', content: 'Yes — go to the Sites tab in Deal Manager and click Add Site to link additional cost model projects.', date: '2026-04-05T15:00:00Z' }],
  },
  {
    id: 'fb6', title: 'Fleet Modeler team driving toggle doesn\'t update totals', description: 'Toggling team driving for a lane doesn\'t recalculate the fleet composition until you manually re-run the analysis.',
    type: 'bug', status: 'open', priority: 'medium', submittedBy: 'Design Engineer 2', submittedDate: '2026-04-12',
    tool: 'Fleet Modeler', tags: ['fleet', 'bug', 'calculation'], upvotes: 3, upvotedBy: ['u2'],
    comments: [],
  },
  {
    id: 'fb7', title: 'Add dark mode support', description: 'The hub is quite bright. Would love a dark mode option, especially for late-night work sessions.',
    type: 'feature', status: 'declined', priority: 'low', submittedBy: 'Design Engineer 1', submittedDate: '2026-01-15',
    tool: 'Hub General', tags: ['ui', 'dark-mode', 'accessibility'], upvotes: 4, upvotedBy: ['u2', 'u3'],
    comments: [{ id: 'fc5', author: 'Brock Eckles', content: 'Deferring — not in scope for v3 launch. May revisit post-launch.', date: '2026-01-20T11:00:00Z' }],
  },
  {
    id: 'fb8', title: 'Add equipment financing calculator to Cost Model', description: 'Would save time if we could calculate monthly lease payments directly in the Equipment section instead of using Excel.',
    type: 'feature', status: 'completed', priority: 'high', submittedBy: 'Design Engineer 2', submittedDate: '2026-03-01',
    tool: 'Cost Model Builder', tags: ['equipment', 'financing', 'calculator'], upvotes: 9, upvotedBy: ['u1', 'u2', 'u4'],
    comments: [{ id: 'fc6', author: 'Brock Eckles', content: 'Done — added unit_cost × quantity + lease/purchase dropdown in v2 on 2026-04-16.', date: '2026-04-16T08:00:00Z' }],
  },
];
