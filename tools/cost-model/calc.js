/**
 * IES Hub v3 — Cost Model Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 * Tested with Vitest in Node.js environment.
 *
 * Every formula that was duplicated across v2 (30+ inline calculations)
 * is now a single-source-of-truth function here.
 *
 * Phase 1 integration: buildYearlyProjections becomes a thin wrapper that
 * routes through tools/cost-model/calc.monthly.js when the per-call
 * `useMonthlyEngine` flag (or window-level COST_MODEL_MONTHLY_ENGINE) is
 * set. The legacy implementation stays in place as the default.
 *
 * @module tools/cost-model/calc
 */

import * as monthly from './calc.monthly.js?v=20260612-mix1';
import { permMixFracForLine, tempMarkupFracForLine, blendLoadedRate } from './calc.scenarios.js?v=20260612-mix1';
import { deriveFunctionForLine as _deriveFunctionForLine } from './shift-planner.js?v=20260430-hours-first';
import {
  getAnnualVolume as _getAnnualVolume,
  getAggregateDerived as _getAggregateDerived,
  getAggregateInbound as _getAggregateInbound,
  getOutboundChannels as _getOutboundChannels,
} from './calc.channels.js?v=20260429-vol13';

// ============================================================
// MARGIN / GROSS-UP
// ============================================================

/**
 * Reference-aligned cost-plus revenue gross-up.
 *
 *   Revenue = Cost / (1 − margin)
 *
 * This is the industry-standard 3PL pricing mechanic (McKinsey cleansheet,
 * RFP cost-plus responses, customer budget summary). Applied per line/category
 * throughout the model so the customer-facing pricing schedule displays each
 * revenue component built up from its own cost.
 *
 * **Architectural rule (supersedes the doc's M6):** revenue is DERIVED from
 * cost + target margin by default ("recommended pricing"). The analyst may
 * override any line's rate via bucket.rate, in which case achieved margin
 * diverges from target and the reframed M3 validator flags the gap. Overrides
 * are first-class — not helpers, not silent defaults.
 *
 * Guards marginPct into [0, 0.999] so a misconfigured 100% target doesn't
 * produce infinite revenue.
 *
 * @param {number} cost — the cost base (>= 0)
 * @param {number} marginPct — fraction, e.g. 0.16 for 16%
 * @returns {number} cost / (1 − marginPct)
 */
export function grossUp(cost, marginPct) {
  const m = Math.min(0.999, Math.max(0, Number(marginPct) || 0));
  return (Number(cost) || 0) / (1 - m);
}

/**
 * Reference Part I §4 stacked G&A → Mgmt Fee decomposition.
 *
 *   G&A component  = Cost × g / (1 − t)
 *   Mgmt component = Cost × m / (1 − t)
 *   Total revenue  = Cost + G&A + Mgmt = Cost / (1 − t)
 *
 * Where g = G&A margin fraction, m = Mgmt Fee margin fraction, and t = g + m.
 *
 * This is the stacked-layer form that matches the reference model's
 * Customer Budget Summary semantics: "G&A layered first on cost base,
 * Mgmt Fee layered on (cost + G&A), total ties to Cost / (1 − t)."
 *
 * Derivation: for the layered sum to reconcile with the one-shot gross-up,
 * (Cost + G&A) × (1 / (1 − m)) must equal Cost / (1 − t), which solves to
 * G&A = Cost × g / (1 − t) and Mgmt = (Cost + G&A) × m / (1 − m) =
 * Cost × m / (1 − t). Both components are positive for g, m > 0 and sum to
 * Cost × t / (1 − t) — the gross-up delta.
 *
 * (Note: the doc's Part I §4 formula as literally written produces a
 * negative G&A component and doesn't reconcile to Cost / (1 − t). This
 * function implements the algebraically-correct form that matches the
 * doc's stated layering semantics.)
 *
 * @param {Object} params
 * @param {number} params.cost — cost base for the line
 * @param {number} params.gaPct — G&A margin as fraction (e.g. 0.06)
 * @param {number} params.mgmtPct — Mgmt Fee margin as fraction (e.g. 0.10)
 * @returns {{ cost: number, gaComponent: number, mgmtComponent: number,
 *             totalRevenue: number, gaPct: number, mgmtPct: number, totalPct: number }}
 */
export function computeStackedRevenue({ cost, gaPct, mgmtPct }) {
  const c = Number(cost) || 0;
  const g = Math.min(0.999, Math.max(0, Number(gaPct) || 0));
  const m = Math.min(0.999, Math.max(0, Number(mgmtPct) || 0));
  const t = Math.min(0.999, g + m);
  if (t === 0) {
    return { cost: c, gaComponent: 0, mgmtComponent: 0, totalRevenue: c, gaPct: g, mgmtPct: m, totalPct: t };
  }
  const denom = 1 - t;
  const gaComponent   = c * g / denom;
  const mgmtComponent = c * m / denom;
  const totalRevenue  = c + gaComponent + mgmtComponent;
  return {
    cost: c,
    gaComponent,
    mgmtComponent,
    totalRevenue,
    gaPct: g, mgmtPct: m, totalPct: t,
  };
}

/**
 * Inverse of grossUp — computes achieved margin given revenue and cost.
 *
 *   achievedMargin = (revenue − cost) / revenue
 *
 * Used by the reframed M3 validator and the Override Variance panel to
 * compare against the project's target margin. When no overrides are present,
 * achievedMargin == target by construction (all rates are derived from target).
 * The validator only fires when at least one bucket override is present.
 *
 * @param {number} revenue
 * @param {number} cost
 * @returns {number} margin fraction in [−∞, 1). 0 if revenue <= 0.
 */
export function achievedMargin(revenue, cost) {
  const r = Number(revenue) || 0;
  if (r <= 0) return 0;
  return (r - (Number(cost) || 0)) / r;
}

// ============================================================
// OPERATING HOURS
// ============================================================

/**
 * Annual paid hours per FTE — the US full-time reference standard.
 *
 * Returns the CONSTANT `2080` regardless of `shifts` input. Per Brock
 * 2026-04-21: 8 × 5 × 52 = 2,080 IS the standard; every legitimate FT pattern
 * (including 4×10 compressed workweeks) sums to the same number. A 24/7
 * facility still schedules each FTE for 2,080 hrs/year — multiple FTEs rotate
 * to cover the calendar.
 *
 * Accepts `shifts` for signature compatibility with existing callers; the
 * argument is ignored. PTO and holidays are applied downstream as headcount
 * uplift / hours reduction (see `ptoHeadcountUplift` / `holidayUplift`), not
 * here.
 *
 * @param {import('./types.js?v=20260612-mix1').ShiftConfig} [shifts] — ignored
 * @returns {number} 2080
 */
export function operatingHours(shifts) {
  return 2080;
}

/** US FT paid-hours constant — exported so UI and tests can reference it directly. */
export const ANNUAL_PAID_HOURS_PER_FTE = 2080;

/**
 * Productive hours per FTE — for DISPLAY/REPORTING only. Defined as the
 * number of paid hours left after subtracting PTO hours and holiday hours
 * from the 2,080 standard:
 *
 *   productive = 2080 − (2080 × ptoPct) − (2080 × holidayPct)
 *              = 2080 × (1 − ptoPct − holidayPct)
 *
 * Direct Utilization (PF&D haircut) is NOT applied here. Per Build-Up Logic
 * doc §2.1/§5.2, direct utilization is a haircut on UPH (see `effectiveUPH`),
 * not on paid hours — the employee is still paid for the full 2,080; they
 * just deliver less measured work per hour. Brock 2026-04-21: "the logic used
 * to drive the two blue tiles is faulty. Right tile should be
 * [2080 − PTO hours − holiday hours]."
 *
 * @param {import('./types.js?v=20260612-mix1').ShiftConfig} [shifts] — ignored
 * @param {{ ptoPct?: number, holidayPct?: number }} [projectAssumptions]
 * @returns {number}
 */
export function productiveHoursPerFTE(shifts, projectAssumptions = {}) {
  const ptoPct = projectAssumptions.ptoPct ?? 0.05;
  const holidayPct = projectAssumptions.holidayPct ?? 0;
  const net = Math.max(0, 1 - ptoPct - holidayPct);
  return ANNUAL_PAID_HOURS_PER_FTE * net;
}

// ============================================================
// LABOR — BUILD-UP HELPERS (doc: Labor Build-Up Logic 2026-04-20)
// ============================================================

/**
 * Effective UPH after PF&D (Direct Utilization) haircut.
 *
 * The Build-Up Logic doc's single most important hours decision: the 85%
 * direct-utilization factor is applied to UPH, not to hours. Captures
 * personal allowance, fatigue, delay, paid breaks, start-of-shift ramp,
 * activity-switching overhead — time for which the employee is paid but
 * cannot be doing the measured work at full MOST-standard rate.
 *
 *   effective_uph = base_uph × direct_utilization × (productivity_pct / 100)
 *
 * When base_uph = 100 and direct_utilization = 0.85, effective = 85.
 * Callers then compute hours_required = volume / effective_uph, which yields
 * the ~15% more hours (and therefore FTEs, and therefore cost) that the
 * current code is systematically under-counting.
 *
 * The optional productivity_pct (default 100) is the MOST "% to standard"
 * knob already in the analysis grid — a separate axis from PF&D.
 *
 * @param {{ base_uph?: number }} line
 * @param {{ directUtilization?: number, productivity_pct?: number }} [opts]
 * @returns {number}
 */
export function effectiveUPH(line, opts = {}) {
  const baseUph = Number(line.base_uph) || 0;
  if (baseUph === 0) return 0;
  const util = opts.directUtilization ?? 0.85;
  const prod = (opts.productivity_pct ?? 100) / 100;
  return baseUph * util * prod;
}

/**
 * PTO headcount uplift: hire more people to cover the PTO gap so every shift
 * stays staffed. Formula: `rawFTEs / (1 - ptoPct)`. With 5% PTO, raw 100 FTEs
 * becomes 105.26 FTEs.
 *
 * Per doc: applies ONLY to permanent labor. Temp doesn't accrue PTO.
 *
 * @param {number} rawFTEs
 * @param {number} ptoPct — fraction (0.05, not 5)
 * @returns {number}
 */
export function ptoHeadcountUplift(rawFTEs, ptoPct) {
  const p = Math.max(0, Math.min(0.5, Number(ptoPct) || 0));
  if (p === 0) return rawFTEs;
  return rawFTEs / (1 - p);
}

/**
 * Holiday uplift/reduction. Two treatments:
 * - `'headcount_uplift'` (Option A): divide by (1 - holidayPct). Appropriate
 *   for 24/7 e-commerce where holidays need coverage.
 * - `'reduce_hours'` (Option B): return FTEs unchanged. The reduction instead
 *   manifests as fewer working-hours-per-FTE upstream (the caller subtracted
 *   holiday hours from hoursPerFte before computing rawFTEs). Appropriate for
 *   B2B ops that close on holidays.
 *
 * Default treatment is `'reduce_hours'` — aligned with most 3PL B2B deals.
 *
 * @param {number} rawFTEs
 * @param {number} holidayPct — fraction
 * @param {'reduce_hours'|'headcount_uplift'} [treatment]
 * @returns {number}
 */
export function holidayUplift(rawFTEs, holidayPct, treatment = 'reduce_hours') {
  if (treatment !== 'headcount_uplift') return rawFTEs;
  const p = Math.max(0, Math.min(0.5, Number(holidayPct) || 0));
  if (p === 0) return rawFTEs;
  return rawFTEs / (1 - p);
}

/**
 * Year-specific wage load lookup. `wageLoadByYear` is a 5-element array of
 * fractions (e.g. `[0.30, 0.3065, 0.3106, 0.3127, 0.3133]` per the doc's
 * reference schedule). Clamps year to array bounds so Y6+ uses the last
 * value. If `wageLoadByYear` is missing/empty, falls back to `fallback`.
 *
 * Per Brock 2026-04-20: this is the SINGLE consolidated wage load. The legacy
 * split of `burden_pct` + `benefit_load_pct` was double-dipping — both covered
 * the same bucket (payroll taxes + workers' comp + health + retirement +
 * benefits + sick days). Keep `burden_pct` as the canonical 30% input;
 * `benefit_load_pct` is ignored by the new calc path.
 *
 * @param {number[]|null|undefined} wageLoadByYear — fractions
 * @param {number} year — 1-based (1 = first operational year)
 * @param {number} [fallback]
 * @returns {number} fraction (e.g. 0.30 for 30%)
 */
export function wageLoadForYear(wageLoadByYear, year, fallback = 0.30) {
  if (!Array.isArray(wageLoadByYear) || wageLoadByYear.length === 0) return fallback;
  const y = Math.max(1, Number(year) || 1);
  const idx = Math.min(y - 1, wageLoadByYear.length - 1);
  const v = Number(wageLoadByYear[idx]);
  return (Number.isFinite(v) && v >= 0) ? v : fallback;
}

/**
 * Multiplicative escalation factor: `(1 + ratePct/100)^(year - 1)`. Year 1
 * returns 1.0 (no escalation). Negative rates are clamped to 0 (escalation
 * never reduces base; for a discount factor, callers should handle that
 * separately). Expects rate as a PERCENT (5, not 0.05) — matches the
 * shape of `ch.laborEscPct` / `ch.costEscPct` etc. in the Cost Model
 * heuristics object.
 *
 * Single source of truth for the `baseValue × (1 + rate)^(yr − 1)` pattern
 * that previously lived inline at 5 sites in cost-model/ui.js around
 * line 2063 (S13 relocation 2026-05-11).
 *
 * @param {number} ratePct — percent (5 = 5%, not 0.05)
 * @param {number} year — 1-based
 * @returns {number}
 */
export function escalationFactor(ratePct, year) {
  const r = Math.max(0, Number(ratePct) || 0) / 100;
  const y = Math.max(1, Number(year) || 1);
  return Math.pow(1 + r, y - 1);
}

/**
 * Cumulative escalation from base (additive form): `(1 + ratePct/100)^(year - 1) - 1`.
 * Year 1 returns 0 (no escalation yet). Useful for human-display strings like
 * "compounded 9.3% by Y4". Negative rates are clamped to 0.
 *
 * @param {number} ratePct — percent (5 = 5%, not 0.05)
 * @param {number} year — 1-based
 * @returns {number} fractional cumulative escalation (0.0926 for 3%/yr by Y4)
 */
export function cumulativeEscalation(ratePct, year) {
  return escalationFactor(ratePct, year) - 1;
}

/**
 * Compound wage escalation: `baseWage × (1 + escFrac)^(year - 1)`. Year 1
 * returns base (no escalation). Neg. escFrac is clamped to 0; escFrac is
 * expected as a FRACTION (0.03, not 3) — different from the new
 * `escalationFactor` helper which takes a percent. Kept as a fraction-shaped
 * convenience for the existing labor-line callers that already had the
 * fraction form.
 *
 * @param {number} baseWage
 * @param {number} year — 1-based
 * @param {number} wageEscFrac — fraction (0.03 = 3%)
 * @returns {number}
 */
export function escalatedWage(baseWage, year, wageEscFrac) {
  const w = Number(baseWage) || 0;
  const escPct = Math.max(0, Number(wageEscFrac) || 0) * 100;
  return w * escalationFactor(escPct, year);
}

/**
 * Sum of the 5 benefit-load percentage components on a LaborConfig.
 * Pure: takes the lc object, returns total percent. Used by the labor
 * editor's "benefits roll-up" KPI and by `defaultBurdenPct` auto-calc.
 *
 * Relocated from cost-model/ui.js → calc.js 2026-05-11 (S13) — pure
 * math, no DOM dependency, deserves to live with the engine.
 *
 * @param {{
 *   benefitLoadPayrollTaxesPct?: number,
 *   benefitLoadWorkersCompPct?: number,
 *   benefitLoadHealthWelfarePct?: number,
 *   benefitLoadRetirementPct?: number,
 *   benefitLoadOtherPct?: number,
 * } | null | undefined} lc
 * @returns {number} sum in percent (e.g. 28.5)
 */
export function benefitLoadTotal(lc) {
  if (!lc) return 0;
  return (
    (Number(lc.benefitLoadPayrollTaxesPct)  || 0) +
    (Number(lc.benefitLoadWorkersCompPct)   || 0) +
    (Number(lc.benefitLoadHealthWelfarePct) || 0) +
    (Number(lc.benefitLoadRetirementPct)    || 0) +
    (Number(lc.benefitLoadOtherPct)         || 0)
  );
}

/**
 * Shift-differential multiplier. `line.shift_2_hours_share` and
 * `line.shift_3_hours_share` are fractions of this line's hours on evening /
 * overnight shifts. Premiums are fractions (e.g. 0.10 = 10% uplift).
 *
 *   shiftMult = 1 + s2_share × s2_premium + s3_share × s3_premium
 *
 * When both shares are 0, returns 1.0 (no differential). Negative values and
 * values > 1 are clamped.
 *
 * @param {{ shift_2_hours_share?: number, shift_3_hours_share?: number }} line
 * @param {{ shift2Premium?: number, shift3Premium?: number }} [opts]
 * @returns {number}
 */
export function shiftDifferentialMult(line, opts = {}) {
  const s2share = clamp01(Number(line.shift_2_hours_share) || 0);
  const s3share = clamp01(Number(line.shift_3_hours_share) || 0);
  const s2prem = Math.max(0, Number(opts.shift2Premium) || 0);
  const s3prem = Math.max(0, Number(opts.shift3Premium) || 0);
  return 1 + s2share * s2prem + s3share * s3prem;
}

/** @param {number} v */
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * Resolve the canonical wage load for a labor line. Implements the
 * consolidation rule (Brock 2026-04-20):
 *
 *   Priority:
 *   1. If line has per-line `burden_pct` → use it (as fraction)
 *   2. Else fall back to `opts.wageLoadByYear[year-1]` via wageLoadForYear
 *   3. Else `opts.defaultWageLoadFrac` (0.30)
 *
 * `benefit_load_pct` is IGNORED — it was the double-dipping partner and
 * covers the same bucket as `burden_pct`. Callers should migrate to using
 * just one of them.
 *
 * Temp-agency lines return 0 — the agency markup on their rate is already
 * the full load; no additional wage load applies.
 *
 * @param {{ burden_pct?: number, employment_type?: string }} line
 * @param {number} year — 1-based
 * @param {{ wageLoadByYear?: number[], defaultWageLoadFrac?: number }} [opts]
 * @returns {number} fraction
 */
export function wageLoadFracForLine(line, year, opts = {}) {
  // Temp-agency: rate already includes agency markup; no separate wage load.
  if ((line.employment_type || 'permanent') === 'temp_agency') return 0;
  // Per-line override wins
  if (line.burden_pct != null) {
    const v = Number(line.burden_pct);
    if (Number.isFinite(v) && v >= 0) return v / 100;
  }
  // Year-schedule
  return wageLoadForYear(opts.wageLoadByYear, year, opts.defaultWageLoadFrac ?? (DEFAULT_WAGE_LOAD_PCT / 100));
}

// ============================================================
// LABOR — LINE-LEVEL CALCULATIONS
// ============================================================

/**
 * Phase 4a: effective hourly rate after employment-type multipliers.
 * For `temp_agency` lines, `temp_agency_markup_pct` uplifts the base rate
 * (e.g. 25 → 1.25×). For `permanent` and `contractor` the base rate is
 * returned unchanged. This is the single point all downstream labor-cost
 * functions (directLineAnnual, fullyLoadedRate, monthlyLaborCost, etc.)
 * flow through, so flipping employment_type automatically re-prices.
 *
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine | import('./types.js?v=20260612-mix1').IndirectLaborLine} line
 * @returns {number}
 */
export function effectiveHourlyRate(line) {
  const base = line.hourly_rate || 0;
  if ((line.employment_type || 'permanent') === 'temp_agency') {
    const markupFrac = (line.temp_agency_markup_pct || 0) / 100;
    return base * (1 + markupFrac);
  }
  return base;
}

/**
 * Fully loaded hourly rate: rate × (1 + wage_load%) + benefits_per_hour.
 *
 * wage_load is the SINGLE consolidated employer-side cost on top of base
 * wage (payroll taxes + workers comp + health + retirement + other
 * benefits). Per Brock 2026-04-20: `benefit_load_pct` used to be added on
 * top of `burden_pct` which was a double-count (same bucket). Now calc
 * uses only ONE source.
 *
 * `benefits_per_hour` is a distinct per-hour dollar line (rare, legacy) and
 * is kept additive — it's NOT the same as the % benefit load.
 *
 * For temp-agency lines, wage_load resolves to 0 (rate already loaded).
 *
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine | import('./types.js?v=20260612-mix1').IndirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.benefitLoadFallback] — default wage-load fraction if line has no burden_pct (legacy alias retained)
 * @param {number[]} [opts.wageLoadByYear]
 * @param {number} [opts.year]
 * @returns {number}
 */

/**
 * Phase 4e (2026-06-12): blended loaded rate for a line, honoring
 * retention_mix_pct (perm/temp split within a line). Resolves wage load
 * exactly as before, then blends via the shared calc.scenarios helpers.
 * opts: { year, wageLoadByYear, benefitLoadFallback, includeBenefits,
 *         marketTempPremiumPct, defaultTempMarkupPct, tempShareDeltaPp }
 */
function _blendedLoadedRate(line, opts = {}) {
  const wageLoadFrac = wageLoadFracForLine(line, opts.year ?? 1, {
    wageLoadByYear: opts.wageLoadByYear,
    defaultWageLoadFrac: opts.benefitLoadFallback ?? (DEFAULT_WAGE_LOAD_PCT / 100),
  });
  return blendLoadedRate({
    baseRate: Number(line.hourly_rate) || 0,
    wageLoadFrac,
    benefitsPerHr: opts.includeBenefits === false ? 0 : (Number(line.benefits_per_hour) || 0),
    mixFrac: permMixFracForLine(line, { tempShareDeltaPp: opts.tempShareDeltaPp }),
    tempMarkupFrac: tempMarkupFracForLine(line, {
      marketTempPremiumPct: opts.marketTempPremiumPct,
      defaultTempMarkupPct: opts.defaultTempMarkupPct,
    }),
  });
}

export function fullyLoadedRate(line, opts = {}) {
  // Phase 4e: routed through the retention blend. mix=100 (default) and
  // pure-temp lines reproduce the previous math exactly.
  return _blendedLoadedRate(line, opts);
}

/**
 * Annual cost for a direct labor line.
 * Includes shift differential, OT (for hourly-nonexempt only), and
 * year-specific wage load.
 *
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.otPct] — overtime % (0-based), applied at 1.5× rate
 * @param {number} [opts.benefitLoadFallback] — fallback wage-load fraction
 * @param {number[]} [opts.wageLoadByYear] — 5-year wage load schedule
 * @param {number} [opts.year] — 1-based year, default 1
 * @param {number} [opts.shift2Premium]
 * @param {number} [opts.shift3Premium]
 * @returns {number}
 */
export function directLineAnnual(line, opts = {}) {
  const hours = line.annual_hours || 0;
  // OT only applies to hourly-nonexempt lines. pay_type default 'hourly'.
  const otEligible = (line.pay_type || 'hourly') === 'hourly';
  const otMult = otEligible ? (1 + (opts.otPct || 0) * 0.5) : 1.0;
  // Shift differential pulls fraction fields OR legacy shift_num integer.
  const shiftMult = shiftDifferentialMultForLine(line, opts);
  // Phase 4e: retention blend (historically this path excluded
  // benefits_per_hour — preserved).
  const effectiveRate = _blendedLoadedRate(line, { ...opts, includeBenefits: false }) * otMult * shiftMult;
  return hours * effectiveRate;
}

/**
 * Resolve shift differential for a line. Prefers `shift_2_hours_share` /
 * `shift_3_hours_share` when present; falls back to integer `shift_num`
 * (1/2/3) which treats the whole line as 100% on that shift. If none
 * are set, multiplier is 1.0 (shift 1 / no differential).
 *
 * @param {{ shift_2_hours_share?: number, shift_3_hours_share?: number, shift_num?: number }} line
 * @param {{ shift2Premium?: number, shift3Premium?: number }} opts
 * @returns {number}
 */
function shiftDifferentialMultForLine(line, opts) {
  const hasShares = line.shift_2_hours_share != null || line.shift_3_hours_share != null;
  if (hasShares) return shiftDifferentialMult(line, opts);
  const n = Number(line.shift_num) || 1;
  if (n === 2) return 1 + (Number(opts.shift2Premium) || 0);
  if (n === 3) return 1 + (Number(opts.shift3Premium) || 0);
  return 1;
}

/**
 * Simplified direct labor annual cost — no shift/OT (for inline cell display).
 *
 * Formula: annual_hours × hourly_rate × (1 + wage_load_pct)
 *
 * Per Brock 2026-04-20: consolidated to a SINGLE wage load. The legacy
 * `benefitLoadPct` from `costing` is IGNORED — it was the double-dip
 * partner of `defaultBurdenPct`.
 *
 * Per-line burden_pct still wins when present (supports line-level
 * override for high-burden roles).
 *
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine} line
 * @param {{ defaultBurdenPct?: number, wageLoadByYear?: number[], year?: number }} [costing]
 * @returns {number}
 */
export function directLineAnnualSimple(line, costing) {
  const hours = line.annual_hours || 0;
  const c = costing || {};
  // Phase 4e: retention blend (no benefits_per_hour in the Simple path —
  // preserved).
  return hours * _blendedLoadedRate(line, {
    year: c.year ?? 1,
    wageLoadByYear: c.wageLoadByYear,
    benefitLoadFallback: (c.defaultBurdenPct ?? DEFAULT_WAGE_LOAD_PCT) / 100,
    includeBenefits: false,
    marketTempPremiumPct: c.marketTempPremiumPct,
    defaultTempMarkupPct: c.defaultTempMarkupPct,
    tempShareDeltaPp: c.tempShareDeltaPp,
  });
}

/**
 * Annual cost for an indirect labor line.
 *
 * Includes:
 * - Year-specific wage load via wageLoadFracForLine
 * - PTO headcount uplift (perm only)
 * - Bonus multiplier (applied to hourly AND salary now — doc §3.5 notes
 *   the old "hourly only" rule was inconsistent; salary bonuses are
 *   typically LARGER than hourly. Users can zero bonusPct for per-line
 *   exclusion.)
 * - Shift differential
 * - OT for hourly-nonexempt (salary exempt skipped)
 *
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine} line
 * @param {Object} opts
 * @param {number} opts.operatingHours — annual operating hours
 * @param {number} [opts.bonusPct]
 * @param {number} [opts.otPct]
 * @param {number} [opts.ptoPct] — default 0 (no uplift) for backward compat
 * @param {number} [opts.benefitLoadFallback]
 * @param {number[]} [opts.wageLoadByYear]
 * @param {number} [opts.year]
 * @param {number} [opts.shift2Premium]
 * @param {number} [opts.shift3Premium]
 * @returns {number}
 */
export function indirectLineAnnual(line, opts) {
  const hc = line.headcount || 0;
  const rate = effectiveHourlyRate(line);
  const year = opts.year ?? 1;
  const wageLoadFrac = wageLoadFracForLine(line, year, {
    wageLoadByYear: opts.wageLoadByYear,
    defaultWageLoadFrac: opts.benefitLoadFallback ?? (DEFAULT_WAGE_LOAD_PCT / 100),
  });
  const bonusMult = 1 + (opts.bonusPct || 0);
  const otEligible = (line.pay_type || 'hourly') === 'hourly';
  const otMult = otEligible ? (1 + (opts.otPct || 0) * 0.5) : 1.0;
  const shiftMult = shiftDifferentialMultForLine(line, opts);
  // PTO uplift on headcount (permanent only). Temp indirect is rare; treat
  // as no uplift.
  const isTemp = (line.employment_type || 'permanent') === 'temp_agency';
  const effectiveHc = isTemp ? hc : ptoHeadcountUplift(hc, opts.ptoPct || 0);
  return effectiveHc * opts.operatingHours * rate * (1 + wageLoadFrac)
       * bonusMult * otMult * shiftMult;
}

/**
 * Simplified indirect labor annual cost — for inline cell display.
 *
 * Formula: headcount × operatingHours × hourly_rate × (1 + wage_load_pct)
 *
 * Per Brock 2026-04-20: consolidated wage load (was double-dipping
 * burden_pct + benefit_load_pct). Line-level burden_pct still wins when
 * present — management roles can carry different loads than warehouse.
 *
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine} line
 * @param {number} opHours
 * @param {{ defaultBurdenPct?: number, wageLoadByYear?: number[], year?: number }} [costing]
 * @returns {number}
 */
export function indirectLineAnnualSimple(line, opHours, costing) {
  const hc = line.headcount || 0;
  const rate = effectiveHourlyRate(line);
  const c = costing || {};
  const wageLoadFrac = wageLoadFracForLine(line, c.year ?? 1, {
    wageLoadByYear: c.wageLoadByYear,
    defaultWageLoadFrac: (c.defaultBurdenPct ?? DEFAULT_WAGE_LOAD_PCT) / 100,
  });
  // Baseline year-round cost
  const baseline = hc * opHours * rate * (1 + wageLoadFrac);
  // Seasonal uplift (Brock 2026-04-20): when the line declares extra
  // headcount needed during peak months, add them pro-rated to the
  // months they're on staff + uplifted by a temp-agency markup.
  // peak_only_hc + peak_months + peak_markup_pct. All optional — zeros
  // mean no uplift and baseline is the full annual cost.
  const peakHc = Number(line.peak_only_hc) || 0;
  const peakMonths = Number(line.peak_months) || 0;
  const peakMarkupPct = Number(line.peak_markup_pct) || 0;
  if (peakHc > 0 && peakMonths > 0) {
    // Pro-rate to the active portion of the year + apply markup
    const monthFraction = Math.min(12, peakMonths) / 12;
    const markupFactor = 1 + (peakMarkupPct / 100);
    const seasonalAnnualRate = peakHc * opHours * rate * (1 + wageLoadFrac);
    return baseline + (seasonalAnnualRate * monthFraction * markupFactor);
  }
  return baseline;
}

