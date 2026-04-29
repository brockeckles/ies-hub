/**
 * IES Hub v3 — Admin Panel Calculation Engine
 * PURE FUNCTIONS ONLY — master data validation, user management, escalation logic, audit log.
 *
 * @module hub/admin/calc
 */

// ============================================================
// MASTER TABLE DEFINITIONS
// ============================================================

/** @type {import('./types.js?v=20260418-sP').MasterTableConfig[]} */
export const MASTER_TABLES = [
  {
    id: 'cost_buckets', name: 'Cost Buckets', description: 'Standard cost categories for cost models',
    tableName: 'master_cost_buckets', rowCount: 0,
    columns: [
      { key: 'code', label: 'Code', type: 'text', required: true, editable: true },
      { key: 'label', label: 'Label', type: 'text', required: true, editable: true },
      { key: 'category', label: 'Category', type: 'text', editable: true },
      { key: 'description', label: 'Description', type: 'text', editable: true },
    ],
  },
  {
    id: 'vehicle_types', name: 'Vehicle Types', description: 'Vehicle specifications for fleet modeling',
    tableName: 'master_vehicle_types', rowCount: 0,
    columns: [
      { key: 'code', label: 'Code', type: 'text', required: true, editable: true },
      { key: 'label', label: 'Label', type: 'text', required: true, editable: true },
      { key: 'capacity_lbs', label: 'Capacity (lbs)', type: 'number', editable: true },
      { key: 'mpg', label: 'MPG', type: 'number', editable: true },
      { key: 'notes', label: 'Notes', type: 'text', editable: true },
    ],
  },
  // dos_templates dropped 2026-04-29 — DOS templates live in stage_element_templates,
  // edited via Deal Management → DOS Elements (not redundantly here).
  {
    id: 'escalation_rates', name: 'Escalation Rates', description: 'Annual cost escalation rates by category',
    tableName: 'master_escalation_rates', rowCount: 0,
    columns: [
      { key: 'category', label: 'Category', type: 'text', required: true, editable: true },
      { key: 'pct', label: 'Rate (%)', type: 'number', required: true, editable: true },
      { key: 'effective_year', label: 'Year', type: 'number', editable: true },
      { key: 'notes', label: 'Notes', type: 'text', editable: true },
    ],
  },
  {
    id: 'sccs', name: 'Supply Chain Capabilities', description: 'The 12 GXO IES Supply Chain Capabilities',
    tableName: 'master_sccs', rowCount: 0,
    columns: [
      { key: 'code', label: 'Code', type: 'text', required: true, editable: true },
      { key: 'label', label: 'Label', type: 'text', required: true, editable: true },
      { key: 'category', label: 'Category', type: 'select', editable: true, options: ['Strategic', 'Operational', 'Technology'] },
      { key: 'description', label: 'Description', type: 'text', editable: true },
    ],
  },
  // ---- Go-to-market reference tables (restored 2026-04-18 per gap punchlist) ----
  {
    id: 'accounts', name: 'Accounts', description: 'Key target and existing accounts (go-to-market)',
    tableName: 'accounts', rowCount: 0,
    columns: [
      { key: 'company_name', label: 'Company', type: 'text', required: true, editable: true },
      { key: 'vertical', label: 'Vertical', type: 'text', editable: true },
      { key: 'region', label: 'Region', type: 'text', editable: true },
      { key: 'revenue_tier', label: 'Revenue Tier', type: 'select', editable: true, options: ['<$100M','$100M-$500M','$500M-$1B','$1B-$5B','>$5B'] },
      { key: 'priority_tier', label: 'Priority', type: 'select', editable: true, options: ['A','B','C'] },
      { key: 'notes', label: 'Notes', type: 'text', editable: true },
    ],
  },
  {
    id: 'competitors', name: 'Competitors', description: '3PL competitive set (DHL SC, Ryder, XPO, CEVA, etc.)',
    tableName: 'competitors', rowCount: 0,
    columns: [
      { key: 'name', label: 'Competitor', type: 'text', required: true, editable: true },
      { key: 'parent_company', label: 'Parent Co.', type: 'text', editable: true },
      { key: 'region_focus', label: 'Region Focus', type: 'text', editable: true },
      { key: 'segment_focus', label: 'Segment Focus', type: 'text', editable: true },
      { key: 'notes', label: 'Notes', type: 'text', editable: true },
    ],
  },
  {
    id: 'markets', name: 'Markets', description: 'Geographic markets for pipeline + intelligence',
    tableName: 'master_markets', rowCount: 0,
    columns: [
      { key: 'market_code', label: 'Code', type: 'text', required: true, editable: true },
      { key: 'market_name', label: 'Market', type: 'text', required: true, editable: true },
      { key: 'state', label: 'State', type: 'text', editable: true },
      { key: 'region', label: 'Region', type: 'text', editable: true },
    ],
  },
  {
    id: 'verticals', name: 'Verticals', description: 'Industry verticals (Retail, F&B, Pharma, Auto, etc.)',
    tableName: 'verticals', rowCount: 0,
    columns: [
      { key: 'code', label: 'Code', type: 'text', required: true, editable: true },
      { key: 'label', label: 'Label', type: 'text', required: true, editable: true },
      { key: 'description', label: 'Description', type: 'text', editable: true },
    ],
  },
  // ---- Threshold / scoring rule tables (X6 admin editor — 2026-04-18 audit) ----
  {
    id: 'multisite_grade_thresholds',
    name: 'Multi-Site Grade Thresholds',
    description: 'Min/target/max and weighting for each deal-scoring metric on Multi-Site Analyzer',
    tableName: 'ref_multisite_grade_thresholds', rowCount: 0,
    columns: [
      { key: 'metric_name', label: 'Metric', type: 'text', required: true, editable: true },
      { key: 'label',       label: 'Label',  type: 'text', editable: true },
      { key: 'min_value',   label: 'Min',    type: 'number', editable: true },
      { key: 'target_value',label: 'Target', type: 'number', editable: true },
      { key: 'max_value',   label: 'Max',    type: 'number', editable: true },
      { key: 'weight_pct',  label: 'Weight %',type: 'number', editable: true },
    ],
  },
  {
    id: 'fleet_carrier_rates',
    name: 'Fleet Carrier Rates',
    description: 'Common-carrier benchmark rates used by the Fleet Modeler 3-way comparison',
    tableName: 'ref_fleet_carrier_rates', rowCount: 0,
    columns: [
      { key: 'vehicle_type',       label: 'Vehicle Key',   type: 'text', required: true, editable: true },
      { key: 'display_name',       label: 'Display Name',  type: 'text', required: true, editable: true },
      { key: 'base_rate_per_mile', label: '$/Mile',        type: 'number', required: true, editable: true },
      { key: 'fuel_surcharge_pct', label: 'Fuel FSC (0-1)',type: 'number', editable: true },
      { key: 'min_charge',         label: 'Min Charge',    type: 'number', editable: true },
      { key: 'notes',              label: 'Notes',         type: 'text', editable: true },
      { key: 'is_active',          label: 'Active',        type: 'boolean', editable: true },
    ],
  },
  {
    id: 'fleet_dedicated_benchmarks',
    name: 'Fleet Dedicated Benchmarks',
    description: 'Per-market $/mile benchmarks for dedicated fleet pricing — reference data used during RFP build-out. Dedicated fleet is cost-plus in the calc; these benchmarks help designers validate the derived rate against market reality.',
    tableName: 'ref_fleet_dedicated_benchmarks', rowCount: 0,
    columns: [
      { key: 'market_id',          label: 'Market ID',    type: 'text',   required: true, editable: true },
      { key: 'vehicle_type',       label: 'Vehicle',      type: 'text',   required: true, editable: true },
      { key: 'benchmark_per_mile', label: '$/Mile',       type: 'number', required: true, editable: true },
      { key: 'low_band_per_mile',  label: 'Low Band',     type: 'number', editable: true },
      { key: 'high_band_per_mile', label: 'High Band',    type: 'number', editable: true },
      { key: 'source_citation',    label: 'Source',       type: 'text',   editable: true },
      { key: 'notes',              label: 'Notes',        type: 'text',   editable: true },
      { key: 'is_active',          label: 'Active',       type: 'boolean', editable: true },
    ],
  },
  {
    id: 'labor_market_profiles',
    name: 'Labor Market Profiles',
    description: 'Per-market turnover, temp premium, and seasonal OT/absence shape used as defaults when a labor line opts in via "Use market defaults".',
    tableName: 'ref_labor_market_profiles', rowCount: 0,
    columns: [
      { key: 'market_id',              label: 'Market ID',         type: 'text',   required: true, editable: true },
      { key: 'turnover_pct_annual',    label: 'Turnover %/yr',     type: 'number', editable: true },
      { key: 'temp_cost_premium_pct',  label: 'Temp Premium %',    type: 'number', editable: true },
      { key: 'holiday_days_per_year',  label: 'Holiday Days/yr',   type: 'number', editable: true },
      { key: 'notes',                  label: 'Notes',             type: 'text',   editable: true },
    ],
  },
  {
    id: 'design_heuristics',
    name: 'Design Heuristics Catalog',
    description: 'Standard modeling assumptions (DSO, benefit load, ramp, escalation, etc.) surfaced in the Cost Model Assumptions section. Editing defaults here affects every NEW scenario; approved scenarios stay frozen via rate snapshots.',
    tableName: 'ref_design_heuristics', rowCount: 0,
    columns: [
      { key: 'key',           label: 'Key',           type: 'text', required: true, editable: true },
      { key: 'label',         label: 'Label',         type: 'text', required: true, editable: true },
      { key: 'description',   label: 'Description',   type: 'text', editable: true },
      { key: 'category',      label: 'Category',      type: 'text', required: true, editable: true },
      { key: 'data_type',     label: 'Data Type',     type: 'text', required: true, editable: true },
      { key: 'unit',          label: 'Unit',          type: 'text', editable: true },
      { key: 'default_value', label: 'Default (num)', type: 'number', editable: true },
      { key: 'default_enum',  label: 'Default (enum)',type: 'text', editable: true },
      { key: 'min_value',     label: 'Min',           type: 'number', editable: true },
      { key: 'max_value',     label: 'Max',           type: 'number', editable: true },
      { key: 'sort_order',    label: 'Sort',          type: 'number', editable: true },
      { key: 'is_active',     label: 'Active',        type: 'boolean', editable: true },
    ],
  },
];

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260418-sP').UserAccount[]} */
export const DEMO_USERS = [
  { id: 'u1', email: 'brockeckles@gmail.com', displayName: 'Brock Eckles', role: 'admin', active: true, lastLogin: '2026-04-16T10:30:00Z' },
  { id: 'u2', email: 'design.eng1@gxo.com', displayName: 'Design Engineer 1', role: 'editor', active: true, lastLogin: '2026-04-15T14:00:00Z' },
  { id: 'u3', email: 'design.eng2@gxo.com', displayName: 'Design Engineer 2', role: 'editor', active: true, lastLogin: '2026-04-14T09:00:00Z' },
  { id: 'u4', email: 'ops.mgr@gxo.com', displayName: 'Operations Manager', role: 'viewer', active: true, lastLogin: '2026-04-10T11:00:00Z' },
  { id: 'u5', email: 'former.user@gxo.com', displayName: 'Former User', role: 'viewer', active: false, lastLogin: '2026-02-01T08:00:00Z' },
];

