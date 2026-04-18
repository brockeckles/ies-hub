/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 *
 * Aggregates multi-site financials, computes deal-level metrics,
 * generates multi-year P&L, and tracks DOS stage progress.
 *
 * @module tools/deal-manager/calc
 */

// ============================================================
// CONSTANTS
// ============================================================

/** EBITDA overhead deduction rate (SGA + D&A) */
export const EBITDA_OVERHEAD_PCT = 8;

/** NPV discount rate */
export const DISCOUNT_RATE = 0.10;

/** Default escalation rate for multi-year projections */
export const DEFAULT_ESCALATION_PCT = 3;

/** Default contract term */
export const DEFAULT_CONTRACT_YEARS = 5;

/** Financial metric thresholds (pass/fail) */
export const THRESHOLDS = {
  grossMarginPct: { min: 8, target: 12, label: 'Gross Margin' },
  ebitdaPct: { min: 4, target: 8, label: 'EBITDA Margin' },
  paybackMonths: { max: 24, target: 18, label: 'Payback Period' },
  costPerSqft: { max: 18, target: 12, label: 'Cost/SqFt' },
};

// ============================================================
// DOS STAGES (reference)
// ============================================================

/** @type {Array<{ number: number, name: string, elementCount: number }>} */
export const DOS_STAGES = [
  { number: 1, name: 'Pre-Sales Engagement', elementCount: 4 },
  { number: 2, name: 'Deal Qualification', elementCount: 6 },
  { number: 3, name: 'Kick-Off & Solution Design', elementCount: 15 },
  { number: 4, name: 'Operations Review', elementCount: 2 },
  { number: 5, name: 'Executive Review', elementCount: 5 },
  { number: 6, name: 'Delivery Handover', elementCount: 6 },
];

// ============================================================
// SITE-LEVEL FINANCIALS
// ============================================================

/**
 * Compute per-site financials.
 * @param {import('./types.js?v=20260418-s5').Site} site
 * @returns {import('./types.js?v=20260418-s5').SiteFinancials}
 */
export function computeSiteFinancials(site) {
  const annualCost = site.annualCost || 0;
  const marginPct = site.targetMarginPct || 0;
  const annualRevenue = marginPct > 0 ? annualCost / (1 - marginPct / 100) : annualCost;
  const grossMarginPct = annualRevenue > 0 ? ((annualRevenue - annualCost) / annualRevenue) * 100 : 0;
  const costPerSqft = site.sqft > 0 ? annualCost / site.sqft : 0;

  return {
    siteId: site.id,
    siteName: site.name,
    annualCost,
    annualRevenue,
    grossMarginPct,
    costPerSqft,
  };
}

// ============================================================
// DEAL-LEVEL AGGREGATE FINANCIALS
// ============================================================

/**
 * Compute deal-level aggregate financials from sites.
 * @param {import('./types.js?v=20260418-s5').Site[]} sites
 * @param {number} [contractTermYears]
 * @returns {import('./types.js?v=20260418-s5').DealFinancials}
 */
export function computeDealFinancials(sites, contractTermYears = DEFAULT_CONTRACT_YEARS) {
  if (sites.length === 0) {
    return emptyFinancials();
  }

  const bySite = sites.map(s => computeSiteFinancials(s));
  const totalAnnualCost = bySite.reduce((s, sf) => s + sf.annualCost, 0);
  const totalAnnualRevenue = bySite.reduce((s, sf) => s + sf.annualRevenue, 0);
  const grossMarginPct = totalAnnualRevenue > 0
    ? ((totalAnnualRevenue - totalAnnualCost) / totalAnnualRevenue) * 100
    : 0;
  const ebitdaPct = grossMarginPct - EBITDA_OVERHEAD_PCT;
  const totalStartupCost = sites.reduce((s, site) => s + (site.startupCost || 0), 0);
  const totalSqft = sites.reduce((s, site) => s + (site.sqft || 0), 0);

  const annualGrossProfit = totalAnnualRevenue - totalAnnualCost;
  const annualEbitda = totalAnnualRevenue * (ebitdaPct / 100);

  // NPV
  const npv = computeNpv(totalStartupCost, annualEbitda, contractTermYears);

  // Payback
  const paybackMonths = computePaybackMonths(totalStartupCost, annualEbitda);

  // IRR (simplified — Newton's method)
  const irr = computeIrr(totalStartupCost, annualEbitda, contractTermYears);

  return {
    totalAnnualCost,
    totalAnnualRevenue,
    grossMarginPct,
    ebitdaPct,
    totalStartupCost,
    npv,
    paybackMonths,
    irr,
    totalSqft,
    costPerSqft: totalSqft > 0 ? totalAnnualCost / totalSqft : 0,
    revenuePerSqft: totalSqft > 0 ? totalAnnualRevenue / totalSqft : 0,
    bySite,
  };
}