/**
 * Breakdown version — used by UI to show baseline vs seasonal uplift
 * sub-totals side-by-side.
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine} line
 * @param {number} opHours
 * @param {Object} [costing]
 * @returns {{ baseline: number, seasonal: number, total: number }}
 */
export function indirectLineAnnualBreakdown(line, opHours, costing) {
  const hc = line.headcount || 0;
  const rate = effectiveHourlyRate(line);
  const c = costing || {};
  const wageLoadFrac = wageLoadFracForLine(line, c.year ?? 1, {
    wageLoadByYear: c.wageLoadByYear,
    defaultWageLoadFrac: (c.defaultBurdenPct ?? DEFAULT_WAGE_LOAD_PCT) / 100,
  });
  const baseline = hc * opHours * rate * (1 + wageLoadFrac);
  let seasonal = 0;
  const peakHc = Number(line.peak_only_hc) || 0;
  const peakMonths = Number(line.peak_months) || 0;
  const peakMarkupPct = Number(line.peak_markup_pct) || 0;
  if (peakHc > 0 && peakMonths > 0) {
    const monthFraction = Math.min(12, peakMonths) / 12;
    const markupFactor = 1 + (peakMarkupPct / 100);
    seasonal = peakHc * opHours * rate * (1 + wageLoadFrac) * monthFraction * markupFactor;
  }
  return { baseline, seasonal, total: baseline + seasonal };
}

/**
 * FTE calculation: annual_hours / operatingHours.
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine} line
 * @param {number} opHours — annual operating hours
 * @returns {number}
 */
export function fte(line, opHours) {
  if (!opHours || opHours <= 0) return 0;
  return (line.annual_hours || 0) / opHours;
}

// ============================================================
// LABOR — AGGREGATE CALCULATIONS
// ============================================================

/**
 * Total annual labor cost (direct + indirect).
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine[]} directLines
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine[]} indirectLines
 * @param {Object} opts
 * @param {number} opts.operatingHours
 * @param {number} [opts.otPct]
 * @param {number} [opts.bonusPct]
 * @param {number} [opts.benefitLoadFallback]
 * @returns {number}
 */

/**
 * 2026-06-10 (assessment Phase 2/3 wage-load unification): the SINGLE default
 * employer wage-load (burden) percentage used wherever no per-line burden_pct
 * and no model-level laborCosting.defaultBurdenPct is configured. Audit found
 * FOUR different defaults across surfaces (engine 30 / labor table 32 /
 * monthly per-line 35 / buckets 0 — buckets fixed 2026-06-10 via
 * directLineAnnual routing). Every fallback now references this constant.
 * 2026-06-11 (engine-parity): resolveCalcHeuristics' benefit_load_pct
 * heuristic now mirrors this constant (was 35 — the last divergent burden
 * fallback; the parked legacy-vs-monthly Y1 reconciliation is RESOLVED).
 * The mirror in calc.scenarios.js is kept literal to avoid a
 * calc.js → calc.monthly.js → calc.scenarios.js import cycle; equality is
 * pinned by test-cm-engine-parity.mjs.
 */
export const DEFAULT_WAGE_LOAD_PCT = 30;

export function totalLaborCost(directLines, indirectLines, opts) {
  let cost = 0;
  for (const line of directLines) {
    cost += directLineAnnual(line, opts);
  }
  for (const line of indirectLines) {
    cost += indirectLineAnnual(line, opts);
  }
  return cost;
}

/**
 * Total FTEs (direct + indirect headcount).
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine[]} directLines
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine[]} indirectLines
 * @param {number} opHours
 * @returns {number}
 */
export function totalFtes(directLines, indirectLines, opHours) {
  let ftes = 0;
  for (const line of directLines) {
    if (opHours > 0) ftes += (line.annual_hours || 0) / opHours;
  }
  for (const line of indirectLines) {
    ftes += line.headcount || 0;
  }
  return ftes;
}

// ============================================================
// EQUIPMENT — LINE-LEVEL CALCULATIONS
// ============================================================

/**
 * Annual operating cost for an equipment line.
 * - Lease/service: (monthly_cost + monthly_maintenance) × 12 × qty
 * - Purchase: maintenance only as operating cost
 *
 * Brock 2026-04-20 — seasonal uplift: when the line carries a
 * `peak_markup_pct` AND a caller supplies `peakOverflowByMonth` (an array
 * of 12 non-negative units representing "extras beyond baseline needed in
 * this calendar month"), the annual cost splits into baseline year-round
 * + seasonal short-term rental. When those are absent, behavior is
 * identical to the prior version.
 *
 *   baselineAnnual = qty × monthlyRate × 12
 *   seasonalAnnual = Σ overflow[m] × monthlyRate × (1 + markup/100)
 *   annualCost     = baselineAnnual + seasonalAnnual
 *
 * The line stores only the baseline qty + markup rate; the per-month
 * overflow is DERIVED at cost-compute time from the Monthly Labor View
 * FTE curve ÷ shifts. That avoids duplicating the seasonal curve on every
 * line and keeps the single source of truth in the MLV.
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @param {number[]} [peakOverflowByMonth] — 12 non-negative month values
 * @returns {number}
 */
export function equipLineAnnual(line, peakOverflowByMonth) {
  const qty = line.quantity || 1;
  const type = normalizeAcqType(line.acquisition_type);

  // Phase 2b (2026-04-22): rented_mhe lines have a fundamentally different
  // cost profile — their entire annual cost is seasonal (no baseline).
  //   annualCost = qty × monthly_cost × seasonal_months.length
  // No peak_markup_pct on these lines (no overflow concept — the whole line
  // IS the rental). seasonal_months defaults to [10,11,12] when empty.
  // Rental qty=0 means "no rental" and returns $0 — doesn't default to 1
  // like other types (where qty=0 is typically a misconfig to flag).
  if (line.line_type === 'rented_mhe') {
    const rentalQty = Number(line.quantity) || 0;
    const months = _normalizeSeasonalMonths(line.seasonal_months);
    const monthly = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
    return rentalQty * monthly * months.length;
  }

  // Acquisition-type → monthly-rate that flows as operating expense:
  //   capital     — only maintenance (acquisition_cost flows as depreciation, not opex)
  //   lease       — monthly_cost + maintenance
  //   service     — monthly_cost (maintenance typically bundled into service fee)
  //   ti          — $0 opex on the equipment line (cost rolls into facility rent)
  let monthlyRate;
  if (type === 'capital') {
    monthlyRate = (line.monthly_maintenance || 0);
  } else if (type === 'ti') {
    monthlyRate = 0;
  } else if (type === 'service') {
    monthlyRate = (line.monthly_cost || 0);
  } else {
    // lease (default)
    monthlyRate = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
  }

  const baselineAnnual = monthlyRate * 12 * qty;

  // Seasonal uplift — only when both overflow data AND markup rate are set
  const markupPct = Number(line.peak_markup_pct) || 0;
  if (markupPct > 0 && Array.isArray(peakOverflowByMonth) && peakOverflowByMonth.length === 12) {
    const markupFactor = 1 + (markupPct / 100);
    let seasonalAnnual = 0;
    for (const overflowUnits of peakOverflowByMonth) {
      const u = Number(overflowUnits) || 0;
      if (u > 0) seasonalAnnual += u * monthlyRate * markupFactor;
    }
    return baselineAnnual + seasonalAnnual;
  }

  return baselineAnnual;
}

/**
 * Normalize `seasonal_months` to a clean sorted unique int[] in 1-12.
 * Accepts: number[], comma-separated string, null/undefined.
 * Defaults to [10,11,12] (Oct-Dec omni-channel peak) when empty/missing.
 * Exported for tests. Private helper for equip cost functions.
 * @param {unknown} raw
 * @returns {number[]}
 */
export function _normalizeSeasonalMonths(raw) {
  const DEFAULT = [10, 11, 12];
  if (raw == null) return DEFAULT;
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = raw.split(/[,\s]+/).filter(Boolean);
  else return DEFAULT;
  const out = [];
  for (const v of arr) {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n >= 1 && n <= 12 && !out.includes(n)) out.push(n);
  }
  if (out.length === 0) return DEFAULT;
  return out.sort((a, b) => a - b);
}

/**
 * Split an equipment line's annual cost into baseline + seasonal uplift
 * sub-totals. Used by the UI to render the two numbers side-by-side so
 * the cost of seasonal flex is explicit, not buried in the total.
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @param {number[]} [peakOverflowByMonth]
 * @returns {{ baseline: number, seasonal: number, total: number }}
 */
