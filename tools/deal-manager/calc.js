/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 *
 * Aggregates multi-site financials, computes deal-level metrics,
 * generates multi-year P&L, and tracks DOS stage progress.
 *
 * @module tools/deal-manager/calc
 */

// P2-a (2026-07-23): ONE revenue formula — the bid snapshot prices ★ models
// exactly like the Σ★ roll-up does (engine-stamped revenue wins; markup
// heuristic otherwise). Importing beats re-implementing: any drift between
// the live roll-up and the frozen bid of record would poison calibration.
// hub/deal-management/calc.js is pure + import-free, so no cycle (it's the
// hub API that imports THIS module, not the other way around).
import { modelRevenueEst } from '../../hub/deal-management/calc.js?v=20260722-s3d';

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

/** MUL-A2 — Default weights for computeDealScore. Sum to 1.0. */
export const DEFAULT_SCORE_WEIGHTS = {
  margin: 0.35,
  ebitda: 0.25,
  payback: 0.20,
  npv: 0.20,
};

/** MUL-A3 — Default grade thresholds (score floor for each grade). */
export const DEFAULT_GRADE_THRESHOLDS = {
  A: 90,
  B: 75,
  C: 60,
  D: 45,
  // anything below D = F
};

/**
 * MUL-D1 — Per-component escalation defaults. Allows operating cost to
 * escalate at one rate, revenue at another (as 3PL contracts often do
 * because labor index ≠ CPI ≠ negotiated rate-card cap), and startup
 * not at all (one-time spend).
 */
export const DEFAULT_ESCALATION_BY_COMPONENT = {
  revenue: 3.0,
  cost: 3.0,
  startup: 0,
};

/**
 * MUL-C1 — Industry-standard markup applied to transactional/cost-pass
 * pricing models. Cost-plus uses targetMarginPct directly (price = cost
 * / (1 - margin)). The other models bill back cost with a fixed markup.
 */
export const DEFAULT_PRICING_MARKUPS = {
  'cost-plus': null,        // uses targetMarginPct
  'transactional': 0.12,    // 12% markup on cost basis
  'cost-pass-through': 0.08, // pass-through with 8% mgmt fee
  'fixed-fee': null,        // uses targetMarginPct (with revenue cap)
  'hybrid': 0.10,           // blended fixed-fee + transactional
};

// ============================================================
// DOS STAGES — SINGLE canonical in-code definition (S2, 2026-07-22).
// Previously defined twice with drifting shapes (here w/ stale hardcoded
// elementCounts · hub/deal-management/ui.js w/ colors). Canonical stage
// NAMES still come from the DB at runtime (api.fetchStages); this constant
// is the offline/presentation fallback. `id` aliases `number` so both
// historical call styles work.
// ============================================================

/** @type {Array<{ number: number, id: number, name: string, color: string }>} */
export const DOS_STAGES = [
  { number: 1, id: 1, name: 'Pre-Sales Engagement',       color: '#6b7280' },
  { number: 2, id: 2, name: 'Deal Qualification',         color: '#2563eb' },
  { number: 3, id: 3, name: 'Kick-Off & Solution Design', color: '#7c3aed' },
  { number: 4, id: 4, name: 'Operations Review',          color: '#d97706' },
  { number: 5, id: 5, name: 'Executive Review',           color: '#ea580c' },
  { number: 6, id: 6, name: 'Delivery Handover',          color: '#16a34a' },
];

// ============================================================
// S2 (2026-07-22, Brock ruling: DM adopts ★ models' CM knobs) —
// per-site escalation extracted from a cost_model_projects row.
// ============================================================

/** Typical 3PL warehouse cost composition — blend weights for collapsing
 *  the CM's four category escalators into DM's single rev/cost pair.
 *  Heuristic (labor-dominant ops); revisit if composition data lands on
 *  the row someday. */
export const ESC_BLEND_WEIGHTS = { labor: 0.55, cost: 0.15, facility: 0.20, equipment: 0.10 };

/**
 * Best-effort per-site escalation pair from a cost_model_projects row.
 * Mirrors resolveCalcHeuristics' resting precedence per category:
 * heuristic_overrides[snake] → project_data.financial.<camel legacy> → 3.
 * (Transient/snapshot layers are CM-session concepts — a row read here is
 * by definition at rest.) The four category knobs blend into one rate via
 * ESC_BLEND_WEIGHTS, applied to BOTH revenue and cost — matching CM
 * cost-plus semantics where price tracks escalated cost at constant
 * margin. Returns null when the row carries no signal at all (caller
 * falls back to the deal-level default pair → zero-diff).
 *
 * @param {Object} row — cost_model_projects row (needs heuristic_overrides
 *        and/or project_data; both optional)
 * @returns {{revenue: number, cost: number}|null}
 */
