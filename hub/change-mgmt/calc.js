/**
 * IES Hub v3 — Change Management Calculation Engine
 * PURE FUNCTIONS ONLY — readiness scoring, timeline, stats, stakeholder analysis.
 *
 * @module hub/change-mgmt/calc
 */

// ============================================================
// STATS
// ============================================================

/**
 * Compute aggregate stats across all initiatives.
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative[]} initiatives
 * @returns {import('./types.js?v=20260417-mG').InitiativeStats}
 */
export function computeStats(initiatives) {
  const allMilestones = initiatives.flatMap(i => i.milestones || []);
  const allStakeholders = initiatives.flatMap(i => i.stakeholders || []);
  const allComms = initiatives.flatMap(i => i.communications || []);

  return {
    totalInitiatives: initiatives.length,
    activeInitiatives: initiatives.filter(i => i.status === 'in-progress').length,
    completedInitiatives: initiatives.filter(i => i.status === 'completed').length,
    totalMilestones: allMilestones.length,
    completedMilestones: allMilestones.filter(m => m.status === 'completed').length,
    overdueMilestones: allMilestones.filter(m => m.status === 'overdue').length,
    totalStakeholders: allStakeholders.length,
    championCount: allStakeholders.filter(s => s.sentiment === 'champion').length,
    resistantCount: allStakeholders.filter(s => s.sentiment === 'resistant').length,
    totalCommunications: allComms.length,
    plannedCommunications: allComms.filter(c => c.status === 'planned').length,
  };
}

// ============================================================
// READINESS SCORING
// ============================================================

/**
 * Compute change readiness score for an initiative.
 * Milestone score: % completed (40% weight)
 * Stakeholder score: weighted by sentiment & influence (35% weight)
 * Communication score: % completed/sent (25% weight)
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative} initiative
 * @returns {import('./types.js?v=20260417-mG').ReadinessScore}
 */
export function computeReadiness(initiative) {
  const milestoneScore = computeMilestoneScore(initiative.milestones || []);
  const stakeholderScore = computeStakeholderScore(initiative.stakeholders || []);
  const communicationScore = computeCommunicationScore(initiative.communications || []);

  const overall = Math.round(
    milestoneScore * 0.40 +
    stakeholderScore * 0.35 +
    communicationScore * 0.25
  );

  /** @type {'red' | 'yellow' | 'green'} */
  let rating = 'green';
  if (overall < 40) rating = 'red';
  else if (overall < 70) rating = 'yellow';

  return { overall, milestoneScore, stakeholderScore, communicationScore, rating };
}

/**
 * Milestone completion percentage.
 * @param {import('./types.js?v=20260417-mG').Milestone[]} milestones
 * @returns {number} 0-100
 */
export function computeMilestoneScore(milestones) {
  if (milestones.length === 0) return 0;
  const completed = milestones.filter(m => m.status === 'completed').length;
  return Math.round((completed / milestones.length) * 100);
}

/**
 * Stakeholder sentiment score weighted by influence.
 * Champion=100, Supporter=75, Neutral=50, Resistant=10.
 * Influence weights: high=3, medium=2, low=1.
 * @param {import('./types.js?v=20260417-mG').Stakeholder[]} stakeholders
 * @returns {number} 0-100
 */