export function equipLineAnnualBreakdown(line, peakOverflowByMonth) {
  const qty = line.quantity || 1;

  // Phase 2b (2026-04-22): rented_mhe is seasonal-only. No baseline, no
  // peak_markup_pct path — the whole line's cost accrues in seasonal_months.
  if (line.line_type === 'rented_mhe') {
    const rentalQty = Number(line.quantity) || 0;
    const months = _normalizeSeasonalMonths(line.seasonal_months);
    const monthly = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
    const seasonal = rentalQty * monthly * months.length;
    return { baseline: 0, seasonal, total: seasonal };
  }

  const type = normalizeAcqType(line.acquisition_type);
  const monthlyRate = type === 'capital'
    ? (line.monthly_maintenance || 0)
    : type === 'ti'      ? 0
    : type === 'service' ? (line.monthly_cost || 0)
    : /* lease */          (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
  const baseline = monthlyRate * 12 * qty;
  let seasonal = 0;
  const markupPct = Number(line.peak_markup_pct) || 0;
  if (markupPct > 0 && Array.isArray(peakOverflowByMonth) && peakOverflowByMonth.length === 12) {
    const markupFactor = 1 + (markupPct / 100);
    for (const u of peakOverflowByMonth) {
      const units = Number(u) || 0;
      if (units > 0) seasonal += units * monthlyRate * markupFactor;
    }
  }
  return { baseline, seasonal, total: baseline + seasonal };
}

/**
 * Normalize the acquisition_type field to the canonical 4-way taxonomy.
 * Per the Asset Defaults Guidance (2026-04-20), the system carries four
 * financing types:
 *   capital   — provider buys, depreciates, owns
 *   lease     — third-party operating lease, monthly opex, no ownership
 *   ti        — Tenant Improvement (built into facility, amortized via rent)
 *   service   — managed third-party service, per-month opex with no residual
 * The legacy value 'purchase' is accepted and aliased to 'capital'.
 * Unknown values fall back to 'lease' as the safest default.
 * @param {string|null|undefined} v
 * @returns {'capital'|'lease'|'ti'|'service'}
 */
export function normalizeAcqType(v) {
  const s = (v || '').toLowerCase();
  if (s === 'capital' || s === 'purchase') return 'capital';
  if (s === 'ti')      return 'ti';
  if (s === 'service') return 'service';
  return 'lease';
}

/**
 * Phase 2 asset master (2026-06-12) — capital loading factor. Multiplies the
 * base unit cost by 1 + (contingency% + freight% + tax% + allowances%)/100.
 * All four default to 0, so legacy lines compute exactly as before.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {number} multiplier ≥ 0
 */
export function equipLoadingFactor(line) {
  const pct = (Number(line?.contingency_pct) || 0) + (Number(line?.freight_pct) || 0)
            + (Number(line?.tax_pct) || 0) + (Number(line?.allowances_pct) || 0);
  return Math.max(0, 1 + pct / 100);
}

/**
 * Loaded-cost breakdown for the Equipment "Advanced" panel:
 * base + each loading component + loaded unit + line total.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {{ baseUnit:number, contingency:number, freight:number, tax:number,
 *             allowances:number, loadedUnit:number, qty:number, total:number }}
 */
export function assetLoadedCostBreakdown(line) {
  const baseUnit = Number(line?.acquisition_cost) || 0;
  const qty = Number(line?.quantity) || 1;
  const pc = (k) => baseUnit * ((Number(line?.[k]) || 0) / 100);
  const contingency = pc('contingency_pct');
  const freight     = pc('freight_pct');
  const tax         = pc('tax_pct');
  const allowances  = pc('allowances_pct');
  const loadedUnit  = baseUnit + contingency + freight + tax + allowances;
  return { baseUnit, contingency, freight, tax, allowances, loadedUnit, qty, total: loadedUnit * qty };
}

/**
 * Residual (salvage) value for a capital line. Absolute `residual_value`
 * wins; else `residual_pct` of the loaded total; else 0. Clamped to the
 * loaded total so amortization never goes negative.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {number}
 */
export function equipResidualValue(line) {
  const loaded = equipTotalAcq(line);
  const abs = Number(line?.residual_value);
  if (Number.isFinite(abs) && abs > 0) return Math.min(abs, loaded);
  const pct = Number(line?.residual_pct);
  if (Number.isFinite(pct) && pct > 0) return Math.min(loaded * pct / 100, loaded);
  return 0;
}

/**
 * Useful life in months. `useful_life_months` wins; falls back to
 * `amort_years` × 12 (legacy field); defaults to 60 (5 years).
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {number}
 */
export function equipLifeMonths(line) {
  const m = Number(line?.useful_life_months);
  if (Number.isFinite(m) && m > 0) return Math.round(m);
  const y = Number(line?.amort_years);
  return Math.max(1, Math.round((Number.isFinite(y) && y > 0 ? y : 5) * 12));
}

/**
 * Total LOADED acquisition cost on a capital or TI equipment line
 * (qty × unit cost × loading factor). Loading pcts default to 0, so this
 * equals the legacy qty × unit cost unless the analyst sets them.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {number}
 */
export function equipTotalAcq(line) {
  return (line.acquisition_cost || 0) * (line.quantity || 1) * equipLoadingFactor(line);
}

/**
 * Annual depreciation for a CAPITAL equipment line. TI items amortize via
 * facility rent (not on the equipment line), service items have no capital,
 * and lease items expense monthly — none of those produce equipment amort.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {number}
 */
export function equipLineAmort(line) {
  if (normalizeAcqType(line.acquisition_type) !== 'capital') return 0;
  const total = equipTotalAcq(line);
  const years = equipLifeMonths(line) / 12;
  return Math.max(0, total - equipResidualValue(line)) / years;
}

/**
 * Full summary for an equipment line. 4-way financing now:
 *   capital — annual = maintenance only (amort tracked separately as D&A)
 *   lease   — annual = (monthly_cost + maint) × 12
 *   ti      — annual = 0 (rolls into facility rent via `tiUpfront`)
 *   service — annual = monthly_cost × 12 (treated as opex; no capital)
 *
 * `tiUpfront` surfaces the Y0 TI outlay so a Summary-level "TI Upfront"
 * rollup can show the build-out cost without folding it into opex.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {{ annual: number, capital: number, amort: number, leaseMo: number, maintAnnual: number, tiUpfront: number, serviceMo: number, type: string }}
 */
export function equipLineSummary(line) {
  const qty = line.quantity || 1;
  const type = normalizeAcqType(line.acquisition_type);
  return {
    annual:       equipLineAnnual(line),
    capital:      type === 'capital' ? equipTotalAcq(line) : 0,
    amort:        equipLineAmort(line),
    leaseMo:      type === 'lease'   ? (line.monthly_cost || 0) * qty : 0,
    serviceMo:    type === 'service' ? (line.monthly_cost || 0) * qty : 0,
    tiUpfront:    type === 'ti'      ? equipTotalAcq(line) : 0,
    maintAnnual:  (line.monthly_maintenance || 0) * 12 * qty,
    type,
  };
}

/**
 * Horizon sum of one-time TI capital outlays — the Y0 cash that flows into
 * facility build-out. Exposed so the Summary can show a "TI Upfront" card
 * without mixing TI into opex or into capital-equipment totals.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalEquipmentTiUpfront(lines) {
  return (lines || []).reduce((s, line) => {
    return normalizeAcqType(line.acquisition_type) === 'ti' ? s + equipTotalAcq(line) : s;
  }, 0);
}

/**
 * Annual cost displayed in the equipment table row.
 * Includes amortization for purchase items (different from equipLineAnnual).
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {number}
 */
export function equipLineTableCost(line, peakOverflowByMonth) {
  // Phase 2b (2026-04-22): rented_mhe is seasonal-only. Annual = qty ×
  // monthly × seasonal_months.length. Match equipLineAnnual behavior so
  // the row's Annual column agrees with the aggregator's total.
  if (line.line_type === 'rented_mhe') {
    const rentalQty = Number(line.quantity) || 0;
    const months = _normalizeSeasonalMonths(line.seasonal_months);
    const monthly = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
    return rentalQty * monthly * months.length;
  }
  const qty = line.quantity || 1;
  const type = normalizeAcqType(line.acquisition_type);
  const markupPct = Number(line.peak_markup_pct) || 0;
  const hasOverflow = markupPct > 0 && Array.isArray(peakOverflowByMonth) && peakOverflowByMonth.length === 12;

  if (type === 'capital') {
    // Display cost = maintenance + depreciation + seasonal uplift on maintenance rate
    const monthlyRate = (line.monthly_maintenance || 0);
    const maintenance = monthlyRate * 12 * qty;
    let seasonal = 0;
    if (hasOverflow) {
      const f = 1 + markupPct / 100;
      for (const u of peakOverflowByMonth) seasonal += (Number(u) || 0) * monthlyRate * f;
    }
    // Phase 2: depreciation via equipLineAmort (loaded cost − residual, life-months aware)
    return maintenance + equipLineAmort(line) + seasonal;
  }
  if (type === 'ti') {
    // TI = 0 ongoing display cost; cost lives in facility rent.
    return 0;
  }
  if (type === 'service') {
    // Service = monthly_cost × 12 only; no maintenance line (bundled)
    const monthlyRate = (line.monthly_cost || 0);
    const baseline = monthlyRate * qty * 12;
    let seasonal = 0;
    if (hasOverflow) {
      const f = 1 + markupPct / 100;
      for (const u of peakOverflowByMonth) seasonal += (Number(u) || 0) * monthlyRate * f;
    }
    return baseline + seasonal;
  }
  // Lease
  const monthlyRate = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
  const baseline = monthlyRate * qty * 12;
  let seasonal = 0;
  if (hasOverflow) {
    const f = 1 + markupPct / 100;
    for (const u of peakOverflowByMonth) seasonal += (Number(u) || 0) * monthlyRate * f;
  }
  return baseline + seasonal;
}

// ============================================================
// EQUIPMENT — AGGREGATE CALCULATIONS
// ============================================================

/**
 * Total annual equipment operating cost (lease/service + maintenance only).
 * When a Monthly Labor View summary is supplied, each line's seasonal
 * uplift is computed from its matching MHE/IT type curve.
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @param {Object} [opts]
 * @param {Object} [opts.mlv] — full computeMonthlyLaborView() result ({months, summary})
 * @param {number} [opts.shiftsPerDay=1]
 * @returns {number}
 */
export function totalEquipmentCost(lines, opts = {}) {
  const overflowByLine = equipmentOverflowByLine(lines, opts);
  return lines.reduce((sum, line, i) => sum + equipLineAnnual(line, overflowByLine[i]), 0);
}

/**
 * Split total equipment cost into baseline + seasonal uplift sub-totals.
 * UI uses this to show "Seasonal Uplift: $X" next to the headline total
 * so the cost of seasonal flex is explicit.
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @param {Object} [opts]
 * @returns {{ baseline: number, seasonal: number, total: number }}
 */
export function totalEquipmentCostBreakdown(lines, opts = {}) {
  const overflowByLine = equipmentOverflowByLine(lines, opts);
  return lines.reduce((acc, line, i) => {
    const bd = equipLineAnnualBreakdown(line, overflowByLine[i]);
    return { baseline: acc.baseline + bd.baseline, seasonal: acc.seasonal + bd.seasonal, total: acc.total + bd.total };
  }, { baseline: 0, seasonal: 0, total: 0 });
}

/**
 * For each equipment line, derive a 12-element overflow-units-per-calendar-
 * month array from the MLV summary (if provided). Overflow = required
 * units that month − baseline (line.quantity). Only positive overflow is
 * non-zero — a month where required < quantity means you have spare, not
 * a cost saving.
 *
 * Matching strategy:
 *   MHE category line → match by line.mhe_type / line.equipment_name
 *   IT line           → match by line.it_device / line.equipment_name
 * Falls back to name substring match if canonical type fields aren't set.
 *
 * Returns an array aligned to the lines array — `overflowByLine[i]` is
 * either `null` (no match, no seasonal uplift) or a 12-element array.
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @param {Object} opts
 * @returns {Array<number[]|null>}
 */
export function equipmentOverflowByLine(lines, opts = {}) {
  const mlv = opts.mlv;
  const shifts = Math.max(1, Math.floor(opts.shiftsPerDay || 1));
  if (!mlv || !Array.isArray(lines)) return lines.map(() => null);

  // Build a calendar-month aggregated FTE curve per type from MLV months.
  // MLV months[] may span multiple contract years; aggregate by calendar
  // month (1-12) so the worst-case month across years drives the required
  // units for that month (year-5 peak volume is what you'd size for).
  const months = mlv.months || null;
  if (!months || !Array.isArray(months) || months.length === 0) return lines.map(() => null);

  // Aggregate by calendar_month (1-12): max FTE across years for that type
  // This captures the realistic worst-case: in year 5 volume growth may lift
  // peak higher, and that's what you'd need equipment for in those months.
  const byTypeByCalMonth = { mhe: {}, it: {} };
  for (const m of months) {
    const cm = m.calendar_month;
    if (!cm) continue;
    for (const [type, fte] of Object.entries(m.by_mhe || {})) {
      if (!byTypeByCalMonth.mhe[type]) byTypeByCalMonth.mhe[type] = Array(12).fill(0);
      byTypeByCalMonth.mhe[type][cm - 1] = Math.max(byTypeByCalMonth.mhe[type][cm - 1], fte);
    }
    for (const [type, fte] of Object.entries(m.by_it || {})) {
      if (!byTypeByCalMonth.it[type]) byTypeByCalMonth.it[type] = Array(12).fill(0);
      byTypeByCalMonth.it[type][cm - 1] = Math.max(byTypeByCalMonth.it[type][cm - 1], fte);
    }
  }

  return lines.map(line => {
    const qty = line.quantity || 0;
    if (qty <= 0) return null;

    // Decide which type bucket to look at
    const cat = (line.category || '').toLowerCase();
    const name = (line.equipment_name || '').toLowerCase();
    const mheType = line.mhe_type || '';
    const itDevice = line.it_device || '';

    let curve = null;
    if (mheType && byTypeByCalMonth.mhe[mheType]) {
      curve = byTypeByCalMonth.mhe[mheType];
    } else if (itDevice && byTypeByCalMonth.it[itDevice]) {
      curve = byTypeByCalMonth.it[itDevice];
    } else if (cat === 'mhe') {
      // Substring-match the name against available MHE type keys
      for (const key of Object.keys(byTypeByCalMonth.mhe)) {
        if (name.includes(key.replace(/_/g, ' ')) || name.includes(key)) {
          curve = byTypeByCalMonth.mhe[key]; break;
        }
      }
    } else if (cat === 'it') {
      for (const key of Object.keys(byTypeByCalMonth.it)) {
        if (name.includes(key.replace(/_/g, ' ')) || name.includes(key)) {
          curve = byTypeByCalMonth.it[key]; break;
        }
      }
    }
    if (!curve) return null;

    // Convert per-month FTE to per-month required units, subtract baseline
    return curve.map(fteThisMonth => {
      const required = Math.ceil(fteThisMonth / shifts);
      return Math.max(0, required - qty);
    });
  });
}

/**
 * Total capital investment (purchase equipment only).
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @returns {number}
 */
/**
 * Phase 2e (2026-04-22): subset of totalEquipmentCost attributable to
 * `rented_mhe` lines only. Drives the "Peak Rentals" sub-slice annotation
 * in the Summary Cost Breakdown. Zero-cost when no rentals exist.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalRentedMheCost(lines) {
  return (lines || []).reduce((sum, line) => {
    if (line && line.line_type === 'rented_mhe') return sum + equipLineAnnual(line);
    return sum;
  }, 0);
}

/**
 * Phase 2e follow-up (2026-04-22): produce a 12-element array of equipment
 * expense by calendar month (index 0 = January).
 *
 *   Owned / IT / Facility lines — annual cost spread evenly /12
 *   rented_mhe lines           — qty × monthly_cost added ONLY to each month
 *                                in seasonal_months (defaults to [10,11,12])
 *
 * Used by the monthly engine so Q4 shows the real peak-rental bump rather
 * than a smoothed /12 spread. Sum across months equals totalEquipmentCost
 * + totalEquipmentAmort (capital amort included since 2026-06-10).
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @returns {number[]} length-12 array, index 0 = January
 */
export function computeEquipmentMonthlySeries(lines) {
  const series = new Array(12).fill(0);
  if (!Array.isArray(lines)) return series;
  for (const line of lines) {
    if (!line) continue;
    if (line.line_type === 'rented_mhe') {
      const qty = Number(line.quantity) || 0;
      const monthly = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
      const months = _normalizeSeasonalMonths(line.seasonal_months);
      for (const m of months) series[m - 1] += qty * monthly;
    } else {
      // 2026-06-10: include capital amortization so the series sum equals
      // totalEquipmentCost + totalEquipmentAmort — the monthly engine's
      // base_equipment_cost now carries amort (Critical #3 fix), and a series
      // that omitted it would silently drop amort whenever the series path won.
      const annual = equipLineAnnual(line) + equipLineAmort(line);
      const perMonth = annual / 12;
      for (let i = 0; i < 12; i++) series[i] += perMonth;
    }
  }
  return series;
}

export function totalEquipmentCapital(lines) {
  return lines.reduce((sum, line) => {
    // Capital items ONLY — TI is facility rent, lease has no capital, service
    // is pure opex. Previously summed any line with acquisition_type='purchase'
    // which lumped the building-TI items into equipment capital and inflated
    // the Total Investment tile on the Summary.
    if (normalizeAcqType(line.acquisition_type) === 'capital') {
      return sum + equipTotalAcq(line);
    }
    return sum;
  }, 0);
}

/**
 * Total annual equipment amortization (purchase equipment only).
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalEquipmentAmort(lines) {
  return lines.reduce((sum, line) => sum + equipLineAmort(line), 0);
}

/**
 * EQ-1/EQ-2 — 3-way ROI comparison for MHE lines: Own year-round vs Rent
 * year-round vs Buy-to-Peak (own steady-state, rent overflow). Computes a
 * per-line 5-year TCO under each strategy plus the break-even peak duration
 * where rent overtakes own. Operates on MHE category only — racking, IT,
 * facility lines are structurally not "rent vs own" decisions.
 *
 * Formulas (all annualized over `years` then summed):
 *   OWN year-round   = capital amortized over amort_years × years held
 *                      + (monthly_maintenance × 12) × years
 *                      Capital piece prorates: if years > amort_years, only
 *                      one acquisition; if years < amort_years, charge
 *                      (capital × years / amort_years) — straight-line.
 *   RENT year-round  = (monthly_cost × 12) × qty × years
 *                      uses the line's monthly_cost as the rental rate
 *                      regardless of acquisition_type (we assume the user
 *                      entered an MHE rental rate when toggling rent UI;
 *                      fallback: 1.5% of acquisition_cost / month industry rule)
 *   BUY-TO-PEAK      = OWN cost on steady-state qty + RENT cost on peak qty
 *                      for the months above baseline (from peakOverflow)
 *
 * Break-even peak months (EQ-2):
 *   The number of peak months/year at which Rent annual cost equals Own
 *   annual cost (capital amort + maintenance, baseline qty=1):
 *     break_even = annual_own_per_unit / monthly_rent_per_unit
 *   If break_even > 12, "Always Own". If break_even < 0.5, "Always Rent".
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @param {Array<number>|null} peakOverflowByMonth — qty above baseline by month (from MLV)
 * @param {number} [years=5] — comparison horizon (default = typical contract length)
 * @returns {{
 *   ownYearRound: number,
 *   rentYearRound: number,
 *   buyToPeak: number,
 *   breakEvenPeakMonths: number,
 *   verdict: 'always_own'|'always_rent'|'buy_to_peak'|'tied',
 *   monthlyRentPerUnit: number,
 *   annualOwnPerUnit: number,
 *   peakMonths: number,
 *   qtyBaseline: number
 * }}
 */
export function equipLine3WayRoi(line, peakOverflowByMonth, years = 5) {
  if (!line) return null;
  const qty = Math.max(1, parseInt(line.quantity) || 1);
  const acqCost = (parseFloat(line.acquisition_cost) || 0) * equipLoadingFactor(line);
  const amortYrs = Math.max(1, parseInt(line.amort_years) || 5);
  const maintMo = parseFloat(line.monthly_maintenance) || 0;
  let rentMo = parseFloat(line.monthly_cost) || 0;
  // Industry-rule fallback when user didn't enter a rent rate but did enter
  // acquisition cost (1.5%/mo of acq cost — typical short-term MHE rental).
  if (rentMo <= 0 && acqCost > 0) rentMo = acqCost * 0.015;

  // Per-unit annualized own cost: straight-line capital + maintenance.
  const annualCapitalPerUnit = amortYrs > 0 ? (acqCost / amortYrs) : 0;
  const annualMaintPerUnit = maintMo * 12;
  const annualOwnPerUnit = annualCapitalPerUnit + annualMaintPerUnit;

  // Strategy totals (over `years` for entire qty).
  const ownYearRound = annualOwnPerUnit * qty * years;
  const rentYearRound = rentMo * 12 * qty * years;

  // Buy-to-peak: own baseline qty year-round + rent overflow only in months
  // where MLV indicates peak demand. Without MLV data, fall back to seasonal_months
  // length × overflow ≈ 0.2 × qty (industry default 20% peak swing).
  let peakUnitMonths = 0;
  let peakMonths = 0;
  if (peakOverflowByMonth && peakOverflowByMonth.length) {
    peakUnitMonths = peakOverflowByMonth.reduce((s, u) => s + Math.max(0, u || 0), 0);
    peakMonths = peakOverflowByMonth.filter(u => (u || 0) > 0).length;
  } else if (Array.isArray(line.seasonal_months) && line.seasonal_months.length > 0) {
    // No MLV — use line's own seasonal_months × 20% qty overflow as proxy.
    peakMonths = line.seasonal_months.length;
    peakUnitMonths = peakMonths * Math.max(1, Math.round(qty * 0.2));
  }
  const buyToPeak = (annualOwnPerUnit * qty * years) + (rentMo * peakUnitMonths * years);

  // Break-even peak months: rent_mo × N == annual_own_per_unit (per single unit)
  const breakEvenPeakMonths = rentMo > 0 ? (annualOwnPerUnit / rentMo) : 999;

  // Verdict logic — pick the cheapest of the three.
  let verdict;
  if (breakEvenPeakMonths >= 12) verdict = 'always_own';
  else if (breakEvenPeakMonths <= 0.5) verdict = 'always_rent';
  else if (peakMonths > 0 && buyToPeak < ownYearRound && buyToPeak < rentYearRound) verdict = 'buy_to_peak';
  else if (Math.abs(ownYearRound - rentYearRound) < 0.01) verdict = 'tied';
  else verdict = ownYearRound < rentYearRound ? 'always_own' : 'always_rent';

  return {
    ownYearRound,
    rentYearRound,
    buyToPeak,
    breakEvenPeakMonths,
    verdict,
    monthlyRentPerUnit: rentMo,
    annualOwnPerUnit,
    peakMonths,
    qtyBaseline: qty,
  };
}

/**
 * EQ-1 — Roll up 3-way ROI across all MHE lines. Aggregates totals and
 * reports per-strategy savings vs the current line_type configuration.
 *
 * @param {Array<import('./types.js?v=20260612-mix1').EquipmentLine>} lines
 * @param {{ peakOverflowByLine?: Array<Array<number>|null>, years?: number }} [opts]
 */
export function totalEquipment3WayRoi(lines, opts = {}) {
  const years = opts.years || 5;
  const overflowByLine = opts.peakOverflowByLine || [];
  const mheLines = (lines || []).filter(l => l && l.category === 'MHE');
  let ownYearRound = 0, rentYearRound = 0, buyToPeak = 0;
  const perLine = mheLines.map((line, i) => {
    const overflow = overflowByLine[i] || null;
    const r = equipLine3WayRoi(line, overflow, years);
    if (r) {
      ownYearRound += r.ownYearRound;
      rentYearRound += r.rentYearRound;
      buyToPeak += r.buyToPeak;
    }
    return { line, roi: r };
  });
  // Cheapest strategy wins.
  const min = Math.min(ownYearRound, rentYearRound, buyToPeak);
  let cheapest;
  if (min === buyToPeak && buyToPeak > 0 && buyToPeak < ownYearRound && buyToPeak < rentYearRound) cheapest = 'buy_to_peak';
  else if (min === ownYearRound) cheapest = 'own';
  else cheapest = 'rent';
  return { ownYearRound, rentYearRound, buyToPeak, perLine, cheapest, years, mheLineCount: mheLines.length };
}

/**
 * EQ-3 — IT capex separated from total capital. Returns { itCapital, nonItCapital, total }.
 */
export function equipmentCapitalByType(lines) {
  const out = { itCapital: 0, nonItCapital: 0, total: 0 };
  (lines || []).forEach(line => {
    if (normalizeAcqType(line.acquisition_type) !== 'capital') return;
    const cap = equipTotalAcq(line);
    out.total += cap;
    const isIt = (line.line_type === 'it_equipment') || (line.category === 'IT');
    if (isIt) out.itCapital += cap;
    else out.nonItCapital += cap;
  });
  return out;
}

// ============================================================
// OVERHEAD
// ============================================================

/**
 * Annual cost for an overhead line (handles monthly vs annual cost_type).
 * @param {import('./types.js?v=20260612-mix1').OverheadLine} line
 * @returns {number}
 */
export function overheadLineAnnual(line) {
  if (line.cost_type === 'monthly') {
    return (line.monthly_cost || 0) * 12;
  }
  return line.annual_cost || 0;
}

/**
 * Total annual overhead cost.
 * @param {import('./types.js?v=20260612-mix1').OverheadLine[]} lines
 * @returns {number}
 */
export function totalOverheadCost(lines) {
  return lines.reduce((sum, line) => sum + overheadLineAnnual(line), 0);
}

// ============================================================
// VAS
// ============================================================

/**
 * Annual cost for a VAS line.
 * Uses total_cost override if set, otherwise rate × volume.
 * @param {import('./types.js?v=20260612-mix1').VASLine} line
 * @returns {number}
 */
export function vasLineAnnual(line) {
  if (line.total_cost) return line.total_cost;
  return (line.rate || 0) * (line.volume || 0);
}

/**
 * Total annual VAS cost.
 * @param {import('./types.js?v=20260612-mix1').VASLine[]} lines
 * @returns {number}
 */
export function totalVasCost(lines) {
  return lines.reduce((sum, line) => sum + vasLineAnnual(line), 0);
}

// ============================================================
// FACILITY
// ============================================================

/**
 * Annual facility cost from square footage and market rates.
 *
 * Brock 2026-04-20 (Asset Defaults Guidance doc): TI (Tenant Improvement)
 * upfront outlays — dock levelers, office build-out, break room, CCTV —
 * don't flow as equipment opex or capital. The reference-model design
 * intent is that TI amortizes through rent over the lease term. This
 * helper accepts an optional `tiAmort` (annual TI amortization = TI
 * upfront ÷ contract term years) and folds it into total facility cost
 * as an additional line. Callers that don't supply tiAmort get the
 * classic lease+cam+tax+insurance+utility sum (backward compat).
 *
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} facility
 * @param {import('./types.js?v=20260612-mix1').FacilityRate} [facilityRate]
 * @param {import('./types.js?v=20260612-mix1').UtilityRate} [utilityRate]
 * @param {Object} [opts]
 * @param {number} [opts.tiAmort] — annual TI amortization (fold into facility)
 * @returns {number}
 */
export function totalFacilityCost(facility, facilityRate, utilityRate, opts = {}) {
  const sqft = facility.totalSqft || 0;
  const fr = facilityRate || {};
  const ur = utilityRate || {};

  const lease = sqft * (fr.lease_rate_psf_yr || 0);
  const cam = sqft * (fr.cam_rate_psf_yr || 0);
  const tax = sqft * (fr.tax_rate_psf_yr || 0);
  const insurance = sqft * (fr.insurance_rate_psf_yr || 0);
  const utility = sqft * 12 * (ur.avg_monthly_per_sqft || 0);
  const tiAmort = Math.max(0, Number(opts.tiAmort) || 0);

  return lease + cam + tax + insurance + utility + tiAmort;
}

/**
 * Facility cost breakdown by component. tiAmort exposed so the UI can
 * surface "TI Amortization" as a distinct line under rent.
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} facility
 * @param {import('./types.js?v=20260612-mix1').FacilityRate} [facilityRate]
 * @param {import('./types.js?v=20260612-mix1').UtilityRate} [utilityRate]
 * @param {Object} [opts]
 * @param {number} [opts.tiAmort] — annual TI amortization
 * @returns {{ lease: number, cam: number, tax: number, insurance: number, utility: number, tiAmort: number, total: number }}
 */
export function facilityCostBreakdown(facility, facilityRate, utilityRate, opts = {}) {
  const sqft = facility.totalSqft || 0;
  const fr = facilityRate || {};
  const ur = utilityRate || {};

  // 2026-04-25 (CM-FAC-1): per-deal overrides on market seed rates.
  // facility.overrides is the source of truth; opts.facilityOverride is a
  // deprecated escape hatch but accepted for API symmetry.
  const ov = (facility.overrides && typeof facility.overrides === 'object')
    ? facility.overrides
    : (opts.facilityOverride || {});
  // null/undefined/'' should NOT activate the override — Number(null) is 0
  // which would otherwise pass `>= 0` and zero out market rates by accident.
  const _hasOv = (v) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  const ratePerSfYrOv = Number(ov.ratePerSfYr);
  const utilPerSfMoOv = Number(ov.utilPerSfMo);
  const maintPctOv    = Number(ov.maintPct);
  const usingRentOv = _hasOv(ov.ratePerSfYr);
  const usingUtilOv = _hasOv(ov.utilPerSfMo);
  const usingMaint  = _hasOv(ov.maintPct) && Number(ov.maintPct) > 0;

  let lease, cam, tax, insurance;
  if (usingRentOv) {
    // Single override replaces lease + cam + tax + insurance combined.
    // We park the entire amount on `lease` and zero out the others so the
    // breakdown still totals correctly without confusing the rendered table.
    lease = sqft * ratePerSfYrOv;
    cam = 0; tax = 0; insurance = 0;
  } else {
    lease = sqft * (fr.lease_rate_psf_yr || 0);
    cam = sqft * (fr.cam_rate_psf_yr || 0);
    tax = sqft * (fr.tax_rate_psf_yr || 0);
    insurance = sqft * (fr.insurance_rate_psf_yr || 0);
  }
  const utility = usingUtilOv
    ? sqft * 12 * utilPerSfMoOv
    : sqft * 12 * (ur.avg_monthly_per_sqft || 0);
  const tiAmort = Math.max(0, Number(opts.tiAmort) || 0);
  // Maintenance/Repair adds on top of base rent (industry common practice
  // is 0.5–2% of base rent for repairs, HVAC service, paint touch-ups).
  const baseRent = lease + cam + tax + insurance;
  const maintenance = usingMaint ? baseRent * (maintPctOv / 100) : 0;

  // TI Phase B — Mode B rent credit, informational. Gross total is the P&L
  // figure; netTotal = market-equivalent rent for benchmarking quoted rent.
  const tiRentCredit = Math.max(0, (Number(facility.tiRentCreditPsfMo ?? facility.ti_rent_credit_psf_mo) || 0) * 12 * sqft);
  const grossTotal = lease + cam + tax + insurance + utility + tiAmort + maintenance;

  return {
    lease, cam, tax, insurance, utility, tiAmort, maintenance,
    tiRentCredit,
    netTotal: Math.max(0, grossTotal - tiRentCredit),
    overrideFlags: { rent: usingRentOv, util: usingUtilOv, maint: usingMaint },
    total: grossTotal,
  };
}

/**
 * Landlord TI allowance in dollars for a facility (TI Phase A, 2026-06-11).
 * Explicit total wins when set (> 0); otherwise derived as allowance-PSF ×
 * total sqft. Never negative. Accepts camelCase (jsonb model) or snake_case
 * (normalized column) field names, matching the automationLevel precedent.
 *
 * Per TI Handling doc: a silent $0 allowance is on the "common mistakes"
 * list — market default is ~$15–25/SF on a 5-yr industrial lease. The UI
 * surfaces this hint; the engine just computes what it's given.
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} [facility]
 * @returns {number}
 */
export function tiAllowanceTotal(facility) {
  if (!facility) return 0;
  const explicit = Number(facility.tiAllowanceTotal ?? facility.landlord_ti_allowance_total);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const psf  = Number(facility.tiAllowancePsf ?? facility.landlord_ti_allowance_psf) || 0;
  const sqft = Number(facility.totalSqft) || 0;
  return Math.max(0, psf * sqft);
}

/**
 * Split the total TI outlay into landlord-funded vs provider-funded shares
 * (TI Handling doc, Phase A — "the biggest accuracy gain"):
 *   landlordFunded = min(total TI, allowance)
 *   providerFunded = max(0, total TI − landlordFunded)
 * Only the provider share amortizes into facility rent — the landlord share
 * is the landlord's capital, already recovered through base rent.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} equipmentLines
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} [facility]
 * @returns {{ totalTi:number, allowanceTotal:number, landlordFunded:number, providerFunded:number }}
 */
export function tiNetProviderCost(equipmentLines, facility) {
  const totalTi = totalEquipmentTiUpfront(equipmentLines || []);
  const allowanceTotal = tiAllowanceTotal(facility);
  const landlordFunded = Math.min(totalTi, allowanceTotal);
  return { totalTi, allowanceTotal, landlordFunded, providerFunded: Math.max(0, totalTi - landlordFunded) };
}

/**
 * TI Phase B (2026-06-11) — Mode B rent credit. When the landlord funds TI
 * and recoups it through ELEVATED rent, `tiRentCreditPsfMo` records the
 * $/SF/month slice of quoted rent attributable to TI recovery. Gross rent
 * stays in the P&L (it is the real cash cost); the credit feeds the
 * net "market-equivalent rent" display so quoted rent can be benchmarked
 * against market comps without the TI premium muddying the comparison.
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} [facility]
 * @returns {number} annual rent credit in dollars
 */
export function tiRentCreditAnnual(facility) {
  if (!facility) return 0;
  const psfMo = Number(facility.tiRentCreditPsfMo ?? facility.ti_rent_credit_psf_mo) || 0;
  const sqft  = Number(facility.totalSqft) || 0;
  return Math.max(0, psfMo * 12 * sqft);
}

/**
 * Net market-equivalent storage cost: gross facility cost minus the Mode B
 * TI rent credit. Informational / benchmarking only — never feeds totalCost.
 * @param {number} grossFacilityCost
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} [facility]
 * @returns {number}
 */
export function netStorageCost(grossFacilityCost, facility) {
  return Math.max(0, (Number(grossFacilityCost) || 0) - tiRentCreditAnnual(facility));
}

/**
 * Sum TI outlay by shell classification ('shell' = base-building scope,
 * typically landlord-funded; 'non_shell' = provider scope: hazmat rooms,
 * temp control, freezer build-out). Informational rollup — the funding
 * split itself is allowance-driven via `tiNetProviderCost`. Lines without
 * a ti_classification default to 'non_shell'.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} lines
 * @param {('shell'|'non_shell')} classification
 * @returns {number}
 */
export function totalEquipmentTiByClass(lines, classification) {
  return (lines || []).reduce((s, line) => {
    if (normalizeAcqType(line.acquisition_type) !== 'ti') return s;
    const cls = line.ti_classification === 'shell' ? 'shell' : 'non_shell';
    return cls === classification ? s + equipTotalAcq(line) : s;
  }, 0);
}

/**
 * Convenience: compute annual TI amortization from equipment lines + contract term.
 * TI Phase A (2026-06-11): when `facility` is supplied, only the
 * PROVIDER-FUNDED share (total TI − landlord allowance) amortizes.
 * Omitting `facility` preserves the legacy behavior (full TI amortizes —
 * equivalent to a $0 allowance). Returns 0 when nothing to amortize.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} equipmentLines
 * @param {number} contractYears
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} [facility]
 * @returns {number}
 */
export function tiAmortAnnual(equipmentLines, contractYears, facility) {
  // TI Phase C (2026-06-11): explicit amort-period override for cases where
  // the lease term ≠ amortization window (e.g., renewal-likely deals).
  // Default remains the contract term per the doc ("usually equals lease term").
  const override = Number(facility?.tiAmortYears ?? facility?.ti_amort_years);
  const y = Math.max(1, (Number.isFinite(override) && override > 0) ? override : (Number(contractYears) || 5));
  const { providerFunded } = tiNetProviderCost(equipmentLines || [], facility);
  return providerFunded > 0 ? providerFunded / y : 0;
}

// ============================================================
// PHASE 2 — ASSET MASTER / CAPITAL PLANNING (2026-06-12)
// Roadmap §Phase 2: per-asset depreciation schedules, capital plan,
// op-lease vs capital split, rack BOM costing.
// ============================================================

/**
 * Build a monthly depreciation schedule for one asset.
 * Straight-line: (loaded − residual) / life, final month absorbs rounding.
 * Declining-balance: double-declining monthly rate (2/life) with
 * straight-line switch (standard DDB-with-SL-crossover) and a residual
 * floor; the schedule may end early once book value reaches residual.
 * Either way the schedule sums to (loaded − residual) within rounding.
 *
 * @param {{ total_loaded_cost?:number, loadedCost?:number, residual_value?:number,
 *           useful_life_months?:number, amort_method?:string }} asset
 * @param {{ goLivePeriodIndex?:number }} [opts]
 * @returns {Array<{ period_index:number, depreciation_amount:number,
 *                   accumulated_depreciation:number, book_value:number }>}
 */
export function buildDepreciationSchedule(asset, opts = {}) {
  const loaded = Number(asset?.total_loaded_cost ?? asset?.loadedCost) || 0;
  if (loaded <= 0) return [];
  const residual = Math.min(Math.max(0, Number(asset?.residual_value) || 0), loaded);
  const life = Math.max(1, Math.round(Number(asset?.useful_life_months) || 60));
  const method = asset?.amort_method === 'declining_balance' ? 'declining_balance' : 'straight_line';
  const startIdx = Number.isFinite(Number(opts.goLivePeriodIndex)) ? Number(opts.goLivePeriodIndex) : 0;

  const rows = [];
  let book = loaded;
  let acc = 0;
  for (let m = 0; m < life; m++) {
    let d;
    if (method === 'straight_line') {
      d = (loaded - residual) / life;
    } else {
      d = book * (2 / life);
      const slRemaining = (book - residual) / (life - m);
      if (slRemaining > d) d = slRemaining; // SL switch
    }
    if (book - d < residual) d = book - residual;     // residual floor
    if (m === life - 1) d = book - residual;          // absorb rounding
    d = Math.max(0, d);
    acc += d;
    book -= d;
    rows.push({
      period_index: startIdx + m,
      depreciation_amount: d,
      accumulated_depreciation: acc,
      book_value: book,
    });
    if (book <= residual + 1e-9 && m < life - 1) break; // DDB fully depreciated early
  }
  return rows;
}

/**
 * Convert equipment lines into asset-instance rows for persistence
 * (cost_model_asset_instances). Capital + TI lines only — lease and service
 * lines are pure opex with no balance-sheet asset. `_total_loaded_cost` is
 * client-side convenience; the DB recomputes it via a generated column and
 * the API layer must strip underscore-prefixed keys before insert.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} equipmentLines
 * @returns {Object[]}
 */
export function buildAssetInstances(equipmentLines) {
  return (equipmentLines || []).filter(l => {
    const t = normalizeAcqType(l?.acquisition_type);
    return (t === 'capital' || t === 'ti') && (Number(l?.acquisition_cost) || 0) > 0;
  }).map(l => ({
    equipment_line_id: l.id != null ? String(l.id) : null,
    name: l.equipment_name || l.name || 'Unnamed asset',
    category: l.category || null,
    quantity: Number(l.quantity) || 1,
    unit_cost: Number(l.acquisition_cost) || 0,
    contingency_pct: Number(l.contingency_pct) || 0,
    freight_pct: Number(l.freight_pct) || 0,
    tax_pct: Number(l.tax_pct) || 0,
    allowances_pct: Number(l.allowances_pct) || 0,
    financing_type: normalizeAcqType(l.acquisition_type),
    amort_method: l.amort_method === 'declining_balance' ? 'declining_balance' : 'straight_line',
    useful_life_months: equipLifeMonths(l),
    residual_value: equipResidualValue(l),
    _total_loaded_cost: equipTotalAcq(l),
  }));
}

/**
 * Capital plan: monthly capex / depreciation / book value series plus a
 * capex-by-category rollup, distinguishing capital purchases (balance
 * sheet, amortized to P&L) from operating leases (straight to opex).
 * TI lines are excluded — they amortize via facility rent (tiAmortAnnual).
 *
 * Acceptance (Roadmap §Phase 2): operating leases never hit the capex
 * line; capital purchases always do.
 *
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} equipmentLines
 * @param {{ contractMonths?:number }} [opts]
 * @returns {{ series: Array<{period_index:number, capex:number, depreciation:number,
 *             book_value:number, lease_opex:number}>,
 *             capexByCategory: Object<string, number>, totalCapex: number,
 *             totalLeaseOpexMo: number }}
 */
export function computeCapital(equipmentLines, opts = {}) {
  const months = Math.max(1, Math.round(Number(opts.contractMonths) || 60));
  const series = Array.from({ length: months }, (_, m) => ({
    period_index: m, capex: 0, depreciation: 0, book_value: 0, lease_opex: 0,
  }));
  const capexByCategory = {};
  let totalCapex = 0;
  let totalLeaseOpexMo = 0;

  for (const line of (equipmentLines || [])) {
    const t = normalizeAcqType(line?.acquisition_type);
    const qty = Number(line?.quantity) || 1;
    if (t === 'lease' || t === 'service') {
      const mo = ((Number(line?.monthly_cost) || 0) + (Number(line?.monthly_maintenance) || 0)) * qty;
      totalLeaseOpexMo += mo;
      for (const s of series) s.lease_opex += mo;
      continue;
    }
    if (t !== 'capital') continue; // TI → facility rent, not the equipment capital plan
    const loaded = equipTotalAcq(line);
    if (loaded <= 0) continue;
    totalCapex += loaded;
    series[0].capex += loaded;
    const cat = line.category || 'Uncategorized';
    capexByCategory[cat] = (capexByCategory[cat] || 0) + loaded;

    const sched = buildDepreciationSchedule({
      total_loaded_cost: loaded,
      residual_value: equipResidualValue(line),
      useful_life_months: equipLifeMonths(line),
      amort_method: line.amort_method,
    });
    const lastBook = sched.length ? sched[sched.length - 1].book_value : loaded;
    for (let m = 0; m < months; m++) {
      if (m < sched.length) {
        series[m].depreciation += sched[m].depreciation_amount;
        series[m].book_value += sched[m].book_value;
      } else {
        series[m].book_value += lastBook;
      }
    }
  }
  return { series, capexByCategory, totalCapex, totalLeaseOpexMo };
}

/**
 * Total cost of a rack profile BOM. Takes the joined rows of
 * ref_rack_profile_components × ref_rack_components and sums qty × unit
 * cost. Pure — the API layer fetches; this prices.
 * @param {Array<{qty:number, unit_cost:number}>} componentRows
 * @returns {number}
 */
export function rackProfileCost(componentRows) {
  return (componentRows || []).reduce(
    (s, r) => s + (Number(r?.qty) || 0) * (Number(r?.unit_cost) || 0), 0);
}

// ============================================================
// HOUSE ASSUMPTIONS — pricing_assumptions pinning (2026-06-12)
// Corporate out-year escalation guidance (pricing_assumptions table) is
// PINNED into each project at creation/first save. Later guidance changes
// never alter an existing project — analysts see the drift and adopt the
// new guidance only by explicit action. (Brock 2026-06-12: "if the
// original deal modeled 3% but we later adjusted corporate guidance to
// 5%, the 3% for that specific project should remain intact.")
// ============================================================

/**
 * Snapshot pricing_assumptions rows into a project-pinnable shape.
 * @param {Object[]} rows — live pricing_assumptions rows
 * @param {string} [asOf] — pin date (YYYY-MM-DD); defaults to today
 * @returns {{ pinnedAt: string, rows: Object[] }}
 */
export function pinHouseAssumptions(rows, asOf) {
  const clean = (rows || []).map(r => ({
    scope: r.scope ?? null,
    scope_key: r.scope_key ?? null,
    metric: r.metric ?? null,
    year_1_pct: Number(r.year_1_pct) || 0,
    year_2_pct: Number(r.year_2_pct) || 0,
    year_3_pct: Number(r.year_3_pct) || 0,
    year_4_pct: Number(r.year_4_pct) || 0,
    year_5_pct: Number(r.year_5_pct) || 0,
    effective_date: r.effective_date ?? null,
    notes: r.notes ?? null,
  }));
  return { pinnedAt: asOf || new Date().toISOString().slice(0, 10), rows: clean };
}

/**
 * Map pinned house guidance onto the project's escalation defaults.
 * hourly-wage Y1 → financial.laborEscalation; global capex Y1 →
 * financial.annualEscalation (general cost). Only used when SEEDING a
 * brand-new model — never re-applied to existing projects.
 * @param {{ rows: Object[] }} pinned
 * @returns {{ laborEscalation?: number, annualEscalation?: number }}
 */
export function houseGuidanceSeeds(pinned) {
  const rows = pinned?.rows || [];
  const find = (scope, metric, key) => rows.find(r =>
    r.scope === scope && r.metric === metric && (key === undefined || r.scope_key === key));
  const wage  = find('labor_category', 'wage', 'hourly') || find('global', 'wage', null) || find('global', 'wage');
  const capex = find('global', 'capex', null) || find('global', 'capex');
  const out = {};
  if (wage  && Number.isFinite(wage.year_1_pct))  out.laborEscalation  = wage.year_1_pct;
  if (capex && Number.isFinite(capex.year_1_pct)) out.annualEscalation = capex.year_1_pct;
  return out;
}

/**
 * Compare a project's pinned house assumptions against live guidance.
 * @param {{ rows: Object[] }} pinned
 * @param {Object[]} currentRows — live pricing_assumptions
 * @returns {{ rows: Object[], anyDrift: boolean }} each row gains
 *   { current, changed, missing }
 */
export function houseAssumptionsDrift(pinned, currentRows) {
  const keyOf = r => `${r.scope}|${r.scope_key ?? ''}|${r.metric}`;
  const cur = new Map((currentRows || []).map(r => [keyOf(r), r]));
  const rows = (pinned?.rows || []).map(r => {
    const c = cur.get(keyOf(r)) || null;
    const changed = !!c && [1, 2, 3, 4, 5].some(i =>
      Number(c[`year_${i}_pct`]) !== Number(r[`year_${i}_pct`]));
    return { ...r, current: c, changed, missing: !c };
  });
  return { rows, anyDrift: rows.some(r => r.changed || r.missing) };
}

// ============================================================
// STARTUP / CAPITAL
// ============================================================

/**
 * Total annual startup amortization. Skips lines with `billing_type === 'as_incurred'`
 * (reference Part I §9 sub-branch: as-incurred startup lines are zero-margin
 * pass-through, not capitalized + amortized).
 *
 * @param {import('./types.js?v=20260612-mix1').StartupLine[]} lines
 * @param {number} contractYears
 * @returns {number}
 */
export function totalStartupAmort(lines, contractYears) {
  const years = Math.max(1, contractYears || 5);
  return lines.reduce((sum, line) => {
    if (line.billing_type === 'as_incurred') return sum;
    return sum + (line.one_time_cost || 0) / years;
  }, 0);
}

/**
 * Total startup capital (one-time costs). Skips `as_incurred` lines — those
 * are billed-as-incurred, not capitalized.
 *
 * @param {import('./types.js?v=20260612-mix1').StartupLine[]} lines
 * @returns {number}
 */
export function totalStartupCapital(lines) {
  return lines.reduce((sum, line) => {
    if (line.billing_type === 'as_incurred') return sum;
    return sum + (line.one_time_cost || 0);
  }, 0);
}

/**
 * Total as-incurred startup pass-through. Sum of one-time costs on lines
 * where `billing_type === 'as_incurred'`. These flow through the P&L as
 * revenue = expense (zero margin), not amortized.
 *
 * @param {import('./types.js?v=20260612-mix1').StartupLine[]} lines
 * @returns {number}
 */
export function totalStartupAsIncurred(lines) {
  return lines.reduce((sum, line) => {
    return sum + (line.billing_type === 'as_incurred' ? (line.one_time_cost || 0) : 0);
  }, 0);
}

// ============================================================
// COST SUMMARY
// ============================================================

/**
 * Compute full cost summary from all model data.
 * @param {Object} params
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine[]} params.laborLines
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine[]} params.indirectLaborLines
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} params.equipmentLines
 * @param {import('./types.js?v=20260612-mix1').OverheadLine[]} params.overheadLines
 * @param {import('./types.js?v=20260612-mix1').VASLine[]} params.vasLines
 * @param {import('./types.js?v=20260612-mix1').StartupLine[]} params.startupLines
 * @param {import('./types.js?v=20260612-mix1').FacilityConfig} params.facility
 * @param {import('./types.js?v=20260612-mix1').ShiftConfig} params.shifts
 * @param {import('./types.js?v=20260612-mix1').FacilityRate} [params.facilityRate]
 * @param {import('./types.js?v=20260612-mix1').UtilityRate} [params.utilityRate]
 * @param {number} params.contractYears
 * @param {number} params.targetMarginPct
 * @param {number} params.annualOrders
 * @param {Object} [params.laborOpts] — otPct, bonusPct, benefitLoadFallback
 * @returns {import('./types.js?v=20260612-mix1').CostSummary}
 */
export function computeSummary(params) {
  const opHrs = operatingHours(params.shifts);
  const laborOpts = { operatingHours: opHrs, ...(params.laborOpts || {}) };

  const laborCost = totalLaborCost(params.laborLines, params.indirectLaborLines, laborOpts);
  // Brock 2026-04-20 — TI upfront rolls into facility rent over the lease term.
  // TI Phase A (2026-06-11): only the provider-funded share (total TI minus
  // the landlord allowance on params.facility) amortizes into rent.
  const tiSplit = tiNetProviderCost(params.equipmentLines, params.facility);
  const tiAmort = tiAmortAnnual(params.equipmentLines, params.contractYears, params.facility);
  const facilityCost = totalFacilityCost(params.facility, params.facilityRate, params.utilityRate, { tiAmort });
  // Equipment seasonal uplift: when caller supplies the MLV (Monthly Labor
  // View output), each line's peak_markup_pct flows through via overflow
  // per calendar month. Without MLV, behavior reduces to the legacy
  // qty × monthlyRate × 12 math.
  const equipmentCost = totalEquipmentCost(params.equipmentLines, {
    mlv: params.mlv,
    shiftsPerDay: params.shifts?.shiftsPerDay || 1,
  });
  const overheadCost = totalOverheadCost(params.overheadLines);
  const vasCost = totalVasCost(params.vasLines);
  const startupAmort = totalStartupAmort(params.startupLines, params.contractYears);
  // 2026-06-10 ground-up assessment Critical #3: capital-equipment acquisition
  // cost previously appeared in NO financial output. The R5 fix (2026-04-29)
  // removed equipmentCapital from totalInvestment on the assumption that
  // equipment amort was flowing through opex — but no path actually included
  // it. Per the engine's documented opex-amortization accounting, the annual
  // amortization (acquisition / amort_years, capital lines only) now flows
  // into totalCost and the revenue gross-up, so pricing recovers capital and
  // NPV genuinely ties to cumFcf.
  const equipmentAmort = totalEquipmentAmort(params.equipmentLines);

  const totalCost = laborCost + facilityCost + equipmentCost + equipmentAmort + overheadCost + vasCost + startupAmort;
  // Reference-aligned cost-plus gross-up: Revenue = Cost / (1 − margin).
  // Applied per-category so the Pricing Schedule + P&L can display line-level
  // gross-up per reference Part I §3.2. The sum is mathematically identical
  // to a one-shot total gross-up; the breakout enables line-level display
  // and per-category audit tie-out.
  const marginFrac = Math.min(0.999, Math.max(0, (params.targetMarginPct || 0) / 100));
  const laborRevenue     = grossUp(laborCost,     marginFrac);
  const facilityRevenue  = grossUp(facilityCost,  marginFrac);
  const equipmentRevenue = grossUp(equipmentCost + equipmentAmort, marginFrac);
  const overheadRevenue  = grossUp(overheadCost,  marginFrac);
  const vasRevenue       = grossUp(vasCost,       marginFrac);
  const startupRevenue   = grossUp(startupAmort,  marginFrac);
  const totalRevenue     = laborRevenue + facilityRevenue + equipmentRevenue
                         + overheadRevenue + vasRevenue + startupRevenue;
  const orders = params.annualOrders || 1;

  return {
    laborCost,
    facilityCost,
    equipmentCost,
    overheadCost,
    vasCost,
    startupAmort,
    totalCost,
    totalRevenue,
    // Per-category revenue breakout (reference Part I §3.2)
    laborRevenue,
    facilityRevenue,
    equipmentRevenue,
    overheadRevenue,
    vasRevenue,
    startupRevenue,
    totalFtes: totalFtes(params.laborLines, params.indirectLaborLines, opHrs),
    costPerOrder: totalCost / orders,
    equipmentCapital: totalEquipmentCapital(params.equipmentLines),
    equipmentAmort,
    startupCapital: totalStartupCapital(params.startupLines),
    // Y0 TI outlay (dock levelers, office build-out, CCTV, etc.). Intentionally
    // NOT folded into equipmentCapital / totalInvestment — TI rolls into
    // facility rent via `tiAmortAnnual`. Surfaced here so Summary can show it
    // as a distinct tile without reaching back into equipmentLines.
    tiUpfront: tiSplit.totalTi,
    // TI Phase A split — landlord share is funded by the allowance and never
    // amortizes; provider share drives tiAmortAnnual above.
    tiLandlordFunded: tiSplit.landlordFunded,
    tiProviderFunded: tiSplit.providerFunded,
    tiAllowanceTotal: tiSplit.allowanceTotal,
    tiAmortAnnual: tiAmort,
    // TI Phase B — Mode B rent credit (informational; gross rent stays in
    // totalCost). netFacilityCost = market-equivalent rent for benchmarking.
    tiRentCreditAnnual: tiRentCreditAnnual(params.facility),
    netFacilityCost: netStorageCost(facilityCost, params.facility),
  };
}

// ============================================================
// MULTI-YEAR PROJECTIONS
// ============================================================

/** @type {Record<string, number>} */
const LEARNING_CURVE_FACTORS = {
  low: 0.95,
  medium: 0.85,
  high: 0.75,
};

/**
 * Weighted-average Year-1 learning-curve productivity factor across labor
 * lines (complexity_tier weighted by annual_hours). Returns 1.0 when no
 * lines. Y1 labor cost multiplier is 1/factor (lower productivity → higher
 * cost). Engine-parity 2026-06-11: shared by the legacy yearly path AND
 * adaptYearlyToMonthlyParams so both engines apply the identical Y1
 * learning multiplier — the monthly engine previously skipped learning
 * entirely (its crew ramp models hiring, not productivity).
 * @param {Array<{annual_hours?:number, complexity_tier?:string}>} laborLines
 * @returns {number}
 */
export function computeYr1LearningFactor(laborLines) {
  if (!Array.isArray(laborLines) || laborLines.length === 0) return 1.0;
  let totalHours = 0;
  let weightedFactor = 0;
  for (const line of laborLines) {
    const h = line.annual_hours || 0;
    const tier = line.complexity_tier || 'medium';
    const f = LEARNING_CURVE_FACTORS[tier] ?? 0.85;
    totalHours += h;
    weightedFactor += h * f;
  }
  return totalHours > 0 ? weightedFactor / totalHours : 1.0;
}

/**
 * Build yearly P&L projections with escalation, volume growth, and learning curve.
 * @param {Object} params
 * @param {number} params.years — contract term in years
 * @param {number} params.baseLaborCost
 * @param {number} params.baseFacilityCost
 * @param {number} params.baseEquipmentCost
 * @param {number} params.baseOverheadCost
 * @param {number} params.baseVasCost
 * @param {number} params.startupAmort
 * @param {number} params.startupCapital
 * @param {number} params.baseOrders
 * @param {number} params.marginPct — target margin (0-based fraction, e.g. 0.12)
 * @param {number} [params.volGrowthPct] — annual volume growth (0-based fraction)
 * @param {number} [params.laborEscPct] — annual labor escalation (0-based fraction)
 * @param {number} [params.uphYoyPct] — annual UPH productivity growth (0-based fraction); offsets labor escalation as a divisor (2026-06-12, escalation.uph_yoy)
 * @param {number} [params.costEscPct] — annual cost escalation (0-based fraction)
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine[]} [params.laborLines] — for learning curve calc
 * @returns {{ projections: import('./types.js?v=20260612-mix1').YearlyProjection[], startupCapital: number }}
 */
export function buildYearlyProjections(params) {
  // Phase 1 routing: when the monthly engine flag is on AND we have the
  // dependencies it needs (periods + ramp + seasonality), build the monthly
  // bundle and aggregate to yearly. Falls back to the legacy yearly path
  // when the flag is off or dependencies are missing.
  const useMonthly =
    !!params.useMonthlyEngine ||
    (typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false);
  // Require periods; ramp + seasonality are defaulted in the adapter if absent.
  if (useMonthly && Array.isArray(params.periods) && params.periods.length > 0) {
    const bundle = monthly.buildMonthlyProjections(adaptYearlyToMonthlyParams(params));
    return {
      projections: monthly.groupMonthlyToYearly(bundle, params.years, {
        baseOrders: params.baseOrders,
        volGrowthPct: params.volGrowthPct,
      }),
      startupCapital: params.startupCapital,
      monthlyBundle: bundle, // exposed for Timeline UI + reconciliation tests
    };
  }

  const {
    years, baseLaborCost, baseFacilityCost, baseEquipmentCost,
    baseOverheadCost, baseVasCost, startupAmort, startupCapital,
    baseOrders, marginPct,
    volGrowthPct = 0, laborEscPct = 0, uphYoyPct = 0, costEscPct = 0.03,
    laborLines = [],
    // Phase 0: per-project tax rate (was hardcoded 25%). Falls back to 25
    // if the model didn't carry one from cost_model_projects.tax_rate_pct.
    taxRatePct = 25,
    // 2026-04-21 audit: facility + equipment escalation were folded into
    // costEscPct for every category. What-If slider for Facility Escalation
    // was silently dead because the engine had no way to escalate facility
    // separately from equipment/overhead. Now optional + fall back to
    // costEscPct for backwards compatibility (existing projects unchanged).
  } = params;
  const facilityEscPct  = params.facilityEscPct  != null ? params.facilityEscPct  : costEscPct;
  const equipmentEscPct = params.equipmentEscPct != null ? params.equipmentEscPct : costEscPct;

  // Learning curve: weighted avg productivity factor for Year 1 (shared
  // helper — adaptYearlyToMonthlyParams passes the same factor to the
  // monthly engine so Y1 labor ties across engines).
  const yr1LearningFactor = computeYr1LearningFactor(laborLines);

  /** @type {import('./types.js?v=20260612-mix1').YearlyProjection[]} */
  const projections = [];
  let cumFcfRun = 0;

  for (let yr = 1; yr <= years; yr++) {
    const volMult = Math.pow(1 + volGrowthPct, yr - 1);
    // 2026-06-12: UPH productivity growth offsets wage escalation — labor
    // cost = base × (1+wage)^n / (1+uph)^n. Default 0 preserves legacy.
    const laborMult = Math.pow(1 + laborEscPct, yr - 1) / Math.pow(1 + Math.max(0, uphYoyPct), yr - 1);
    const costMult = Math.pow(1 + costEscPct, yr - 1);
    const facilityMult  = Math.pow(1 + facilityEscPct,  yr - 1);
    const equipmentMult = Math.pow(1 + equipmentEscPct, yr - 1);

    const learningMult = yr === 1 ? (1 / yr1LearningFactor) : 1.0;
    const labor = baseLaborCost * laborMult * volMult * learningMult;
    const facility = baseFacilityCost * facilityMult;
    const equipment = baseEquipmentCost * equipmentMult;
    // 2026-04-21 audit: overhead had `* Math.pow(1 + volGrowthPct * 0.3, yr - 1)`
    // tacked on — an undocumented hybrid that compounded cost-escalation with
    // 30% of volume growth (10% vol growth → overhead escalated at ~6%/yr
    // instead of 3%). The 0.3 constant was magic. Monthly engine (calc.monthly.js)
    // uses cost-escalation-only; aligning the legacy path here so both
    // branches reconcile on Y2+. If volume-elasticity is genuinely wanted in
    // the future, surface as an explicit heuristic (e.g. `overhead_volume_elasticity_pct`).
    const overhead = baseOverheadCost * costMult;
    const vas = baseVasCost * volMult;
    const startup = startupAmort;
    const totalCost = labor + facility + equipment + overhead + vas + startup;
    // Reference-aligned gross-up: Revenue = Cost / (1 − margin).
    // Per-category breakout exposed via laborRevenue/facilityRevenue/etc. for
    // the Pricing Schedule and P&L line-level display. Sum is identical to the
    // one-shot total gross-up; the breakout enables category-level audit.
    const mFrac = Math.min(0.999, Math.max(0, marginPct || 0));
    const laborRevenue     = labor     / (1 - mFrac);
    const facilityRevenue  = facility  / (1 - mFrac);
    const equipmentRevenue = equipment / (1 - mFrac);
    const overheadRevenue  = overhead  / (1 - mFrac);
    const vasRevenue       = vas       / (1 - mFrac);
    const startupRevenue   = startup   / (1 - mFrac);
    const revenue = laborRevenue + facilityRevenue + equipmentRevenue
                  + overheadRevenue + vasRevenue + startupRevenue;
    // Accounting stack (Brock 2026-04-30 NIGHT — moved Overhead into COGS
    // to match 3PL site-level cost convention; site utilities/supplies/
    // sanitation/security are direct cost of providing the warehousing
    // service, not corporate SG&A. Mgmt-fee overlay remains in SG&A).
    //   COGS = Labor + Facility + Equipment + VAS + Overhead
    //   SG&A = sgaOverlay (mgmt fee / corporate allocation only)
    //   D&A  = startup amortization
    //   GP   = Revenue − COGS
    //   EBITDA = GP − SG&A
    //   EBIT = EBITDA − D&A = Revenue − totalCost (unchanged)
    const cogs         = labor + facility + equipment + vas + overhead;
    const sgaCategory  = 0;
    // M2 (2026-04-21): SG&A overlay per reference Part I §5 — additive to
    // category-based SG&A. Default 0; non-zero when project opts into
    // reference-aligned pricing.
    const sgaOverlay = params.sgaOverlayPct > 0
      ? revenue * Math.min(0.50, Math.max(0, params.sgaOverlayPct / 100))
      : 0;
    const sga          = sgaCategory + sgaOverlay;
    const depreciation = startupAmort;
    const grossProfit  = revenue - cogs;
    const ebitda       = grossProfit - sga;
    const ebit         = ebitda - depreciation;
    const orders = baseOrders * volMult;

    // Phase 0 fix: per-project tax rate (was hardcoded 25%).
    const taxes = Math.max(0, ebit * (taxRatePct / 100));
    const netIncome = ebit - taxes;
    const capex = yr === 1 ? startupCapital : 0;
    // Legacy 8%-of-revenue working-capital proxy. The monthly engine uses a
    // defensible DSO/DPO/labor-accrual model — this path fires only when the
    // monthly engine flag is off or ref_periods is unavailable.
    const WC_PROXY_PCT = 0.08;
    const workingCapitalChange = yr === 1
      ? revenue * WC_PROXY_PCT
      : revenue * volGrowthPct * WC_PROXY_PCT;
    const operatingCashFlow = netIncome + depreciation - workingCapitalChange;
    const freeCashFlow = operatingCashFlow - capex;
    cumFcfRun += freeCashFlow;

    projections.push({
      year: yr, orders, labor, facility, equipment, overhead, vas, startup,
      cogs, sga,
      // M2 (2026-04-21): expose sgaCategory + sgaOverlay separately for P&L UI
      sgaCategory, sgaOverlay,
      totalCost, revenue, grossProfit, ebitda, ebit, depreciation,
      // Per-category revenue breakout (reference Part I §3.2) — enables the
      // customer-facing pricing schedule to display each revenue line grossed
      // up from its own cost category.
      laborRevenue, facilityRevenue, equipmentRevenue, overheadRevenue,
      vasRevenue, startupRevenue,
      taxes, netIncome, capex, workingCapitalChange, operatingCashFlow, freeCashFlow,
      cumFcf: cumFcfRun,
      learningMult,
    });
  }

  return { projections, startupCapital };
}

// ============================================================
// FINANCIAL METRICS
// ============================================================

/**
 * Compute all 12 financial metrics from yearly projections.
 * @param {import('./types.js?v=20260612-mix1').YearlyProjection[]} projections
 * @param {Object} opts
 * @param {number} opts.startupCapital
 * @param {number} opts.discountRatePct — e.g. 10 for 10%
 * @param {number} opts.reinvestRatePct — e.g. 8 for 8%
 * @param {number} opts.totalFtes
 * @param {number} [opts.fixedCost] — annual fixed cost (for operating leverage)
 * @returns {import('./types.js?v=20260612-mix1').FinancialMetrics}
 */
export function computeFinancialMetrics(projections, opts) {
  const years = projections.length;
  if (years === 0) return emptyMetrics();

  const discountRate = (opts.discountRatePct ?? 10) / 100;
  const reinvestRate = (opts.reinvestRatePct ?? 8) / 100;
  const startupCapital   = Number(opts.startupCapital)   || 0;
  const equipmentCapital = Number(opts.equipmentCapital) || 0;
  // Tax rate — needed to compute NOPAT for ROIC. Caller passes the same
  // taxRatePct threaded through buildYearlyProjections. Defaults 25% for
  // back-compat with older call sites.
  const taxRatePct = Number(opts.taxRatePct != null ? opts.taxRatePct : 25);
  // Annual D&A: caller passes equipment amort + startup amort. Used to
  // derive a proper EBITDA when the projections path doesn't carry per-line
  // depreciation (e.g. when cashflow rows predate the cogs/sga split).
  const annualDepreciation = Number(opts.annualDepreciation) || 0;
  // Average net working capital — optional, used to inflate invested capital
  // for a defensible ROIC denominator. If omitted, falls back to a DSO-based
  // proxy derived from Y1 revenue (see below).
  const avgWorkingCapitalOpt = Number(opts.avgWorkingCapital) || null;

  // totalInvestment — the one-time capital outlay at t=0. Used as the anchor
  // for MIRR, NPV, and Payback cashflows.
  //
  // R5 fix (2026-04-29 EVE): previously summed startupCapital + equipmentCapital.
  // That double-counted equipment because equipment cost is ALSO amortized into
  // opex over the contract term in buildYearlyProjections (`baseEquipmentCost
  // = totalEquipmentAmort(...)`) and in calc.monthly.js (LEASED_EQUIP COGS).
  // Including the full equipment purchase at t=0 AND amortizing it through
  // opex meant NPV(5YR) ≈ cumFcf(Y5) − equipmentCapital — explained the
  // -$8.1M-NPV-vs-+$1.05M-cumFcf contradiction observed in the demo audit.
  //
  // Correct treatment for the opex-amortization accounting the rest of the
  // engine uses: only startupCapital is a Y0 outflow. Equipment shows up
  // through its yearly amortization in totalCost / freeCashFlow already.
  // Now NPV @ r=0 ties exactly to cumFcf(Y5), as the inline doc on the
  // cumFcf row promises.
  const totalInvestment = startupCapital;

  const totalRevenue = projections.reduce((s, p) => s + p.revenue, 0);
  const _totalCost = projections.reduce((s, p) => s + p.totalCost, 0);
  const totalEbitRaw = projections.reduce((s, p) => s + (p.ebit || 0), 0);
  const totalEbitdaRaw = projections.reduce((s, p) => s + (p.ebitda || 0), 0);
  // Total Gross Profit: prefer the explicit per-year field (monthly engine
  // now emits the correct value post-2026-04-20 audit). Fall back to
  // Revenue − COGS if the per-year field is absent, else last-resort to the
  // legacy Revenue − totalCost (which is actually EBIT, not GP).
  const totalGpExplicit = projections.reduce((s, p) => s + (p.grossProfit || 0), 0);
  const totalCogs       = projections.reduce((s, p) => s + (p.cogs || 0), 0);
  const totalGrossProfit = totalGpExplicit > 0
    ? totalGpExplicit
    : (totalCogs > 0 ? totalRevenue - totalCogs : totalRevenue - _totalCost);

  // Horizon EBITDA / EBIT come DIRECTLY from the per-year rollup now that
  // the monthly engine and legacy yearly path both emit the correct values
  // (post-2026-04-20 Summary audit). The prior `ebitdaAdjustment` logic
  // silently lifted horizon EBITDA by annualDepreciation × years when the
  // per-year EBITDA didn't already have D&A separated — that created a drift
  // where the Financial Metrics tile disagreed with the P&L EBITDA row right
  // above it. annualDepreciation is now used only for the tooltip; it is
  // NOT folded into the rollup. If D&A should appear on the P&L, it needs
  // to flow through the expense pipeline, not be added back here.
  const totalEbit   = totalEbitRaw;
  const totalEbitda = totalEbitdaRaw;

  const grossMarginPct  = totalRevenue > 0 ? (totalGrossProfit / totalRevenue) * 100 : 0;
  const ebitdaMarginPct = totalRevenue > 0 ? (totalEbitda      / totalRevenue) * 100 : 0;
  const ebitMarginPct   = totalRevenue > 0 ? (totalEbit        / totalRevenue) * 100 : 0;

  // ROIC — NOPAT / Invested Capital (industry-standard). Prior version used
  // pre-tax EBIT, overstating ROIC by the tax shield; and used only startup
  // + equipment for IC, so on thin-capital 3PL deals it read ~1000%+. Now:
  //   NOPAT            = avg annual EBIT × (1 − tax rate)
  //   Invested Capital = startup + equipment + avg NWC (AR less AP)
  // AR proxy uses Y1 revenue × DSO/365 and AP proxy uses Y1 COGS × DPO/365
  // when opts.avgWorkingCapital isn't supplied directly. This keeps ROIC
  // defensible to a reviewer without requiring full WC forecasting.
  const avgAnnualEbit   = totalEbit / years;
  const avgAnnualNopat  = avgAnnualEbit * (1 - taxRatePct / 100);
  // Working-capital estimate — defensibility: use the AR/AP balance level
  // implied by the P&L's own DSO/DPO assumption rather than a parallel
  // formula. The P&L ΔWC row is the CHANGE in working capital per year;
  // the relevant quantity for ROIC is the average AR/AP BALANCE tied up in
  // the deal. At steady state:
  //   AR_balance ≈ annual_revenue × DSO/365
  //   AP_balance ≈ annual_COGS    × DPO/365
  //   NWC_avg    ≈ (horizon_revenue_avg × DSO/365) − (horizon_COGS_avg × DPO/365)
  // Using horizon averages (rather than Y1 only) smooths ramp + growth so
  // the ROIC tile holds against a reviewer's whole-horizon view. If the
  // caller passes `avgWorkingCapital` directly that wins (future hook for
  // cashflow-statement-derived figures).
  let estimatedNWC = avgWorkingCapitalOpt;
  if (estimatedNWC == null) {
    const dsoDays = Number(opts.dsoDays) || 0;
    const dpoDays = Number(opts.dpoDays) || 0;
    if (projections.length > 0 && dsoDays > 0) {
      const avgRevenue = totalRevenue / years;
      const avgCogs    = (totalCogs > 0 ? totalCogs : _totalCost) / years;
      estimatedNWC = Math.max(0, avgRevenue * (dsoDays / 365) - avgCogs * (dpoDays / 365));
    } else {
      estimatedNWC = 0;
    }
  }
  const investedCapitalBase = totalInvestment + estimatedNWC;
  // Fallback: if capital base is still 0 (e.g. all-lease deal, no DSO),
  // use 10% of Y1 revenue as a placeholder WC floor so ROIC doesn't divide
  // by zero and read as a blank tile.
  const investedCapital = investedCapitalBase > 0
    ? investedCapitalBase
    : (projections[0]?.revenue || 0) * 0.10;
  const roicPct = investedCapital > 0 ? (avgAnnualNopat / investedCapital) * 100 : 0;

  // Build the cashflow vector used by MIRR, NPV, and Payback. Use each year's
  // FREE CASH FLOW (after tax, after WC changes, after capex) — previously
  // used grossProfit which was (a) mis-named — actually EBITDA given the
  // pre-audit formula — and (b) ignored taxes, WC drag, and capex. Using
  // FCF makes these metrics tie out to the cashflow statement.
  const fcfSeries = projections.map(p => Number(p.freeCashFlow) || 0);
  // Year-0 anchor: total outflow = startup + equipment capital (pre-go-live).
  // Adjust for capex already reflected inside Y1 FCF — if projections[0].capex
  // equals totalInvestment (monthly engine books capex in Y1), subtracting it
  // here would double-count. Add the capex back to Y1 FCF so the initial
  // outflow lives at t=0 and Y1 reflects purely operating cash generation.
  const y1Capex = Number(projections[0]?.capex) || 0;
  const year0Outflow = -(totalInvestment || y1Capex);
  const y1Operating = fcfSeries.length > 0 ? fcfSeries[0] + y1Capex : 0;
  const cashFlows = [year0Outflow, y1Operating, ...fcfSeries.slice(1)];

  // MIRR — use FCF-based cashflow vector.
  let mirrPct = 0;
  if (totalInvestment > 0 && cashFlows.length > 1) {
    let pvNeg = 0;
    for (let i = 0; i < cashFlows.length; i++) {
      if (cashFlows[i] < 0) pvNeg += cashFlows[i] / Math.pow(1 + discountRate, i);
    }
    const n = cashFlows.length - 1;
    let fvPos = 0;
    for (let i = 0; i < cashFlows.length; i++) {
      if (cashFlows[i] > 0) fvPos += cashFlows[i] * Math.pow(1 + reinvestRate, n - i);
    }
    if (pvNeg < 0 && fvPos > 0) {
      mirrPct = (Math.pow(fvPos / (-pvNeg), 1 / n) - 1) * 100;
    }
  }

  // NPV — discount the FCF-based cashflow vector at the discount rate.
  let npv = 0;
  for (let i = 0; i < cashFlows.length; i++) {
    npv += cashFlows[i] / Math.pow(1 + discountRate, i);
  }

  // Payback period (months) — uses FCF now, not grossProfit. Walks monthly
  // cumulative cash assuming even distribution within each year. If the
  // deal never pays back within the horizon, caps at contractYears × 12.
  let paybackMonths = years * 12;
  let cumCash = -totalInvestment;
  for (let yr = 0; yr < years; yr++) {
    const yearCash = yr === 0 ? y1Operating : fcfSeries[yr];
    const monthlyCash = yearCash / 12;
    for (let m = 0; m < 12; m++) {
      cumCash += monthlyCash;
      if (cumCash >= 0) {
        paybackMonths = yr * 12 + m + 1;
        yr = years; // break outer
        break;
      }
    }
  }

  // Revenue per FTE — Y1 revenue over current total FTE.
  const revenuePerFte = opts.totalFtes > 0 ? projections[0].revenue / opts.totalFtes : 0;

  // Contribution per order — Y1 gross profit ÷ Y1 orders. This is GP/order
  // now that grossProfit is correctly Rev − COGS (was EBITDA-equivalent
  // pre-audit, so the number itself changes on fix, labels in UI adjusted
  // to say "GP / Order" for clarity).
  const yr1 = projections[0];
  const contribPerOrder = yr1.orders > 0 ? (yr1.grossProfit || 0) / yr1.orders : 0;

  // Operating leverage — Y1 fixed cost share of Y1 total cost.
  const opLeveragePct = yr1.totalCost > 0 ? ((opts.fixedCost || 0) / yr1.totalCost) * 100 : 0;

  const contractValue = totalRevenue;

  return {
    grossMarginPct,
    ebitdaMarginPct,
    ebitMarginPct,
    roicPct,
    mirrPct,
    npv,
    paybackMonths,
    revenuePerFte,
    contribPerOrder,
    opLeveragePct,
    contractValue,
    totalInvestment,
    // New: exposed for tooltips / defensibility.
    investedCapital,
    nopat: avgAnnualNopat,
    estimatedNwc: estimatedNWC,
  };
}

/** @returns {import('./types.js?v=20260612-mix1').FinancialMetrics} */
function emptyMetrics() {
  return {
    grossMarginPct: 0, ebitdaMarginPct: 0, ebitMarginPct: 0,
    roicPct: 0, mirrPct: 0, npv: 0, paybackMonths: 0,
    revenuePerFte: 0, contribPerOrder: 0, opLeveragePct: 0,
    contractValue: 0, totalInvestment: 0,
  };
}

/** Sum capex across all projection years */
function totalEquipmentCapitalFromProjections(projections) {
  return projections.reduce((s, p) => s + (p.capex || 0), 0);
}

// ============================================================
// PRICING SCHEDULE
// ============================================================

// CM-PRC-1 — bucket auto-assignment heuristic.
// Maps a cost line to the most likely pricing bucket based on the line's
// metadata. Conservative: returns null when no signal matches, leaving the
// UI dropdown unset rather than guessing wrong. Caller can then prompt user.
//
// Heuristics (most-specific first):
//   1. Line type → category (overhead/startup → mgmt; vas → vas; equipment → first variable bucket)
//   2. Role/title keyword match — pick/pack → pick_pack, receive/inbound → inbound, etc.
//   3. Labor activity (MOST template) keyword match
//   4. Fallback: first non-mgmt/non-startup variable bucket
const ROLE_TO_BUCKET_HINTS = [
  { kws: ['pick', 'pack', 'fulfill', 'order picker', 'packer'],          bucket: 'pick_pack' },
  { kws: ['receive', 'receiver', 'inbound', 'unload', 'put-away', 'putaway', 'dock worker', 'dock supervisor'], bucket: 'inbound' },
  { kws: ['storage', 'replen', 'replenishment', 'cycle count', 'inventory control'], bucket: 'storage' },
  { kws: ['vas', 'kitting', 'kit', 'label', 'rework', 'returns', 'qa', 'quality'], bucket: 'vas' },
  { kws: ['manager', 'supervisor', 'admin', 'clerk', 'lead', 'director', 'foreman'], bucket: 'mgmt_fee' },
];

/**
 * Suggest a pricing bucket for a single cost line.
 * @param {object} line — a labor/equipment/overhead/vas/startup line
 * @param {string} lineType — 'labor' | 'indirectLabor' | 'equipment' | 'overhead' | 'vas' | 'startup'
 * @param {Array<{id:string, name:string, type:string, uom:string}>} buckets
 * @returns {string|null} bucket id (or null if no confident match)
 */
export function suggestBucket(line, lineType, buckets = []) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const has = (id) => buckets.some(b => b && b.id === id);
  const firstNonMgmt = () => {
    const b = buckets.find(b => b && b.id && !/mgmt|management|startup/i.test(b.id));
    return b ? b.id : (buckets[0] ? buckets[0].id : null);
  };
  const firstVariable = () => {
    const b = buckets.find(b => b && b.type === 'variable' && !/mgmt|management|startup/i.test(b.id));
    return b ? b.id : firstNonMgmt();
  };

  // Type-based fast paths
  if (lineType === 'overhead' || lineType === 'startup') return has('mgmt_fee') ? 'mgmt_fee' : firstNonMgmt();
  if (lineType === 'vas') return has('vas') ? 'vas' : firstVariable();
  if (lineType === 'equipment') return firstVariable();

  // Role/title keyword search (labor / indirectLabor)
  const blob = [
    line && line.role,
    line && line.title,
    line && line.position,
    line && line.activity,
    line && line.most_template,
    line && line.most_activity,
    line && line.description,
  ].filter(Boolean).join(' ').toLowerCase();

  if (blob) {
    for (const hint of ROLE_TO_BUCKET_HINTS) {
      if (hint.kws.some(kw => blob.includes(kw))) {
        return has(hint.bucket) ? hint.bucket : firstNonMgmt();
      }
    }
  }

  // No confident match
  return null;
}