/** @type {import('./types.js?v=20260418-sP').EscalationRule[]} */
export const DEMO_ESCALATIONS = [
  { id: 'e1', name: 'Low Gross Margin', metric: 'gross_margin_pct', condition: 'below', threshold: 8, severity: 'critical', active: true, notifyEmail: 'brockeckles@gmail.com' },
  { id: 'e2', name: 'Low EBITDA', metric: 'ebitda_pct', condition: 'below', threshold: 4, severity: 'warning', active: true, notifyEmail: 'brockeckles@gmail.com' },
  { id: 'e3', name: 'High Cost Per SqFt', metric: 'cost_per_sqft', condition: 'above', threshold: 18, severity: 'warning', active: true },
  { id: 'e4', name: 'Long Payback', metric: 'payback_months', condition: 'above', threshold: 24, severity: 'critical', active: false },
];

/** @type {import('./types.js?v=20260418-sP').AuditLogEntry[]} */
export const DEMO_AUDIT_LOG = [
  { id: 'a1', action: 'update', tableName: 'cost_model_projects', recordId: 'cm-7', userId: 'u1', userName: 'Brock Eckles', timestamp: '2026-04-16T10:15:00Z', changes: { gross_margin: { from: 10.5, to: 11.2 } } },
  { id: 'a2', action: 'create', tableName: 'fleet_scenarios', recordId: 'fs-12', userId: 'u2', userName: 'Design Engineer 1', timestamp: '2026-04-15T16:30:00Z' },
  { id: 'a3', action: 'update', tableName: 'opportunity_tasks', recordId: 'ot-45', userId: 'u1', userName: 'Brock Eckles', timestamp: '2026-04-15T14:00:00Z', changes: { status: { from: 'pending', to: 'completed' } } },
  { id: 'a4', action: 'delete', tableName: 'wiki_articles', recordId: 'w-old', userId: 'u1', userName: 'Brock Eckles', timestamp: '2026-04-14T09:00:00Z' },
  { id: 'a5', action: 'create', tableName: 'change_initiatives', recordId: 'cm3', userId: 'u1', userName: 'Brock Eckles', timestamp: '2026-04-13T11:00:00Z' },
];