export function siteEscalationFromRow(row) {
  const o = row?.heuristic_overrides || {};
  const f = row?.project_data?.financial || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const knob = (snake, ...legacy) => {
    const ov = num(o[snake]);
    if (ov !== null) return ov;
    for (const k of legacy) { const lv = num(f[k]); if (lv !== null) return lv; }
    return null;
  };
  const cats = {
    labor:     knob('labor_escalation_pct', 'laborEscalation'),
    cost:      knob('cost_escalation_pct', 'costEscalation', 'annualEscalation'),
    facility:  knob('facility_escalation_pct', 'facilityEscalation'),
    equipment: knob('equipment_escalation_pct', 'equipmentEscalation'),
  };
  if (Object.values(cats).every(v => v === null)) return null;
  let blended = 0;
  for (const [k, w] of Object.entries(ESC_BLEND_WEIGHTS)) {
    blended += (cats[k] ?? DEFAULT_ESCALATION_PCT) * w;
  }
  blended = Number(blended.toFixed(2));
  return { revenue: blended, cost: blended };
}

// ============================================================
// SITE-LEVEL FINANCIALS
// ============================================================

/**
 * Compute per-site financials.
 * @param {import('./types.js?v=20260418-sL').Site} site
 * @returns {import('./types.js?v=20260418-sL').SiteFinancials}
 */
export function computeSiteFinancials(site) {
  const annualCost = site.annualCost || 0;
  const marginPct = site.targetMarginPct || 0;
  const pricingModel = site.pricingModel || 'cost-plus';
  const markup = DEFAULT_PRICING_MARKUPS[pricingModel];
  const annualVolume = Number(site.annualVolume || 0);
  // MUL-C2: per-volume rate (override). When site has a perVolumeRate set,
  // use it × annualVolume as the revenue basis; otherwise fall back to
  // model-specific defaults below.
  const ratePerVolume = Number(site.perVolumeRate || 0);

  let annualRevenue;
  // CM-authoritative pricing (2026-07-04, D1 vocab decision): when the CM
  // engine has stamped a real revenue on this model (site.annualRevenue,
  // from cost_model_projects.total_annual_revenue), it IS the price — the
  // pricing_model markup heuristic below only labels never-engine-saved
  // rows, and callers surface revenueSource so the UI can badge estimates.
  const cmRevenue = Number(site.annualRevenue || 0);
  if (cmRevenue > 0) {
    annualRevenue = cmRevenue;
  } else if (ratePerVolume > 0 && annualVolume > 0) {
    // Volume-based revenue (units × rate). Margin emerges; doesn't drive price.
    annualRevenue = ratePerVolume * annualVolume;
  } else if (pricingModel === 'cost-plus' || pricingModel === 'fixed-fee') {
    // Standard cost-plus: price = cost / (1 - margin). For fixed-fee we use
    // the same target-margin pricing but cap at a fixed annual figure.
    annualRevenue = marginPct > 0 ? annualCost / (1 - marginPct / 100) : annualCost;
  } else if (markup != null) {
    // Transactional / cost-pass-through / hybrid: rev = cost × (1 + markup)
    annualRevenue = annualCost * (1 + markup);
  } else {
    annualRevenue = annualCost;
  }

  const grossMarginPct = annualRevenue > 0 ? ((annualRevenue - annualCost) / annualRevenue) * 100 : 0;
  const costPerSqft = site.sqft > 0 ? annualCost / site.sqft : 0;
  const costPerVolume = annualVolume > 0 ? annualCost / annualVolume : 0;
  const revenuePerVolume = annualVolume > 0 ? annualRevenue / annualVolume : 0;

  return {
    siteId: site.id,
    siteName: site.name,
    annualCost,
    annualRevenue,
    grossMarginPct,
    costPerSqft,
    pricingModel,
    annualVolume,
    costPerVolume,
    revenuePerVolume,
    // 'cm' = engine-stamped revenue (authoritative) · 'estimate' = markup
    // heuristic fallback for models never saved through the CM engine.
    revenueSource: cmRevenue > 0 ? 'cm' : 'estimate',
  };
}

// ============================================================
// DEAL-LEVEL AGGREGATE FINANCIALS
// ============================================================

/**
 * Compute deal-level aggregate financials from sites.
 * @param {import('./types.js?v=20260418-sL').Site[]} sites
 * @param {number} [contractTermYears]
 * @returns {import('./types.js?v=20260418-sL').DealFinancials}
 */
