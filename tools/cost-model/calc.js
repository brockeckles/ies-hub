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

import * as monthly from './calc.monthly.js?v=20260420-vN';

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
 * @param {import('./types.js?v=20260418-sK').ShiftConfig} [shifts] — ignored
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
 * @param {import('./types.js?v=20260418-sK').ShiftConfig} [shifts] — ignored
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
 * Compound wage escalation: `baseWage × (1 + escPct)^(year - 1)`. Year 1
 * returns base (no escalation). Neg. escPct is clamped to 0; escPct is
 * expected as a FRACTION (0.03, not 3).
 *
 * @param {number} baseWage
 * @param {number} year — 1-based
 * @param {number} wageEscFrac — fraction
 * @returns {number}
 */
export function escalatedWage(baseWage, year, wageEscFrac) {
  const w = Number(baseWage) || 0;
  const y = Math.max(1, Number(year) || 1);
  const e = Math.max(0, Number(wageEscFrac) || 0);
  return w * Math.pow(1 + e, y - 1);
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
  return wageLoadForYear(opts.wageLoadByYear, year, opts.defaultWageLoadFrac ?? 0.30);
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
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine | import('./types.js?v=20260418-sK').IndirectLaborLine} line
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
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine | import('./types.js?v=20260418-sK').IndirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.benefitLoadFallback] — default wage-load fraction if line has no burden_pct (legacy alias retained)
 * @param {number[]} [opts.wageLoadByYear]
 * @param {number} [opts.year]
 * @returns {number}
 */
export function fullyLoadedRate(line, opts = {}) {
  const rate = effectiveHourlyRate(line);
  const wageLoadFrac = wageLoadFracForLine(line, opts.year ?? 1, {
    wageLoadByYear: opts.wageLoadByYear,
    defaultWageLoadFrac: opts.benefitLoadFallback ?? 0.30,
  });
  const benefitsPerHr = line.benefits_per_hour || 0;
  return rate * (1 + wageLoadFrac) + benefitsPerHr;
}

/**
 * Annual cost for a direct labor line.
 * Includes shift differential, OT (for hourly-nonexempt only), and
 * year-specific wage load.
 *
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine} line
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
  const rate = effectiveHourlyRate(line);
  const year = opts.year ?? 1;
  const wageLoadFrac = wageLoadFracForLine(line, year, {
    wageLoadByYear: opts.wageLoadByYear,
    defaultWageLoadFrac: opts.benefitLoadFallback ?? 0.30,
  });
  // OT only applies to hourly-nonexempt lines. pay_type default 'hourly'.
  const otEligible = (line.pay_type || 'hourly') === 'hourly';
  const otMult = otEligible ? (1 + (opts.otPct || 0) * 0.5) : 1.0;
  // Shift differential pulls fraction fields OR legacy shift_num integer.
  const shiftMult = shiftDifferentialMultForLine(line, opts);
  const effectiveRate = rate * (1 + wageLoadFrac) * otMult * shiftMult;
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
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine} line
 * @param {{ defaultBurdenPct?: number, wageLoadByYear?: number[], year?: number }} [costing]
 * @returns {number}
 */
export function directLineAnnualSimple(line, costing) {
  const hours = line.annual_hours || 0;
  const rate = effectiveHourlyRate(line);
  const c = costing || {};
  const wageLoadFrac = wageLoadFracForLine(line, c.year ?? 1, {
    wageLoadByYear: c.wageLoadByYear,
    defaultWageLoadFrac: (c.defaultBurdenPct ?? 30) / 100,
  });
  return hours * rate * (1 + wageLoadFrac);
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
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine} line
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
    defaultWageLoadFrac: opts.benefitLoadFallback ?? 0.30,
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
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine} line
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
    defaultWageLoadFrac: (c.defaultBurdenPct ?? 30) / 100,
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
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine} line
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
    defaultWageLoadFrac: (c.defaultBurdenPct ?? 30) / 100,
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
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine} line
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
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine[]} directLines
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine[]} indirectLines
 * @param {Object} opts
 * @param {number} opts.operatingHours
 * @param {number} [opts.otPct]
 * @param {number} [opts.bonusPct]
 * @param {number} [opts.benefitLoadFallback]
 * @returns {number}
 */
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
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine[]} directLines
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine[]} indirectLines
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @param {number[]} [peakOverflowByMonth] — 12 non-negative month values
 * @returns {number}
 */