// ============================================================
// STATS
// ============================================================

/**
 * Compute admin panel stats.
 * @param {import('./types.js?v=20260418-sP').UserAccount[]} users
 * @param {import('./types.js?v=20260418-sP').MasterTableConfig[]} tables
 * @param {import('./types.js?v=20260418-sP').EscalationRule[]} escalations
 * @param {import('./types.js?v=20260418-sP').AuditLogEntry[]} auditLog
 * @param {string} [referenceDate] — ISO date for 7-day window
 * @returns {import('./types.js?v=20260418-sP').AdminStats}
 */
export function computeStats(users, tables, escalations, auditLog, referenceDate) {
  const refDate = referenceDate || new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(new Date(refDate).getTime() - 7 * 86400000).toISOString();

  return {
    totalUsers: users.length,
    activeUsers: users.filter(u => u.active).length,
    totalTables: tables.length,
    totalRecords: tables.reduce((s, t) => s + (t.rowCount || 0), 0),
    activeEscalations: escalations.filter(e => e.active).length,
    recentAuditEntries: auditLog.filter(a => a.timestamp >= sevenDaysAgo).length,
  };
}

// ============================================================
// VALIDATION
// ============================================================

/**
 * Validate a record against table column definitions.
 * @param {Record<string, any>} record
 * @param {import('./types.js?v=20260418-sP').ColumnDef[]} columns
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRecord(record, columns) {
  const errors = [];
  for (const col of columns) {
    const val = record[col.key];
    if (col.required && (val === undefined || val === null || val === '')) {
      errors.push(`${col.label} is required`);
    }
    if (val !== undefined && val !== null && val !== '') {
      if (col.type === 'number' && typeof val !== 'number' && isNaN(Number(val))) {
        errors.push(`${col.label} must be a number`);
      }
      if (col.type === 'boolean' && typeof val !== 'boolean') {
        errors.push(`${col.label} must be true or false`);
      }
      if (col.type === 'select' && col.options && !col.options.includes(val)) {
        errors.push(`${col.label} must be one of: ${col.options.join(', ')}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// ============================================================
// ESCALATION LOGIC
// ============================================================

/**
 * Evaluate a metric value against escalation rules.
 * @param {string} metric — metric key (e.g. 'gross_margin_pct')
 * @param {number} value
 * @param {import('./types.js?v=20260418-sP').EscalationRule[]} rules
 * @returns {import('./types.js?v=20260418-sP').EscalationRule[]} — triggered rules
 */