/**
 * @returns {import('./types.js?v=20260418-s5').DealFinancials}
 */
function emptyFinancials() {
  return {
    totalAnnualCost: 0, totalAnnualRevenue: 0, grossMarginPct: 0, ebitdaPct: 0,
    totalStartupCost: 0, npv: 0, paybackMonths: 0, irr: 0, totalSqft: 0,
    costPerSqft: 0, revenuePerSqft: 0, bySite: [],
  };
}

// ============================================================
// NPV / PAYBACK / IRR
// ============================================================

/**
 * Compute NPV.
 * @param {number} startup — initial investment (negative cash flow at t=0)
 * @param {number} annualCashFlow — annual EBITDA
 * @param {number} years
 * @param {number} [rate]
 * @returns {number}
 */
export function computeNpv(startup, annualCashFlow, years, rate = DISCOUNT_RATE) {
  let npv = -startup;
  for (let t = 1; t <= years; t++) {
    npv += annualCashFlow / Math.pow(1 + rate, t);
  }
  return npv;
}

/**
 * Compute payback period in months.
 * @param {number} startup
 * @param {number} annualCashFlow
 * @returns {number}
 */
export function computePaybackMonths(startup, annualCashFlow) {
  if (annualCashFlow <= 0) return Infinity;
  if (startup <= 0) return 0;
  return (startup / annualCashFlow) * 12;
}

/**
 * Compute IRR using Newton's method.
 * Cash flows: [-startup, cf, cf, ..., cf] for n years.
 * @param {number} startup
 * @param {number} annualCashFlow
 * @param {number} years
 * @returns {number} IRR as decimal (0.15 = 15%)
 */
export function computeIrr(startup, annualCashFlow, years) {
  if (startup <= 0 || annualCashFlow <= 0) return 0;

  let rate = 0.10;
  for (let iter = 0; iter < 100; iter++) {
    let npv = -startup;
    let deriv = 0;
    for (let t = 1; t <= years; t++) {
      const disc = Math.pow(1 + rate, t);
      npv += annualCashFlow / disc;
      deriv -= t * annualCashFlow / (disc * (1 + rate));
    }
    if (Math.abs(deriv) < 1e-12) break;
    const newRate = rate - npv / deriv;
    if (Math.abs(newRate - rate) < 1e-8) { rate = newRate; break; }
    rate = newRate;
  }

  return Math.max(0, rate);
}

// ============================================================
// MULTI-YEAR P&L
// ============================================================

/**
 * Generate multi-year P&L projection.
 * @param {import('./types.js?v=20260418-s5').DealFinancials} fin
 * @param {number} [years]
 * @param {number} [escalationPct]
 * @returns {import('./types.js?v=20260418-s5').MultiYearRow[]}
 */