/**
 * Auto-assign pricing_bucket on every line that doesn't already have one.
 * Mutates a shallow-cloned model and returns it (caller is responsible for
 * persisting). Lines with an existing pricing_bucket are left untouched.
 *
 * @param {object} model
 * @param {{ overwrite?: boolean }} [opts] — if overwrite=true, replaces existing
 * @returns {{ model: object, assigned: number, skipped: number, unmatched: number }}
 */
export function autoAssignBuckets(model, opts = {}) {
  const overwrite = !!opts.overwrite;
  const buckets = Array.isArray(model && model.pricingBuckets) ? model.pricingBuckets : [];
  if (buckets.length === 0) return { model, assigned: 0, skipped: 0, unmatched: 0 };

  let assigned = 0, skipped = 0, unmatched = 0;
  const sweep = (arr, lineType) => {
    if (!Array.isArray(arr)) return;
    for (const l of arr) {
      if (!l) continue;
      if (l.pricing_bucket && !overwrite) { skipped++; continue; }
      const sug = suggestBucket(l, lineType, buckets);
      if (sug) { l.pricing_bucket = sug; assigned++; }
      else { unmatched++; }
    }
  };
  sweep(model.laborLines,         'labor');
  sweep(model.indirectLaborLines, 'indirectLabor');
  sweep(model.equipmentLines,     'equipment');
  sweep(model.overheadLines,      'overhead');
  sweep(model.vasLines,           'vas');
  sweep(model.startupLines,       'startup');
  return { model, assigned, skipped, unmatched };
}