export function evaluateEscalations(metric, value, rules) {
  return rules.filter(r => {
    if (!r.active || r.metric !== metric) return false;
    if (r.condition === 'below') return value < r.threshold;
    if (r.condition === 'above') return value > r.threshold;
    return false;
  });
}

/**
 * Check all escalation rules against a set of metrics.
 * @param {Record<string, number>} metrics — key-value pairs (e.g. { gross_margin_pct: 7.5 })
 * @param {import('./types.js?v=20260418-sP').EscalationRule[]} rules
 * @returns {Array<{ rule: import('./types.js?v=20260418-sP').EscalationRule, metricValue: number }>}
 */
export function checkAllEscalations(metrics, rules) {
  const triggered = [];
  for (const [metric, value] of Object.entries(metrics)) {
    const matched = evaluateEscalations(metric, value, rules);
    for (const rule of matched) {
      triggered.push({ rule, metricValue: value });
    }
  }
  return triggered;
}

// ============================================================
// USER MANAGEMENT
// ============================================================

/**
 * Filter users.
 * @param {import('./types.js?v=20260418-sP').UserAccount[]} users
 * @param {{ role?: string, active?: boolean | 'all' }} filters
 * @returns {import('./types.js?v=20260418-sP').UserAccount[]}
 */
export function filterUsers(users, filters = {}) {
  let result = users;
  if (filters.role && filters.role !== 'all') {
    result = result.filter(u => u.role === filters.role);
  }
  if (filters.active !== undefined && filters.active !== 'all') {
    result = result.filter(u => u.active === filters.active);
  }
  return result;
}