export function computeDealFinancials(sites, contractTermYears = DEFAULT_CONTRACT_YEARS, opts = {}) {
  if (sites.length === 0) {
    return emptyFinancials();
  }

  // MUL-D3 + MUL-D4 — overhead and discount-rate are now caller-tunable.
  const ebitdaOverheadPct = Number(opts.ebitdaOverheadPct ?? EBITDA_OVERHEAD_PCT);
  const discountRate = Number(opts.discountRate ?? DISCOUNT_RATE);

  const bySite = sites.map(s => computeSiteFinancials(s));
  const totalAnnualCost = bySite.reduce((s, sf) => s + sf.annualCost, 0);
  const totalAnnualRevenue = bySite.reduce((s, sf) => s + sf.annualRevenue, 0);
  const grossMarginPct = totalAnnualRevenue > 0
    ? ((totalAnnualRevenue - totalAnnualCost) / totalAnnualRevenue) * 100
    : 0;
  const ebitdaPct = grossMarginPct - ebitdaOverheadPct;
  const totalStartupCost = sites.reduce((s, site) => s + (site.startupCost || 0), 0);
  const totalSqft = sites.reduce((s, site) => s + (site.sqft || 0), 0);
  const totalAnnualVolume = sites.reduce((s, site) => s + Number(site.annualVolume || 0), 0);

  const annualGrossProfit = totalAnnualRevenue - totalAnnualCost;
  const annualEbitda = totalAnnualRevenue * (ebitdaPct / 100);

  // 2026-06-10 (ground-up assessment DM #10): headline NPV/IRR/payback
  // previously discounted a FLAT Y1 EBITDA for every year while the
  // Multi-Year P&L on the same screen modeled margin compression from
  // independent revenue/cost escalators (MUL-D1) — on a 5-year deal with
  // 2.5% rev / 4.5% cost the NPV card and the cumulative-cash-flow column
  // disagreed. The metrics now run on the SAME escalated EBITDA series the
  // P&L shows (opts.escalation { revenue, cost } %, default 3/3 — matching
  // the UI's dealConfig defaults).
  const escRev = Number(opts.escalation?.revenue ?? DEFAULT_ESCALATION_PCT);
  const escCost = Number(opts.escalation?.cost ?? DEFAULT_ESCALATION_PCT);
  // S2 (2026-07-22, Brock ruling): per-site escalation. When a site carries
  // its ★ model's CM-derived pair (site.escalation, or opts.escalationBySite
  // keyed by site id), that site's series compounds at ITS rates; sites
  // without a pair use the deal-level escRev/escCost above. With no per-site
  // pairs anywhere this reduces EXACTLY to the old aggregate math
  // (Σ·(1+r)^n === Σ(each·(1+r)^n) for a uniform r) — zero-diff.
  const escBySite = opts.escalationBySite || null;
  const perSite = sites.map((site, i) => {
    const pair = site.escalation || (escBySite && (escBySite[site.id] ?? escBySite[String(site.id)])) || null;
    return {
      rev0: bySite[i].annualRevenue,
      cost0: bySite[i].annualCost,
      escRev: Number(pair?.revenue ?? escRev),
      escCost: Number(pair?.cost ?? escCost),
    };
  });
  const escInEffect = perSite.some(p => p.escRev !== escRev || p.escCost !== escCost);
  const ebitdaSeries = [];
  for (let yr = 1; yr <= contractTermYears; yr++) {
    let rev = 0, cost = 0;
    for (const p of perSite) {
      rev += p.rev0 * Math.pow(1 + p.escRev / 100, yr - 1);
      cost += p.cost0 * Math.pow(1 + p.escCost / 100, yr - 1);
    }
    const gmPct = rev > 0 ? ((rev - cost) / rev) * 100 : 0;
    ebitdaSeries.push(rev * ((gmPct - ebitdaOverheadPct) / 100));
  }
  const npv = computeNpvFromSeries(totalStartupCost, ebitdaSeries, discountRate);
  const paybackMonths = computePaybackMonthsFromSeries(totalStartupCost, ebitdaSeries);
  const irr = computeIrrFromSeries(totalStartupCost, ebitdaSeries);

  return {
    totalAnnualCost,
    totalAnnualRevenue,
    grossMarginPct,
    ebitdaPct,
    ebitdaOverheadPct,
    discountRate,
    totalStartupCost,
    npv,
    paybackMonths,
    irr,
    totalSqft,
    totalAnnualVolume,
    costPerSqft: totalSqft > 0 ? totalAnnualCost / totalSqft : 0,
    revenuePerSqft: totalSqft > 0 ? totalAnnualRevenue / totalSqft : 0,
    costPerVolume: totalAnnualVolume > 0 ? totalAnnualCost / totalAnnualVolume : 0,
    revenuePerVolume: totalAnnualVolume > 0 ? totalAnnualRevenue / totalAnnualVolume : 0,
    // S2: true when at least one site escalated at its own CM-derived pair
    // (UI badges the escalation basis).
    perSiteEscalation: escInEffect,
    bySite,
  };
}

/**
 * @returns {import('./types.js?v=20260418-sL').DealFinancials}
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
export function computeNpvFromSeries(startup, flows, rate = DISCOUNT_RATE) {
  let npv = -(Number(startup) || 0);
  (flows || []).forEach((cf, i) => { npv += (Number(cf) || 0) / Math.pow(1 + rate, i + 1); });
  return npv;
}

/** Payback in months walking a non-flat series (linear within the breakeven year). */
export function computePaybackMonthsFromSeries(startup, flows) {
  let remaining = Number(startup) || 0;
  if (remaining <= 0) return 0;
  for (let i = 0; i < (flows || []).length; i++) {
    const cf = Number(flows[i]) || 0;
    if (cf <= 0) continue;
    if (cf >= remaining) return (i + remaining / cf) * 12;
    remaining -= cf;
  }
  return Infinity;
}