/**
 * Compute cost allocated to each pricing bucket.
 * @param {Object} params
 * @param {import('./types.js?v=20260612-mix1').PricingBucket[]} params.buckets
 * @param {import('./types.js?v=20260612-mix1').DirectLaborLine[]} params.laborLines
 * @param {import('./types.js?v=20260612-mix1').IndirectLaborLine[]} params.indirectLaborLines
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine[]} params.equipmentLines
 * @param {import('./types.js?v=20260612-mix1').OverheadLine[]} params.overheadLines
 * @param {import('./types.js?v=20260612-mix1').VASLine[]} params.vasLines
 * @param {import('./types.js?v=20260612-mix1').StartupLine[]} params.startupLines
 * @param {number} params.facilityCost — pre-computed facility annual cost
 * @param {number} params.operatingHours
 * @param {Object} [params.laborOpts] — engine labor opts (otPct, shift premiums,
 *   ptoPct, bonusPct, benefitLoadFallback, wageLoadByYear) for full parity with
 *   totalLaborCost; defaults mirror computeSummary's defaults
 * @returns {Record<string, number>} — bucket ID → annual cost
 */
export function computeBucketCosts(params) {
  /** @type {Record<string, number>} */
  const costs = {};
  for (const b of params.buckets) costs[b.id] = 0;
  costs['_unassigned'] = 0;

  const add = (bucketId, amount) => {
    if (bucketId && costs[bucketId] !== undefined) costs[bucketId] += amount;
    else costs['_unassigned'] += amount;
  };

  // Direct + indirect labor — 2026-06-10 ground-up assessment Critical #4:
  // this function previously priced labor with its own formula (burden
  // defaulting to 0% vs the engine's 30%, no temp-agency markup, no OT/
  // shift/PTO/bonus), so bucket costs ran up to ~30% under the P&L labor
  // cost and "recommended" rates under-recovered. Now routes through the
  // engine's own line-annual functions so buckets price the same dollars
  // the P&L books. Callers may pass params.laborOpts for OT/shift/PTO
  // parity; absent that, defaults match the engine's computeSummary
  // defaults (burden fallback 30%, temp markup honored, no OT/shift).
  const laborOpts = params.laborOpts || {};
  for (const l of params.laborLines) {
    add(l.pricing_bucket, directLineAnnual(l, laborOpts));
  }

  for (const l of params.indirectLaborLines) {
    add(l.pricing_bucket, indirectLineAnnual(l, { ...laborOpts, operatingHours: params.operatingHours || 0 }));
  }

  // Equipment
  for (const l of params.equipmentLines) {
    add(l.pricing_bucket, equipLineTableCost(l));
  }

  // Overhead
  for (const l of params.overheadLines) {
    add(l.pricing_bucket, overheadLineAnnual(l));
  }

  // VAS
  for (const l of params.vasLines) {
    add(l.pricing_bucket, vasLineAnnual(l));
  }

  // Startup
  for (const l of params.startupLines) {
    add(l.pricing_bucket, l.annual_amort || 0);
  }

  // Facility cost → configurable target bucket (I-01 edge fix).
  // Resolution order:
  //   1. params.facilityBucketId (if set and matches an existing bucket)
  //   2. 'storage' (legacy default — only if it exists)
  //   3. 'mgmt_fee' (legacy fallback — only if it exists)
  //   4. first non-startup bucket
  //   5. _unassigned (and we mark _facilityOrphan so the UI can flag it)
  let facilityTarget = null;
  const candidate = params.facilityBucketId;
  if (candidate && costs[candidate] !== undefined) {
    facilityTarget = candidate;
  } else if (costs['storage'] !== undefined) {
    facilityTarget = 'storage';
  } else if (costs['mgmt_fee'] !== undefined) {
    facilityTarget = 'mgmt_fee';
  } else {
    const firstNonStartup = (params.buckets || []).find(b => b && b.id && !/startup/i.test(b.id));
    if (firstNonStartup) facilityTarget = firstNonStartup.id;
  }
  if (facilityTarget) {
    costs[facilityTarget] += (params.facilityCost || 0);
  } else {
    costs['_unassigned'] += (params.facilityCost || 0);
    costs['_facilityOrphan'] = (params.facilityCost || 0);
  }
  costs['_facilityTarget'] = facilityTarget;

  // Roll line-level unassigned into mgmt_fee (back-compat behavior).
  // We also preserve `_unassigned` as the standalone orphan amount so the
  // UI can render an explicit "Unassigned" row in the Pricing table even
  // when the rolled-into bucket doesn't exist.
  const unassignedAmount = costs['_unassigned'] || 0;
  if (unassignedAmount > 0) {
    costs['mgmt_fee'] = (costs['mgmt_fee'] || 0) + unassignedAmount;
  }

  return costs;
}

/**
 * Derive recommended per-bucket rates from assigned costs + margin + volume driver.
 *
 * **This is the recommended-pricing engine.** Uses the reference-aligned
 * gross-up form `Revenue = Cost / (1 − margin)` per `grossUp()` above.
 * Each bucket gets a rate that, if consumed literally, produces revenue equal
 * to its cost grossed up to the target margin.
 *
 * The UI labels these rates as "Recommended" in the 3-column Pricing Schedule;
 * analysts can override them via `bucket.rate` (see `enrichBucketsWithDerivedRates`).
 * When an override is present, achieved margin diverges from target and the
 * reframed M3 validator surfaces the gap.
 *
 * @param {Object} params
 * @param {Array} params.buckets — model.pricingBuckets
 * @param {Record<string, number>} params.bucketCosts — output of computeBucketCosts
 * @param {number} params.marginPct — target margin (0-based fraction, e.g. 0.16)
 * @param {Object} [params.model] — full cost-model state; when present, volume-by-UOM
 *   is computed channel-aware via getAnnualVolume(). Phase 3 of volumes-as-nucleus.
 * @param {Array} [params.volumeLines] — legacy fallback when no model is passed
 *   (used only by tests + any pre-Phase-3 caller still on the old shape).
 * @returns {Record<string, { rate: number, annualVolume: number, withMargin: number }>}
 */
export function computeBucketRates(params) {
  const { buckets = [], bucketCosts = {}, marginPct = 0, volumeLines = [], model = null } = params;

  // Volume-by-UOM lookup. Channel-aware path (Phase 3): when a model is
  // provided, each bucket's UOM is resolved by summing every (non-reverse)
  // channel's primary volume converted into that UOM. Multi-channel deals
  // therefore fold DTC orders + B2B orders + EDI orders into the orders UOM
  // total for the order-handling bucket. Legacy path kept for tests + any
  // caller that still passes raw volumeLines.
  const volumeByUom = {};
  if (model) {
    const uomsNeeded = new Set();
    for (const b of buckets) {
      if (b && b.type !== 'fixed' && b.uom) uomsNeeded.add(String(b.uom));
    }
    for (const uom of uomsNeeded) {
      volumeByUom[uom] = _getAnnualVolume(model, uom);
    }
  } else {
    for (const vl of volumeLines) {
      const key = vl.uom || 'each';
      volumeByUom[key] = (volumeByUom[key] || 0) + (Number(vl.volume) || 0);
    }
  }

  // Reference-aligned gross-up: Cost / (1 − margin). Guarded.
  const mFrac = Math.min(0.999, Math.max(0, Number(marginPct) || 0));

  /** @type {Record<string, { rate: number, annualVolume: number, withMargin: number }>} */
  const out = {};
  for (const b of buckets) {
    const cost = bucketCosts[b.id] || 0;
    const withMargin = cost / (1 - mFrac); // <-- gross-up form (was cost * (1+m))
    // Fixed buckets bill monthly: divide annual cost by 12.
    // Variable buckets bill per-unit: divide by annual volume for the bucket's UOM.
    let annualVolume;
    let rate;
    if (b.type === 'fixed') {
      annualVolume = 12;
      rate = withMargin / 12; // monthly fee
    } else {
      annualVolume = Number(b.annualVolume) > 0
        ? Number(b.annualVolume)
        : (volumeByUom[b.uom] || 0);
      rate = annualVolume > 0 ? withMargin / annualVolume : 0;
    }
    out[b.id] = { rate, annualVolume, withMargin };
  }
  return out;
}

/**
 * Return a shallow-copied pricingBuckets array with recommended + effective
 * rates materialized on each bucket.
 *
 * **Recommended/Override semantics (2026-04-21 Margin Handling rewire):**
 *
 *   - `recommendedRate` — ALWAYS the derived `Cost / (1 − margin)` rate. Never
 *     null. Displayed in the Recommended column of the Pricing Schedule.
 *   - `bucket.rate` — the analyst's override. Null/0/unset = "use recommended".
 *     A positive number = "override to this value." Displayed in the Override
 *     column; edits write back here.
 *   - `rate` (on the enriched copy) — the EFFECTIVE rate: override if present,
 *     else recommended. This is what the monthly engine consumes literally to
 *     produce revenue.
 *   - `_rateSource` — `'override'` when bucket.rate is set, else `'recommended'`.
 *     (Legacy values `'explicit'` / `'derived'` retained as aliases — renamed
 *     primary to match UI vocabulary.)
 *   - `overrideReason` — optional free text surfaced in the audit trail when
 *     an override is set. Passed through untouched if present.
 *
 * @param {Object} params — same shape as computeBucketRates
 * @returns {Array} — pricingBuckets with recommendedRate + effective rate
 */
export function enrichBucketsWithDerivedRates(params) {
  const derived = computeBucketRates(params);
  return (params.buckets || []).map(b => {
    const d = derived[b.id] || { rate: 0, annualVolume: 0 };
    // 2026-04-21 PM (UX nit #3): $0 override for free-tier services.
    // Historical semantics (`rate > 0`) still hold — any positive rate is an
    // override, preserving back-compat for projects that never touched the
    // explicit-flag UI. The NEW path is an explicit flag that lets a deliberate
    // $0 also count as an override, so a "free returns processing" bucket can
    // show as overridden with $0.00/return on the customer budget summary.
    // Set by the Pricing Schedule input handler when user types (including 0);
    // cleared by the ↺ Reset button and by any cleared-input event.
    const hasOverride    = b.rateExplicitOverride === true || Number(b.rate) > 0;
    const hasExplicitVol = Number(b.annualVolume) > 0;
    const recommendedRate   = d.rate;
    const effectiveRate     = hasOverride ? Number(b.rate) : recommendedRate;
    return {
      ...b,
      // Effective rate — what the monthly engine reads literally. Matches
      // `rate` field name for back-compat with existing consumers.
      rate: effectiveRate,
      annualVolume: hasExplicitVol ? Number(b.annualVolume) : d.annualVolume,
      // Recommended rate — always populated. UI shows in the Recommended column.
      recommendedRate,
      // Override variance diagnostics — driven off bucket.rate (the user input).
      overrideRate:     hasOverride ? Number(b.rate) : null,
      overrideReason:   b.overrideReason || null,
      overrideDelta:    hasOverride ? (Number(b.rate) - recommendedRate) : 0,
      overrideDeltaPct: hasOverride && recommendedRate > 0
        ? (Number(b.rate) - recommendedRate) / recommendedRate
        : 0,
      // Diagnostic: UI chip label. `'override'` new-primary; `'explicit'` kept
      // as alias for tests that assert on the old value.
      _rateSource:  hasOverride ? 'override' : 'recommended',
      _rateSourceLegacy: hasOverride ? 'explicit' : 'derived',
    };
  });
}

/**
 * Roll up override impact across all buckets: total annual revenue delta vs
 * recommended pricing. Consumed by the Override Variance panel + reframed M3
 * validator.
 *
 * @param {Array} enrichedBuckets — output of enrichBucketsWithDerivedRates
 * @returns {{ totalRecommendedRevenue: number, totalEffectiveRevenue: number,
 *             totalOverrideDelta: number, overriddenBucketCount: number,
 *             perBucket: Array<{ id: string, name: string, recommendedRevenue: number,
 *                                effectiveRevenue: number, deltaAnnual: number,
 *                                deltaPct: number, isOverridden: boolean }> }}
 */
export function computeOverrideImpact(enrichedBuckets = []) {
  let totalRecommendedRevenue = 0;
  let totalEffectiveRevenue   = 0;
  let overriddenBucketCount   = 0;
  const perBucket = [];
  for (const b of enrichedBuckets) {
    const vol = Number(b.annualVolume) || 0;
    const recRev = (Number(b.recommendedRate) || 0) * vol;
    const effRev = (Number(b.rate)            || 0) * vol;
    const isOver = b._rateSource === 'override';
    if (isOver) overriddenBucketCount++;
    totalRecommendedRevenue += recRev;
    totalEffectiveRevenue   += effRev;
    perBucket.push({
      id: b.id,
      name: b.name || b.id,
      recommendedRevenue: recRev,
      effectiveRevenue:   effRev,
      deltaAnnual:        effRev - recRev,
      deltaPct:           recRev > 0 ? (effRev - recRev) / recRev : 0,
      isOverridden:       isOver,
      overrideReason:     b.overrideReason || null,
    });
  }
  return {
    totalRecommendedRevenue,
    totalEffectiveRevenue,
    totalOverrideDelta: totalEffectiveRevenue - totalRecommendedRevenue,
    overriddenBucketCount,
    perBucket,
  };
}

/**
 * SG&A overlay per reference Part I §5.
 *
 *   overlay = sga_pct × (revenue − pass_through_revenue)     when applies_to='net_revenue'
 *   overlay = sga_pct × revenue                              when applies_to='gross_revenue'
 *
 * Applied between Contribution Margin and EBIT on the P&L. Category-based
 * SG&A (OVERHEAD + startup amortization codes) remains as-is on cost rows;
 * this overlay is ADDITIVE and represents unmodeled corporate overhead
 * common in cost-plus RFP responses.
 *
 * Default `sga_overlay_pct = 0` — existing projects see no change. Set to
 * 4.5 for reference-model-aligned pricing.
 *
 * @param {Object} params
 * @param {number} params.revenue — total revenue for the period
 * @param {number} [params.passThroughRevenue=0] — revenue from pass-through / as-incurred / deferred lines
 * @param {number} params.sgaOverlayPct — as percentage (e.g., 4.5)
 * @param {'net_revenue'|'gross_revenue'} [params.appliesTo='net_revenue']
 * @returns {number} overlay $ amount (0 when pct is 0 or revenue base is 0)
 */
export function computeSgaOverlay({ revenue, passThroughRevenue = 0, sgaOverlayPct, appliesTo = 'net_revenue' }) {
  const pct = Math.min(0.50, Math.max(0, (Number(sgaOverlayPct) || 0) / 100));
  if (pct === 0) return 0;
  const r = Number(revenue) || 0;
  const pt = Number(passThroughRevenue) || 0;
  const base = appliesTo === 'gross_revenue' ? r : Math.max(0, r - pt);
  return base * pct;
}

/**
 * Override Implications Panel — closed-form approximation of how a set of
 * pricing-bucket overrides propagates through the 5-year P&L.
 *
 * Assumptions:
 *   - Cost is unchanged (overrides only move revenue, not cost lines)
 *   - SG&A is category-based (not a % of revenue), so SG&A delta = 0
 *   - EBITDA delta ≡ revenue delta (no cost offset)
 *   - Net-income delta = revenue delta × (1 − tax_rate), assuming positive EBIT
 *     both before and after the override
 *   - FCF delta ≈ net-income delta (D&A and WC swings net out over 5 years)
 *   - Variable-bucket overrides scale annually with volume growth; fixed-bucket
 *     overrides are flat. For simplicity we apply volume growth blended —
 *     acceptable because this is a planning-panel estimate, not the canonical
 *     P&L (which comes from buildYearlyProjections).
 *   - 5-year NPV: discount annual FCF deltas at the project's discount rate
 *   - Payback shift: linear approximation from baseline FCF and ΔFCF in Y1
 *
 * For exact numbers, downstream consumers should re-run buildYearlyProjections
 * with overridden vs recommended bucket rates. This helper is the fast-path
 * display for the Pricing Schedule's Implications panel.
 *
 * @param {Object} params
 * @param {number} params.totalOverrideDeltaY1 — annual revenue delta from
 *   computeOverrideImpact (positive = overrides raise revenue; negative = lower)
 * @param {number} params.baselineAnnualRevenue — recommended-rate annual revenue
 * @param {number} params.baselineAnnualCost — annual cost (for EBIT check)
 * @param {number} params.startupCapital — initial outlay (for payback base)
 * @param {number} [params.years=5]
 * @param {number} [params.volGrowthPct=0] — as fraction
 * @param {number} [params.taxRatePct=25] — as %
 * @param {number} [params.discountRatePct=10] — as %
 * @returns {{ y1RevDelta: number, y1EbitdaDelta: number, fiveYrNpvDelta: number,
 *             paybackShiftMonths: number, hasOverrides: boolean }}
 */
export function computeImplicationsImpact(params) {
  const {
    totalOverrideDeltaY1 = 0,
    baselineAnnualRevenue = 0,
    baselineAnnualCost = 0,
    startupCapital = 0,
    years = 5,
    volGrowthPct = 0,
    taxRatePct = 25,
    discountRatePct = 10,
  } = params;

  const hasOverrides = Math.abs(totalOverrideDeltaY1) > 0.5;
  if (!hasOverrides) {
    return { y1RevDelta: 0, y1EbitdaDelta: 0, fiveYrNpvDelta: 0, paybackShiftMonths: 0, hasOverrides: false };
  }

  const taxFrac      = Math.min(0.999, Math.max(0, taxRatePct / 100));
  const discountFrac = Math.max(0, discountRatePct / 100);
  const growthFrac   = volGrowthPct / 100;

  const y1RevDelta    = totalOverrideDeltaY1;
  const y1EbitdaDelta = y1RevDelta; // revenue-only change, cost unchanged

  // 5-yr NPV delta: sum of after-tax FCF deltas, discounted.
  // Guard the tax shield: if baseline EBIT is negative, tax shield doesn't apply
  // the same way. Use simple post-tax form.
  const baselineEbit = baselineAnnualRevenue - baselineAnnualCost;
  const effectiveTax = baselineEbit > 0 ? taxFrac : 0;
  let fiveYrNpvDelta = 0;
  for (let y = 1; y <= years; y++) {
    const revDeltaY = y1RevDelta * Math.pow(1 + growthFrac, y - 1);
    const fcfDeltaY = revDeltaY * (1 - effectiveTax);
    fiveYrNpvDelta += fcfDeltaY / Math.pow(1 + discountFrac, y);
  }

  // Payback shift (months, linear approximation):
  //   baseline payback ≈ startupCapital / annualFcfBaseline
  //   new payback      ≈ startupCapital / (annualFcfBaseline + annualFcfDelta)
  //   Δpayback = new − baseline
  // Uses Y1 FCF as the baseline rate (reasonable over the ramp); if baseline
  // is near-zero the shift is capped.
  const annualFcfBaseline = (baselineAnnualRevenue - baselineAnnualCost) * (1 - effectiveTax);
  const annualFcfDelta    = y1RevDelta * (1 - effectiveTax);
  let paybackShiftMonths = 0;
  if (startupCapital > 0 && Math.abs(annualFcfBaseline) > 1) {
    const baselinePaybackYears = startupCapital / annualFcfBaseline;
    const newFcf = annualFcfBaseline + annualFcfDelta;
    const newPaybackYears = Math.abs(newFcf) > 1 ? startupCapital / newFcf : baselinePaybackYears * 2;
    paybackShiftMonths = (newPaybackYears - baselinePaybackYears) * 12;
    // Guard pathological cases (e.g. override flips FCF sign)
    if (!isFinite(paybackShiftMonths) || Math.abs(paybackShiftMonths) > 600) {
      paybackShiftMonths = Math.sign(paybackShiftMonths || 0) * 600;
    }
  }

  return { y1RevDelta, y1EbitdaDelta, fiveYrNpvDelta, paybackShiftMonths, hasOverrides: true };
}

// ============================================================
// VALIDATION
// ============================================================

// TI-candidate detection (gap-analysis items 10/13, 2026-06-11).
// Asset Defaults Guidance: dock hardware, office/break-room build-out and
// ELECTRONIC security (CCTV / access control / alarm) belong in TI — they
// amortize through facility rent, not equipment capital/lease. PHYSICAL
// security (fence, gate, guard shack) is legitimately Capital and excluded.
const TI_CANDIDATE_PATTERNS = [
  /dock\s*(leveler|seal|restraint|light|bumper|package|door)/i,
  /build[\s-]?out/i,
  /(office|break\s*room|breakroom)\s*(fit|finish|improvement)/i,
  /cctv|access\s*control|(card|badge)\s*reader|burglar|alarm\s*(panel|system)?|motion\s*detector|security\s*camera/i,
  /freezer\s*(room|build)|cold\s*storage\s*build|temp(erature)?[\s-]control/i,
];
const TI_CANDIDATE_EXCLUSIONS = /fence|fencing|\bgate\b|guard\s*(shack|booth|house)|hvls/i;

/**
 * True when a non-TI equipment line *looks like* Tenant Improvement scope
 * and is probably misclassified as capital / lease / purchase. Lines already
 * financed as 'ti' or 'service' never flag. Category 'Dock' or 'Office' is a
 * strong signal on its own; otherwise the name must match a TI pattern.
 * @param {import('./types.js?v=20260612-mix1').EquipmentLine} line
 * @returns {boolean}
 */
export function isTiCandidate(line) {
  if (!line) return false;
  const acqType = normalizeAcqType(line.acquisition_type);
  if (acqType === 'ti' || acqType === 'service') return false;
  const hay = `${line.equipment_name || ''} ${line.category || ''}`;
  if (TI_CANDIDATE_EXCLUSIONS.test(hay)) return false;
  const cat = (line.category || '').toLowerCase();
  if (cat === 'dock' || cat === 'office') return true;
  return TI_CANDIDATE_PATTERNS.some(re => re.test(hay));
}

/**
 * Validate a cost model and return warnings.
 * @param {import('./types.js?v=20260612-mix1').CostModelData} model
 * @param {Object} [opts]
 * @param {number} [opts.operatingHours]
 * @returns {import('./types.js?v=20260612-mix1').ValidationWarning[]}
 */
export function validateModel(model, opts = {}) {
  /** @type {import('./types.js?v=20260612-mix1').ValidationWarning[]} */
  const warnings = [];
  const pd = model.projectDetails || {};
  const fin = model.financial || {};

  // Setup
  if (!pd.name) {
    warnings.push({ level: 'warning', area: 'setup', message: 'Project name is empty' });
  }
  if (!pd.market) {
    warnings.push({ level: 'warning', area: 'setup', message: 'No market selected' });
  }
  if (!pd.contractTerm || pd.contractTerm < 1) {
    warnings.push({ level: 'error', area: 'setup', message: 'Contract term must be at least 1 year' });
  }

  // Facility
  if (!model.facility?.totalSqft || model.facility.totalSqft <= 0) {
    warnings.push({ level: 'error', area: 'facility', message: 'Facility square footage is zero' });
  }

  // Labor
  if (!model.laborLines?.length) {
    warnings.push({ level: 'warning', area: 'labor', message: 'No direct labor lines defined' });
  }
  for (const line of model.laborLines || []) {
    if ((line.hourly_rate || 0) <= 0) {
      warnings.push({ level: 'warning', area: 'labor', message: `"${line.activity_name}" has $0 hourly rate` });
    }
    if ((line.annual_hours || 0) <= 0 && (line.volume || 0) > 0) {
      warnings.push({ level: 'info', area: 'labor', message: `"${line.activity_name}" has volume but 0 annual hours — check UPH` });
    }
  }

  // Equipment
  for (const line of model.equipmentLines || []) {
    const acqType = normalizeAcqType(line.acquisition_type);
    if ((acqType === 'capital' || acqType === 'ti') && (line.acquisition_cost || 0) <= 0) {
      warnings.push({ level: 'warning', area: 'equipment', message: `"${line.equipment_name}" is marked ${acqType === 'capital' ? 'Capital' : 'TI'} but has $0 acquisition cost — check the catalog for a default` });
    }
    // TI-candidate validator (2026-06-11): dock hardware / build-out /
    // electronic security financed as capital or lease is the classic
    // misclassification from the Asset Defaults Guidance audit — it inflates
    // equipment capital/opex and skips the rent-amortization path.
    if (isTiCandidate(line)) {
      warnings.push({ level: 'warning', area: 'equipment', message: `"${line.equipment_name}" is financed as ${acqType === 'capital' ? 'Capital' : 'Lease'} but looks like Tenant Improvement scope (dock hardware / build-out / electronic security) — consider TI so it amortizes through facility rent per Asset Defaults Guidance` });
    }
  }

  // Financial
  const targetMarginPct = Number(fin.targetMargin || 0);
  if (targetMarginPct <= 0) {
    warnings.push({ level: 'warning', area: 'financial', message: 'Target margin is 0% — revenue will equal cost' });
  }
  if (targetMarginPct > 50) {
    warnings.push({ level: 'info', area: 'financial', message: `Target margin of ${targetMarginPct}% is unusually high for 3PL` });
  }

  // M3 reframed (2026-04-21): achieved margin vs target, driven by overrides.
  // Under pure cost-plus (no overrides), achieved ≡ target by construction —
  // validator is silent. When any bucket carries an override, we compute the
  // bucket-weighted achieved margin and flag 2pp / 5pp shortfalls.
  //
  // Thresholds per MD4 recommendation: warn at −2pp, error at −5pp.
  const buckets = model.pricingBuckets || [];
  if (buckets.length > 0 && targetMarginPct > 0) {
    // Mirrors enrichBucketsWithDerivedRates (calc.js:L1884): a deliberate $0
    // override (free-tier service) carries rateExplicitOverride=true and must
    // trip the validator even though its numeric rate is 0.
    const hasAnyOverride = buckets.some(b =>
      b.rateExplicitOverride === true || Number(b.rate) > 0);
    if (hasAnyOverride) {
      // Re-derive enriched buckets against current cost rollup so the
      // validator matches what the Pricing Schedule UI displays.
      const hrsForValidator = opts.operatingHours || operatingHours(model.shifts || {});
      const startupWithAmort = (model.startupLines || []).map(l => ({
        ...l,
        annual_amort: (l.one_time_cost || 0) / Math.max(1, pd.contractTerm || 5),
      }));
      // Facility cost may be unknown in the validator context (we don't have
      // refData here). Pass 0 — any facility routing noise is dwarfed by the
      // override delta we're checking against.
      const bucketCosts = computeBucketCosts({
        buckets,
        laborLines: model.laborLines || [],
        indirectLaborLines: model.indirectLaborLines || [],
        equipmentLines: model.equipmentLines || [],
        overheadLines: model.overheadLines || [],
        vasLines: model.vasLines || [],
        startupLines: startupWithAmort,
        facilityCost: 0,
        operatingHours: hrsForValidator,
        facilityBucketId: fin.facilityBucketId || null,
      });
      const enriched = enrichBucketsWithDerivedRates({
        buckets, bucketCosts,
        marginPct: targetMarginPct / 100,
        volumeLines: model.volumeLines || [],
        model,
      });
      const impact = computeOverrideImpact(enriched);
      const totalCost = Object.entries(bucketCosts).reduce(
        (s, [k, v]) => (typeof v === 'number' && !k.startsWith('_')) ? s + v : s, 0);
      const ach = achievedMargin(impact.totalEffectiveRevenue, totalCost) * 100;
      const deltaPP = ach - targetMarginPct;
      const overrideCount = impact.overriddenBucketCount;
      if (deltaPP <= -5) {
        warnings.push({
          level: 'error',
          area: 'financial',
          message: `Achieved margin ${ach.toFixed(1)}% is ${Math.abs(deltaPP).toFixed(1)}pp below ${targetMarginPct}% target due to ${overrideCount} bucket override${overrideCount === 1 ? '' : 's'}. Review Pricing Schedule.`,
        });
      } else if (deltaPP <= -2) {
        warnings.push({
          level: 'warning',
          area: 'financial',
          message: `Achieved margin ${ach.toFixed(1)}% is ${Math.abs(deltaPP).toFixed(1)}pp below ${targetMarginPct}% target due to ${overrideCount} bucket override${overrideCount === 1 ? '' : 's'}.`,
        });
      }
    }
  }

  // Volumes — channel-aware (Phase 3 of volumes-as-nucleus). Warn when no
  // outbound channel carries any positive primary volume. This catches the
  // single-channel "user forgot to enter volumes" case AND the multi-channel
  // "all channels are zero" case in one check.
  const outboundChannels = _getOutboundChannels(model);
  const hasOutboundVolume = outboundChannels.some(c => (Number(c.primary?.value) || 0) > 0);
  if (!hasOutboundVolume) {
    warnings.push({ level: 'warning', area: 'volumes', message: 'No primary outbound volume defined — unit cost metrics will be inaccurate' });
  }

  return warnings;
}