/**
 * Count users by role.
 * @param {import('./types.js?v=20260418-sP').UserAccount[]} users
 * @returns {{ admin: number, editor: number, viewer: number }}
 */
export function usersByRole(users) {
  return {
    admin: users.filter(u => u.role === 'admin').length,
    editor: users.filter(u => u.role === 'editor').length,
    viewer: users.filter(u => u.role === 'viewer').length,
  };
}

/**
 * Find inactive users (no login within N days).
 * @param {import('./types.js?v=20260418-sP').UserAccount[]} users
 * @param {string} referenceDate — ISO datetime
 * @param {number} [days=30]
 * @returns {import('./types.js?v=20260418-sP').UserAccount[]}
 */
export function inactiveUsers(users, referenceDate, days = 30) {
  const cutoff = new Date(new Date(referenceDate).getTime() - days * 86400000).toISOString();
  return users.filter(u => u.active && (!u.lastLogin || u.lastLogin < cutoff));
}

// ============================================================
// AUDIT LOG
// ============================================================

/**
 * Filter audit log entries.
 * @param {import('./types.js?v=20260418-sP').AuditLogEntry[]} log
 * @param {{ action?: string, tableName?: string, userId?: string }} filters
 * @returns {import('./types.js?v=20260418-sP').AuditLogEntry[]}
 */