export function equipLineAnnual(line, peakOverflowByMonth) {
  const qty = line.quantity || 1;
  const type = normalizeAcqType(line.acquisition_type);

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
 * Split an equipment line's annual cost into baseline + seasonal uplift
 * sub-totals. Used by the UI to render the two numbers side-by-side so
 * the cost of seasonal flex is explicit, not buried in the total.
 *
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @param {number[]} [peakOverflowByMonth]
 * @returns {{ baseline: number, seasonal: number, total: number }}
 */
export function equipLineAnnualBreakdown(line, peakOverflowByMonth) {
  const qty = line.quantity || 1;
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
 * Total acquisition cost on a capital or TI equipment line (qty × unit cost).
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipTotalAcq(line) {
  return (line.acquisition_cost || 0) * (line.quantity || 1);
}

/**
 * Annual depreciation for a CAPITAL equipment line. TI items amortize via
 * facility rent (not on the equipment line), service items have no capital,
 * and lease items expense monthly — none of those produce equipment amort.
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipLineAmort(line) {
  if (normalizeAcqType(line.acquisition_type) !== 'capital') return 0;
  const total = equipTotalAcq(line);
  const years = Math.max(1, line.amort_years || 5);
  return total / years;
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipLineTableCost(line, peakOverflowByMonth) {
  const qty = line.quantity || 1;
  const type = normalizeAcqType(line.acquisition_type);
  const markupPct = Number(line.peak_markup_pct) || 0;
  const hasOverflow = markupPct > 0 && Array.isArray(peakOverflowByMonth) && peakOverflowByMonth.length === 12;

  if (type === 'capital') {
    // Display cost = maintenance + depreciation + seasonal uplift on maintenance rate
    const monthlyRate = (line.monthly_maintenance || 0);
    const maintenance = monthlyRate * 12 * qty;
    const acqCost = (line.acquisition_cost || 0) * qty;
    const years = Math.max(1, line.amort_years || 5);
    let seasonal = 0;
    if (hasOverflow) {
      const f = 1 + markupPct / 100;
      for (const u of peakOverflowByMonth) seasonal += (Number(u) || 0) * monthlyRate * f;
    }
    return maintenance + acqCost / years + seasonal;
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
 * @returns {number}
 */
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalEquipmentAmort(lines) {
  return lines.reduce((sum, line) => sum + equipLineAmort(line), 0);
}

// ============================================================
// OVERHEAD
// ============================================================

/**
 * Annual cost for an overhead line (handles monthly vs annual cost_type).
 * @param {import('./types.js?v=20260418-sK').OverheadLine} line
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
 * @param {import('./types.js?v=20260418-sK').OverheadLine[]} lines
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
 * @param {import('./types.js?v=20260418-sK').VASLine} line
 * @returns {number}
 */
export function vasLineAnnual(line) {
  if (line.total_cost) return line.total_cost;
  return (line.rate || 0) * (line.volume || 0);
}

/**
 * Total annual VAS cost.
 * @param {import('./types.js?v=20260418-sK').VASLine[]} lines
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
 * @param {import('./types.js?v=20260418-sK').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sK').FacilityRate} [facilityRate]
 * @param {import('./types.js?v=20260418-sK').UtilityRate} [utilityRate]
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
 * @param {import('./types.js?v=20260418-sK').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sK').FacilityRate} [facilityRate]
 * @param {import('./types.js?v=20260418-sK').UtilityRate} [utilityRate]
 * @param {Object} [opts]
 * @param {number} [opts.tiAmort] — annual TI amortization
 * @returns {{ lease: number, cam: number, tax: number, insurance: number, utility: number, tiAmort: number, total: number }}
 */
export function facilityCostBreakdown(facility, facilityRate, utilityRate, opts = {}) {
  const sqft = facility.totalSqft || 0;
  const fr = facilityRate || {};
  const ur = utilityRate || {};

  const lease = sqft * (fr.lease_rate_psf_yr || 0);
  const cam = sqft * (fr.cam_rate_psf_yr || 0);
  const tax = sqft * (fr.tax_rate_psf_yr || 0);
  const insurance = sqft * (fr.insurance_rate_psf_yr || 0);
  const utility = sqft * 12 * (ur.avg_monthly_per_sqft || 0);
  const tiAmort = Math.max(0, Number(opts.tiAmort) || 0);

  return {
    lease, cam, tax, insurance, utility, tiAmort,
    total: lease + cam + tax + insurance + utility + tiAmort,
  };
}

/**
 * Convenience: compute annual TI amortization from equipment lines + contract term.
 * Returns 0 when there are no TI items or contract term isn't set.
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} equipmentLines
 * @param {number} contractYears
 * @returns {number}
 */
export function tiAmortAnnual(equipmentLines, contractYears) {
  const y = Math.max(1, Number(contractYears) || 5);
  const upfront = totalEquipmentTiUpfront(equipmentLines || []);
  return upfront > 0 ? upfront / y : 0;
}

// ============================================================
// STARTUP / CAPITAL
// ============================================================

/**
 * Total annual startup amortization.
 * @param {import('./types.js?v=20260418-sK').StartupLine[]} lines
 * @param {number} contractYears
 * @returns {number}
 */
export function totalStartupAmort(lines, contractYears) {
  const years = Math.max(1, contractYears || 5);
  return lines.reduce((sum, line) => sum + (line.one_time_cost || 0) / years, 0);
}

/**
 * Total startup capital (one-time costs).
 * @param {import('./types.js?v=20260418-sK').StartupLine[]} lines
 * @returns {number}
 */
export function totalStartupCapital(lines) {
  return lines.reduce((sum, line) => sum + (line.one_time_cost || 0), 0);
}

// ============================================================
// COST SUMMARY
// ============================================================

/**
 * Compute full cost summary from all model data.
 * @param {Object} params
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine[]} params.laborLines
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine[]} params.indirectLaborLines
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} params.equipmentLines
 * @param {import('./types.js?v=20260418-sK').OverheadLine[]} params.overheadLines
 * @param {import('./types.js?v=20260418-sK').VASLine[]} params.vasLines
 * @param {import('./types.js?v=20260418-sK').StartupLine[]} params.startupLines
 * @param {import('./types.js?v=20260418-sK').FacilityConfig} params.facility
 * @param {import('./types.js?v=20260418-sK').ShiftConfig} params.shifts
 * @param {import('./types.js?v=20260418-sK').FacilityRate} [params.facilityRate]
 * @param {import('./types.js?v=20260418-sK').UtilityRate} [params.utilityRate]
 * @param {number} params.contractYears
 * @param {number} params.targetMarginPct
 * @param {number} params.annualOrders
 * @param {Object} [params.laborOpts] — otPct, bonusPct, benefitLoadFallback
 * @returns {import('./types.js?v=20260418-sK').CostSummary}
 */
export function computeSummary(params) {
  const opHrs = operatingHours(params.shifts);
  const laborOpts = { operatingHours: opHrs, ...(params.laborOpts || {}) };

  const laborCost = totalLaborCost(params.laborLines, params.indirectLaborLines, laborOpts);
  // Brock 2026-04-20 — TI upfront rolls into facility rent over the lease term.
  const tiAmort = tiAmortAnnual(params.equipmentLines, params.contractYears);
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

  const totalCost = laborCost + facilityCost + equipmentCost + overheadCost + vasCost + startupAmort;
  // Reference-aligned cost-plus gross-up: Revenue = Cost / (1 − margin).
  // Applied per-category so the Pricing Schedule + P&L can display line-level
  // gross-up per reference Part I §3.2. The sum is mathematically identical
  // to a one-shot total gross-up; the breakout enables line-level display
  // and per-category audit tie-out.
  const marginFrac = Math.min(0.999, Math.max(0, (params.targetMarginPct || 0) / 100));
  const laborRevenue     = grossUp(laborCost,     marginFrac);
  const facilityRevenue  = grossUp(facilityCost,  marginFrac);
  const equipmentRevenue = grossUp(equipmentCost, marginFrac);
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
    equipmentAmort: totalEquipmentAmort(params.equipmentLines),
    startupCapital: totalStartupCapital(params.startupLines),
    // Y0 TI outlay (dock levelers, office build-out, CCTV, etc.). Intentionally
    // NOT folded into equipmentCapital / totalInvestment — TI rolls into
    // facility rent via `tiAmortAnnual`. Surfaced here so Summary can show it
    // as a distinct tile without reaching back into equipmentLines.
    tiUpfront: totalEquipmentTiUpfront(params.equipmentLines),
    tiAmortAnnual: tiAmort,
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
 * @param {number} [params.costEscPct] — annual cost escalation (0-based fraction)
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine[]} [params.laborLines] — for learning curve calc
 * @returns {{ projections: import('./types.js?v=20260418-sK').YearlyProjection[], startupCapital: number }}
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
    volGrowthPct = 0, laborEscPct = 0, costEscPct = 0.03,
    laborLines = [],
    // Phase 0: per-project tax rate (was hardcoded 25%). Falls back to 25
    // if the model didn't carry one from cost_model_projects.tax_rate_pct.
    taxRatePct = 25,
  } = params;

  // Learning curve: weighted avg productivity factor for Year 1
  let yr1LearningFactor = 1.0;
  if (laborLines.length > 0) {
    let totalHours = 0;
    let weightedFactor = 0;
    for (const line of laborLines) {
      const h = line.annual_hours || 0;
      const tier = line.complexity_tier || 'medium';
      const f = LEARNING_CURVE_FACTORS[tier] ?? 0.85;
      totalHours += h;
      weightedFactor += h * f;
    }
    yr1LearningFactor = totalHours > 0 ? weightedFactor / totalHours : 1.0;
  }

  /** @type {import('./types.js?v=20260418-sK').YearlyProjection[]} */
  const projections = [];
  let cumFcfRun = 0;

  for (let yr = 1; yr <= years; yr++) {
    const volMult = Math.pow(1 + volGrowthPct, yr - 1);
    const laborMult = Math.pow(1 + laborEscPct, yr - 1);
    const costMult = Math.pow(1 + costEscPct, yr - 1);

    const learningMult = yr === 1 ? (1 / yr1LearningFactor) : 1.0;
    const labor = baseLaborCost * laborMult * volMult * learningMult;
    const facility = baseFacilityCost * costMult;
    const equipment = baseEquipmentCost * costMult;
    const overhead = baseOverheadCost * costMult * Math.pow(1 + volGrowthPct * 0.3, yr - 1);
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
    // Accounting stack (parity with monthly engine as of 2026-04-20 audit):
    //   COGS = Labor + Facility + Equipment + VAS
    //   SG&A = Overhead
    //   D&A  = startup amortization
    //   GP   = Revenue − COGS
    //   EBITDA = GP − SG&A
    //   EBIT = EBITDA − D&A = Revenue − totalCost (unchanged)
    const cogs         = labor + facility + equipment + vas;
    const sga          = overhead;
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
 * @param {import('./types.js?v=20260418-sK').YearlyProjection[]} projections
 * @param {Object} opts
 * @param {number} opts.startupCapital
 * @param {number} opts.discountRatePct — e.g. 10 for 10%
 * @param {number} opts.reinvestRatePct — e.g. 8 for 8%
 * @param {number} opts.totalFtes
 * @param {number} [opts.fixedCost] — annual fixed cost (for operating leverage)
 * @returns {import('./types.js?v=20260418-sK').FinancialMetrics}
 */
export function computeFinancialMetrics(projections, opts) {
  const years = projections.length;
  if (years === 0) return emptyMetrics();

  const discountRate = (opts.discountRatePct || 10) / 100;
  const reinvestRate = (opts.reinvestRatePct || 8) / 100;
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
  // for MIRR, NPV, and Payback cashflows. Previously summed projections[].capex;
  // that read $0 on the monthly engine path so the Summary collapsed to
  // MIRR=0 / Payback=1mo. Now explicit as startup + equipment.
  const totalInvestment = startupCapital + equipmentCapital;

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

/** @returns {import('./types.js?v=20260418-sK').FinancialMetrics} */
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

/**
 * Compute cost allocated to each pricing bucket.
 * @param {Object} params
 * @param {import('./types.js?v=20260418-sK').PricingBucket[]} params.buckets
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine[]} params.laborLines
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine[]} params.indirectLaborLines
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} params.equipmentLines
 * @param {import('./types.js?v=20260418-sK').OverheadLine[]} params.overheadLines
 * @param {import('./types.js?v=20260418-sK').VASLine[]} params.vasLines
 * @param {import('./types.js?v=20260418-sK').StartupLine[]} params.startupLines
 * @param {number} params.facilityCost — pre-computed facility annual cost
 * @param {number} params.operatingHours
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

  // Direct labor
  for (const l of params.laborLines) {
    const loaded = (l.hourly_rate || 0) * (1 + (l.burden_pct || 0) / 100) + (l.benefits_per_hour || 0);
    add(l.pricing_bucket, (l.annual_hours || 0) * loaded);
  }

  // Indirect labor
  for (const l of params.indirectLaborLines) {
    const loaded = (l.hourly_rate || 0) * (1 + (l.burden_pct || 0) / 100);
    add(l.pricing_bucket, (l.headcount || 0) * params.operatingHours * loaded);
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
 * @param {Array} [params.volumeLines] — model.volumeLines (used when bucket.annualVolume is unset)
 * @returns {Record<string, { rate: number, annualVolume: number, withMargin: number }>}
 */
export function computeBucketRates(params) {
  const { buckets = [], bucketCosts = {}, marginPct = 0, volumeLines = [] } = params;

  // Volume-by-UOM lookup (matches Pricing UI logic)
  const volumeByUom = {};
  for (const vl of volumeLines) {
    const key = vl.uom || 'each';
    volumeByUom[key] = (volumeByUom[key] || 0) + (Number(vl.volume) || 0);
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
    const hasOverride    = Number(b.rate) > 0;
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

// ============================================================
// VALIDATION
// ============================================================

/**
 * Validate a cost model and return warnings.
 * @param {import('./types.js?v=20260418-sK').CostModelData} model
 * @param {Object} [opts]
 * @param {number} [opts.operatingHours]
 * @returns {import('./types.js?v=20260418-sK').ValidationWarning[]}
 */
export function validateModel(model, opts = {}) {
  /** @type {import('./types.js?v=20260418-sK').ValidationWarning[]} */
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
  }

  // Financial
  if ((fin.targetMargin || 0) <= 0) {
    warnings.push({ level: 'warning', area: 'financial', message: 'Target margin is 0% — revenue will equal cost' });
  }
  if ((fin.targetMargin || 0) > 50) {
    warnings.push({ level: 'info', area: 'financial', message: `Target margin of ${fin.targetMargin}% is unusually high for 3PL` });
  }

  // Volumes
  const orderVol = (model.volumeLines || []).find(v =>
    v.name?.toLowerCase().includes('order') && v.isOutboundPrimary
  );
  if (!orderVol || (orderVol.volume || 0) <= 0) {
    warnings.push({ level: 'warning', area: 'volumes', message: 'No primary outbound order volume defined — unit cost metrics will be inaccurate' });
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
  const baseRevenue = (opts.baseRevenue != null && Number(opts.baseRevenue) > 0)
    ? Number(opts.baseRevenue)
    : baseTotalCost * (1 + marginFrac);
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
export function formatCurrency(value, opts = {}) {
  if (opts.compact) {
    if (Math.abs(value) >= 1_000_000) return '$' + (value / 1_000_000).toFixed(1) + 'M';
    if (Math.abs(value) >= 1_000) return '$' + (value / 1_000).toFixed(0) + 'K';
  }
  const decimals = opts.decimals ?? (Math.abs(value) >= 1 ? 0 : 2);
  return '$' + value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a number as percentage.
 * @param {number} value — raw percentage (e.g. 12.5 for 12.5%)
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatPct(value, decimals = 1) {
  return value.toFixed(decimals) + '%';
}

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
 * @returns {import('./types.js?v=20260418-sK').IndirectLaborLine[]}
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

  // 6. Customer Service: 1 per 500K orders/yr
  const annualOrders = (state.volumeLines || [])
    .filter(v => v.isOutboundPrimary)
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  if (annualOrders >= 500000) {
    addRole('Customer Service Rep', Math.ceil(annualOrders / 500000), 18, 30,
      { code: 'indirect.customer_service.per_500k_orders', label: '1 CS rep per 500K orders/yr', value: 500000, source: 'legacy', legacy_value: 500000 });
  }

  // 7. Returns Processor: 1 per 100K returns/yr (estimate as 5% of outbound orders)
  const estimatedReturns = annualOrders * 0.05;
  if (estimatedReturns >= 100000) {
    addRole('Returns Processor', Math.ceil(estimatedReturns / 100000), 17, 30,
      { code: 'indirect.returns_processor.per_100k_returns', label: '1 processor per 100K returns/yr (5% of outbound)', value: 100000, source: 'legacy', legacy_value: 100000 });
  }

  // 8. IT Support: 0.5-2 based on FTE count
  if (totalDirectFtes >= 20) {
    const itHeadcount = Math.max(0.5, Math.min(2, Math.ceil(totalDirectFtes / 40)));
    addRole('IT Support', itHeadcount, 35, 30,
      { code: 'indirect.it_support.per_40_ftes', label: '0.5–2 IT per direct FTE tier', value: 40, source: 'legacy', legacy_value: 40 });
  }

  // 9. Maintenance: 1 per 100K sqft
  const totalSqft = state.facility?.totalSqft || 0;
  if (totalSqft >= 100000) {
    addRole('Maintenance Technician', Math.ceil(totalSqft / 100000), 25, 30,
      { code: 'indirect.maintenance.per_100k_sqft', label: '1 maintenance tech per 100K sqft', value: 100000, source: 'legacy', legacy_value: 100000 });
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
 * @returns {import('./types.js?v=20260418-sK').EquipmentLine[]}
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

  // Helper — accepts explicit financing type per the Asset Defaults Guidance
  // (2026-04-20). Legacy callers without `financing` still work via heuristic
  // fallback, but the auto-gen rules below now always pass the type.
  const addEquip = (name, category, qty, monthlyCost = 0, acquisitionCost = 0, monthlyMaint = 0, drivenBy = '', financing = null, amortYears = 5) => {
    if (qty > 0) {
      // Heuristic fallback: if no financing type supplied, infer from cost shape.
      // Acquisition cost present → capital; else → lease. Legacy call sites.
      const acq_type = financing || (acquisitionCost > 0 ? 'capital' : 'lease');
      lines.push({
        equipment_name: name,
        category: category || 'Other',
        quantity: Math.ceil(qty),
        acquisition_type: acq_type,
        monthly_cost: monthlyCost,
        acquisition_cost: acquisitionCost,
        monthly_maintenance: monthlyMaint,
        amort_years: amortYears,
        driven_by: drivenBy,
      });
    }
  };

  // Facility-level policy inputs — defaults per Asset Defaults Guidance.
  //   automation_level='none' — no conveyor auto-add (was volume-triggered).
  //   security_tier=3         — reference-template default. Tier 2-3 only
  //                              triggers electronic security (TI).
  //   fenced_perimeter_lf=0   — no fencing unless explicitly set.
  const automationLevel = (state.facility?.automationLevel || state.facility?.automation_level || 'none').toLowerCase();
  const securityTier    = Number(state.facility?.securityTier ?? state.facility?.security_tier ?? 3);
  const fencedLf        = Number(state.facility?.fencedPerimeterLf ?? state.facility?.fenced_perimeter_lf ?? 0);

  const annualOrders = (state.volumeLines || [])
    .filter(v => v.isOutboundPrimary)
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  const annualPalletsIn = (state.volumeLines || [])
    .filter(v => v.uom === 'pallet')
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;

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
  if (totalDirectFtes > 0) {
    // Reach Truck
    const reachPeak = peakMheFteFromMlv('reach_truck');
    const reachQty = (reachPeak != null)
      ? (reachPeak / shiftsPerDay) * spareFactor
      : (totalDirectFtes / 3) * spareFactor;
    const reachDriver = (reachPeak != null)
      ? `Peak ${reachPeak.toFixed(1)} FTE ÷ ${shiftsPerDay} shifts × 1.15 spare (MLV shift-math)`
      : `${totalDirectFtes.toFixed(1)} direct FTE / 3 × 1.15 spare (heuristic)`;
    addEquip('Reach Truck', 'MHE', reachQty,
      /*monthlyCost*/ 800, /*acqCost*/ 0, /*maint*/ 150, reachDriver, 'lease');

    // Order Picker
    const pickerPeak = peakMheFteFromMlv('order_picker');
    const pickerQty = (pickerPeak != null)
      ? (pickerPeak / shiftsPerDay) * spareFactor
      : Math.max(0, (totalDirectFtes / 5) * spareFactor);
    const pickerDriver = (pickerPeak != null)
      ? `Peak ${pickerPeak.toFixed(1)} FTE ÷ ${shiftsPerDay} shifts × 1.15 spare (MLV shift-math)`
      : `${totalDirectFtes.toFixed(1)} direct FTE / 5 × 1.15 spare (heuristic)`;
    addEquip('Order Picker', 'MHE', pickerQty,
      600, 0, 100, pickerDriver, 'lease');

    // Sit-down forklift — only if MLV reports non-trivial peak. No
    // heuristic fallback (the prior code didn't generate this type).
    const forkliftPeak = peakMheFteFromMlv('sit_down_forklift');
    if (forkliftPeak != null && forkliftPeak >= 0.5) {
      const forkliftQty = (forkliftPeak / shiftsPerDay) * spareFactor;
      addEquip('Sit-Down Counterbalance Forklift', 'MHE', forkliftQty,
        750, 0, 150,
        `Peak ${forkliftPeak.toFixed(1)} FTE ÷ ${shiftsPerDay} shifts × 1.15 spare (MLV shift-math)`,
        'lease');
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 2. IT Infrastructure — Capital per reference model. RF devices,
  //    printers, WiFi APs, switches. NEVER leased (was lease pre-audit).
  // ────────────────────────────────────────────────────────────────
  if (totalDirectFtes > 0) {
    // RF: ~$2,850 purchase, 3-year life. Flipped from $150/mo lease.
    addEquip('RF Handheld / Mobile Computer', 'IT',
      Math.ceil(totalDirectFtes * spareFactor * 0.3),
      0, 2850, 15, 'Direct labor × 30% coverage', 'capital', 3);
  }
  addEquip('Label Printer (Thermal)', 'IT',
    Math.max(1, Math.ceil(totalHC / 50)),
    0, 1500, 25, 'Pack stations + Receiving/Shipping', 'capital', 5);
  if (sqft > 0) {
    // WiFi AP: ~$540/unit. Flipped from $100/mo lease.
    addEquip('WiFi Access Point (warehouse)', 'IT',
      Math.max(2, Math.ceil(sqft / 10000)),
      0, 540, 0, sqft.toLocaleString() + ' sqft @ 1 per 10K sqft', 'capital', 5);
    // Network backbone — one 24-port PoE switch per 50K sqft.
    addEquip('Switch (24-port PoE)', 'IT',
      Math.max(2, Math.ceil(sqft / 50000)),
      0, 3024, 0, '1 per 50K sqft', 'capital', 7);
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
      avgPalletsOnHand.toLocaleString() + ' avg pallets + 15% buffer', 'lease');
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
      0, 1200, 50, forkliftCount + ' electric MHE units', 'capital', 7);
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
      0, 20000, 0, 'Security Tier ' + securityTier, 'ti');
    const cameraCount = Math.max(4, Math.ceil(sqft / 30000));
    addEquip('Security Cameras', 'Security', cameraCount,
      0, 1562, 0, cameraCount + ' cameras (sqft / 30K)', 'ti');
  }
  if (securityTier >= 3) {
    // Access control — TI (default tier)
    addEquip('Access Control System (head-end)', 'Security', 1,
      0, 20000, 0, 'Security Tier ' + securityTier, 'ti');
    addEquip('Employee Entrance (turnstile)', 'Security', 1,
      0, 2500, 0, 'Security Tier 3+', 'ti');
  }
  if (securityTier >= 4) {
    // Guard shack + gate — Capital (physical)
    addEquip('External Guard Shack', 'Security', 1,
      0, 43000, 0, 'Security Tier 4', 'capital', 15);
    addEquip('Gate Automation', 'Security', 1,
      0, 25000, 0, 'Security Tier 4', 'capital', 10);
  }
  if (fencedLf > 0) {
    // Physical perimeter — Capital
    addEquip('Perimeter Fencing', 'Security', fencedLf,
      0, 52, 0, fencedLf + ' LF', 'capital', 15);
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
      'lease');
  }

  return lines;
}

// ============================================================
// AUTO-GENERATION — OVERHEAD
// ============================================================

/**
 * Auto-generate overhead lines based on sqft, HC, and volume.
 * @param {Object} state
 * @returns {import('./types.js?v=20260418-sK').OverheadLine[]}
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

  // Helper
  const addOh = (category, description, annualCost, costType = 'annual', pricingBucket = '') => {
    lines.push({
      category,
      description,
      cost_type: costType,
      annual_cost: costType === 'annual' ? annualCost : 0,
      monthly_cost: costType === 'monthly' ? annualCost : 0,
      pricing_bucket: pricingBucket,
    });
  };

  // PER-SQFT SCALERS
  if (sqft > 0) {
    addOh('Facility Maintenance', 'Janitorial, HVAC maint, pest control, repairs (IFMA benchmark)', sqft * 1.00);
    addOh('Security', 'Monitoring, camera systems, access control', sqft * 0.12);
    addOh('Property & Liability Insurance', 'Property, GL, umbrella coverage', sqft * 0.35);
    addOh('Fire & Life Safety', 'Sprinkler inspection, suppression, extinguishers', sqft * 0.04);
  }

  // PER-HEADCOUNT SCALERS
  if (totalHC > 0) {
    addOh('IT / WMS Licensing', 'BY WMS, RF mgmt, networking, printers, telecom', totalHC * 2500);
    addOh('HR & Recruiting', 'Payroll, benefits, onboarding + replacement hires', (totalHC * 2500) + (annualHires * 4700));
    addOh('Workers Comp Insurance', 'Workers comp premiums, warehouse risk class', totalHC * 1250);
    addOh('Safety & Compliance', 'OSHA compliance, training, safety supplies', totalHC * 800);
    addOh('Uniforms & PPE', 'Safety vests, gloves, boots, hard hats, eye protection', (totalHC + annualHires) * 400);
  }

  // PER-UNIT SCALERS
  const annualOrders = (state.volumeLines || [])
    .filter(v => v.isOutboundPrimary)
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  const annualUnitsShipped = annualOrders + ((state.volumeLines || [])
    .filter(v => v.uom === 'pallet')
    .reduce((s, v) => s + (v.volume || 0), 0) || 0);

  if (annualUnitsShipped > 0) {
    addOh('Supplies & Consumables', 'Stretch wrap, labels, tape, dunnage, cleaning', annualUnitsShipped * 0.15);
  }
  if (annualOrders > 0) {
    addOh('Quality & Inspection', 'QC labor overhead, quality systems, audits', annualOrders * 0.25);
  }

  return lines;
}

// ============================================================
// AUTO-GENERATION — STARTUP
// ============================================================

/**
 * Auto-generate startup/capital lines.
 * @param {Object} state
 * @returns {import('./types.js?v=20260418-sK').StartupLine[]}
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

  const addStartup = (description, cost) => {
    if (cost > 0) {
      lines.push({
        description,
        one_time_cost: Math.ceil(cost),
      });
    }
  };

  // 1. Racking capital — $85/pallet position
  const annualPalletsIn = (state.volumeLines || [])
    .filter(v => v.uom === 'pallet')
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  if (annualPalletsIn > 0) {
    const turnsPerYear = 12;
    const avgPalletsOnHand = Math.ceil(annualPalletsIn / turnsPerYear);
    const rackPositions = Math.ceil(avgPalletsOnHand * 1.15);
    addStartup('Selective Pallet Racking Installation', rackPositions * 85);
  }

  // 2. Build-out — $45/sqft office, $30/sqft break room
  const totalIndirectHC = (state.indirectLaborLines || []).reduce((s, l) => s + (l.headcount || 0), 0);
  if (totalIndirectHC > 0) {
    const officeSqft = Math.ceil(totalIndirectHC * 120);
    addStartup('Office Build-Out', officeSqft * 45);
    const totalHC = Math.ceil(totalDirectFtes) + totalIndirectHC;
    const breakSqft = Math.max(200, Math.ceil(totalHC * 15));
    addStartup('Break Room Build-Out', breakSqft * 30);
  }

  // 3. IT infrastructure — $0.50/sqft + WMS $50K + $2K/user
  if (sqft > 0) {
    addStartup('Network Cabling & Infrastructure', sqft * 0.50);
  }
  if (totalDirectFtes > 0) {
    addStartup('WMS Implementation & Configuration', 50000 + (Math.ceil(totalDirectFtes) * 2000));
  }

  // 4. EDI setup
  addStartup('EDI Setup & Customer Integration', 15000);

  // 5. Dock installation — $4,500 per door
  const daysPerYear = (state.shifts?.daysPerWeek || 5) * (state.shifts?.weeksPerYear ?? 52);
  const dailyPalletsTotal = (annualPalletsIn || 0) / Math.max(1, daysPerYear);
  if (dailyPalletsTotal > 0) {
    const dockDoors = Math.max(2, Math.ceil(dailyPalletsTotal / 90));
    addStartup('Dock Leveler Installation', dockDoors * 4500);
  }

  // 6. MHE charging power drops — $3,500 per station
  const chargingStations = Math.max(0, Math.ceil((state.equipmentLines || [])
    .filter(l => l.equipment_name?.toLowerCase().includes('charging'))
    .reduce((s, l) => s + l.quantity, 0)));
  if (chargingStations > 0) {
    addStartup('Power Drops for MHE Charging', chargingStations * 3500);
  }

  // 7. Lighting — $1.25/sqft
  if (sqft >= 50000) {
    addStartup('High-Bay LED Lighting Upgrade', sqft * 1.25);
  }

  // 8. Safety barriers — $0.15/sqft
  if (sqft >= 50000) {
    addStartup('Guard Rails & Safety Barriers', sqft * 0.15);
  }

  // 9. Training / ramp-up — 30% labor inefficiency × ramp weeks
  if (totalDirectFtes > 0) {
    const rampWeeks = 8;
    const hoursPerShift = state.shifts?.hoursPerShift || 8;
    const daysPerWeek = state.shifts?.daysPerWeek || 5;
    const rampHours = rampWeeks * daysPerWeek * hoursPerShift;
    const avgRate = 20;
    addStartup('Training & Ramp-Up Premium', totalDirectFtes * rampHours * avgRate * 0.30);
    addStartup('Go-Live Support Team (4 weeks)', 4 * 40 * 180); // PM + IT + Trainer
  }

  // 10. Contingency — 5% of subtotal
  const subtotal = lines.reduce((s, l) => s + (l.one_time_cost || 0), 0);
  addStartup('Contingency (5%)', subtotal * 0.05);

  return lines;
}

// ============================================================
// DESIGN HEURISTICS — 10 BENCHMARK CHECKS
// ============================================================

/**
 * Generate 10 industry benchmark checks.
 * @param {Object} state
 * @param {import('./types.js?v=20260418-sK').CostSummary} summary
 * @returns {Array<{ type: 'ok'|'warn'|'info', title: string, detail: string }>}
 */
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
  const annualOrders = (state.volumeLines || [])
    .filter(v => v.isOutboundPrimary)
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;

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

  // 4. Cost per order
  if (summary.costPerOrder > 0) {
    if (summary.costPerOrder < 1.50) {
      checks.push({ type: 'warn', title: 'Cost/order very low ($' + summary.costPerOrder.toFixed(2) + ')',
        detail: 'Below $1.50/order is unusual. Check for missing cost components.' });
    } else if (summary.costPerOrder > 8.00) {
      checks.push({ type: 'warn', title: 'Cost/order above range ($' + summary.costPerOrder.toFixed(2) + ')',
        detail: 'Benchmark: $3-6. Higher typical for B2B or low-volume accounts.' });
    } else {
      checks.push({ type: 'ok', title: 'Cost/order in range ($' + summary.costPerOrder.toFixed(2) + ')',
        detail: '$3-6 range is typical for ecommerce 3PL.' });
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

  // 10. Facility suggestion
  if (annualOrders > 0 && sqft > 0) {
    const palletsStored = ((state.volumeLines || [])
      .filter(v => v.uom === 'pallet')
      .reduce((s, v) => s + (v.volume || 0), 0) || 0) / 2 / 12;
    const estPalletArea = palletsStored * 40;
    const suggestedSqft = Math.round((estPalletArea + (sqft * 0.25)) / 1000) * 1000;
    if (suggestedSqft > 0 && Math.abs(suggestedSqft - sqft) / sqft > 0.30) {
      checks.push({ type: 'info', title: 'Suggested facility size: ~' + suggestedSqft.toLocaleString() + ' sqft',
        detail: 'Current: ' + sqft.toLocaleString() + ' sqft (' + (sqft > suggestedSqft ? 'may be oversized' : 'may be undersized') + ').' });
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
    base_overhead_cost:  p.baseOverheadCost,
    base_vas_cost:       p.baseVasCost,
    startup_amort:       p.startupAmort,
    startup_capital:     p.startupCapital,
    base_orders:         p.baseOrders,
    margin_pct:          p.marginPct,
    vol_growth_pct:      p.volGrowthPct || 0,
    labor_esc_pct:       p.laborEscPct  || 0,
    cost_esc_pct:        p.costEscPct   || 0,
    tax_rate_pct:        p.taxRatePct ?? 25,
    dso_days:            p.dsoDays ?? 30,
    dpo_days:            p.dpoDays ?? 30,
    labor_payable_days:  p.laborPayableDays ?? 14,
    ramp:                p.ramp        || DEFAULT_RAMP_MEDIUM,
    seasonality:         p.seasonality || DEFAULT_FLAT_SEASONALITY,
    periods:             p.periods     || [],
    startupLines:        p.startupLines     || [],
    pricingBuckets:      p.pricingBuckets   || [],
    // Phase 4d — per-line monthly labor cost when laborLines + calcHeur available
    laborLines:          p.laborLines        || [],
    calcHeur:            p._calcHeur         || null,
    marketLaborProfile:  p.marketLaborProfile || null,
    // Phase A Labor Build-Up Logic additions (Brock 2026-04-20):
    wageLoadByYear:      p.wageLoadByYear    || null,
    shift2Premium:       Number(p.shift2Premium) || 0,
    shift3Premium:       Number(p.shift3Premium) || 0,
    ptoPct:              Number(p.ptoPct)        || 0,
  };
}