// ============================================================
// SENSITIVITY ANALYSIS
// ============================================================

/**
 * Compute sensitivity table: impact of ±adjustment on total cost.
 * @param {Object} baseCosts — { labor, facility, equipment, overhead, vas, startup }
 * @param {number} baseOrders
 * @param {number[]} [adjustments] — e.g. [-0.10, -0.05, 0.05, 0.10]
 * @returns {Array<{ label: string, adjustments: Array<{ pct: number, totalCost: number, costPerOrder: number, delta: number }> }>}
 */
export function sensitivityTable(baseCosts, baseOrders, adjustments = [-0.10, -0.05, 0.05, 0.10], opts = {}) {
  const baseTotalCost = baseCosts.labor + baseCosts.facility + baseCosts.equipment +
    baseCosts.overhead + baseCosts.vas + baseCosts.startup;
  // Baseline revenue: prefer the caller-supplied Y1 P&L revenue (so Sensitivity
  // ties out to the Multi-Year P&L row directly above it), else fall back to
  // the cost+margin assumption. On projects with explicit pricing-bucket rates,
  // the P&L revenue drifts from cost × (1+margin) — this keeps the sensitivity
  // footnote "Base GP: $X" consistent with the table.
  const marginPct = Number(opts.marginPct) || 0;
  const marginFrac = marginPct / 100;
  // 2026-04-21 audit: fallback used the legacy markup formula
  // `cost × (1 + m)` — on 16% margin this is 1.16× vs the correct cost-plus
  // 1.19× (23% skew in the baseline at the extremes). Aligned with grossUp
  // at L46-48 so sensitivity and Pricing Schedule share a baseline.
  const baseRevenue = (opts.baseRevenue != null && Number(opts.baseRevenue) > 0)
    ? Number(opts.baseRevenue)
    : baseTotalCost / Math.max(0.001, 1 - Math.min(0.999, Math.max(0, marginFrac)));
  const baseGP = baseRevenue - baseTotalCost;

  const burdenPct  = Number(opts.burdenPct)  || 0;
  const benefitPct = Number(opts.benefitPct) || 0;
  const burdenFraction = (burdenPct + benefitPct) > 0
    ? (burdenPct / 100) / (1 + (burdenPct + benefitPct) / 100)
    : 0.20;

  // Per-bucket volume elasticity — only labor, VAS, overhead (partial), and
  // equipment (partial) move with order volume. Facility + startup do not.
  const VOLUME_ELASTICITY = { labor: 1.0, vas: 1.0, overhead: 0.5, equipment: 0.15, facility: 0, startup: 0 };

  const drivers = [
    { label: 'Volume',        kind: 'volume' },
    { label: 'Labor Rate',    kind: 'labor_rate' },
    { label: 'Burden %',      kind: 'burden' },
    { label: 'Facility Rate', kind: 'facility_rate' },
  ];

  return drivers.map(driver => ({
    label: driver.label,
    kind: driver.kind,
    adjustments: adjustments.map(adj => {
      const adjusted = { ...baseCosts };
      if (driver.kind === 'volume') {
        for (const bucket of Object.keys(VOLUME_ELASTICITY)) {
          const e = VOLUME_ELASTICITY[bucket];
          adjusted[bucket] = baseCosts[bucket] * (1 + adj * e);
        }
      } else if (driver.kind === 'labor_rate') {
        adjusted.labor = baseCosts.labor * (1 + adj);
      } else if (driver.kind === 'burden') {
        adjusted.labor = baseCosts.labor * (1 + adj * burdenFraction);
      } else if (driver.kind === 'facility_rate') {
        adjusted.facility = baseCosts.facility * (1 + adj);
      }
      const totalCost = adjusted.labor + adjusted.facility + adjusted.equipment +
        adjusted.overhead + adjusted.vas + adjusted.startup;
      const orders = driver.kind === 'volume' ? baseOrders * (1 + adj) : baseOrders;
      // Revenue model: for a 3PL, pricing is cost+margin, so Volume scales
      // revenue proportionally (order_rate × $/order). Rate/Burden/Facility
      // don't touch revenue in this scope — they're internal cost levers.
      const revenue = driver.kind === 'volume'
        ? baseRevenue * (1 + adj)
        : baseRevenue;
      const grossProfit = revenue - totalCost;
      return {
        pct: adj * 100,
        totalCost,
        revenue,
        grossProfit,
        costPerOrder: orders > 0 ? totalCost / orders : 0,
        // Legacy field — cost delta. Kept for back-compat but UI should
        // prefer gpDelta for correct color semantics.
        delta: totalCost - baseTotalCost,
        // Preferred: gross-profit delta. POSITIVE = good for the 3PL —
        // lets the UI color with positiveIsGood=true consistently.
        gpDelta: grossProfit - baseGP,
        revenueDelta: revenue - baseRevenue,
      };
    }),
  }));
}

// ============================================================
// FORMATTING HELPERS (pure — no DOM)
// ============================================================

/**
 * Format a number as currency.
 * @param {number} value
 * @param {Object} [opts]
 * @param {number} [opts.decimals]
 * @param {boolean} [opts.compact] — use K/M suffixes
 * @returns {string}
 */
// ============================================================
// Display formatting — delegated to shared/format.js (S16)
// ============================================================
// formatCurrency / formatPct / formatNumber used to live here as
// duplicated copies across cost-model / network-opt / fleet-modeler /
// deal-manager / warehouse-sizing calc.js. Consolidated 2026-05-11
// into shared/format.js — these re-exports preserve every existing
// consumer call site (`calc.formatCurrency(...)` etc.) so the move is
// a no-op at every call site.
export { formatCurrency, formatPct, formatNumber } from '../../shared/format.js';



// ============================================================
// AUTO-GENERATION — INDIRECT LABOR
// ============================================================

/**
 * Auto-generate indirect labor lines based on span-of-control heuristics.
 *
 * Phase 6: accepts an optional `planningRatiosMap` (flat code→{value, source}
 * map, shape returned by `resolvePlanningRatios`). When supplied, spans of
 * control pull from the ref_planning_ratios catalog (with per-project
 * overrides) instead of the legacy hardcoded divisors. When NOT supplied,
 * behavior is unchanged from prior versions.
 *
 * @param {Object} state — { laborLines, indirectLaborLines, facility, shifts, financial }
 * @param {Object} [opts]
 * @param {Object<string, {value: any, source: string}>} [opts.planningRatiosMap]
 * @returns {import('./types.js?v=20260612-mix1').IndirectLaborLine[]}
 */
export function autoGenerateIndirectLabor(state, opts = {}) {
  const lines = [];
  const opHrs = operatingHours(state.shifts || {});

  // Calculate total direct FTEs
  const totalDirectFtes = (state.laborLines || []).reduce((sum, l) => {
    if (!opHrs || opHrs <= 0) return sum;
    return sum + ((l.annual_hours || 0) / opHrs);
  }, 0);

  const totalDirectHC = Math.ceil(totalDirectFtes);

  // Helper to pull a span-of-control from the planning ratios catalog.
  // Falls back to the legacy hardcoded divisor when no catalog is provided
  // or when the code is missing / unusable (0, NaN, non-numeric).
  //
  // Q4 (2026-04-20): when the catalog IS used, also return the resolved
  // planning-ratio definition + source so we can stamp provenance onto
  // the generated line (UI surfaces it as an ℹ chip).
  const prMap = opts.planningRatiosMap || null;
  /**
   * Resolve a planning-ratio code. Returns { value, source, def } where
   * source ∈ 'catalog' | 'override' | 'legacy'.
   * @param {string} code
   * @param {number|null} fallback
   */
  const pr = (code, fallback) => {
    if (!prMap) return { value: fallback, source: 'legacy', def: null };
    const r = prMap[code];
    if (!r || r.value === null || r.value === undefined) {
      return { value: fallback, source: 'legacy', def: null };
    }
    const n = Number(r.value);
    if (!Number.isFinite(n) || n <= 0) {
      return { value: fallback, source: 'legacy', def: null };
    }
    return { value: n, source: r.source || 'catalog', def: r.def || null };
  };

  // Helper to add indirect line. When `heuristic` is supplied, stamps
  // `_heuristic` metadata onto the line so the Indirect Labor UI can
  // render a provenance chip (ratio name, source, value used, citation).
  const addRole = (name, headcount, rate, burden = 30, heuristic = null) => {
    if (headcount > 0) {
      const line = {
        role_name: name,
        headcount: Math.ceil(headcount),
        hourly_rate: rate,
        burden_pct: burden,
      };
      if (heuristic) line._heuristic = heuristic;
      lines.push(line);
    }
  };
  /**
   * Shape a heuristic metadata object from a resolved ratio + the legacy
   * fallback value + a friendly label for the span-of-control ratio used.
   * When `value` came from the catalog (r.source === 'catalog' or 'override')
   * we include the source citation so the UI can explain WHERE the 15:1 or
   * 75:1 figure came from.
   */
  const makeHeuristic = (code, resolved, legacyValue, label) => ({
    code,
    label,                                  // "Team Lead span of control"
    value: resolved.value,                  // 15 (catalog) or 8 (legacy)
    source: resolved.source,                // 'catalog' | 'override' | 'legacy'
    legacy_value: legacyValue,              // 8 (so UI can show "legacy default")
    source_detail: resolved.def?.source_detail || null,
    source_date: resolved.def?.source_date || null,
    source_citation: resolved.def?.source || null,
    ratio_id: resolved.def?.id || null,
  });

  // 1. Team Leads: catalog 15 per Team Lead; legacy 8.
  if (totalDirectFtes >= 3) {
    const r = pr('indirect.team_lead.span', 8);
    addRole('Team Lead', Math.ceil(totalDirectFtes / r.value), 22, 30,
      makeHeuristic('indirect.team_lead.span', r, 8, 'Team Lead span of control (direct FTEs per lead)'));
  }

  // 2. Supervisors: catalog 25 per Ops Supervisor; legacy 15.
  if (totalDirectFtes >= 8) {
    const r = pr('salary.operations_supervisor.span', 15);
    addRole('Supervisor', Math.ceil(totalDirectFtes / r.value), 28, 30,
      makeHeuristic('salary.operations_supervisor.span', r, 15, 'Ops Supervisor span of control'));
  }

  // 3. Operations Manager: catalog 75 per mgr; legacy piecewise (1 at 20 FTE, 2 at 80 FTE).
  if (totalDirectFtes >= 20) {
    const r = pr('salary.operations_manager.span', null);
    const opsManagers = r.value
      ? Math.max(1, Math.ceil(totalDirectFtes / r.value))
      : (totalDirectFtes >= 80 ? 2 : 1);
    // Legacy value here is a piecewise rule, not a single divisor — show "piecewise" in legacy_value
    addRole('Operations Manager', opsManagers, 42, 30,
      makeHeuristic('salary.operations_manager.span', r, 'piecewise (1 at 20 FTE, 2 at 80 FTE)', 'Operations Manager span of control'));
  }

  // 4. Inventory Control: catalog 50 per IC Manager; legacy 25.
  if (totalDirectFtes > 0) {
    const r = pr('salary.inventory_manager.span', 25);
    addRole('Inventory Control', Math.ceil(totalDirectFtes / r.value), 20, 30,
      makeHeuristic('salary.inventory_manager.span', r, 25, 'Inventory Control span of control'));
  }

  // 5. Receiving/Shipping Clerk: 1 per shift (fixed legacy rule, no catalog)
  const shiftsPerDay = state.shifts?.shiftsPerDay || 1;
  addRole('Receiving / Shipping Clerk', Math.max(1, shiftsPerDay), 18, 30,
    { code: 'indirect.recv_ship_clerk.per_shift', label: '1 clerk per shift', value: 1, source: 'legacy', legacy_value: 1 });

  // 6. Customer Service: 1 per 500K orders/yr — channel-aware aggregate
  // (Phase 3 of volumes-as-nucleus). Sums each non-reverse channel's derived
  // orders, override-aware. Single-channel deals match the legacy filter on
  // isOutboundPrimary; multi-channel deals now correctly fold DTC + B2B.
  const annualOrders = _getAggregateDerived(state, 'orders');
  {
    // Item 31 closure (2026-06-11): orders-per-CSR now resolves from the
    // planning-ratios catalog (override > catalog > legacy 500K).
    const r = pr('indirect.customer_service.per_500k_orders', 500000);
    if (annualOrders >= r.value) {
      addRole('Customer Service Rep', Math.ceil(annualOrders / r.value), 18, 30,
        makeHeuristic('indirect.customer_service.per_500k_orders', r, 500000, '1 CS rep per N orders/yr (channel-aware aggregate)'));
    }
  }

  // 7. Returns Processor: 1 per 100K return ORDERS/yr — channel-aware (Phase 3).
  // 2026-04-30 (G9): switched from return UNITS to return ORDERS. A
  // returns processor handles return shipments (~30-50 return-orders/hr =
  // ~100K return-orders/year), not individual items. Counting in units
  // over-sized this role 5-15× on multi-channel deals where B2B's high
  // units-per-order multiplied returns enormously (a 72M-unit B2B channel
  // with 2% returns produced 1.44M return UNITS = 14 imaginary FTEs).
  // Each channel contributes orders × that channel's own returnsPercent.
  const estimatedReturnOrders = _getAggregateDerived(state, 'returnOrders');
  {
    // Item 31 closure (2026-06-11): return-orders-per-processor from catalog.
    const r = pr('indirect.returns_processor.per_100k_return_orders', 100000);
    if (estimatedReturnOrders >= r.value) {
      const h = makeHeuristic('indirect.returns_processor.per_100k_return_orders', r, 100000, '1 processor per N return orders/yr (per-channel returns%)');
      // Preserve the channel-aware driver signal for the inspector when no
      // catalog value is in play (legacy behavior surfaced 'channels').
      if (h.source === 'legacy') h.source = 'channels';
      addRole('Returns Processor', Math.ceil(estimatedReturnOrders / r.value), 17, 30, h);
    }
  }

  // 8. IT Support: 0.5-2 based on FTE count
  if (totalDirectFtes >= 20) {
    const itHeadcount = Math.max(0.5, Math.min(2, Math.ceil(totalDirectFtes / 40)));
    addRole('IT Support', itHeadcount, 35, 30,
      { code: 'indirect.it_support.per_40_ftes', label: '0.5–2 IT per direct FTE tier', value: 40, source: 'legacy', legacy_value: 40 });
  }

  // 9. Maintenance: 1 per 100K sqft
  const totalSqft = state.facility?.totalSqft || 0;
  {
    // Item 31 closure (2026-06-11): sqft-per-maintenance-tech from catalog.
    const r = pr('indirect.maintenance.per_100k_sqft', 100000);
    if (totalSqft >= r.value) {
      addRole('Maintenance Technician', Math.ceil(totalSqft / r.value), 25, 30,
        makeHeuristic('indirect.maintenance.per_100k_sqft', r, 100000, '1 maintenance tech per N sqft'));
    }
  }

  // 10. Janitorial: 1 per 150K sqft (often outsourced, include as benchmark)
  if (totalSqft >= 150000) {
    addRole('Janitorial Supervisor', Math.ceil(totalSqft / 150000), 20, 30,
      { code: 'indirect.janitorial.per_150k_sqft', label: '1 janitorial supervisor per 150K sqft', value: 150000, source: 'legacy', legacy_value: 150000 });
  }

  // 11. Account Manager: 0.5-1 based on FTE
  if (totalDirectFtes >= 10) {
    addRole('Account Manager', totalDirectFtes >= 50 ? 1 : 0.5, 40, 30,
      { code: 'indirect.account_manager.tier', label: '0.5 AM at 10 FTE, 1 AM at 50+ FTE', value: 50, source: 'legacy', legacy_value: 50 });
  }

  // 12. General Manager: 1 if total HC >= 50
  if (totalDirectHC + lines.reduce((s, l) => s + l.headcount, 0) >= 50) {
    addRole('General Manager', 1, 55, 30,
      { code: 'indirect.general_manager.threshold', label: '1 GM when total HC ≥ 50', value: 50, source: 'legacy', legacy_value: 50 });
  }

  return lines;
}

// ============================================================
// AUTO-GENERATION — EQUIPMENT
// ============================================================

/**
 * Auto-generate equipment lines based on labor, facility, and volume.
 * @param {Object} state
 * @returns {import('./types.js?v=20260612-mix1').EquipmentLine[]}
 */