export function filterAuditLog(log, filters = {}) {
  let result = log;
  if (filters.action && filters.action !== 'all') {
    result = result.filter(a => a.action === filters.action);
  }
  if (filters.tableName && filters.tableName !== 'all') {
    result = result.filter(a => a.tableName === filters.tableName);
  }
  if (filters.userId && filters.userId !== 'all') {
    result = result.filter(a => a.userId === filters.userId);
  }
  return result;
}

/**
 * Count audit actions by type.
 * @param {import('./types.js?v=20260418-sP').AuditLogEntry[]} log
 * @returns {{ create: number, update: number, delete: number }}
 */
export function auditActionCounts(log) {
  return {
    create: log.filter(a => a.action === 'create').length,
    update: log.filter(a => a.action === 'update').length,
    delete: log.filter(a => a.action === 'delete').length,
  };
}

/**
 * Get most active users from audit log.
 * @param {import('./types.js?v=20260418-sP').AuditLogEntry[]} log
 * @param {number} [limit=5]
 * @returns {Array<{ userId: string, userName: string, count: number }>}
 */
export function mostActiveUsers(log, limit = 5) {
  const counts = new Map();
  for (const entry of log) {
    const key = entry.userId;
    if (!counts.has(key)) counts.set(key, { userId: key, userName: entry.userName, count: 0 });
    counts.get(key).count++;
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, limit);
}

// ============================================================
// FORMATTING
// ============================================================

/** @param {string} dateStr — ISO datetime */
export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** @param {string} action */
export function actionBadgeColor(action) {
  const colors = {
    create: '#16a34a',
    insert: '#16a34a',
    update: '#2563eb',
    delete: '#dc2626',
    link:   '#7c3aed',
    unlink: '#6b7280',
    // Margin-override trail (CM 2026-04-21). Amber family so these stand out
    // from routine CRUD and are visually grouped with each other.
    'price-override':        '#d97706',
    'price-override-reset':  '#b45309',
    'price-override-reason': '#f59e0b',
  };
  return colors[action] || '#6b7280';
}

/** @param {string} role */
export function roleBadgeColor(role) {
  const colors = { admin: '#7c3aed', editor: '#2563eb', viewer: '#6b7280' };
  return colors[role] || '#6b7280';
}

/** @param {string} severity */
export function severityColor(severity) {
  return severity === 'critical' ? '#dc2626' : '#d97706';
}

// ============================================================
// USER ACTIVITY (Slice 3.13)
// ============================================================

/**
 * Route → human label map. Keeps the table reading "Cost Model Builder"
 * instead of "designtools/cost-model/p-l". Exhaustive for top-level routes;
 * falls back to the route string itself for anything unmatched.
 * @type {Record<string, string>}
 */
export const ROUTE_LABELS = {
  overview: 'Home',
  overviewold: 'Home (old)',
  dealmanager: 'Deal Manager',
  dashboards: 'Dashboards',
  admin: 'Admin',
  feedback: 'Feedback',
  commandcenter: 'Command Center',
  'designtools/cost-model': 'Cost Model Builder',
  'designtools/warehouse-sizing': 'Warehouse Sizing',
  'designtools/deal-manager': 'Deal Manager',
  'designtools/fleet-modeler': 'Fleet Modeler',
  'designtools/center-of-gravity': 'Center of Gravity',
  'designtools/most-standards': 'MOST Labor Standards',
  'designtools/network-opt': 'Network Optimizer',
  designtools: 'Design Tools',
  'deck-generator': 'Deck Generator',
  'training-wiki': 'Training Wiki',
  'market-explorer': 'Market Explorer',
  'change-mgmt': 'Change Management',
  wiki: 'Wiki',
};

export function humanRouteLabel(route) {
  if (!route) return '—';
  // Strip tab suffixes the router appends (e.g. cost-model/p-l → cost-model)
  // by matching the longest prefix we know.
  if (ROUTE_LABELS[route]) return ROUTE_LABELS[route];
  const parts = route.split('/');
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/');
    if (ROUTE_LABELS[prefix]) return ROUTE_LABELS[prefix];
  }
  return route;
}