/** IRR via Newton's method over an arbitrary series. */
export function computeIrrFromSeries(startup, flows) {
  const s0 = Number(startup) || 0;
  const fl = (flows || []).map(Number);
  if (s0 <= 0 || !fl.some(v => v > 0)) return 0;
  let rate = 0.10;
  for (let iter = 0; iter < 100; iter++) {
    let npv = -s0, deriv = 0;
    fl.forEach((cf, i) => {
      const t = i + 1;
      const disc = Math.pow(1 + rate, t);
      npv += cf / disc;
      deriv -= t * cf / (disc * (1 + rate));
    });
    if (Math.abs(npv) < 1e-7) break;
    if (deriv === 0) break;
    const next = rate - npv / deriv;
    if (!Number.isFinite(next) || next <= -0.99) break;
    if (Math.abs(next - rate) < 1e-9) { rate = next; break; }
    rate = next;
  }
  return Math.max(-0.99, rate);
}

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
 * @param {import('./types.js?v=20260418-sL').DealFinancials} fin
 * @param {number} [years]
 * @param {number} [escalationPct]
 * @returns {import('./types.js?v=20260418-sL').MultiYearRow[]}
 */
export function generateMultiYearPL(fin, years = DEFAULT_CONTRACT_YEARS, escalation = DEFAULT_ESCALATION_PCT) {
  const rows = [];
  let cumCashFlow = -(fin.totalStartupCost || 0);

  // MUL-D1 — accept either a scalar (legacy) or an object
  // { revenue, cost } so revenue and cost can escalate independently.
  // Common pattern: revenue capped at 2.5%/yr CPI escalator while cost
  // tracks 4-5% labor index.
  const escRev = typeof escalation === 'object'
    ? Number(escalation.revenue ?? DEFAULT_ESCALATION_PCT)
    : Number(escalation);
  const escCost = typeof escalation === 'object'
    ? Number(escalation.cost ?? DEFAULT_ESCALATION_PCT)
    : Number(escalation);

  for (let yr = 1; yr <= years; yr++) {
    const revFactor = Math.pow(1 + escRev / 100, yr - 1);
    const costFactor = Math.pow(1 + escCost / 100, yr - 1);
    const revenue = fin.totalAnnualRevenue * revFactor;
    const cost = fin.totalAnnualCost * costFactor;
    const grossProfit = revenue - cost;
    // EBITDA% drifts as margins compress when cost escalates faster
    const annualGm = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;
    const overhead = Number(fin.ebitdaOverheadPct ?? EBITDA_OVERHEAD_PCT);
    const annualEbitdaPct = annualGm - overhead;
    const ebitda = revenue * (annualEbitdaPct / 100);
    cumCashFlow += ebitda;

    rows.push({
      year: yr, revenue, cost, grossProfit, ebitda, cumulativeCashFlow: cumCashFlow,
      grossMarginPct: annualGm,
      ebitdaPct: annualEbitdaPct,
      revenueEscPct: escRev,
      costEscPct: escCost,
    });
  }

  return rows;
}

// ============================================================
// DOS STAGE PROGRESS
// ============================================================

/**
 * Compute progress across DOS stages.
 * @param {import('./types.js?v=20260418-sL').DosStage[]} stages
 * @returns {import('./types.js?v=20260418-sL').StageProgress[]}
 */
/**
 * Canonical deal_dos_status.element_id key — MUST match the hub
 * deal-management tool, which writes rows as `t<stageNumber>-<templateRowId>`
 * (see hub/deal-management/api.js fetchActivityTemplates).
 * @param {number} stageNumber
 * @param {number|string} elementTemplateId
 */
export function dosStatusKey(stageNumber, elementTemplateId) {
  return `t${stageNumber}-${elementTemplateId}`;
}

/**
 * Normalize a persisted DOS status (hub vocabulary, hyphenated) into the
 * Multi-Site Analyzer's internal vocabulary (underscored). Unknown / missing
 * values are not_started — an empty deal_dos_status table must read as 0%.
 * @param {string|null|undefined} raw
 * @returns {'complete'|'in_progress'|'blocked'|'not_started'}
 */
export function normalizeDosStatus(raw) {
  if (raw === 'complete') return 'complete';
  if (raw === 'in-progress' || raw === 'in_progress') return 'in_progress';
  if (raw === 'blocked') return 'blocked';
  return 'not_started';
}

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
 * @param {import('./types.js?v=20260418-sL').StageProgress[]} progress
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
 * @param {import('./types.js?v=20260418-sL').DealFinancials} fin
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
 * @param {import('./types.js?v=20260418-sL').DealFinancials} fin
 * @returns {{ score: number, grade: 'A' | 'B' | 'C' | 'D' | 'F' }}
 */