export function autoGenerateEquipment(state, opts = {}) {
  const lines = [];
  const opHrs = operatingHours(state.shifts || {});
  const totalDirectFtes = (state.laborLines || []).reduce((sum, l) => {
    if (!opHrs || opHrs <= 0) return sum;
    return sum + ((l.annual_hours || 0) / opHrs);
  }, 0);
  const totalIndirectHC = (state.indirectLaborLines || []).reduce((s, l) => s + (l.headcount || 0), 0);
  const totalHC = Math.ceil(totalDirectFtes) + totalIndirectHC;
  const sqft = state.facility?.totalSqft || 0;
  const spareFactor = 1.15;
  const shiftsPerDay = Math.max(1, Number(state.shifts?.shiftsPerDay) || 1);

  // Brock 2026-04-20 — when an MLV (Monthly Labor View) summary is passed
  // in, MHE quantities come from PEAK-MONTH FTE per assigned mhe_type ÷
  // shifts/day rather than the ceil(totalFTE/3) × 1.15 heuristic that was
  // producing 36 Reach Trucks for Wayfair when the shift-math says 6.
  // The MLV's `by_mhe[type]` is already sum-of-fractional-FTEs for that
  // type on a given calendar month; dividing by shifts gives "units you
  // need on the floor at once" because each FTE is on one shift at a time.
  //
  // Falls back to the legacy heuristic when MLV is absent (e.g., autogen
  // fired before labor is set up) or when the labor lines don't carry
  // `mhe_type` so nothing aggregates under the type key.
  const mlv = opts.mlv || null;
  const peakMheFteFromMlv = (type) => {
    if (!mlv?.months || !Array.isArray(mlv.months) || mlv.months.length === 0) return null;
    let peak = 0;
    for (const m of mlv.months) {
      const f = (m.by_mhe && m.by_mhe[type]) || 0;
      if (f > peak) peak = f;
    }
    return peak > 0 ? peak : null; // null = "no signal, use heuristic"
  };

  // Phase 2d (2026-04-22): derive the peak / steady / seasonal signal per
  // MHE type from the MLV. Aggregates across calendar years by calendar_month
  // (1-12) — same pattern as equipmentOverflowByLine — so a 5-year contract
  // with Y5 peak higher than Y1 still surfaces the worst-case rental sizing.
  //
  // Returns:
  //   peak           — max monthly FTE (already available)
  //   steady         — min of non-zero monthly FTEs (represents baseline op)
  //   seasonalMonths — calendar_months 1-12 where FTE > steady × 1.25
  //
  // Threshold tuning (2026-04-22 PM, Brock): 1.10 was too permissive — on a
  // smoothly-ramping ecom profile (Wayfair-style, where Jul-Sep rise 15-20%
  // above Feb baseline as BTS/early-holiday kick in), 1.10 flagged 6 months
  // as seasonal when operators only rent for 3 months of true Q4 peak.
  // 1.25 cleanly separates "summer ramp" from "Q4 spike" and matches
  // industry convention that rentals are a seasonal flex tool, not a
  // shoulder-season capacity boost.
  //
  // Returns null when MLV is absent OR no months carry this type (auto-gen
  // then falls through to the legacy heuristic path for owned-only sizing).
  const SEASONAL_THRESHOLD = 1.25;
  const mheSignalFromMlv = (type) => {
    if (!mlv?.months || !Array.isArray(mlv.months) || mlv.months.length === 0) return null;
    const byCalMonth = Array(12).fill(0);
    for (const m of mlv.months) {
      const cm = m.calendar_month;
      if (!cm || cm < 1 || cm > 12) continue;
      const f = (m.by_mhe && m.by_mhe[type]) || 0;
      if (f > byCalMonth[cm - 1]) byCalMonth[cm - 1] = f;
    }
    const nonZero = byCalMonth.filter(f => f > 0);
    if (nonZero.length === 0) return null;
    const peak = Math.max(...nonZero);
    const steady = Math.min(...nonZero);
    const threshold = steady * SEASONAL_THRESHOLD;
    const seasonalMonths = [];
    for (let i = 0; i < 12; i++) if (byCalMonth[i] > threshold) seasonalMonths.push(i + 1);
    return { peak, steady, seasonalMonths };
  };

  // Peak direct-labor FTE across all types — drives IT equipment sizing
  // (Phase 2d: IT always sized to peak, not totalDirectFtes which is a
  // horizon average). Returns totalDirectFtes as a safe fallback when
  // MLV is unavailable.
  const peakDirectFteFromMlv = () => {
    if (!mlv?.months || !Array.isArray(mlv.months) || mlv.months.length === 0) return totalDirectFtes;
    let peak = 0;
    for (const m of mlv.months) {
      const t = Number(m.total_fte) || 0;
      if (t > peak) peak = t;
    }
    return peak > 0 ? peak : totalDirectFtes;
  };

  // Helper — accepts explicit financing type per the Asset Defaults Guidance
  // (2026-04-20). Legacy callers without `financing` still work via heuristic
  // fallback, but the auto-gen rules below now always pass the type.
  //
  // Phase 2a (2026-04-22): also stamps `line_type` on every generated row so
  // newly auto-generated projects carry the peak-capacity classification from
  // day 1. Mapping mirrors the back-fill adapter in api.js.
  const categoryToLineType = (c) => {
    const cat = String(c || '').trim().toLowerCase();
    if (cat === 'mhe') return 'owned_mhe';
    if (cat === 'it')  return 'it_equipment';
    return 'owned_facility';
  };
  const addEquip = (name, category, qty, monthlyCost = 0, acquisitionCost = 0, monthlyMaint = 0, drivenBy = '', financing = null, amortYears = 5, heuristic = null) => {
    if (qty > 0) {
      // Heuristic fallback: if no financing type supplied, infer from cost shape.
      // Acquisition cost present → capital; else → lease. Legacy call sites.
      const acq_type = financing || (acquisitionCost > 0 ? 'capital' : 'lease');
      const line = {
        equipment_name: name,
        category: category || 'Other',
        line_type: categoryToLineType(category),
        quantity: Math.ceil(qty),
        acquisition_type: acq_type,
        monthly_cost: monthlyCost,
        acquisition_cost: acquisitionCost,
        monthly_maintenance: monthlyMaint,
        amort_years: amortYears,
        driven_by: drivenBy,
      };
      // Phase 5.3b — auto-gen equipment now stamps `_heuristic` metadata
      // onto each generated line so the Cell-Inspector panel can drill back
      // from any line into its formula + driver inputs.
      if (heuristic) line._heuristic = heuristic;
      lines.push(line);
    }
  };
  // Phase 5.3b — heuristic builder for equipment auto-gen lines.
  const eqH = (code, label, value, formula, driver, source = 'legacy', legacyValue = null) => ({
    code, label, value, formula, driver, source,
    legacy_value: legacyValue != null ? legacyValue : value,
  });

  // Item 31 closure (2026-06-11): equipment density ratios now resolve from
  // the planning-ratios catalog (override > catalog > legacy constant),
  // mirroring autoGenerateIndirectLabor's pr() contract.
  const prMap = opts.planningRatiosMap || null;
  const pr = (code, fallback) => {
    if (!prMap) return { value: fallback, source: 'legacy', def: null };
    const r = prMap[code];
    if (!r || r.value === null || r.value === undefined) return { value: fallback, source: 'legacy', def: null };
    const n = Number(r.value);
    if (!Number.isFinite(n) || n <= 0) return { value: fallback, source: 'legacy', def: null };
    return { value: n, source: r.source || 'catalog', def: r.def || null };
  };

  // Phase 2d (2026-04-22): dedicated helper for rented_mhe sibling lines.
  // Always line_type='rented_mhe' with seasonal_months from the MLV delta.
  // monthlyCost is the rental rate (maintenance bundled); acquisition_cost
  // is always 0; peak_markup_pct stays 0 (whole line IS the peak).
  const addRentedMhe = (name, qty, monthlyCost, seasonalMonths, drivenBy, heuristic = null) => {
    if (qty <= 0) return;
    if (!Array.isArray(seasonalMonths) || seasonalMonths.length === 0) return;
    const line = {
      equipment_name: name,
      category: 'MHE',
      line_type: 'rented_mhe',
      quantity: Math.ceil(qty),
      acquisition_type: 'lease', // semantically "rental" — stored as lease
      monthly_cost: monthlyCost,
      acquisition_cost: 0,
      monthly_maintenance: 0,
      amort_years: 5,
      seasonal_months: seasonalMonths.slice().sort((a, b) => a - b),
      driven_by: drivenBy,
    };
    if (heuristic) line._heuristic = heuristic;
    lines.push(line);
  };

  // Facility-level policy inputs — defaults per Asset Defaults Guidance.
  //   automation_level='none' — no conveyor auto-add (was volume-triggered).
  //   security_tier=3         — reference-template default. Tier 2-3 only
  //                              triggers electronic security (TI).
  //   fenced_perimeter_lf=0   — no fencing unless explicitly set.
  const automationLevel = (state.facility?.automationLevel || state.facility?.automation_level || 'none').toLowerCase();
  const securityTier    = Number(state.facility?.securityTier ?? state.facility?.security_tier ?? 3);
  const fencedLf        = Number(state.facility?.fencedPerimeterLf ?? state.facility?.fenced_perimeter_lf ?? 0);

  // Equipment auto-gen volume reads — channel-aware (Phase 3 of
  // volumes-as-nucleus). annualOrders sums each channel's derived orders;
  // annualPalletsIn aggregates each channel's inbound (= primary-units ×
  // inboundOutboundRatio) converted to pallets via that channel's own
  // conversion factors. Multi-channel deals now correctly size MHE/dock
  // doors against true cross-channel demand.
  const annualOrders = _getAggregateDerived(state, 'orders');
  const annualPalletsIn = _getAggregateInbound(state, 'pallets');

  // ────────────────────────────────────────────────────────────────
  // 1. MHE — forklifts (Leased per reference model; vendor-financed,
  //    maintenance included).
  //
  //    Two paths:
  //    (a) MLV-backed  — when the caller passes computeMonthlyLaborView()
  //        output via opts.mlv. Qty = ceil(peak_month_fte / shifts) × 1.15
  //        spare. Matches Brock's mental model: a 3-shift op with 18 FTE
  //        on reach trucks needs 6 trucks (one per simultaneous FTE),
  //        not 21 (the old heuristic's implied 1-per-3 coverage over
  //        total headcount).
  //    (b) Heuristic — fallback when MLV is absent or labor lines
  //        don't carry mhe_type. Matches pre-2026-04-20 behavior.
  //
  //    Note on drivenBy strings: annotated with "(MLV shift-math)" or
  //    "(heuristic)" so the Equipment UI can surface which path drove
  //    the quantity.
  // ────────────────────────────────────────────────────────────────
  // Phase 2d (2026-04-22): each MHE type generates an OWNED line sized to
  // steady-state max-shift HC (small spare), and a RENTED sibling sized to
  // the peak-vs-steady delta (opex, seasonal_months derived from MLV). When
  // MLV is absent or the type is flat across months, only the owned line is
  // generated at the legacy 1.15 spare to preserve pre-2d behavior.
  //
  //   OWNED_SPARE  = 1.05 — thin buffer for maintenance downtime on owned fleet
  //   legacy path  = 1.15 — keeps behavior identical for heuristic / flat MLV
  //
  // Default rental rates per Brock 2026-04-22:
  //   reach_truck        $1,000/mo
  //   order_picker         $900/mo
  //   sit_down_forklift  $2,500/mo
  //   walkie_rider         $650/mo  (not auto-generated today, ready for future)
  const OWNED_SPARE = 1.05;

  // 2026-04-22 EVE (Brock): the old `sig.steady / shiftsPerDay` divisor assumed
  // FTE splits evenly across shifts. When the Shift Planner matrix skews (say
  // picking 30/50/20), that flat assumption undersizes for the peak shift —
  // S2 needs 50% of picking FTE on the floor at once, not 33%. Replace the
  // divisor with a *peak-shift fraction* read from the matrix: the max of
  // (row[s] / rowSum) across the functions that any line of this mhe_type
  // serves. Legacy behavior preserved when:
  //   - no allocation on the model (e.g., fresh projects, pre-Shift-Planner models)
  //   - no labor line carries this mhe_type
  //   - every relevant row is all-zero or Even (max == 1/shiftsPerDay → no change)
  //
  // In all fallbacks, peakShiftFraction returns 1 / shiftsPerDay so the
  // computed qty matches the pre-2026-04-22-EVE behavior exactly.
  const peakShiftFractionForMheType = (mheType) => {
    const flatFraction = 1 / Math.max(1, shiftsPerDay);
    const alloc = state.shiftAllocation;
    if (!alloc || !alloc.matrix) return flatFraction;
    const laborLines = Array.isArray(state.laborLines) ? state.laborLines : [];
    let peakFraction = 0;
    let matchedAny = false;
    for (const line of laborLines) {
      if (line.mhe_type !== mheType) continue;
      const fn = _deriveFunctionForLine(line);
      if (!fn) continue;
      const row = alloc.matrix[fn];
      if (!Array.isArray(row) || row.length === 0) continue;
      const rowSum = row.reduce((a, b) => a + (Number(b) || 0), 0);
      if (rowSum <= 0) continue;
      const maxCell = Math.max(...row.map(v => Number(v) || 0));
      const fraction = maxCell / rowSum;
      if (fraction > peakFraction) peakFraction = fraction;
      matchedAny = true;
    }
    return matchedAny && peakFraction > 0 ? peakFraction : flatFraction;
  };

  const emitMheFamily = (config) => {
    // config: { mheType, ownedName, rentalName, ownedMonthly, ownedMaint,
    //          rentalMonthly, heuristic: { divisor, when: () => bool, minPeak } }
    const sig = mheSignalFromMlv(config.mheType);

    if (sig) {
      // MLV-backed path — split into owned + rental if a peak/steady delta exists
      const peakFrac = peakShiftFractionForMheType(config.mheType);
      const flatFrac = 1 / Math.max(1, shiftsPerDay);
      const matrixSkew = peakFrac > flatFrac + 0.001; // true when matrix genuinely skews
      const steadyQty = Math.ceil(sig.steady * peakFrac * OWNED_SPARE);
      const peakShiftFleet = Math.ceil(sig.peak * peakFrac);
      const rentalQty = Math.max(0, peakShiftFleet - steadyQty);

      if (config.minPeak != null && sig.peak < config.minPeak) return;

      const shiftShareNote = matrixSkew
        ? ` × ${(peakFrac * 100).toFixed(0)}% peak-shift share`
        : ` ÷ ${shiftsPerDay} shifts`;
      const ownedDriver = `Steady ${sig.steady.toFixed(1)} FTE${shiftShareNote} × 1.05 spare (MLV${matrixSkew ? ' + matrix' : ''})`;
      addEquip(config.ownedName, 'MHE', steadyQty,
        config.ownedMonthly, 0, config.ownedMaint, ownedDriver, 'lease', 5,
        eqH(`equipment.mhe.${config.mheType}.owned`, `${config.ownedName} — owned, sized to steady-state max-shift HC`,
            steadyQty, `⌈steadyFte × ${matrixSkew ? `${(peakFrac * 100).toFixed(0)}% peak-shift share` : `1/${shiftsPerDay} shifts`} × 1.05 spare⌉`,
            'MLV peak-month FTE per MHE type (channel-aware: per-channel volumes feed labor headcount)', 'channels'));

      if (rentalQty > 0 && sig.seasonalMonths.length > 0) {
        const monthLabels = sig.seasonalMonths.map(n => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][n-1]);
        const rentalShiftNote = matrixSkew
          ? ` × ${(peakFrac * 100).toFixed(0)}% peak-shift share`
          : ` ÷ ${shiftsPerDay}`;
        const rentalDriver = `Peak ${sig.peak.toFixed(1)} − steady ${sig.steady.toFixed(1)} = ${(sig.peak - sig.steady).toFixed(1)} FTE${rentalShiftNote} = ${rentalQty} rental unit${rentalQty === 1 ? '' : 's'} (${monthLabels.join(', ')} per MLV${matrixSkew ? ' + matrix' : ''})`;
        addRentedMhe(config.rentalName, rentalQty, config.rentalMonthly, sig.seasonalMonths, rentalDriver,
          eqH(`equipment.mhe.${config.mheType}.rental`, `${config.rentalName} — peak-only rental, ${monthLabels.join('/')} months`,
              rentalQty, `⌈(peakFte − steadyFte) × ${matrixSkew ? `${(peakFrac * 100).toFixed(0)}% peak-shift share` : `1/${shiftsPerDay}`}⌉`,
              `MLV seasonal delta on ${config.mheType} (months: ${monthLabels.join(', ')})`, 'channels'));
      }
    } else if (config.heuristic && config.heuristic.when()) {
      // Heuristic fallback — owned-only at legacy 1.15 spare. No rental line
      // without MLV signal (would be guessing). Peak-shift matrix weighting
      // only kicks in on the MLV-backed path; the heuristic is already coarse.
      const qty = Math.max(0, (totalDirectFtes / config.heuristic.divisor) * spareFactor);
      const driver = `${totalDirectFtes.toFixed(1)} direct FTE / ${config.heuristic.divisor} × 1.15 spare (heuristic)`;
      addEquip(config.ownedName, 'MHE', qty,
        config.ownedMonthly, 0, config.ownedMaint, driver, 'lease', 5,
        eqH(`equipment.mhe.${config.mheType}.owned`, `${config.ownedName} — heuristic fallback (no MLV)`,
            config.heuristic.divisor, `directFtes ÷ ${config.heuristic.divisor} × 1.15 spare`,
            'Heuristic fallback when MLV is absent or labor lines lack mhe_type', 'legacy'));
    }
  };

  if (totalDirectFtes > 0) {
    emitMheFamily({
      mheType: 'reach_truck',
      ownedName: 'Reach Truck',
      rentalName: 'Reach Truck (peak rental)',
      ownedMonthly: 800, ownedMaint: 150,
      rentalMonthly: 1000,
      heuristic: { when: () => true, divisor: 3 },
    });
    emitMheFamily({
      mheType: 'order_picker',
      ownedName: 'Order Picker',
      rentalName: 'Order Picker (peak rental)',
      ownedMonthly: 600, ownedMaint: 100,
      rentalMonthly: 900,
      heuristic: { when: () => true, divisor: 5 },
    });
    emitMheFamily({
      mheType: 'sit_down_forklift',
      ownedName: 'Sit-Down Counterbalance Forklift',
      rentalName: 'Sit-Down Forklift (peak rental)',
      ownedMonthly: 750, ownedMaint: 150,
      rentalMonthly: 2500,
      minPeak: 0.5,
      // No heuristic fallback — matches pre-2d behavior (required MLV signal)
    });
    emitMheFamily({
      mheType: 'walkie_rider',
      ownedName: 'Walkie Rider',
      rentalName: 'Walkie Rider (peak rental)',
      ownedMonthly: 450, ownedMaint: 75,
      rentalMonthly: 650,
      minPeak: 0.5,
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 2. IT Infrastructure — Capital per reference model. RF devices,
  //    printers, WiFi APs, switches. NEVER leased (was lease pre-audit).
  //
  //    Phase 2d (2026-04-22): IT is now sized to PEAK HC, not totalDirectFtes.
  //    Rental isn't an option for RF/devices (short-term provisioning lead
  //    time = same as owned), so the peak determines the buy qty.
  // ────────────────────────────────────────────────────────────────
  if (totalDirectFtes > 0) {
    // RF: ~$2,850 purchase, 3-year life. Sized to peak HC so Q4 coverage
    // is built in to the capex plan — no Black-Friday scramble to order devices.
    const peakDirectFte = peakDirectFteFromMlv();
    addEquip('RF Handheld / Mobile Computer', 'IT',
      Math.ceil(peakDirectFte * spareFactor * 0.3),
      0, 2850, 15,
      mlv ? `Peak ${peakDirectFte.toFixed(1)} FTE × 1.15 × 30% coverage (MLV)` : 'Direct labor × 30% coverage (heuristic)',
      'capital', 3,
      eqH('equipment.it.rf_handheld', 'RF / mobile computer per peak FTE', 0.3,
          '⌈peakFte × 1.15 × 30%⌉ (1 device per ~3.3 peak FTE)',
          mlv ? 'MLV peak HC' : 'totalDirectFtes (heuristic)', mlv ? 'channels' : 'legacy'));
  }
  addEquip('Label Printer (Thermal)', 'IT',
    Math.max(1, Math.ceil(totalHC / 50)),
    0, 1500, 25, 'Pack stations + Receiving/Shipping', 'capital', 5,
    eqH('equipment.it.label_printer', 'Thermal label printer per 50 HC', 50,
        '⌈totalHC ÷ 50⌉ (min 1)', 'totalHC = direct + indirect headcount'));
  if (sqft > 0) {
    // WiFi AP: ~$540/unit. Flipped from $100/mo lease.
    const rWifi = pr('equipment.it.wifi_ap', 10000);
    addEquip('WiFi Access Point (warehouse)', 'IT',
      Math.max(2, Math.ceil(sqft / rWifi.value)),
      0, 540, 0, sqft.toLocaleString() + ' sqft @ 1 per ' + rWifi.value.toLocaleString() + ' sqft', 'capital', 5,
      eqH('equipment.it.wifi_ap', 'WiFi AP sqft density', rWifi.value,
          '⌈sqft ÷ ' + rWifi.value.toLocaleString() + '⌉ (min 2)', 'totalSqft', rWifi.source, 10000));
    // Network backbone — one 24-port PoE switch per N sqft (catalog-driven).
    const rSwitch = pr('equipment.it.network_switch', 50000);
    addEquip('Switch (24-port PoE)', 'IT',
      Math.max(2, Math.ceil(sqft / rSwitch.value)),
      0, 3024, 0, '1 per ' + rSwitch.value.toLocaleString() + ' sqft', 'capital', 7,
      eqH('equipment.it.network_switch', '24-port PoE switch sqft density', rSwitch.value,
          '⌈sqft ÷ ' + rSwitch.value.toLocaleString() + '⌉ (min 2)', 'totalSqft', rSwitch.source, 50000));
  }

  // ────────────────────────────────────────────────────────────────
  // 3. Racking — Leased per reference model. ~$1/position/month +
  //    ~$0.15/position/month maintenance. Flipped from $85/pos capital.
  // ────────────────────────────────────────────────────────────────
  if (annualPalletsIn > 0) {
    const turnsPerYear = 12;
    const avgPalletsOnHand = Math.ceil(annualPalletsIn / turnsPerYear);
    const rackPositions = Math.ceil(avgPalletsOnHand * 1.15);
    addEquip('Selective Pallet Rack', 'Racking', rackPositions,
      /*monthly*/ 1.00, /*acq*/ 0, /*maint*/ 0.15,
      avgPalletsOnHand.toLocaleString() + ' avg pallets + 15% buffer', 'lease', 5,
      eqH('equipment.racking.selective_pallet', 'Selective pallet rack positions', 1.15,
          '⌈(annualPalletsIn ÷ 12 turns) × 1.15 buffer⌉',
          'Cross-channel inbound pallets (Phase 3 — per-channel inboundOutboundRatio + UOM conv)', 'channels'));
  }

  // ────────────────────────────────────────────────────────────────
  // 4. REMOVED: Dock Levelers (TI — built into facility).
  //    Dock hardware rolls into facility.rate_psf via the TI allowance.
  //    Driving it from facility.dock_count × per-dock cost prevents
  //    double-counting against the equipment capital bucket.
  // ────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────
  // 5. Charging — Capital (bundled price approximation). One station
  //    per ~6 electric MHE units. Acquisition cost ~$1,200/station.
  // ────────────────────────────────────────────────────────────────
  const forkliftCount = lines.filter(l =>
    l.equipment_name.toLowerCase().includes('truck') ||
    l.equipment_name.toLowerCase().includes('picker')
  ).reduce((s, l) => s + l.quantity, 0);
  if (forkliftCount > 0) {
    addEquip('Battery Charging Station', 'Charging',
      Math.max(1, Math.ceil(forkliftCount / 6)),
      0, 1200, 50, forkliftCount + ' electric MHE units', 'capital', 7,
      eqH('equipment.charging.station', 'Battery charging station per ~6 MHE', 6,
          '⌈forkliftCount ÷ 6⌉ (min 1)', 'count of MHE lines (truck/picker)'));
  }

  // ────────────────────────────────────────────────────────────────
  // 6. REMOVED: Office + Break Room Build-Out (TI — facility lease).
  //    Handled via facility.office_pct_of_total_sf (space heuristics),
  //    not an equipment capex line.
  // ────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────
  // 7. Security — Driven by Security Tier (1-4). Electronic security
  //    is TI; physical security (fencing, guard shack, gate) is Capital.
  //    Tier 1 = alarm only; Tier 2 = + CCTV; Tier 3 = + access control
  //    (default); Tier 4 = + guard shack + gate automation.
  // ────────────────────────────────────────────────────────────────
  if (securityTier >= 2 && sqft > 0) {
    // CCTV — TI (built into facility)
    addEquip('Security Camera System (head-end)', 'Security', 1,
      0, 20000, 0, 'Security Tier ' + securityTier, 'ti', 5,
      eqH('equipment.security.camera_headend', 'CCTV head-end (1 system)', 1,
          'Tier ≥2 → 1 head-end', `Security Tier ${securityTier}`));
    const rCam = pr('equipment.security.cameras', 30000);
    const cameraCount = Math.max(4, Math.ceil(sqft / rCam.value));
    addEquip('Security Cameras', 'Security', cameraCount,
      0, 1562, 0, cameraCount + ' cameras (sqft / ' + rCam.value.toLocaleString() + ')', 'ti', 5,
      eqH('equipment.security.cameras', 'CCTV camera sqft density', rCam.value,
          '⌈sqft ÷ ' + rCam.value.toLocaleString() + '⌉ (min 4)', 'totalSqft + Security Tier ≥2', rCam.source, 30000));
  }
  if (securityTier >= 3) {
    // Access control — TI (default tier)
    addEquip('Access Control System (head-end)', 'Security', 1,
      0, 20000, 0, 'Security Tier ' + securityTier, 'ti', 5,
      eqH('equipment.security.access_headend', 'Access control head-end', 1,
          'Tier ≥3 → 1 head-end', `Security Tier ${securityTier}`));
    addEquip('Employee Entrance (turnstile)', 'Security', 1,
      0, 2500, 0, 'Security Tier 3+', 'ti', 5,
      eqH('equipment.security.turnstile', 'Employee entrance turnstile', 1,
          'Tier ≥3 → 1 turnstile', `Security Tier ${securityTier}`));
  }
  if (securityTier >= 4) {
    // Guard shack + gate — Capital (physical)
    addEquip('External Guard Shack', 'Security', 1,
      0, 43000, 0, 'Security Tier 4', 'capital', 15,
      eqH('equipment.security.guard_shack', 'External guard shack', 1,
          'Tier ≥4 → 1 shack', `Security Tier ${securityTier}`));
    addEquip('Gate Automation', 'Security', 1,
      0, 25000, 0, 'Security Tier 4', 'capital', 10,
      eqH('equipment.security.gate_automation', 'Gate automation', 1,
          'Tier ≥4 → 1 system', `Security Tier ${securityTier}`));
  }
  if (fencedLf > 0) {
    // Physical perimeter — Capital
    addEquip('Perimeter Fencing', 'Security', fencedLf,
      0, 52, 0, fencedLf + ' LF', 'capital', 15,
      eqH('equipment.security.fencing', 'Perimeter fencing per linear foot', 52,
          'fencedLf × $52/LF', 'facility.fencedPerimeterLf'));
  }

  // ────────────────────────────────────────────────────────────────
  // 8. Conveyor — Gated on automation_level. Volume alone doesn't
  //    imply conveyor (design decision, not a threshold outcome).
  //    Leased per reference model, $5-8/LF/mo (was $2 pre-audit).
  // ────────────────────────────────────────────────────────────────
  if (automationLevel === 'medium' || automationLevel === 'high') {
    const conveyorLF = automationLevel === 'high'
      ? Math.min(1500, Math.max(300, Math.ceil(annualOrders / 3000)))
      : Math.min(500,  Math.max(100, Math.ceil(annualOrders / 5000)));
    addEquip('Belt Conveyor (linear ft)', 'Conveyor', conveyorLF,
      /*monthly*/ 6, /*acq*/ 0, /*maint*/ 0,
      'automation=' + automationLevel + ', ' + annualOrders.toLocaleString() + ' orders/yr',
      'lease', 5,
      eqH('equipment.conveyor.belt', `Belt conveyor (${automationLevel} automation)`,
          conveyorLF, automationLevel === 'high' ? 'min(1500, max(300, ⌈orders ÷ 3000⌉))' : 'min(500, max(100, ⌈orders ÷ 5000⌉))',
          `automation_level=${automationLevel} + cross-channel orders`, 'channels'));
  }

  return lines;
}

// ============================================================
// AUTO-GENERATION — OVERHEAD
// ============================================================

/**
 * Auto-generate overhead lines based on sqft, HC, and volume.
 * @param {Object} state
 * @returns {import('./types.js?v=20260612-mix1').OverheadLine[]}
 */
export function autoGenerateOverhead(state) {
  const lines = [];
  const opHrs = operatingHours(state.shifts || {});
  const totalDirectFtes = (state.laborLines || []).reduce((sum, l) => {
    if (!opHrs || opHrs <= 0) return sum;
    return sum + ((l.annual_hours || 0) / opHrs);
  }, 0);
  const totalIndirectHC = (state.indirectLaborLines || []).reduce((s, l) => s + (l.headcount || 0), 0);
  const totalHC = Math.ceil(totalDirectFtes) + totalIndirectHC;
  const sqft = state.facility?.totalSqft || 0;
  const turnoverPct = 0.43;
  const annualHires = Math.ceil(totalHC * turnoverPct);

  // Phase 5.3 — auto-gen overhead now stamps `_heuristic` metadata onto
  // each generated line so the Cell-Inspector panel can drill back from
  // any line into its formula + driver inputs.
  //
  // heuristic shape: { code, label, value, source, legacy_value, formula?, driver? }
  const addOh = (category, description, annualCost, costType = 'annual', pricingBucket = '', heuristic = null) => {
    const line = {
      category,
      description,
      cost_type: costType,
      annual_cost: costType === 'annual' ? annualCost : 0,
      monthly_cost: costType === 'monthly' ? annualCost : 0,
      pricing_bucket: pricingBucket,
    };
    if (heuristic) line._heuristic = heuristic;
    lines.push(line);
  };
  const ohH = (code, label, value, formula, driver, legacyValue = null) => ({
    code, label, value, formula, driver,
    source: code.startsWith('overhead.per_units') || code.startsWith('overhead.per_orders') ? 'channels' : 'legacy',
    legacy_value: legacyValue != null ? legacyValue : value,
  });

  // PER-SQFT SCALERS
  if (sqft > 0) {
    addOh('Facility Maintenance', 'Janitorial, HVAC maint, pest control, repairs (IFMA benchmark)', sqft * 1.00, 'annual', '',
      ohH('overhead.facility_maint.per_sqft', 'IFMA facility maintenance benchmark', 1.00, 'sqft × $1.00/yr', 'sqft'));
    addOh('Security', 'Monitoring, camera systems, access control', sqft * 0.12, 'annual', '',
      ohH('overhead.security.per_sqft', 'Security & monitoring benchmark', 0.12, 'sqft × $0.12/yr', 'sqft'));
    addOh('Property & Liability Insurance', 'Property, GL, umbrella coverage', sqft * 0.35, 'annual', '',
      ohH('overhead.insurance.per_sqft', 'Property + GL insurance benchmark', 0.35, 'sqft × $0.35/yr', 'sqft'));
    addOh('Fire & Life Safety', 'Sprinkler inspection, suppression, extinguishers', sqft * 0.04, 'annual', '',
      ohH('overhead.fire_safety.per_sqft', 'Sprinkler / fire-safety upkeep', 0.04, 'sqft × $0.04/yr', 'sqft'));
  }

  // PER-HEADCOUNT SCALERS
  if (totalHC > 0) {
    addOh('IT / WMS Licensing', 'BY WMS, RF mgmt, networking, printers, telecom', totalHC * 2500, 'annual', '',
      ohH('overhead.it_licensing.per_hc', 'IT / WMS licensing per headcount', 2500, 'totalHC × $2,500/yr', 'totalHC'));
    addOh('HR & Recruiting', 'Payroll, benefits, onboarding + replacement hires', (totalHC * 2500) + (annualHires * 4700), 'annual', '',
      ohH('overhead.hr_recruiting.per_hc', 'HR / recruiting per HC + replacement hires', 2500, '(totalHC × $2,500) + (annualHires × $4,700)', 'totalHC + 43% turnover'));
    addOh('Workers Comp Insurance', 'Workers comp premiums, warehouse risk class', totalHC * 1250, 'annual', '',
      ohH('overhead.wc_insurance.per_hc', 'Workers comp premium per HC', 1250, 'totalHC × $1,250/yr', 'totalHC'));
    addOh('Safety & Compliance', 'OSHA compliance, training, safety supplies', totalHC * 800, 'annual', '',
      ohH('overhead.safety_compliance.per_hc', 'OSHA / safety compliance per HC', 800, 'totalHC × $800/yr', 'totalHC'));
    addOh('Uniforms & PPE', 'Safety vests, gloves, boots, hard hats, eye protection', (totalHC + annualHires) * 400, 'annual', '',
      ohH('overhead.ppe.per_hc', 'Uniforms / PPE per HC + replacement hires', 400, '(totalHC + annualHires) × $400/yr', 'totalHC + 43% turnover'));
  }

  // PER-UNIT SCALERS — channel-aware (Phase 3 of volumes-as-nucleus).
  // annualOrders sums each non-reverse channel's derived orders.
  // annualUnitsShipped is now the sum of each channel's primary expressed
  // in physical units (replaces the legacy "orders + pallet-uom volumes"
  // heuristic, which conflated transactions and physical units).
  const annualOrders = _getAggregateDerived(state, 'orders');
  const annualUnitsShipped = _getAnnualVolume(state, 'units');

  if (annualUnitsShipped > 0) {
    addOh('Supplies & Consumables', 'Stretch wrap, labels, tape, dunnage, cleaning', annualUnitsShipped * 0.15, 'annual', '',
      ohH('overhead.per_units_shipped.supplies', 'Supplies & consumables per unit shipped', 0.15, 'annualUnits × $0.15', 'cross-channel physical units (Phase 3)'));
  }
  if (annualOrders > 0) {
    addOh('Quality & Inspection', 'QC labor overhead, quality systems, audits', annualOrders * 0.25, 'annual', '',
      ohH('overhead.per_orders.quality', 'Quality & inspection per order', 0.25, 'annualOrders × $0.25', 'cross-channel orders'));
  }

  return lines;
}

// ============================================================
// AUTO-GENERATION — STARTUP
// ============================================================

/**
 * Auto-generate startup/capital lines.
 * @param {Object} state
 * @returns {import('./types.js?v=20260612-mix1').StartupLine[]}
 */
export function autoGenerateStartup(state) {
  const lines = [];
  const opHrs = operatingHours(state.shifts || {});
  const totalDirectFtes = (state.laborLines || []).reduce((sum, l) => {
    if (!opHrs || opHrs <= 0) return sum;
    return sum + ((l.annual_hours || 0) / opHrs);
  }, 0);
  const sqft = state.facility?.totalSqft || 0;
  const contractYears = state.financial?.contractTermYears || state.projectDetails?.contractTerm || 5;
  // Cross-channel inbound pallets/year — used by the Dock Leveler line below
  // (line 3655). Declared at the top of the function for clarity; matches the
  // pattern used in autoGenerateOverhead (line ~3179) and the racking
  // heuristic helper (~3727). Pre-fix: this was referenced at line 3655
  // without being declared in scope, throwing "annualPalletsIn is not
  // defined" on every call from autoGenerateStartup.
  const annualPalletsIn = _getAggregateInbound(state, 'pallets');

  // Phase 5.3 — auto-gen startup now stamps `_heuristic` metadata onto
  // each generated line so the Cell-Inspector panel can drill back from
  // any line into its formula + driver inputs.
  const addStartup = (description, cost, heuristic = null) => {
    if (cost > 0) {
      const line = { description, one_time_cost: Math.ceil(cost) };
      if (heuristic) line._heuristic = heuristic;
      lines.push(line);
    }
  };
  const suH = (code, label, value, formula, driver, legacyValue = null) => ({
    code, label, value, formula, driver,
    source: 'legacy',
    legacy_value: legacyValue != null ? legacyValue : value,
  });

  // 1. Racking install REMOVED 2026-04-30 NIGHT (Brock).
  // Equipment auto-gen models racking as a $1/pos/month LEASE
  // (see equipment.racking.selective_pallet); per industry practice,
  // the racking lease quote already bundles installation labor, so a
  // separate $85/pos one-time install line was double-counting.
  // The Equipment monthly lease is now the single source of truth for
  // racking cost — both capital-equivalent and ongoing.

  // 2. Build-out — $45/sqft office, $30/sqft break room
  const totalIndirectHC = (state.indirectLaborLines || []).reduce((s, l) => s + (l.headcount || 0), 0);
  if (totalIndirectHC > 0) {
    const officeSqft = Math.ceil(totalIndirectHC * 120);
    addStartup('Office Build-Out', officeSqft * 45,
      suH('startup.office.per_sqft', 'Office build-out per office sqft', 45, 'officeSqft × $45', 'indirectHC × 120 sqft/person'));
    const totalHC = Math.ceil(totalDirectFtes) + totalIndirectHC;
    const breakSqft = Math.max(200, Math.ceil(totalHC * 15));
    addStartup('Break Room Build-Out', breakSqft * 30,
      suH('startup.breakroom.per_sqft', 'Break room build-out per sqft', 30, 'breakSqft × $30', 'max(200, totalHC × 15 sqft)'));
  }

  // 3. IT infrastructure — $0.50/sqft + WMS $50K + $2K/user
  if (sqft > 0) {
    addStartup('Network Cabling & Infrastructure', sqft * 0.50,
      suH('startup.network.per_sqft', 'Network cabling per sqft', 0.50, 'sqft × $0.50', 'totalSqft'));
  }
  if (totalDirectFtes > 0) {
    addStartup('WMS Implementation & Configuration', 50000 + (Math.ceil(totalDirectFtes) * 2000),
      suH('startup.wms.fixed_plus_user', 'WMS impl base + per-user', 50000, '$50,000 + (directFtes × $2,000)', 'directFtes'));
  }

  // 4. EDI setup
  addStartup('EDI Setup & Customer Integration', 15000,
      suH('startup.edi.fixed', 'EDI setup (fixed)', 15000, '$15,000 flat', 'one-time'));

  // 5. Dock installation — $4,500 per door
  const daysPerYear = (state.shifts?.daysPerWeek || 5) * (state.shifts?.weeksPerYear ?? 52);
  const dailyPalletsTotal = (annualPalletsIn || 0) / Math.max(1, daysPerYear);
  if (dailyPalletsTotal > 0) {
    const dockDoors = Math.max(2, Math.ceil(dailyPalletsTotal / 90));
    addStartup('Dock Leveler Installation', dockDoors * 4500,
      suH('startup.dock.per_door', 'Dock leveler per door', 4500, 'dockDoors × $4,500', 'dailyPallets ÷ 90, min 2 doors'));
  }

  // 6. MHE charging power drops — $3,500 per station
  const chargingStations = Math.max(0, Math.ceil((state.equipmentLines || [])
    .filter(l => l.equipment_name?.toLowerCase().includes('charging'))
    .reduce((s, l) => s + l.quantity, 0)));
  if (chargingStations > 0) {
    addStartup('Power Drops for MHE Charging', chargingStations * 3500,
      suH('startup.power_drops.per_station', 'Power drops per charging station', 3500, 'chargingStations × $3,500', 'count of charging-equipment lines'));
  }

  // 7. Lighting — $1.25/sqft
  if (sqft >= 50000) {
    addStartup('High-Bay LED Lighting Upgrade', sqft * 1.25,
      suH('startup.lighting.per_sqft', 'High-bay LED upgrade per sqft', 1.25, 'sqft × $1.25', 'totalSqft (≥50K threshold)'));
  }

  // 8. Safety barriers — $0.15/sqft
  if (sqft >= 50000) {
    addStartup('Guard Rails & Safety Barriers', sqft * 0.15,
      suH('startup.safety.per_sqft', 'Guard rails / safety barriers', 0.15, 'sqft × $0.15', 'totalSqft (≥50K threshold)'));
  }

  // 9. Training / ramp-up — 30% labor inefficiency × ramp weeks
  if (totalDirectFtes > 0) {
    const rampWeeks = 8;
    const hoursPerShift = state.shifts?.hoursPerShift || 8;
    const daysPerWeek = state.shifts?.daysPerWeek || 5;
    const rampHours = rampWeeks * daysPerWeek * hoursPerShift;
    const avgRate = 20;
    addStartup('Training & Ramp-Up Premium', totalDirectFtes * rampHours * avgRate * 0.30,
      suH('startup.training.ramp_premium', 'Training ramp inefficiency premium', 0.30, 'directFtes × rampHrs × $20 × 30%', '8-week ramp at 30% inefficiency'));
    addStartup('Go-Live Support Team (4 weeks)', 4 * 40 * 180,
      suH('startup.golive.fixed', '4-week go-live support team', 28800, '4 wks × 40 hrs × $180/hr (PM + IT + Trainer blend)', 'one-time')); // PM + IT + Trainer
  }

  // 10. Contingency — 5% of subtotal
  const subtotal = lines.reduce((s, l) => s + (l.one_time_cost || 0), 0);
  addStartup('Contingency (5%)', subtotal * 0.05,
      suH('startup.contingency.pct', 'Contingency on startup subtotal', 0.05, 'subtotal × 5%', 'sum of prior startup lines'));

  return lines;
}

// ============================================================
// DESIGN HEURISTICS — 10 BENCHMARK CHECKS
// ============================================================

/**
 * Generate 10 industry benchmark checks.
 * @param {Object} state
 * @param {import('./types.js?v=20260612-mix1').CostSummary} summary
 * @returns {Array<{ type: 'ok'|'warn'|'info', title: string, detail: string }>}
 */
/**
 * CM-HEUR-1 vertical-storage scaling (2026-05-12).
 *
 * The original heuristic used a flat 40 sqft/pallet — implicit
 * single-level storage. That meaningfully over-estimated facility size
 * for any DC with high clear height (i.e. nearly all modern build-to-
 * suit space) and forced workarounds like Hearthwood's DOH=22 setting
 * (used to artificially shrink avg-on-hand into a number the
 * single-level math could produce a sensible suggestion for).
 *
 * Math:
 *   pallet_level_pitch_ft  = 6.5 ft   (GMA 60" load + 6" pallet + 5" beam + 6" clearance)
 *   sprinkler_clearance_ft = 1.5 ft   (top-flue + sprinkler head)
 *   levels = floor((clearHeight - sprinkler_clearance) / pitch)
 *   capped at 6 (above that, retrieval time + sprinkler classification gets ugly)
 *   floor at 1 (always at least one level even for tight clears)
 *   sqft_per_pallet = 40 / levels
 *
 * Reference table:
 *   <24 ft clear → 3 levels  → 13.3 sqft/pallet
 *   24-30 ft     → 4 levels  → 10.0 sqft/pallet
 *   30-36 ft     → 5 levels  →  8.0 sqft/pallet
 *   36-40 ft     → 5 levels  →  8.0 sqft/pallet
 *   40+ ft       → 6 levels  →  6.7 sqft/pallet (cap)
 *
 * Default clear height when unset / non-positive: 32 ft (typical
 * Class III mod-build, 4-level selective).
 *
 * @param {number} clearHeightFt — facility clear height
 * @returns {{ levels: number, sqftPerPallet: number, clearHeight: number }}
 */
export function computeVerticalPalletFootprint(clearHeightFt) {
  const PALLET_LEVEL_PITCH_FT = 6.5;
  const SPRINKLER_CLEARANCE_FT = 1.5;
  const SQFT_PER_PALLET_SINGLE_LEVEL = 40;
  const MAX_LEVELS = 6;
  const raw = Number(clearHeightFt);
  const clear = Number.isFinite(raw) && raw > 0 ? raw : 32;
  const usable = Math.max(0, clear - SPRINKLER_CLEARANCE_FT);
  const levels = Math.max(1, Math.min(MAX_LEVELS, Math.floor(usable / PALLET_LEVEL_PITCH_FT)));
  return { levels, sqftPerPallet: SQFT_PER_PALLET_SINGLE_LEVEL / levels, clearHeight: clear };
}

/**
 * R14 (2026-04-29) — pure helper: suggested facility sqft from volume.
 * Same DOH-aware math as the heuristic warning in generateHeuristics, factored
 * out so the Setup tab can show a "(suggested: NNNK)" hint before any warning
 * fires.
 *
 * Returns 0 when annualPalletsIn is 0 (no inbound volume yet).
 *
 * @param {object} state — same model shape generateHeuristics consumes
 * @returns {number} suggested sqft (rounded to nearest 1K), or 0
 */
export function suggestFacilitySqft(state) {
  if (!state) return 0;
  const annualPalletsIn = _getAggregateInbound(state, 'pallets');
  if (!(annualPalletsIn > 0)) return 0;
  const dohRaw = Number(state.facility?.daysOnHand);
  const doh = Number.isFinite(dohRaw) && dohRaw > 0 ? dohRaw : 30;
  const avgPalletsOnHand = annualPalletsIn * (doh / 365);
  const { sqftPerPallet } = computeVerticalPalletFootprint(state.facility?.clearHeight);
  const estPalletArea = avgPalletsOnHand * sqftPerPallet;
  // 2026-04-30 (G3) — sanity bound on the suggestion. The largest US
  // warehouses are ~3-4M sqft (Walmart Lehigh Valley ~3.4M, Boeing Everett
  // ~4.3M); a single-DC suggestion above 5M is almost always the symptom
  // of misconfigured channel UOMs producing absurd derived volumes.
  // Returning a capped value with a sentinel field lets the UI render the
  // suggestion AND a warning chip ('volume-driver too high — check
  // channel UOMs') instead of an obviously-broken 81M sqft number.
  const SANITY_CAP_SQFT = 5_000_000;
  const raw = estPalletArea / 0.55;
  if (raw > SANITY_CAP_SQFT) {
    // Stash the over-cap raw value on a side property the UI can read
    // to render the warning. Returning the cap keeps the math stable
    // while the user investigates.
    const capped = SANITY_CAP_SQFT;
    // Note: pure functions shouldn't mutate inputs, so we encode the
    // overflow signal in the return type. Callers that only care about
    // the number get the capped sqft. Callers that want the warning
    // can call suggestFacilitySqftDetail(state) below.
    return Math.round(capped / 1000) * 1000;
  }
  return Math.round((estPalletArea / 0.55) / 1000) * 1000;
}

/**
 * G3 (2026-04-30) — same heuristic but returns { sqft, raw, capped, sane }
 * so the UI can surface a warning when the volume profile would produce
 * a nonsense suggestion. `sane` is true when raw ≤ 5M sqft.
 */
export function suggestFacilitySqftDetail(state) {
  if (!state) return { sqft: 0, raw: 0, capped: false, sane: true, levels: 1, sqftPerPallet: 40 };
  const annualPalletsIn = _getAggregateInbound(state, 'pallets');
  if (!(annualPalletsIn > 0)) return { sqft: 0, raw: 0, capped: false, sane: true, levels: 1, sqftPerPallet: 40 };
  const dohRaw = Number(state.facility?.daysOnHand);
  const doh = Number.isFinite(dohRaw) && dohRaw > 0 ? dohRaw : 30;
  const avgPalletsOnHand = annualPalletsIn * (doh / 365);
  const { levels, sqftPerPallet } = computeVerticalPalletFootprint(state.facility?.clearHeight);
  const raw = (avgPalletsOnHand * sqftPerPallet) / 0.55;
  const SANITY_CAP_SQFT = 5_000_000;
  const capped = raw > SANITY_CAP_SQFT;
  const sqft = capped
    ? Math.round(SANITY_CAP_SQFT / 1000) * 1000
    : Math.round(raw / 1000) * 1000;
  return { sqft, raw: Math.round(raw), capped, sane: !capped, levels, sqftPerPallet };
}

export function generateHeuristics(state, summary) {
  const checks = [];

  if (!summary || !state) return checks;

  const opHrs = operatingHours(state.shifts || {});
  const totalDirectFtes = (state.laborLines || []).reduce((sum, l) => {
    if (!opHrs || opHrs <= 0) return sum;
    return sum + ((l.annual_hours || 0) / opHrs);
  }, 0);
  const totalIndirectHC = (state.indirectLaborLines || []).reduce((s, l) => s + (l.headcount || 0), 0);
  const totalHC = Math.ceil(totalDirectFtes) + totalIndirectHC;
  const sqft = state.facility?.totalSqft || 0;
  // Channel-aware orders aggregate (Phase 3 of volumes-as-nucleus).
  const annualOrders = _getAggregateDerived(state, 'orders');

  const pct = (part, whole) => whole > 0 ? (part / whole * 100) : 0;

  // 1. Labor cost %
  const laborPct = pct(summary.laborCost, summary.totalCost);
  if (laborPct < 35) {
    checks.push({ type: 'warn', title: 'Labor % below typical range (' + laborPct.toFixed(0) + '%)',
      detail: 'Industry benchmark: 40-60%. Low labor may indicate under-staffing or missing indirect roles.' });
  } else if (laborPct > 65) {
    checks.push({ type: 'warn', title: 'Labor % above typical range (' + laborPct.toFixed(0) + '%)',
      detail: 'Industry benchmark: 40-60%. High labor may indicate over-staffing or low automation.' });
  } else {
    checks.push({ type: 'ok', title: 'Labor cost share healthy (' + laborPct.toFixed(0) + '%)',
      detail: 'Within the 40-60% industry range for 3PL warehousing.' });
  }

  // 2. Facility cost %
  const facilityPct = pct(summary.facilityCost, summary.totalCost);
  if (facilityPct > 35) {
    checks.push({ type: 'warn', title: 'Facility cost high (' + facilityPct.toFixed(0) + '%)',
      detail: 'Benchmark: 20-35%. Consider higher-density storage or renegotiating lease.' });
  } else if (facilityPct > 0) {
    checks.push({ type: 'ok', title: 'Facility cost in range (' + facilityPct.toFixed(0) + '%)',
      detail: 'Within 20-35% benchmark.' });
  }

  // 3. Throughput density
  const ordersPerSqft = sqft > 0 ? annualOrders / sqft : 0;
  if (ordersPerSqft < 1.5) {
    checks.push({ type: 'info', title: 'Low throughput density: ' + ordersPerSqft.toFixed(1) + ' orders/sqft/yr',
      detail: 'Typical ecommerce 3PL: 3-8 orders/sqft/yr. Low density drives up per-unit facility cost.' });
  } else if (ordersPerSqft > 12) {
    checks.push({ type: 'warn', title: 'High throughput density: ' + ordersPerSqft.toFixed(1) + ' orders/sqft/yr',
      detail: 'May need conveyor/sortation or multi-shift to handle in this footprint.' });
  } else {
    checks.push({ type: 'ok', title: 'Throughput density healthy: ' + ordersPerSqft.toFixed(1) + ' orders/sqft/yr',
      detail: 'Within typical 3-8 range for ecommerce facilities.' });
  }

  // 4. Cost per order — benchmark against steady-state cost (not Y1 ramped).
  // The Summary KPI above uses Y1 cost ÷ Y1 orders (ramp/learning-curve
  // baked in); this check uses the steady-state figure so the industry
  // range ($3-6) applies at stabilized run-rate. When they differ, Y1 will
  // read higher due to Y1 labor inefficiency — reconcile by comparing to
  // Y2-Y3 P&L rows, which converge to this steady-state figure.
  if (summary.costPerOrder > 0) {
    const cpoLabel = summary.costPerOrder.toFixed(2);
    if (summary.costPerOrder < 1.50) {
      checks.push({ type: 'warn', title: 'Cost/order very low ($' + cpoLabel + ', steady-state)',
        detail: 'Below $1.50/order is unusual. Check for missing cost components. Summary KPI is Y1-basis (higher via ramp); steady-state is the benchmarkable number.' });
    } else if (summary.costPerOrder > 8.00) {
      checks.push({ type: 'warn', title: 'Cost/order above range ($' + cpoLabel + ', steady-state)',
        detail: 'Benchmark: $3-6 at steady state. Higher typical for B2B or low-volume accounts. (Summary KPI shows Y1-basis, which reads higher due to ramp.)' });
    } else {
      checks.push({ type: 'ok', title: 'Cost/order in range ($' + cpoLabel + ', steady-state)',
        detail: '$3-6 range is typical for ecommerce 3PL at steady state. Summary KPI is Y1 (ramped); Y2-Y3 P&L rows converge toward this steady-state figure.' });
    }
  }

  // 5. Staffing ratio
  if (totalHC > 0) {
    const sqftPerFte = sqft / totalHC;
    if (sqftPerFte > 15000) {
      checks.push({ type: 'info', title: 'Low staffing density: ' + Math.round(sqftPerFte).toLocaleString() + ' sqft/FTE',
        detail: 'Typical: 3,000-10,000 sqft/FTE. May indicate high automation or under-staffing.' });
    } else if (sqftPerFte < 2000) {
      checks.push({ type: 'warn', title: 'High staffing density: ' + Math.round(sqftPerFte).toLocaleString() + ' sqft/FTE',
        detail: 'Below 2,000 is crowded. Consider expanding footprint or adding shifts.' });
    } else {
      checks.push({ type: 'ok', title: 'Staffing ratio balanced: ' + Math.round(sqftPerFte).toLocaleString() + ' sqft/FTE',
        detail: 'Within typical 3,000-10,000 range.' });
    }
  }

  // 6. Indirect:direct ratio
  if (totalDirectFtes > 0 && totalIndirectHC > 0) {
    const indirectRatio = totalIndirectHC / totalDirectFtes;
    if (indirectRatio > 0.25) {
      checks.push({ type: 'warn', title: 'Indirect:Direct ratio high (' + (indirectRatio * 100).toFixed(0) + '%)',
        detail: 'Benchmark: 15-25%. High ratio increases overhead burden per productive hour.' });
    } else if (indirectRatio < 0.10 && totalDirectFtes > 10) {
      checks.push({ type: 'warn', title: 'Indirect:Direct ratio low (' + (indirectRatio * 100).toFixed(0) + '%)',
        detail: 'Below 10% with ' + totalDirectFtes.toFixed(0) + ' FTEs may lack supervisory coverage.' });
    } else {
      checks.push({ type: 'ok', title: 'Indirect:Direct ratio healthy (' + (indirectRatio * 100).toFixed(0) + '%)',
        detail: 'Within 15-25% industry range.' });
    }
  }

  // 7. Equipment cost/FTE
  if (summary.equipmentCost > 0 && totalHC > 0) {
    const equipPerFte = summary.equipmentCost / totalHC;
    if (equipPerFte > 25000) {
      checks.push({ type: 'info', title: 'Equipment cost/FTE high: $' + Math.round(equipPerFte).toLocaleString(),
        detail: 'Above $25K/FTE suggests high mechanization. Verify MHE counts align with needs.' });
    }
  }

  // 8. Overhead share
  const ohPct = pct(summary.overheadCost, summary.totalCost);
  if (ohPct > 15) {
    checks.push({ type: 'warn', title: 'Overhead share high (' + ohPct.toFixed(0) + '%)',
      detail: 'Benchmark: 8-15% of total. Review for consolidation opportunities.' });
  } else if (ohPct > 0) {
    checks.push({ type: 'ok', title: 'Overhead share healthy (' + ohPct.toFixed(0) + '%)',
      detail: 'Within 8-15% benchmark.' });
  }

  // 9. Margin sanity
  const margin = state.financial?.targetMargin || 0;
  if (margin < 8) {
    checks.push({ type: 'warn', title: 'Target margin low (' + margin + '%)',
      detail: 'Typical 3PL target: 10-18%. Below 8% leaves little room for variance.' });
  } else if (margin > 25) {
    checks.push({ type: 'info', title: 'Target margin: ' + margin + '%',
      detail: 'Above 25% may reduce competitiveness. Typical: 12-18%.' });
  } else {
    checks.push({ type: 'ok', title: 'Target margin healthy: ' + margin + '%',
      detail: 'Within 10-18% industry standard.' });
  }

  // 10. Facility suggestion (CM-HEUR-1 — final 2026-04-29 pass)
  //
  // Three-strike history on this check:
  //   (1) Original form had `(palletArea + sqft*0.25)/1000` — the sqft*0.25
  //       term was meant as an aisle/staging allowance but accidentally
  //       referenced CURRENT sqft (self-referential). With no pallet-UOM
  //       volume, palletArea collapsed to 0 and the formula produced
  //       0.25× current sqft, always tripping the 30% gate. Every model
  //       got a tautological "may be oversized" warning.
  //   (2) Earlier fix (2026-04-26) gated the check on palletsStored > 0
  //       and replaced the self-referential term with /0.55 net storage
  //       utilization. Defensible but used a hand-waved /2/12 factor for
  //       avg-on-hand inventory (= 24 turns/yr, 15-day DOH) — too fast
  //       for general 3PL operations.
  //   (3) Final pass (this commit): honors model.facility.daysOnHand when
  //       set; defaults to 30 days (12 turns/yr) which is closer to the
  //       3PL median. Surfaces the DOH assumption in the message so the
  //       designer knows where the suggestion came from and how to tune
  //       it. Otherwise unchanged from (2).
  //
  // Math:
  //   avgPalletsOnHand = annualInboundPallets × (DOH / 365)
  //   palletArea       = avgPalletsOnHand × 40 sqft
  //   suggestedSqft    = palletArea / 0.55  (55% net storage utilization)
  //   round to nearest 1K, fire only when divergence > 30%.
  if (annualOrders > 0 && sqft > 0) {
    const annualPalletsIn = _getAggregateInbound(state, 'pallets');
    if (annualPalletsIn > 0) {
      // Designer override on facility, or 30-day default (12 turns/yr).
      const dohRaw = Number(state.facility?.daysOnHand);
      const doh = Number.isFinite(dohRaw) && dohRaw > 0 ? dohRaw : 30;
      const avgPalletsOnHand = annualPalletsIn * (doh / 365);
      // Vertical-storage scaling (2026-05-12): honor facility.clearHeight
      // so multi-level rack shrinks the floor footprint per pallet.
      // Default 32 ft (typical Class III) → 4 levels → 10 sqft/pallet.
      const { levels, sqftPerPallet } = computeVerticalPalletFootprint(state.facility?.clearHeight);
      const estPalletArea = avgPalletsOnHand * sqftPerPallet;
      const rawSqft = estPalletArea / 0.55;
      // 2026-04-30 (G3) — cap at 5M sqft. Above that, the volume profile
      // is almost certainly broken (typically misconfigured channel UOMs).
      // Surface a dedicated 'warn' check rather than the standard
      // suggestion so reviewers immediately spot the problem.
      const SANITY_CAP_SQFT = 5_000_000;
      if (rawSqft > SANITY_CAP_SQFT) {
        checks.push({
          type: 'warn',
          title: 'Volume profile produces unrealistic facility size (raw heuristic ' + (rawSqft / 1_000_000).toFixed(1) + 'M sqft)',
          detail: 'A channel\'s UOM (units/case, lines/order, units/line) likely has an outlier value. Largest US warehouses are ~3-4M sqft; cap is 5M. Review Volumes & Profile per channel.',
        });
      } else {
        const suggestedSqft = Math.round(rawSqft / 1000) * 1000;
        if (suggestedSqft > 0 && Math.abs(suggestedSqft - sqft) / sqft > 0.30) {
          const dohSource = Number.isFinite(dohRaw) && dohRaw > 0
            ? `${doh}-day DOH (project setting)`
            : `30-day DOH default — set facility.daysOnHand to override`;
          const turnsLabel = (365 / doh).toFixed(1);
          checks.push({
            type: 'info',
            title: 'Suggested facility size: ~' + suggestedSqft.toLocaleString() + ' sqft',
            detail: 'Current: ' + sqft.toLocaleString() + ' sqft (' +
              (sqft > suggestedSqft ? 'may be oversized' : 'may be undersized') + '). ' +
              'Rough estimate: ' + Math.round(avgPalletsOnHand).toLocaleString() + ' avg pallets on-hand × ' + sqftPerPallet.toFixed(1) + ' sqft/pallet (' + levels + '-level rack at ' + Math.round(state.facility?.clearHeight || 32) + ' ft clear) / 0.55 net util. ' +
              'Inventory turns: ' + turnsLabel + '/yr (' + dohSource + '). ' +
              'Run Warehouse Sizing for a fully-sized recommendation.',
          });
        }
      }
    }
  }

  return checks;
}

// ============================================================
// PHASE 1 ADAPTER — yearly params → monthly engine inputs
// ============================================================

/**
 * Default 5-point allowance learning curve when the project doesn't
 * pin a specific ramp_profile_id. Matches v2's medium-tier defaults.
 */
const DEFAULT_RAMP_MEDIUM = {
  type: 'medium',
  wk1_factor:  0.55,
  wk2_factor:  0.70,
  wk4_factor:  0.85,
  wk8_factor:  0.95,
  wk12_factor: 1.0,
};

/** Default flat 12-share seasonality. */
const DEFAULT_FLAT_SEASONALITY = {
  monthly_shares: Array(12).fill(1 / 12).map((v, i) => i === 11 ? 0.0837 : 0.0833),
};

/**
 * Translate the yearly buildYearlyProjections params shape into the
 * monthly engine's BuildMonthlyParams. The caller is responsible for
 * supplying `periods` (from ref_periods), `ramp` (from ref_allowance_profiles
 * if present), and `seasonality` (from project.seasonality_profile).
 *
 * Defaults to medium ramp + flat seasonality when those aren't provided
 * — the engine still produces a sensible bundle.
 *
 * @param {Object} p — buildYearlyProjections params (legacy shape)
 * @returns {Object} buildMonthlyProjections params
 */
export function adaptYearlyToMonthlyParams(p) {
  return {
    project_id: p.project_id || 0,
    contract_term_years: p.years,
    pre_go_live_months: p.preGoLiveMonths || 0,
    base_labor_cost:     p.baseLaborCost,
    base_facility_cost:  p.baseFacilityCost,
    base_equipment_cost: p.baseEquipmentCost,
    // Phase 2e follow-up (2026-04-22): pass the 12-month equipment series
    // so rented_mhe lines with seasonal_months actually land in Q4 (or
    // whichever months) instead of smoothed /12 across the year. Prefer
    // an explicit series from the caller; otherwise derive from
    // equipmentLines when available. When null, the monthly engine falls
    // back to base_equipment_cost / 12 (pre-2e behavior).
    equipment_monthly_series:
      (Array.isArray(p.equipmentMonthlySeries) && p.equipmentMonthlySeries.length === 12)
        ? p.equipmentMonthlySeries
        : (Array.isArray(p.equipmentLines) && p.equipmentLines.length > 0)
          ? computeEquipmentMonthlySeries(p.equipmentLines)
          : null,
    base_overhead_cost:  p.baseOverheadCost,
    base_vas_cost:       p.baseVasCost,
    startup_amort:       p.startupAmort,
    startup_capital:     p.startupCapital,
    base_orders:         p.baseOrders,
    margin_pct:          p.marginPct,
    vol_growth_pct:      p.volGrowthPct || 0,
    labor_esc_pct:       p.laborEscPct  || 0,
    uph_yoy_pct:         p.uphYoyPct    || 0,
    cost_esc_pct:        p.costEscPct   || 0,
    // 2026-04-21 audit: pass facility + equipment escalation separately so
    // the monthly engine can honor What-If slider overrides (was dead before).
    facility_esc_pct:    p.facilityEscPct  != null ? p.facilityEscPct  : (p.costEscPct || 0),
    equipment_esc_pct:   p.equipmentEscPct != null ? p.equipmentEscPct : (p.costEscPct || 0),
    tax_rate_pct:        p.taxRatePct ?? 25,
    dso_days:            p.dsoDays ?? 30,
    dpo_days:            p.dpoDays ?? 30,
    labor_payable_days:  p.laborPayableDays ?? 14,
    ramp:                p.ramp        || DEFAULT_RAMP_MEDIUM,
    seasonality:         p.seasonality || DEFAULT_FLAT_SEASONALITY,
    periods:             p.periods     || [],
    startupLines:        p.startupLines     || [],
    pricingBuckets:      p.pricingBuckets   || [],
    // M2 (2026-04-21): SG&A overlay pass-through
    sga_overlay_pct:     Number(p.sgaOverlayPct) || 0,
    sga_applies_to:      p.sgaAppliesTo || 'net_revenue',
    // Phase 4d — per-line monthly labor cost when laborLines + calcHeur available
    laborLines:          p.laborLines        || [],
    calcHeur:            p._calcHeur         || null,
    marketLaborProfile:  p.marketLaborProfile || null,
    // Engine-parity 2026-06-11: Y1 learning-curve factor (complexity-tier
    // weighted, identical helper to the legacy yearly path). The monthly
    // engine applies 1/factor to year-1 labor; the crew ramp stays separate
    // (crew size ≠ learning).
    yr1_learning_factor: computeYr1LearningFactor(p.laborLines || []),
    // Phase A Labor Build-Up Logic additions (Brock 2026-04-20):
    wageLoadByYear:      p.wageLoadByYear    || null,
    shift2Premium:       Number(p.shift2Premium) || 0,
    shift3Premium:       Number(p.shift3Premium) || 0,
    ptoPct:              Number(p.ptoPct)        || 0,
  };
}

/**
 * Pricing snapshot — enrich pricing buckets with derived rates and surface
 * the unassigned-cost rollup. Pure function; reads from the passed-in
 * `model` (NOT a module-level binding) so it can be called from outside
 * the cost-model UI module.
 *
 * Relocated from `cost-model/ui.js` 2026-05-11 (S15). Three call sites
 * in ui.js — chrome KPI strip, renderSummary's bucket panel, and the
 * `buildEnrichedPricingBuckets` wrapper used by callers that only want
 * the buckets array.
 *
 * @param {Object} params
 * @param {Object} params.model — cost-model state (reads laborLines,
 *   indirectLaborLines, equipmentLines, overheadLines, vasLines,
 *   startupLines, pricingBuckets, volumeLines, financial.facilityBucketId)
 * @param {Object} params.summary — output of computeSummary
 * @param {number} params.marginFrac — target margin as a 0-based fraction
 * @param {number} params.opHrs — operating hours per year
 * @param {number} params.contractYears — for startup amortization (max 1)
 * @returns {{
 *   buckets: Array,           // enriched pricing buckets (derived rates, override diagnostics)
 *   bucketCosts: Object,      // bucketId -> cost map, including `_unassigned`
 *   unassignedCount: number,  // count of cost lines without pricing_bucket
 *   unassignedLines: Array,   // [{ type, line }] for the Summary banner drill-down
 * }}
 */
export function computePricingSnapshot({ model, summary, marginFrac, opHrs, contractYears }) {
  const m = model || {};
  const startupWithAmort = (m.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears || 5),
  }));
  // Compute WITHOUT unassigned-rollup so we can see the real unassigned total.
  // The existing computeBucketCosts rolls unassigned into mgmt_fee — we want
  // the pre-rollup number for the banner, so we recompute from line data.
  const buckets = m.pricingBuckets || [];
  const bucketCosts = computeBucketCosts({
    buckets,
    laborLines: m.laborLines || [],
    indirectLaborLines: m.indirectLaborLines || [],
    equipmentLines: m.equipmentLines || [],
    overheadLines: m.overheadLines || [],
    vasLines: m.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost: summary?.facilityCost || 0,
    operatingHours: opHrs || 0,
    facilityBucketId: m.financial?.facilityBucketId || null,
  });
  // Count lines that explicitly lack a pricing_bucket (what goes to _unassigned)
  const unassignedLines = [];
  const tally = (arr, type) => (arr || []).forEach(l => {
    if (!l.pricing_bucket) unassignedLines.push({ type, line: l });
  });
  tally(m.laborLines, 'labor');
  tally(m.indirectLaborLines, 'indirect');
  tally(m.equipmentLines, 'equipment');
  tally(m.overheadLines, 'overhead');
  tally(m.vasLines, 'vas');
  tally(m.startupLines, 'startup');

  const enrichedBuckets = enrichBucketsWithDerivedRates({
    buckets,
    bucketCosts,
    marginPct: marginFrac || 0,
    volumeLines: m.volumeLines || [],
    model: m,
  });

  return {
    buckets: enrichedBuckets,
    bucketCosts,
    unassignedCount: unassignedLines.length,
    unassignedLines,
  };
}