export function computeStakeholderScore(stakeholders) {
  if (stakeholders.length === 0) return 0;

  const sentimentValues = { champion: 100, supporter: 75, neutral: 50, resistant: 10 };
  const influenceWeights = { high: 3, medium: 2, low: 1 };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const s of stakeholders) {
    const w = influenceWeights[s.influence] || 1;
    weightedSum += (sentimentValues[s.sentiment] || 50) * w;
    totalWeight += w;
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

/**
 * Communication completion percentage (sent + completed count as done).
 * @param {import('./types.js?v=20260417-mG').Communication[]} communications
 * @returns {number} 0-100
 */
export function computeCommunicationScore(communications) {
  if (communications.length === 0) return 0;
  const done = communications.filter(c => c.status === 'sent' || c.status === 'completed').length;
  return Math.round((done / communications.length) * 100);
}

// ============================================================
// STAKEHOLDER ANALYSIS
// ============================================================

/**
 * Group stakeholders by sentiment.
 * @param {import('./types.js?v=20260417-mG').Stakeholder[]} stakeholders
 * @returns {Record<string, import('./types.js?v=20260417-mG').Stakeholder[]>}
 */
export function groupBySentiment(stakeholders) {
  const groups = { champion: [], supporter: [], neutral: [], resistant: [] };
  for (const s of stakeholders) {
    const key = s.sentiment || 'neutral';
    if (groups[key]) groups[key].push(s);
    else groups[key] = [s];
  }
  return groups;
}

/**
 * Compute stakeholder influence distribution.
 * @param {import('./types.js?v=20260417-mG').Stakeholder[]} stakeholders
 * @returns {{ high: number, medium: number, low: number }}
 */
export function influenceDistribution(stakeholders) {
  return {
    high: stakeholders.filter(s => s.influence === 'high').length,
    medium: stakeholders.filter(s => s.influence === 'medium').length,
    low: stakeholders.filter(s => s.influence === 'low').length,
  };
}

/**
 * Identify at-risk stakeholders (resistant + high influence).
 * @param {import('./types.js?v=20260417-mG').Stakeholder[]} stakeholders
 * @returns {import('./types.js?v=20260417-mG').Stakeholder[]}
 */
export function atRiskStakeholders(stakeholders) {
  return stakeholders.filter(s => s.sentiment === 'resistant' && s.influence === 'high');
}

// ============================================================
// TIMELINE
// ============================================================

/**
 * Build a unified timeline of events across initiatives.
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative[]} initiatives
 * @returns {import('./types.js?v=20260417-mG').TimelineEvent[]}
 */
export function buildTimeline(initiatives) {
  /** @type {import('./types.js?v=20260417-mG').TimelineEvent[]} */
  const events = [];

  for (const init of initiatives) {
    // Start & target dates
    if (init.startDate) {
      events.push({ date: init.startDate, title: `${init.title} — Start`, type: 'start', initiativeId: init.id, status: 'completed' });
    }
    if (init.targetDate) {
      events.push({ date: init.targetDate, title: `${init.title} — Target`, type: 'target', initiativeId: init.id, status: init.status === 'completed' ? 'completed' : 'pending' });
    }

    // Milestones
    for (const m of (init.milestones || [])) {
      events.push({ date: m.dueDate, title: m.title, type: 'milestone', initiativeId: init.id, status: m.status });
    }

    // Communications
    for (const c of (init.communications || [])) {
      events.push({ date: c.date, title: c.title, type: 'communication', initiativeId: init.id, status: c.status });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Filter timeline events by date range.
 * @param {import('./types.js?v=20260417-mG').TimelineEvent[]} events
 * @param {string} startDate — ISO date
 * @param {string} endDate — ISO date
 * @returns {import('./types.js?v=20260417-mG').TimelineEvent[]}
 */
export function filterTimelineByRange(events, startDate, endDate) {
  return events.filter(e => e.date >= startDate && e.date <= endDate);
}

/**
 * Get upcoming events (within N days from a reference date).
 * @param {import('./types.js?v=20260417-mG').TimelineEvent[]} events
 * @param {string} referenceDate — ISO date
 * @param {number} [days=14]
 * @returns {import('./types.js?v=20260417-mG').TimelineEvent[]}
 */
export function upcomingEvents(events, referenceDate, days = 14) {
  const ref = new Date(referenceDate);
  const end = new Date(ref);
  end.setDate(end.getDate() + days);
  const endStr = end.toISOString().slice(0, 10);
  return events.filter(e => e.date >= referenceDate && e.date <= endStr);
}

// ============================================================
// FILTERING & SORTING
// ============================================================

/**
 * Filter initiatives by status.
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative[]} initiatives
 * @param {string} status
 * @returns {import('./types.js?v=20260417-mG').ChangeInitiative[]}
 */
export function filterByStatus(initiatives, status) {
  if (!status || status === 'all') return initiatives;
  return initiatives.filter(i => i.status === status);
}

/**
 * Filter initiatives by priority.
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative[]} initiatives
 * @param {string} priority
 * @returns {import('./types.js?v=20260417-mG').ChangeInitiative[]}
 */
export function filterByPriority(initiatives, priority) {
  if (!priority || priority === 'all') return initiatives;
  return initiatives.filter(i => i.priority === priority);
}

/**
 * Sort initiatives.
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative[]} initiatives
 * @param {'title' | 'priority' | 'targetDate' | 'status'} sortBy
 * @param {'asc' | 'desc'} [dir='asc']
 * @returns {import('./types.js?v=20260417-mG').ChangeInitiative[]}
 */
export function sortInitiatives(initiatives, sortBy, dir = 'asc') {
  const sorted = [...initiatives];
  const mult = dir === 'asc' ? 1 : -1;
  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };

  sorted.sort((a, b) => {
    switch (sortBy) {
      case 'title': return mult * (a.title || '').localeCompare(b.title || '');
      case 'priority': return mult * ((priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0));
      case 'targetDate': return mult * (a.targetDate || '').localeCompare(b.targetDate || '');
      case 'status': return mult * (a.status || '').localeCompare(b.status || '');
      default: return 0;
    }
  });

  return sorted;
}

// ============================================================
// OVERDUE DETECTION
// ============================================================

/**
 * Mark milestones as overdue based on reference date.
 * Returns a new array of milestones with updated statuses (does not mutate).
 * @param {import('./types.js?v=20260417-mG').Milestone[]} milestones
 * @param {string} referenceDate — ISO date string
 * @returns {import('./types.js?v=20260417-mG').Milestone[]}
 */
export function markOverdueMilestones(milestones, referenceDate) {
  return milestones.map(m => {
    if (m.status === 'pending' && m.dueDate < referenceDate) {
      return { ...m, status: 'overdue' };
    }
    return { ...m };
  });
}

/**
 * Count overdue items across initiatives.
 * @param {import('./types.js?v=20260417-mG').ChangeInitiative[]} initiatives
 * @param {string} referenceDate
 * @returns {{ overdueMilestones: number, overdueCommunications: number }}
 */
export function countOverdue(initiatives, referenceDate) {
  let overdueMilestones = 0;
  let overdueCommunications = 0;

  for (const init of initiatives) {
    for (const m of (init.milestones || [])) {
      if (m.status === 'pending' && m.dueDate < referenceDate) overdueMilestones++;
      if (m.status === 'overdue') overdueMilestones++;
    }
    for (const c of (init.communications || [])) {
      if (c.status === 'planned' && c.date < referenceDate) overdueCommunications++;
    }
  }

  return { overdueMilestones, overdueCommunications };
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

/** @param {number} score */
export function ratingColor(score) {
  if (score >= 70) return '#16a34a';
  if (score >= 40) return '#d97706';
  return '#dc2626';
}

/** @param {string} status */
export function statusBadge(status) {
  const colors = {
    'planning': '#6b7280', 'in-progress': '#2563eb', 'completed': '#16a34a', 'on-hold': '#d97706',
    'pending': '#6b7280', 'overdue': '#dc2626', 'sent': '#16a34a', 'planned': '#2563eb',
    'champion': '#16a34a', 'supporter': '#60a5fa', 'neutral': '#6b7280', 'resistant': '#dc2626',
  };
  return colors[status] || '#6b7280';
}

/** @param {string} priority */
export function priorityBadge(priority) {
  const colors = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#6b7280' };
  return colors[priority] || '#6b7280';
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260417-mG').ChangeInitiative[]} */
export const DEMO_INITIATIVES = [
  {
    id: 'cm1',
    title: 'IES Hub V3 Rollout',
    description: 'Enterprise-wide migration from IES Hub V2 to the modular V3 platform with new design tools, improved performance, and real-time collaboration.',
    status: 'in-progress',
    priority: 'critical',
    owner: 'Brock Eckles',
    startDate: '2026-01-15',
    targetDate: '2026-06-30',
    tags: ['platform', 'migration', 'enterprise'],
    milestones: [
      { id: 'ms1', title: 'Phase 1-3 Complete (Core + Design Tools)', dueDate: '2026-03-15', status: 'completed', completedDate: '2026-03-10' },
      { id: 'ms2', title: 'Phase 4 Complete (Transportation Tools)', dueDate: '2026-04-15', status: 'completed', completedDate: '2026-04-12' },
      { id: 'ms3', title: 'Phase 5 Complete (Deal Manager)', dueDate: '2026-04-30', status: 'completed', completedDate: '2026-04-16' },
      { id: 'ms4', title: 'Phase 6 Complete (Hub Ecosystem)', dueDate: '2026-05-15', status: 'pending' },
      { id: 'ms5', title: 'Phase 7 Complete (SSO + Mobile + Migration)', dueDate: '2026-06-15', status: 'pending' },
      { id: 'ms6', title: 'V2 Retirement', dueDate: '2026-06-30', status: 'pending' },
    ],
    stakeholders: [
      { id: 'sh1', name: 'Brock Eckles', role: 'IES Solutions Design Lead', sentiment: 'champion', influence: 'high' },
      { id: 'sh2', name: 'Design Engineering Team', role: 'Primary Users', sentiment: 'supporter', influence: 'high' },
      { id: 'sh3', name: 'Operations Leadership', role: 'Executive Sponsor', sentiment: 'supporter', influence: 'high' },
      { id: 'sh4', name: 'IT Security', role: 'SSO/RBAC Review', sentiment: 'neutral', influence: 'medium' },
      { id: 'sh5', name: 'Regional Managers', role: 'End Users', sentiment: 'neutral', influence: 'medium' },
    ],
    communications: [
      { id: 'co1', title: 'V3 Vision & Roadmap Presentation', type: 'meeting', date: '2026-01-20', audience: 'IES Team', status: 'completed' },
      { id: 'co2', title: 'Phase 1-3 Demo & Feedback Session', type: 'workshop', date: '2026-03-18', audience: 'Design Engineers', status: 'completed' },
      { id: 'co3', title: 'Transportation Tools Training', type: 'training', date: '2026-04-20', audience: 'All Users', status: 'planned' },
      { id: 'co4', title: 'Deal Manager Walkthrough', type: 'training', date: '2026-05-01', audience: 'Sales & Solutions', status: 'planned' },
      { id: 'co5', title: 'Go-Live Announcement', type: 'announcement', date: '2026-06-15', audience: 'Enterprise', status: 'planned' },
    ],
  },
  {
    id: 'cm2',
    title: 'Blue Yonder WMS Alignment',
    description: 'Ensure all MOST labor standards templates and warehouse design tools align with Blue Yonder WMS workflows, screen interactions, and module naming.',
    status: 'in-progress',
    priority: 'high',
    owner: 'Design Engineering',
    startDate: '2026-02-01',
    targetDate: '2026-05-31',
    tags: ['wms', 'blue-yonder', 'standards'],
    milestones: [
      { id: 'ms7', title: 'MOST Template Audit Complete', dueDate: '2026-03-01', status: 'completed', completedDate: '2026-02-28' },
      { id: 'ms8', title: 'Template Naming Convention Applied', dueDate: '2026-03-15', status: 'completed', completedDate: '2026-03-14' },
      { id: 'ms9', title: 'WSC Integration with BY Modules', dueDate: '2026-04-30', status: 'pending' },
      { id: 'ms10', title: 'Field Validation with Ops Teams', dueDate: '2026-05-31', status: 'pending' },
    ],
    stakeholders: [
      { id: 'sh6', name: 'Warehouse Ops Team', role: 'Subject Matter Experts', sentiment: 'supporter', influence: 'high' },
      { id: 'sh7', name: 'BY Admin Team', role: 'System Owners', sentiment: 'neutral', influence: 'medium' },
      { id: 'sh8', name: 'Labor Standards Analysts', role: 'Template Authors', sentiment: 'champion', influence: 'medium' },
    ],
    communications: [
      { id: 'co6', title: 'BY Alignment Kickoff', type: 'meeting', date: '2026-02-05', audience: 'Ops + IT', status: 'completed' },
      { id: 'co7', title: 'Template Naming Guide Email', type: 'email', date: '2026-03-16', audience: 'All Template Authors', status: 'sent' },
      { id: 'co8', title: 'Field Validation Workshop', type: 'workshop', date: '2026-05-15', audience: 'Ops Teams', status: 'planned' },
    ],
  },
  {
    id: 'cm3',
    title: 'DOS Process Standardization',
    description: 'Formalize the 6-stage Deal Operating System across all regions, embed stage gates into the IES Hub deal workflow, and train all solution designers on the new process.',
    status: 'planning',
    priority: 'high',
    owner: 'Solutions Design Leadership',
    startDate: '2026-04-01',
    targetDate: '2026-08-31',
    tags: ['dos', 'process', 'standardization'],
    milestones: [
      { id: 'ms11', title: 'DOS Template Library Finalized', dueDate: '2026-04-30', status: 'pending' },
      { id: 'ms12', title: 'Hub Stage Gate Integration', dueDate: '2026-06-15', status: 'pending' },
      { id: 'ms13', title: 'Regional Training Complete', dueDate: '2026-08-15', status: 'pending' },
    ],
    stakeholders: [
      { id: 'sh9', name: 'VP Solutions Design', role: 'Executive Sponsor', sentiment: 'champion', influence: 'high' },
      { id: 'sh10', name: 'Regional Solution Directors', role: 'Regional Leads', sentiment: 'supporter', influence: 'high' },
      { id: 'sh11', name: 'Sales Team', role: 'Process Consumers', sentiment: 'resistant', influence: 'medium', notes: 'Concerned about added process overhead' },
    ],
    communications: [
      { id: 'co9', title: 'DOS Standardization Proposal', type: 'meeting', date: '2026-04-10', audience: 'Leadership', status: 'planned' },
      { id: 'co10', title: 'DOS Training Series (4 sessions)', type: 'training', date: '2026-07-01', audience: 'All Solution Designers', status: 'planned' },
    ],
  },
];