/**
 * Collapse analytics_events rows into one object per pilot in `profiles`,
 * with rollups over the event window. Only events in the last `windowDays`
 * days are counted for the "this week" metrics. Events with NULL user_id
 * (pre-Slice-3.13 or fired pre-login) are bucketed into a synthetic
 * "Anonymous" row so we can see the volume without losing it.
 *
 * Shape returned per row:
 *   userId, email, displayName, role, team_id,
 *   lastLogin        — ISO timestamp of most recent session_start
 *   sessionsInWindow — distinct session_id count inside the window
 *   pageViewsInWindow
 *   totalEventsInWindow
 *   mostUsedRoute    — route with the highest count inside the window
 *   medianSessionMin — median duration of session_end rows, rounded to 1 decimal
 *   onlineNow        — true if any event in last `onlineWithinMs` ms
 *   firstSeen        — ISO timestamp of earliest event we have for this user
 *
 * @param {any[]} profiles
 * @param {any[]} events
 * @param {{ now?: number, onlineWithinMs?: number }} [opts]
 */
export function summarizeUserActivity(profiles, events, opts = {}) {
  const now = opts.now || Date.now();
  const onlineWithinMs = opts.onlineWithinMs || 15 * 60 * 1000; // 15 min

  // 2026-04-27: authLogins is the authoritative last-sign-in map keyed on
  // user_id. Comes from public.admin_list_user_logins() which exposes
  // auth.users.last_sign_in_at to admins. We overlay it onto each row's
  // lastLogin so the column shows real auth state instead of telemetry-
  // derived guesses (which were always null because session_start fires
  // before auth bootstraps).
  const authLogins = opts.authLogins || [];
  const authLoginById = new Map();
  for (const r of authLogins) {
    const id = r?.user_id || r?.id;
    const ts = r?.last_sign_in_at;
    if (id && ts) authLoginById.set(id, ts);
  }

  // Bucket events by user_id (string, or '__anon__' for nulls).
  const byUser = new Map();
  for (const ev of events || []) {
    const key = ev.user_id || '__anon__';
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(ev);
  }

  // Build one row per profile; profiles with no events still show in the
  // table with "never logged in" so admins can see who hasn't touched it.
  // Column is `full_name` in public.profiles; accept `display_name` too so
  // any existing fixtures / callers that pass a different shape still work.
  const rows = (profiles || []).map((p) => {
    const evs = byUser.get(p.id) || [];
    const r = rollup({
      userId: p.id,
      email: p.email || '',
      displayName: p.full_name || p.display_name || p.email || '(no name)',
      role: p.role || 'member',
      team_id: p.team_id || null,
      events: evs,
      now, onlineWithinMs,
    });
    // Prefer auth.users.last_sign_in_at — it's the only source that
    // captures sign-ins independent of telemetry firing. Falls back to
    // event-derived lastLogin (still useful when auth fetch fails).
    const authTs = authLoginById.get(p.id);
    if (authTs) r.lastLogin = authTs;
    return r;
  });

  // Append the Anonymous bucket only if we actually have un-attributed
  // events. Keeps the table from showing a ghost row when everyone is
  // attributed.
  const anon = byUser.get('__anon__') || [];
  if (anon.length) {
    rows.push(rollup({
      userId: null,
      email: '',
      displayName: 'Anonymous / pre-login',
      role: '—',
      team_id: null,
      events: anon,
      now, onlineWithinMs,
    }));
  }

  // Sort: online first, then by most recent activity desc, then by email.
  rows.sort((a, b) => {
    if (a.onlineNow !== b.onlineNow) return a.onlineNow ? -1 : 1;
    const at = a.lastLogin ? Date.parse(a.lastLogin) : 0;
    const bt = b.lastLogin ? Date.parse(b.lastLogin) : 0;
    if (at !== bt) return bt - at;
    return String(a.email).localeCompare(String(b.email));
  });
  return rows;
}