export function generateMultiYearPL(fin, years = DEFAULT_CONTRACT_YEARS, escalationPct = DEFAULT_ESCALATION_PCT) {
  const rows = [];
  let cumCashFlow = -(fin.totalStartupCost || 0);

  for (let yr = 1; yr <= years; yr++) {
    const escFactor = Math.pow(1 + escalationPct / 100, yr - 1);
    const revenue = fin.totalAnnualRevenue * escFactor;
    const cost = fin.totalAnnualCost * escFactor;
    const grossProfit = revenue - cost;
    const ebitda = revenue * (fin.ebitdaPct / 100);
    cumCashFlow += ebitda;

    rows.push({ year: yr, revenue, cost, grossProfit, ebitda, cumulativeCashFlow: cumCashFlow });
  }

  return rows;
}

// ============================================================
// DOS STAGE PROGRESS
// ============================================================

/**
 * Compute progress across DOS stages.
 * @param {import('./types.js?v=20260418-s5').DosStage[]} stages
 * @returns {import('./types.js?v=20260418-s5').StageProgress[]}
 */
export function computeStageProgress(stages) {
  return stages.map(stage => {
    const total = stage.elements.length;
    const completed = stage.elements.filter(e => e.status === 'complete').length;
    const inProgress = stage.elements.filter(e => e.status === 'in_progress').length;
    const blocked = stage.elements.filter(e => e.status === 'blocked').length;

    return {
      stageNumber: stage.stageNumber,
      stageName: stage.stageName,
      total,
      completed,
      inProgress,
      blocked,
      pct: total > 0 ? (completed / total) * 100 : 0,
    };
  });
}

/**
 * Compute overall deal completion from stage progress.
 * @param {import('./types.js?v=20260418-s5').StageProgress[]} progress
 * @returns {{ totalElements: number, completedElements: number, overallPct: number, currentStage: string }}
 */
export function computeOverallProgress(progress) {
  const totalElements = progress.reduce((s, p) => s + p.total, 0);
  const completedElements = progress.reduce((s, p) => s + p.completed, 0);
  const overallPct = totalElements > 0 ? (completedElements / totalElements) * 100 : 0;

  // Current stage = first stage with incomplete elements
  const currentStage = progress.find(p => p.pct < 100)?.stageName || 'Complete';

  return { totalElements, completedElements, overallPct, currentStage };
}

// ============================================================
// METRIC EVALUATION (pass/fail)
// ============================================================

/**
 * Evaluate a financial metric against thresholds.
 * @param {string} metric — key in THRESHOLDS
 * @param {number} value
 * @returns {{ passes: boolean, rating: 'good' | 'warning' | 'fail', label: string }}
 */
export function evaluateMetric(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t) return { passes: true, rating: 'good', label: metric };

  if (t.min !== undefined) {
    // Higher is better
    if (value >= t.target) return { passes: true, rating: 'good', label: t.label };
    if (value >= t.min) return { passes: true, rating: 'warning', label: t.label };
    return { passes: false, rating: 'fail', label: t.label };
  }

  if (t.max !== undefined) {
    // Lower is better
    if (value <= t.target) return { passes: true, rating: 'good', label: t.label };
    if (value <= t.max) return { passes: true, rating: 'warning', label: t.label };
    return { passes: false, rating: 'fail', label: t.label };
  }

  return { passes: true, rating: 'good', label: t.label };
}

/**
 * Evaluate all deal financial metrics.
 * @param {import('./types.js?v=20260418-s5').DealFinancials} fin
 * @returns {Array<{ metric: string, value: number, passes: boolean, rating: string, label: string }>}
 */
export function evaluateAllMetrics(fin) {
  return [
    { metric: 'grossMarginPct', value: fin.grossMarginPct, ...evaluateMetric('grossMarginPct', fin.grossMarginPct) },
    { metric: 'ebitdaPct', value: fin.ebitdaPct, ...evaluateMetric('ebitdaPct', fin.ebitdaPct) },
    { metric: 'paybackMonths', value: fin.paybackMonths, ...evaluateMetric('paybackMonths', fin.paybackMonths) },
    { metric: 'costPerSqft', value: fin.costPerSqft, ...evaluateMetric('costPerSqft', fin.costPerSqft) },
  ];
}