// ============================================================
// runScenario — calc-as-service wrapper (port-readiness S10)
// ============================================================
//
// Standardized entry point for external callers (HTTP / MCP / AI
// agents). Wraps computeSummary in the canonical
// { ok, version, result, errors } contract. Never throws — bad input
// returns ok=false with an explanatory errors array.
//
// Cost Model's input shape is multi-section (labor / equipment /
// overhead / VAS / startup / facility / shifts) so the wrapper has
// more validation surface than Fleet / COG / DM / NetOpt. Missing
// arrays normalize to empty; missing shifts becomes `{}` (which
// downstream code tolerates via optional chaining).
export const ENGINE_VERSION = '1.0.0';

/**
 * Run a Cost Model scenario.
 * @param {{
 *   laborLines?: any[],
 *   indirectLaborLines?: any[],
 *   equipmentLines?: any[],
 *   overheadLines?: any[],
 *   vasLines?: any[],
 *   startupLines?: any[],
 *   facility?: any,
 *   shifts?: any,
 *   facilityRate?: any,
 *   utilityRate?: any,
 *   contractYears?: number,
 *   targetMarginPct?: number,
 *   annualOrders?: number,
 *   laborOpts?: any,
 *   mlv?: any,
 * }} params
 * @returns {{ ok: boolean, version: string, result: any, errors: string[] }}
 */
export function runScenario(params) {
  if (params == null || typeof params !== 'object') params = {};
  const errors = [];

  // At least one source of cost must be present, otherwise the model
  // is degenerate (zero revenue, zero cost) — surface that explicitly
  // rather than silently returning a zeroed CostSummary.
  const arrays = ['laborLines', 'indirectLaborLines', 'equipmentLines',
                  'overheadLines', 'vasLines', 'startupLines'];
  const anyArray = arrays.some(k => Array.isArray(params[k]) && params[k].length > 0);
  if (!anyArray) errors.push('at least one cost line array (laborLines, equipmentLines, etc.) must be a non-empty array');

  // Required scalars
  if (params.contractYears != null && !Number.isFinite(Number(params.contractYears))) {
    errors.push('contractYears must be a finite number when provided');
  }
  if (params.targetMarginPct != null && !Number.isFinite(Number(params.targetMarginPct))) {
    errors.push('targetMarginPct must be a finite number when provided');
  }

  if (errors.length) return { ok: false, version: ENGINE_VERSION, result: null, errors };

  // Normalize — computeSummary loops over arrays without optional chaining
  // in places (totalLaborCost et al.), so undefined arrays would throw.
  const normalized = {
    laborLines:         Array.isArray(params.laborLines)         ? params.laborLines         : [],
    indirectLaborLines: Array.isArray(params.indirectLaborLines) ? params.indirectLaborLines : [],
    equipmentLines:     Array.isArray(params.equipmentLines)     ? params.equipmentLines     : [],
    overheadLines:      Array.isArray(params.overheadLines)      ? params.overheadLines      : [],
    vasLines:           Array.isArray(params.vasLines)           ? params.vasLines           : [],
    startupLines:       Array.isArray(params.startupLines)       ? params.startupLines       : [],
    facility:           params.facility || {},
    shifts:             params.shifts   || { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
    facilityRate:       params.facilityRate,
    utilityRate:        params.utilityRate,
    contractYears:      Number(params.contractYears)   || 5,
    targetMarginPct:    Number(params.targetMarginPct) || 0,
    annualOrders:       Number(params.annualOrders)    || 1,
    laborOpts:          params.laborOpts,
    mlv:                params.mlv,
  };

  try {
    const result = computeSummary(normalized);
    return { ok: true, version: ENGINE_VERSION, result, errors: [] };
  } catch (e) {
    return { ok: false, version: ENGINE_VERSION, result: null, errors: [e?.message || String(e)] };
  }
}