export function computeDealScore(fin, opts = {}) {
  // Normalize each metric to 0-100
  const marginScore = clamp(fin.grossMarginPct / 15 * 100, 0, 100);
  const ebitdaScore = clamp(fin.ebitdaPct / 10 * 100, 0, 100);
  // S2 (2026-07-22, surfaced by wiring the score live): paybackMonths === 0
  // is AMBIGUOUS — "no startup capital at risk" (best case) vs "never pays
  // back" (worst). Disambiguate on totalStartupCost: zero-startup deals get
  // full marks; startup that the EBITDA series never recovers stays 0.
  const paybackScore = fin.paybackMonths > 0
    ? clamp((36 - fin.paybackMonths) / 36 * 100, 0, 100)
    : ((fin.totalStartupCost || 0) <= 0 ? 100 : 0);
  const npvScore = fin.npv > 0 ? clamp(100, 0, 100) : clamp(50 + (fin.npv / 100000) * 50, 0, 100);

  // MUL-A2 — weights configurable (sums to 1.0 normalized).
  const w = { ...DEFAULT_SCORE_WEIGHTS, ...(opts.weights || {}) };
  const wSum = (w.margin || 0) + (w.ebitda || 0) + (w.payback || 0) + (w.npv || 0);
  const norm = wSum > 0 ? wSum : 1;

  const score = Math.round(
    (marginScore * (w.margin || 0)
     + ebitdaScore * (w.ebitda || 0)
     + paybackScore * (w.payback || 0)
     + npvScore * (w.npv || 0)) / norm
  );

  // MUL-A3 — grade thresholds configurable.
  const th = { ...DEFAULT_GRADE_THRESHOLDS, ...(opts.gradeThresholds || {}) };
  const grade = score >= th.A ? 'A'
    : score >= th.B ? 'B'
    : score >= th.C ? 'C'
    : score >= th.D ? 'D'
    : 'F';

  return { score, grade, weights: w, thresholds: th, components: { marginScore, ebitdaScore, paybackScore, npvScore } };
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ============================================================
// SITE COMPARISON
// ============================================================

/**
 * Rank sites by cost efficiency.
 * @param {import('./types.js?v=20260418-sL').SiteFinancials[]} siteFins
 * @returns {Array<import('./types.js?v=20260418-sL').SiteFinancials & { rank: number }>}
 */
export function rankSitesByCost(siteFins) {
  const sorted = [...siteFins].sort((a, b) => a.costPerSqft - b.costPerSqft);
  return sorted.map((sf, i) => ({ ...sf, rank: i + 1 }));
}

// ============================================================
// MUL-G3 — SENSITIVITY GRID
// ============================================================

/**
 * Two-axis sensitivity grid over deal-level financials.
 * Sweeps a chosen X-axis (cost%, margin%, escalation%, volume%) against
 * a Y-axis, recomputes the deal at each cell, and returns score + npv +
 * ebitda% for visualization.
 *
 * @param {import('./types.js?v=20260418-sL').Site[]} sites
 * @param {{years:number, opts:object, xAxis:string, xRange:number[], yAxis:string, yRange:number[]}} cfg
 */
/** r4 walk fix (2026-07-10): since CM-authoritative pricing (2026-07-04),
 *  sites with a CM-stamped annualRevenue ignore targetMarginPct — so the
 *  sensitivity grid's margin-pts axis was a silent no-op for exactly the
 *  linked scenarios that matter (all 5 grid rows rendered identical).
 *  For CM-priced sites, translate a pts shift into an adjusted revenue
 *  (rev' = cost / (1 - (currentMargin + delta))); non-CM sites keep the
 *  original targetMarginPct shift. What-if only — base cell (0,0) unchanged. */
function _shiftMarginPts(s, delta) {
  if (!delta) return;
  const rev = Number(s.annualRevenue || 0);
  const cost = Number(s.annualCost || 0);
  if (rev > 0 && cost > 0) {
    const cur = ((rev - cost) / rev) * 100;
    const tgt = Math.min(95, cur + delta);
    if (tgt < 100) s.annualRevenue = cost / (1 - tgt / 100);
  } else {
    s.targetMarginPct = (s.targetMarginPct || 0) + delta;
  }
}

export function calcDealSensitivity(sites, cfg) {
  const { years = DEFAULT_CONTRACT_YEARS, opts = {}, xAxis = 'costPct', xRange = [-10, -5, 0, 5, 10], yAxis = 'marginPct', yRange = [-3, -1.5, 0, 1.5, 3] } = cfg || {};
  const apply = (axis, delta) => {
    const out = sites.map(s => ({ ...s }));
    if (axis === 'costPct') out.forEach(s => { s.annualCost = (s.annualCost || 0) * (1 + delta / 100); });
    else if (axis === 'marginPct') out.forEach(s => { _shiftMarginPts(s, delta); });
    else if (axis === 'volumePct') out.forEach(s => { s.annualVolume = (s.annualVolume || 0) * (1 + delta / 100); s.annualCost = (s.annualCost || 0) * (1 + delta / 100); });
    else if (axis === 'startupPct') out.forEach(s => { s.startupCost = (s.startupCost || 0) * (1 + delta / 100); });
    return out;
  };
  const grid = yRange.map(y => xRange.map(x => {
    const sites2 = apply(yAxis, y);
    if (xAxis === 'costPct') sites2.forEach(s => { s.annualCost = (s.annualCost || 0) * (1 + x / 100); });
    else if (xAxis === 'marginPct') sites2.forEach(s => { _shiftMarginPts(s, x); });
    else if (xAxis === 'volumePct') sites2.forEach(s => { s.annualVolume = (s.annualVolume || 0) * (1 + x / 100); s.annualCost = (s.annualCost || 0) * (1 + x / 100); });
    else if (xAxis === 'startupPct') sites2.forEach(s => { s.startupCost = (s.startupCost || 0) * (1 + x / 100); });
    const fin = computeDealFinancials(sites2, years, opts);
    const sc = computeDealScore(fin, opts);
    return {
      x, y,
      score: sc.score,
      grade: sc.grade,
      ebitdaPct: fin.ebitdaPct,
      npv: fin.npv,
      paybackMonths: fin.paybackMonths,
    };
  }));
  return { xAxis, yAxis, xRange, yRange, grid };
}

/**
 * MUL-G1 — Combine two deals into a single roll-up scenario. Used by
 * drag-to-combine in the UI. Returns a synthetic "combined" deal whose
 * sites are the concatenation, with optional cross-deal cannibalization
 * percentage on revenue (to model overlap between the two books).
 *
 * @param {{sites:any[], dealName:string}} dealA
 * @param {{sites:any[], dealName:string}} dealB
 * @param {{cannibalizationPct?:number, contractTermYears?:number, opts?:object}} cfg
 */
export function combineDeals(dealA, dealB, cfg = {}) {
  const cann = Number(cfg.cannibalizationPct ?? 0);
  const sites = [...(dealA.sites || []), ...(dealB.sites || [])].map(s => ({ ...s }));
  if (cann > 0) {
    sites.forEach(s => { s.annualCost = (s.annualCost || 0) * (1 - cann / 100); });
  }
  const fin = computeDealFinancials(sites, cfg.contractTermYears || DEFAULT_CONTRACT_YEARS, cfg.opts || {});
  const score = computeDealScore(fin, cfg.opts || {});
  return {
    dealName: `${dealA.dealName || 'Deal A'} + ${dealB.dealName || 'Deal B'}`,
    sites,
    financials: fin,
    score,
    cannibalizationPct: cann,
  };
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260418-sL').Deal} */
export const DEMO_DEAL = {
  dealName: 'Midwest Regional Expansion',
  clientName: 'Acme Corp',
  dealOwner: 'Sarah Chen',
  status: 'in_progress',
  contractTermYears: 5,
  notes: 'Multi-site expansion with 3 DCs across the Midwest corridor.',
};

/** @type {import('./types.js?v=20260418-sL').Site[]} */
export const DEMO_SITES = [
  { id: 's1', name: 'Chicago DC', market: 'Midwest', environment: 'Ambient', sqft: 350000, annualCost: 4200000, targetMarginPct: 16, startupCost: 600000, pricingModel: 'cost-plus', annualVolume: 2400000 },
  { id: 's2', name: 'Indianapolis DC', market: 'Midwest', environment: 'Ambient', sqft: 250000, annualCost: 2800000, targetMarginPct: 15, startupCost: 350000, pricingModel: 'cost-plus', annualVolume: 1600000 },
  { id: 's3', name: 'Columbus DC', market: 'Midwest', environment: 'Cold Chain', sqft: 180000, annualCost: 3100000, targetMarginPct: 18, startupCost: 700000, pricingModel: 'transactional', annualVolume: 1200000 },
];

// ============================================================
// FORMATTING
// ============================================================

// Display formatting — delegated to shared/format.js (S16, was duplicated
// across 4 tool calc.js files; consolidated 2026-05-11).
export { formatCurrency, formatPct, formatMonths } from '../../shared/format.js';


/** @param {string} status @returns {{ label: string, color: string, bg: string }} */
export function statusBadge(status) {
  const badges = {
    draft: { label: 'Draft', color: '#6b7280', bg: '#f3f4f6' },
    in_progress: { label: 'In Progress', color: 'var(--ies-blue)', bg: '#dbeafe' },
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
 * @param {import('./types.js?v=20260418-sL').HoursEntry[]} hours
 * @returns {import('./types.js?v=20260418-sL').HoursSummary}
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
 * @param {import('./types.js?v=20260418-sL').Task[]} tasks
 * @returns {import('./types.js?v=20260418-sL').TaskSummary}
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

// ============================================================
// runScenario — calc-as-service wrapper (port-readiness S8)
// ============================================================
//
// Standardized entry point for external callers (HTTP / MCP / AI agents).
// Aggregates site-level financials into a deal roll-up.
export const ENGINE_VERSION = '1.0.0';

/**
 * Run a Multi-Site Analyzer scenario.
 * @param {{
 *   sites: import('./types.js?v=20260418-sL').Site[],
 *   contractTermYears?: number,
 *   ebitdaOverheadPct?: number,
 *   discountRate?: number,
 * }} params
 * @returns {{ ok: boolean, version: string, result: any, errors: string[] }}
 */
export function runScenario(params) {
  if (params == null || typeof params !== 'object') params = {};
  const errors = [];
  if (!Array.isArray(params.sites)) errors.push('sites must be an array');
  if (errors.length) return { ok: false, version: ENGINE_VERSION, result: null, errors };
  const result = computeDealFinancials(
    params.sites,
    params.contractTermYears || DEFAULT_CONTRACT_YEARS,
    {
      ebitdaOverheadPct: params.ebitdaOverheadPct,
      discountRate: params.discountRate,
    }
  );
  return { ok: true, version: ENGINE_VERSION, result, errors: [] };
}

// ============================================================
// P2-a (2026-07-23): BID-OF-RECORD SNAPSHOT PAYLOAD
// ============================================================
// "Mark as submitted" stamps an IMMUTABLE deal_bid_snapshots row. This is
// the ONE pure builder for that row's fields + payload jsonb. Deterministic
// given inputs — timestamps (submitted_at/submitted_by) come from DB
// defaults, never Date.now(). No I/O, no DOM.

/** Payload schema version — bump on any breaking payload-shape change. */
export const BID_SNAPSHOT_SCHEMA_VERSION = 1;

const _snapNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const _snapR2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const _snapR1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/**
 * Build the bid-of-record snapshot for a deal at submit time.
 *
 * Param shapes match what the Package tab already holds (see ui.js
 * _bidManifestFor / listRealDeals' deal shape):
 *
 * @param {{
 *   deal?:     {id?:string, name?:string, client?:string, revenue?:number,
 *               margin?:number, score?:string, scoreNum?:number|null,
 *               sites?:Array<object>, models?:Array<object>}|null,
 *   manifest?: ReturnType<import('../../hub/deal-management/calc.js?v=20260722-s3d').computeBidManifest>|null,
 *   rollup?:   ReturnType<import('../../hub/deal-management/calc.js?v=20260722-s3d').computeStarRollup>|null,
 *   bidMeta?:  {exec_summary?:string, submission_due?:string|null, manual_checks?:object}|null,
 *   sites?:    Array<{id:string|number, name?:string, status?:string,
 *               inBidModelId?:string|number|null, sqft?:number}>|null,
 *   models?:   Array<{id:string|number, name?:string, scenario_label?:string,
 *               total_annual_revenue?:number|string|null,
 *               total_annual_cost?:number|string|null,
 *               target_margin_pct?:number|string|null,
 *               facility_sqft?:number|string|null}>|null,
 *   strategy?: {value_prop?:string|null}|null,
 * }} input — every key optional; sites/models fall back to deal.sites/deal.models
 * @returns {{manifest_pct:number|null, y1_revenue:number|null, y1_cost:number|null,
 *           y1_margin_pct:number|null, payload:object}}
 */
export function buildBidSnapshotPayload({ deal, manifest, rollup, bidMeta, sites, models, strategy } = {}) {
  const siteList = Array.isArray(sites) ? sites : (Array.isArray(deal?.sites) ? deal.sites : []);
  const modelList = Array.isArray(models) ? models : (Array.isArray(deal?.models) ? deal.models : []);
  const modelById = new Map(modelList.filter(Boolean).map(m => [String(m.id), m]));
  const fallbackMargin = _snapNum(rollup?.margin) ?? _snapNum(deal?.margin) ?? 0;

  // ── Per-site rows — ALL sites go on record (dropped ones keep status) ──
  const siteRows = siteList.map((s, i) => {
    const star = s?.inBidModelId != null ? (modelById.get(String(s.inBidModelId)) || null) : null;
    const rev = star ? modelRevenueEst(star, fallbackMargin) : null;
    const cost = star ? (_snapNum(star.total_annual_cost) ?? 0) : null;
    const margin = rev != null && rev > 0 ? _snapR1(((rev - cost) / rev) * 100) : null;
    return {
      site_id: s?.id ?? null,
      name: (typeof s?.name === 'string' && s.name.trim()) ? s.name.trim() : `Site ${i + 1}`,
      status: s?.status || 'proposed',
      star_model_id: s?.inBidModelId ?? null,
      star_model_name: star ? (star.name || null) : null,
      star_scenario_label: star ? (star.scenario_label || null) : null,
      y1_revenue: _snapR2(rev),
      y1_cost: _snapR2(cost),
      y1_margin_pct: margin,
      sqft: _snapNum(s?.sqft) ?? _snapNum(star?.facility_sqft) ?? 0,
      // Same precedence as computeStarRollup / computeBidManifest: an
      // engine-stamped total_annual_revenue > 0 is CM-authoritative.
      revenue_source: star ? (Number(star.total_annual_revenue) > 0 ? 'cm-engine' : 'estimate') : null,
    };
  });

  // ── Σ★ totals — same basis as computeStarRollup (every ★'d site whose
  //    model resolves, regardless of site status). Legacy heuristic totals
  //    pass through only when no ★ pair resolves.
  const starModels = siteList
    .filter(s => s?.inBidModelId != null)
    .map(s => modelById.get(String(s.inBidModelId)))
    .filter(Boolean);
  let y1Revenue = null, y1Cost = null, y1MarginPct = null;
  if (starModels.length) {
    let rev = 0, cost = 0;
    for (const m of starModels) {
      rev += modelRevenueEst(m, fallbackMargin);
      cost += _snapNum(m.total_annual_cost) ?? 0;
    }
    y1Revenue = _snapR2(rev);
    y1Cost = _snapR2(cost);
    y1MarginPct = rev > 0 ? _snapR1(((rev - cost) / rev) * 100) : null;
  } else {
    y1Revenue = _snapR2(_snapNum(rollup?.revenue) ?? _snapNum(deal?.revenue));
    y1MarginPct = _snapR1(_snapNum(rollup?.margin) ?? _snapNum(deal?.margin));
    y1Cost = (y1Revenue != null && y1MarginPct != null)
      ? _snapR2(y1Revenue * (1 - y1MarginPct / 100)) : null;
  }

  const grade = (typeof deal?.score === 'string' && /^[A-F]$/.test(deal.score)) ? deal.score : null;
  const scoreNum = _snapNum(deal?.scoreNum);
  const coverage = rollup?.bidCoverage || deal?.bidCoverage || {
    starred: siteList.filter(s => s?.inBidModelId != null).length,
    active: siteList.filter(s => s?.status !== 'dropped').length,
  };
  const checks = (bidMeta?.manual_checks && typeof bidMeta.manual_checks === 'object')
    ? bidMeta.manual_checks : {};
  const manifestItems = Array.isArray(manifest?.items)
    ? manifest.items.map(it => ({
        key: it.key, label: it.label, group: it.group,
        status: it.status, required: !!it.required, detail: it.detail,
      }))
    : [];

  const payload = {
    schema_version: BID_SNAPSHOT_SCHEMA_VERSION,
    deal: {
      id: deal?.id ?? null,
      name: deal?.name ?? null,
      client: deal?.client ?? null,
    },
    manifest: {
      pct: _snapNum(manifest?.pct) ?? 0,
      required_done: _snapNum(manifest?.requiredDone) ?? 0,
      required_total: _snapNum(manifest?.requiredTotal) ?? 0,
      due_date: manifest?.dueDate ?? bidMeta?.submission_due ?? null,
      items: manifestItems,
    },
    sites: siteRows,
    totals: {
      y1_revenue: y1Revenue,
      y1_cost: y1Cost,
      y1_margin_pct: y1MarginPct,
      rollup_from_stars: !!(rollup?.rollupFromStars ?? deal?.rollupFromStars),
      rollup_is_estimate: !!(rollup?.rollupIsEstimate ?? deal?.rollupIsEstimate),
      any_heuristic_star: !!(rollup?.anyHeuristicStar ?? deal?.anyHeuristicStar
        ?? siteRows.some(r => r.revenue_source === 'estimate')),
      bid_coverage: { starred: _snapNum(coverage.starred) ?? 0, active: _snapNum(coverage.active) ?? 0 },
      grade,
      score: scoreNum,
    },
    exec_summary: typeof bidMeta?.exec_summary === 'string' ? bidMeta.exec_summary : '',
    manual_checks: checks,
    strategy: strategy
      ? { value_prop: typeof strategy.value_prop === 'string' ? strategy.value_prop : null }
      : null,
  };

  return {
    manifest_pct: _snapNum(manifest?.pct) ?? 0,
    y1_revenue: y1Revenue,
    y1_cost: y1Cost,
    y1_margin_pct: y1MarginPct,
    payload,
  };
}

// ============================================================
// P2-1 (2026-07-03): SITE EDITING — FIELD MAP + DEFAULTS
// ============================================================
// Brock's build-it-out call on the 2026-07-02 assessment's P2-1: sites are
// cost_model_projects rows (deal_deals_id link), so "site editing" writes
// the headline CM columns. Pure mapper here so api/ui stay thin + testable.

/** Editable Site fields → cost_model_projects columns. */
export const SITE_TO_CM_COLUMNS = {
  name: 'name',
  market: 'client_name',
  environment: 'environment_type',
  sqft: 'facility_sqft',
  annualCost: 'total_annual_cost',
  targetMarginPct: 'target_margin_pct',
  startupCost: 'startup_cost',
  pricingModel: 'pricing_model',
  annualVolume: 'vol_pallets_received',
};

const SITE_NUMERIC_FIELDS = new Set(['sqft', 'annualCost', 'targetMarginPct', 'startupCost', 'annualVolume']);

/** Defaults for a DM-created skeleton site (the old in-memory ghost values,
 * now actually persisted + editable). */
export const NEW_SITE_DEFAULTS = {
  name: 'New Site',
  sqft: 200000,
  annualCost: 2000000,
  targetMarginPct: 10,
  startupCost: 0,
  pricingModel: 'cost-plus',
};

/**
 * Map a Site-field patch to cost_model_projects columns. Unknown keys are
 * dropped; numeric fields coerce ('' / junk → 0); strings pass through.
 * @param {Object} patch — partial Site
 * @returns {Object} column patch safe for db.insert/db.update
 */
export function siteToCmColumns(patch) {
  const out = {};
  for (const [field, col] of Object.entries(SITE_TO_CM_COLUMNS)) {
    if (!patch || patch[field] === undefined) continue;
    out[col] = SITE_NUMERIC_FIELDS.has(field)
      ? (Number(String(patch[field]).replace(/[,$\s]/g, '')) || 0)
      : patch[field];
  }
  return out;
}