// ============================================================
// DEAL SCORING
// ============================================================

/**
 * Compute a simple deal health score (0-100).
 * Weighted: margin 35%, EBITDA 25%, payback 20%, NPV 20%.
 * @param {import('./types.js?v=20260418-s5').DealFinancials} fin
 * @returns {{ score: number, grade: 'A' | 'B' | 'C' | 'D' | 'F' }}
 */
export function computeDealScore(fin) {
  // Normalize each metric to 0-100
  const marginScore = clamp(fin.grossMarginPct / 15 * 100, 0, 100);
  const ebitdaScore = clamp(fin.ebitdaPct / 10 * 100, 0, 100);
  const paybackScore = fin.paybackMonths > 0 ? clamp((36 - fin.paybackMonths) / 36 * 100, 0, 100) : 0;
  const npvScore = fin.npv > 0 ? clamp(100, 0, 100) : clamp(50 + (fin.npv / 100000) * 50, 0, 100);

  const score = Math.round(marginScore * 0.35 + ebitdaScore * 0.25 + paybackScore * 0.20 + npvScore * 0.20);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';

  return { score, grade };
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ============================================================
// SITE COMPARISON
// ============================================================

/**
 * Rank sites by cost efficiency.
 * @param {import('./types.js?v=20260418-s5').SiteFinancials[]} siteFins
 * @returns {Array<import('./types.js?v=20260418-s5').SiteFinancials & { rank: number }>}
 */
export function rankSitesByCost(siteFins) {
  const sorted = [...siteFins].sort((a, b) => a.costPerSqft - b.costPerSqft);
  return sorted.map((sf, i) => ({ ...sf, rank: i + 1 }));
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260418-s5').Deal} */
export const DEMO_DEAL = {
  dealName: 'Midwest Regional Expansion',
  clientName: 'Acme Corp',
  dealOwner: 'Sarah Chen',
  status: 'in_progress',
  contractTermYears: 5,
  notes: 'Multi-site expansion with 3 DCs across the Midwest corridor.',
};

/** @type {import('./types.js?v=20260418-s5').Site[]} */
export const DEMO_SITES = [
  { id: 's1', name: 'Chicago DC', market: 'Midwest', environment: 'Ambient', sqft: 350000, annualCost: 4200000, targetMarginPct: 12, startupCost: 800000, pricingModel: 'cost-plus', annualVolume: 2400000 },
  { id: 's2', name: 'Indianapolis DC', market: 'Midwest', environment: 'Ambient', sqft: 250000, annualCost: 2800000, targetMarginPct: 10, startupCost: 500000, pricingModel: 'cost-plus', annualVolume: 1600000 },
  { id: 's3', name: 'Columbus DC', market: 'Midwest', environment: 'Cold Chain', sqft: 180000, annualCost: 3100000, targetMarginPct: 14, startupCost: 900000, pricingModel: 'transactional', annualVolume: 1200000 },
];

// ============================================================
// FORMATTING
// ============================================================

/**
 * @param {number} val
 * @param {Object} [opts]
 * @param {boolean} [opts.compact]
 * @returns {string}
 */
export function formatCurrency(val, opts = {}) {
  if (opts.compact) {
    if (Math.abs(val) >= 1e6) return '$' + (val / 1e6).toFixed(1) + 'M';
    if (Math.abs(val) >= 1e3) return '$' + (val / 1e3).toFixed(0) + 'K';
  }
  return '$' + (val || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** @param {number} pct @returns {string} */
export function formatPct(pct) {
  return (pct || 0).toFixed(1) + '%';
}

/** @param {number} months @returns {string} */
export function formatMonths(months) {
  if (!isFinite(months) || months <= 0) return 'N/A';
  if (months < 12) return months.toFixed(1) + ' mo';
  return (months / 12).toFixed(1) + ' yr';
}

/** @param {string} status @returns {{ label: string, color: string, bg: string }} */
export function statusBadge(status) {
  const badges = {
    draft: { label: 'Draft', color: '#6b7280', bg: '#f3f4f6' },
    in_progress: { label: 'In Progress', color: '#0047AB', bg: '#dbeafe' },
    proposal_sent: { label: 'Proposal Sent', color: '#92400e', bg: '#fef3c7' },
    won: { label: 'Won', color: '#15803d', bg: '#dcfce7' },
    lost: { label: 'Lost', color: '#991b1b', bg: '#fee2e2' },
  };
  return badges[status] || badges.draft;
}

/** @param {string} rating @returns {string} */
export function ratingColor(rating) {
  return { good: '#22c55e', warning: '#f59e0b', fail: '#ef4444' }[rating] || '#6b7280';
}

// ============================================================
// HOURS TRACKING CALCULATIONS
// ============================================================

const HOURS_TYPES = [
  'Sales Design',
  'Engineering',
  'Deal Mgmt',
  'Site Visit',
  'Customer Meeting',
  'Internal Review',
  'Documentation',
  'Other'
];

/**
 * Calculate hours summary from hours entries.
 * @param {import('./types.js?v=20260418-s5').HoursEntry[]} hours
 * @returns {import('./types.js?v=20260418-s5').HoursSummary}
 */
export function calcHoursSummary(hours) {
  const byCategory = {};
  const byWeek = {};

  hours.forEach(h => {
    const type = h.hours_type || 'Other';
    const week = h.week_start || '';
    const hval = Number(h.hours || 0);

    // By work type
    if (!byCategory[type]) byCategory[type] = { type, forecast: 0, actual: 0 };
    if (h.category === 'forecast') byCategory[type].forecast += hval;
    else if (h.category === 'actual') byCategory[type].actual += hval;

    // By week
    const weekKey = `${week}|${type}`;
    if (!byWeek[weekKey]) byWeek[weekKey] = { week, forecast: 0, actual: 0 };
    if (h.category === 'forecast') byWeek[weekKey].forecast += hval;
    else if (h.category === 'actual') byWeek[weekKey].actual += hval;
  });

  const totalForecast = Object.values(byCategory).reduce((s, cat) => s + cat.forecast, 0);
  const totalActual = Object.values(byCategory).reduce((s, cat) => s + cat.actual, 0);
  const delta = totalActual - totalForecast;
  const percentUtilized = totalForecast > 0 ? (totalActual / totalForecast) * 100 : 0;

  const weekArray = Object.values(byWeek)
    .map(w => ({ ...w, delta: w.actual - w.forecast }))
    .sort((a, b) => b.week.localeCompare(a.week));

  return {
    totalForecast,
    totalActual,
    delta,
    percentUtilized,
    byWorkType: Object.values(byCategory),
    byWeek: weekArray
  };
}

// ============================================================
// TASK PROGRESS CALCULATIONS
// ============================================================

/**
 * Calculate task progress metrics.
 * @param {import('./types.js?v=20260418-s5').Task[]} tasks
 * @returns {import('./types.js?v=20260418-s5').TaskSummary}
 */
export function calcTaskProgress(tasks) {
  if (tasks.length === 0) {
    return {
      total: 0,
      done: 0,
      inProgress: 0,
      blocked: 0,
      percentComplete: 0,
      byStage: [],
      byPriority: []
    };
  }

  // Count overall
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const percentComplete = (done / total) * 100;

  // Group by DOS stage
  const byStageMap = new Map();
  tasks.forEach(t => {
    const stageNum = t.dos_stage_number || 0;
    const stageName = t.dos_stage_name || `Stage ${stageNum}`;
    const key = `${stageNum}|${stageName}`;
    if (!byStageMap.has(key)) {
      byStageMap.set(key, { dosStageNumber: stageNum, dosStageName: stageName, total: 0, done: 0, inProgress: 0, blocked: 0 });
    }
    const stage = byStageMap.get(key);
    stage.total++;
    if (t.status === 'done') stage.done++;
    else if (t.status === 'in_progress') stage.inProgress++;
    else if (t.status === 'blocked') stage.blocked++;
  });

  const byStage = Array.from(byStageMap.values()).sort((a, b) => a.dosStageNumber - b.dosStageNumber);

  // Group by priority
  const byPriorityMap = new Map();
  ['low', 'medium', 'high', 'critical'].forEach(p => {
    const count = tasks.filter(t => t.priority === p).length;
    if (count > 0) byPriorityMap.set(p, { priority: p, count });
  });

  const byPriority = Array.from(byPriorityMap.values());

  return { total, done, inProgress, blocked, percentComplete, byStage, byPriority };
}

// ============================================================
// DOS ACTIVITY TEMPLATES
// ============================================================

/**
 * Get standard DOS activity templates for a stage.
 * @param {number} stageNumber — 1-6
 * @returns {Array<{ title: string, description: string }>}
 */
export function getDosActivityTemplates(stageNumber) {
  const templates = {
    1: [
      { title: 'Market Analysis', description: 'Research market conditions and competitive landscape' },
      { title: 'RFP Review', description: 'Comprehensive review and qualification of customer RFP' },
      { title: 'Scope Definition', description: 'Define project scope and high-level requirements' },
      { title: 'Solution Overview', description: 'Present initial solution direction to customer' },
      { title: 'Customer Profiling', description: 'Develop customer profile and opportunity assessment' }
    ],
    2: [
      { title: 'Volume Analysis', description: 'Analyze customer volume and demand patterns' },
      { title: 'Complexity Assessment', description: 'Assess solution and operational complexity' },
      { title: 'Resource Estimation', description: 'Estimate required resources and staffing' },
      { title: 'Risk Assessment', description: 'Identify and evaluate key risks' },
      { title: 'Go/No-Go Recommendation', description: 'Make recommendation to proceed with design' },
      { title: 'Solution Lead Assignment', description: 'Assign Solution Lead for next phase' }
    ],
    3: [
      { title: 'Kickoff Meeting', description: 'Conduct formal project kickoff with customer' },
      { title: 'Cost Model Build', description: 'Develop comprehensive cost model' },
      { title: 'Warehouse Sizing', description: 'Size facility requirements and footprint' },
      { title: 'Network Analysis', description: 'Analyze network design and routing' },
      { title: 'Labor Standards', description: 'Develop labor productivity standards' },
      { title: 'Equipment Specification', description: 'Specify equipment and systems requirements' },
      { title: 'Technology Scope', description: 'Define technology and systems architecture' }
    ],
    4: [
      { title: 'Operations Feasibility', description: 'Validate operations feasibility and requirements' },
      { title: 'SLA Definition', description: 'Define Service Level Agreements and metrics' },
      { title: 'KPI Framework', description: 'Establish KPI framework and reporting' },
      { title: 'Transition Plan', description: 'Develop transition and implementation plan' },
      { title: 'Contingency Plan', description: 'Develop contingency and risk mitigation plans' }
    ],
    5: [
      { title: 'Executive Summary', description: 'Prepare executive summary for decision makers' },
      { title: 'Financial Review', description: 'Review and present financial analysis' },
      { title: 'Risk Mitigation', description: 'Present risk mitigation strategies' },
      { title: 'Contract Review', description: 'Legal review of contract terms and conditions' },
      { title: 'Pricing Approval', description: 'Obtain pricing and deal approval' }
    ],
    6: [
      { title: 'Implementation Plan', description: 'Finalize detailed implementation plan' },
      { title: 'Resource Onboarding', description: 'Onboard resources for delivery' },
      { title: 'Systems Setup', description: 'Setup systems and technology infrastructure' },
      { title: 'Go-Live Checklist', description: 'Complete go-live readiness checklist' },
      { title: 'Handover Documentation', description: 'Prepare handover documentation' }
    ]
  };

  return templates[stageNumber] || [];
}