function rollup({ userId, email, displayName, role, team_id, events, now, onlineWithinMs }) {
  if (!events.length) {
    return {
      userId, email, displayName, role, team_id,
      lastLogin: null,
      firstSeen: null,
      sessionsInWindow: 0,
      pageViewsInWindow: 0,
      totalEventsInWindow: 0,
      mostUsedRoute: null,
      medianSessionMin: null,
      onlineNow: false,
    };
  }
  let lastLogin = null;     // latest session_start (ISO)
  let firstSeen = null;     // earliest event (ISO)
  let mostRecentEventAt = 0;
  const sessions = new Set();
  let pageViews = 0;
  const routeCounts = new Map();
  const durationsMin = [];

  for (const ev of events) {
    const t = Date.parse(ev.created_at);
    if (firstSeen === null || t < Date.parse(firstSeen)) firstSeen = ev.created_at;
    if (t > mostRecentEventAt) mostRecentEventAt = t;
    if (ev.session_id) sessions.add(ev.session_id);
    if (ev.event === 'page_view') {
      pageViews += 1;
      const r = ev.route || 'overview';
      routeCounts.set(r, (routeCounts.get(r) || 0) + 1);
    }
    if (ev.event === 'session_start') {
      if (!lastLogin || t > Date.parse(lastLogin)) lastLogin = ev.created_at;
    }
    if (ev.event === 'session_end' && ev.payload && typeof ev.payload.duration_ms === 'number') {
      durationsMin.push(ev.payload.duration_ms / 60000);
    }
  }

  let mostUsedRoute = null;
  if (routeCounts.size) {
    const sorted = [...routeCounts.entries()].sort((a, b) => b[1] - a[1]);
    mostUsedRoute = sorted[0][0];
  }

  let medianSessionMin = null;
  if (durationsMin.length) {
    durationsMin.sort((a, b) => a - b);
    const mid = Math.floor(durationsMin.length / 2);
    const m = durationsMin.length % 2 ? durationsMin[mid] : (durationsMin[mid - 1] + durationsMin[mid]) / 2;
    medianSessionMin = Math.round(m * 10) / 10;
  }

  return {
    userId, email, displayName, role, team_id,
    lastLogin,
    firstSeen,
    sessionsInWindow: sessions.size,
    pageViewsInWindow: pageViews,
    totalEventsInWindow: events.length,
    mostUsedRoute,
    medianSessionMin,
    onlineNow: (now - mostRecentEventAt) <= onlineWithinMs,
  };
}

/**
 * Top-row KPIs derived from the per-user rollup. Kept pure so it's trivial
 * to unit-test against fixture arrays.
 */
export function activityKpis(rows) {
  const r = rows || [];
  const realPilots = r.filter(x => x.userId);
  const activeWindow = realPilots.filter(x => x.sessionsInWindow > 0).length;
  const onlineNow = realPilots.filter(x => x.onlineNow).length;
  const pageViews = realPilots.reduce((s, x) => s + (x.pageViewsInWindow || 0), 0);
  const medians = realPilots.map(x => x.medianSessionMin).filter(x => x != null);
  medians.sort((a, b) => a - b);
  const medianOfMedians = medians.length
    ? (medians.length % 2
        ? medians[Math.floor(medians.length / 2)]
        : (medians[medians.length / 2 - 1] + medians[medians.length / 2]) / 2)
    : null;
  return {
    activeWindow,
    totalPilots: realPilots.length,
    onlineNow,
    pageViews,
    medianSessionMin: medianOfMedians,
  };
}

/**
 * Format a timestamp as "2h ago", "3d ago", "—" style. Short, table-dense.
 */
export function relativeAgo(iso, nowMs) {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!t) return '—';
  const now = nowMs || Date.now();
  const diffSec = Math.max(0, Math.round((now - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
