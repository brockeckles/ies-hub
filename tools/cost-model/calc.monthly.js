/**
 * IES Hub v3 — Cost Model Phase 1 Monthly Calc Engine
 *
 * Pure functions only. No DOM, no Supabase, no browser globals.
 * Persistence helpers (persistMonthlyFacts / fetchMonthlyProjections) live
 * in api.js — see that file for I/O hooks.
 *
 * Acceptance criteria (from /sessions/.../mnt/cm/Phase 1 Design.docx):
 *   1. Sum of monthly revenue × 12 reconciles to annual revenue ± 0.5%
 *   2. Cumulative_cash_flow first becomes positive within ± 1 month of the
 *      annual-calc payback
 *   3. Pre-go-live months have zero revenue, zero labor, positive opex
 *   4. delta_ar ≈ DSO/30 × period-1 revenue in month 0; delta_ar trends to
 *      ~0 in steady state
 *   5. Tax = max(0, ebit × tax_rate_pct/100) — uses project rate, not
 *      hardcoded 25%
 *
 * Phase 4d: when laborLines + calcHeur are supplied, per-period labor cost
 * is summed from per-line monthlyEffectiveHours × fully-loaded rate,
 * honoring Phase 4b per-line monthly OT/absence profiles and Phase 4c
 * market-profile fallbacks. When laborLines is empty the engine falls back
 * to the Phase 1 aggregate-times-seasonalShare shape for backward compat.
 *
 * @module tools/cost-model/calc.monthly
 */

import { monthlyEffectiveHours } from './calc.scenarios.js';

// ============================================================
// TYPEDEFS
// ============================================================

/**
 * @typedef {Object} Period
 * @property {number} id
 * @property {'month'|'quarter'|'year'} period_type
 * @property {number} period_index             0 = go-live month; negative = pre-go-live
 * @property {number} calendar_year
 * @property {number} calendar_month           1-12
 * @property {number} customer_fy_index        1-based
 * @property {number} customer_fm_index        1-12
 * @property {string} label                    'M-3', 'M1', 'Y1Q2', etc.
 * @property {boolean} is_pre_go_live
 */

/**
 * @typedef {Object} RevenueLineRef
 * @property {string} code
 * @property {string} display_name
 * @property {'fixed'|'variable'|'pass_through'|'deferred'|'as_incurred'|'one_time'} category
 * @property {number} sort_order
 * @property {boolean} is_active
 */

/**
 * @typedef {Object} ExpenseLineRef
 * @property {string} code
 * @property {string} display_name
 * @property {'cogs'|'opex'|'sga'|'one_time'|'depreciation'|'interest'|'tax'} category
 * @property {number} sort_order
 * @property {boolean} is_active
 */

/**
 * @typedef {Object} RampProfile
 * @property {'low'|'medium'|'high'|'custom'} type
 * @property {number} wk1_factor    productivity factor at end of week 1 (0-1)
 * @property {number} wk2_factor
 * @property {number} wk4_factor
 * @property {number} wk8_factor
 * @property {number} wk12_factor
 */

/**
 * @typedef {Object} SeasonalityProfile
 * @property {number[]} monthly_shares    12 values summing to 1.0
 */

// ============================================================
// PERIOD AXIS
// ============================================================

/**
 * Resolve the slice of ref_periods rows that a given project needs, keyed
 * to the project's go-live date and customer fiscal year start.
 *
 * @param {Period[]} dbPeriods            Raw rows from ref_periods
 * @param {Date}     goLiveDate
 * @param {number}   preGoLiveMonths      ≥ 0
 * @param {number}   contractTermYears
 * @param {number}   customerFyStartMonth 1-12
 * @returns {Period[]} sorted by period_index
 */
export function resolveProjectPeriods(dbPeriods, goLiveDate, preGoLiveMonths, contractTermYears, customerFyStartMonth) {
  const minIdx = -Math.max(0, preGoLiveMonths | 0);
  const maxIdx = (contractTermYears * 12) - 1;
  const goLive = goLiveDate instanceof Date ? goLiveDate : new Date(goLiveDate);

  const filtered = dbPeriods
    .filter(p => p.period_type === 'month' && p.period_index >= minIdx && p.period_index <= maxIdx)
    .map(p => {
      // Recompute calendar_year/month from the project's go-live date.
      const d = new Date(goLive.getFullYear(), goLive.getMonth() + p.period_index, 1);
      const calMonth = d.getMonth() + 1;
      const calYear  = d.getFullYear();

      // Customer FY indexing — Phase 1 simplification: count contract years
      // from go-live (FY1 = first 12 months operational). FY-start-month is
      // a display-layer concern; full alignment happens when reports need it.
      const customerFyIndex = Math.max(1, Math.floor(p.period_index / 12) + 1);
      const customerFmIndex = (((p.period_index % 12) + 12) % 12) + 1;

      return {
        ...p,
        calendar_year:     calYear,
        calendar_month:    calMonth,
        customer_fy_index: customerFyIndex,
        customer_fm_index: customerFmIndex,
        is_pre_go_live:    p.period_index < 0,
      };
    });

  return filtered.sort((a, b) => a.period_index - b.period_index);
}

/**
 * @param {Period[]} periods
 * @param {number}   periodIndex
 * @returns {number|null}
 */
export function periodIdForIndex(periods, periodIndex) {
  const p = periods.find(x => x.period_index === periodIndex);
  return p ? p.id : null;
}

// ============================================================
// RAMP + SEASONALITY HELPERS
// ============================================================

/** Internal: piecewise-linear interpolate between two points. */
function lerp(x, x0, y0, x1, y1) {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Productivity factor (0-1) at a given week of ramp. Linear interpolation
 * between the 5 anchor points (wk1 / wk2 / wk4 / wk8 / wk12). Returns 1.0
 * for weekNumber ≥ 12.
 *
 * @param {RampProfile} ramp
 * @param {number}      weekNumber  1-based, can be fractional
 * @returns {number}
 */
export function rampFactorAtWeek(ramp, weekNumber) {
  const w = weekNumber;
  if (w <= 1)  return ramp.wk1_factor;
  if (w >= 12) return 1.0;
  if (w <= 2)  return lerp(w, 1,  ramp.wk1_factor, 2,  ramp.wk2_factor);
  if (w <= 4)  return lerp(w, 2,  ramp.wk2_factor, 4,  ramp.wk4_factor);
  if (w <= 8)  return lerp(w, 4,  ramp.wk4_factor, 8,  ramp.wk8_factor);
  return            lerp(w, 8,  ramp.wk8_factor, 12, ramp.wk12_factor);
}

/**
 * Average productivity factor across one month of ramp. Samples
 * rampFactorAtWeek at 4 evenly-spaced points across the month and averages.
 *
 * @param {RampProfile} ramp
 * @param {number}      monthSinceGoLive   1 = first operational month
 * @returns {number}
 */
export function rampFactorForMonth(ramp, monthSinceGoLive) {
  if (monthSinceGoLive >= 3) return 1.0; // by month 3 we're past wk12 anchor
  const weeksInMonth = 52 / 12;
  const startWeek = (monthSinceGoLive - 1) * weeksInMonth + 1;
  let sum = 0;
  const samples = 4;
  for (let i = 0; i < samples; i++) {
    sum += rampFactorAtWeek(ramp, startWeek + (i + 0.5) * (weeksInMonth / samples));
  }
  return sum / samples;
}

/**
 * Seasonalize an annual volume to a single month.
 *
 * @param {number}              annualVolume
 * @param {SeasonalityProfile}  profile
 * @param {number}              calendarMonth   1-12
 * @returns {number}
 */
export function seasonalizedVolume(annualVolume, profile, calendarMonth) {
  const share = profile?.monthly_shares?.[calendarMonth - 1];
  return annualVolume * (typeof share === 'number' ? share : (1 / 12));
}

/**
 * @param {SeasonalityProfile} profile
 * @param {number}             [tolerance=0.001]
 * @returns {{ valid: boolean, sum: number, issue?: string }}
 */
export function validateSeasonality(profile, tolerance = 0.001) {
  if (!profile?.monthly_shares || !Array.isArray(profile.monthly_shares)) {
    return { valid: false, sum: 0, issue: 'monthly_shares must be an array' };
  }
  if (profile.monthly_shares.length !== 12) {
    return { valid: false, sum: 0, issue: `expected 12 monthly shares, got ${profile.monthly_shares.length}` };
  }
  const sum = profile.monthly_shares.reduce((s, v) => s + (Number(v) || 0), 0);
  const valid = Math.abs(sum - 1) <= tolerance;
  return valid ? { valid, sum } : { valid, sum, issue: `monthly_shares sum = ${sum.toFixed(4)}, expected 1.0` };
}

// ============================================================
// Phase 4d — PER-LINE MONTHLY LABOR COST
// ============================================================

/**
 * Sum per-line monthly labor cost for a specific period.
 * Each line contributes:
 *   monthlyEffectiveHours(line, monthIdx, calcHeur, market)
 *     × (seasonalShare × 12)   // expand fraction → multiplier; 1/12 = flat
 *     × rampLaborMult × volMult × escLaborMult
 *     × loadedRate
 * where loadedRate = effectiveBase × (1 + burden%) + benefits_per_hour
 * and effectiveBase applies Phase 4a temp_agency_markup_pct.
 *
 * Pure function — no I/O. Safe to call in a hot loop.
 *
 * @param {Object[]} laborLines
 * @param {Object} ctx — { calcHeur, marketLaborProfile, calendarMonth,
 *                         seasonalShare, escLaborMult, volMult, rampLaborMult }
 * @returns {number}
 */
export function computeMonthlyLaborFromLines(laborLines, ctx) {
  if (!Array.isArray(laborLines) || laborLines.length === 0) return 0;
  const { calcHeur, marketLaborProfile, calendarMonth,
          seasonalShare, escLaborMult, volMult, rampLaborMult } = ctx || {};
  const monthIdx = (((calendarMonth || 1) - 1) % 12 + 12) % 12;
  const seasonalMult = (Number(seasonalShare) || (1/12)) * 12; // flat season → 1.0
  const benefitLoadFallbackPct = (calcHeur?.benefitLoadPct ?? 35);
  let total = 0;
  for (const line of laborLines) {
    const hours = monthlyEffectiveHours(line, monthIdx, calcHeur, marketLaborProfile);
    // Phase 4a: employment-type markup folded into effective base rate
    const baseRate = Number(line.hourly_rate) || 0;
    const empType = line.employment_type || 'permanent';
    const markupFrac = (empType === 'temp_agency')
      ? (Number(line.temp_agency_markup_pct) || 0) / 100
      : 0;
    const effectiveBase = baseRate * (1 + markupFrac);
    // Loaded rate: burden + benefits (line-level burden takes precedence)
    const burdenFrac = (line.burden_pct != null)
      ? Number(line.burden_pct) / 100
      : benefitLoadFallbackPct / 100;
    const benefitsPerHr = Number(line.benefits_per_hour) || 0;
    const loadedRate = effectiveBase * (1 + burdenFrac) + benefitsPerHr;
    total += hours * loadedRate;
  }
  return total * seasonalMult
              * (Number(rampLaborMult) || 1)
              * (Number(volMult)       || 1)
              * (Number(escLaborMult)  || 1);
}

// ============================================================
// MAIN MONTHLY ENGINE
// ============================================================

/**
 * Build the full monthly projection bundle for a project.
 * See module docstring for the high-level algorithm.
 *
 * @param {Object} params  See BuildMonthlyParams in module-level JSDoc
 * @returns {{ periods: Period[], revenue: Object[], expense: Object[], cashflow: Object[] }}
 */
export function buildMonthlyProjections(params) {
  const {
    project_id,
    contract_term_years,
    pre_go_live_months = 0,
    base_labor_cost = 0,
    base_facility_cost = 0,
    base_equipment_cost = 0,
    base_overhead_cost = 0,
    base_vas_cost = 0,
    startup_amort = 0,
    startup_capital = 0,
    base_orders = 0,
    margin_pct = 0,
    vol_growth_pct = 0,
    labor_esc_pct = 0,
    cost_esc_pct = 0,
    tax_rate_pct = 25,
    dso_days = 30,
    dpo_days = 30,
    labor_payable_days = 14,
    ramp,
    seasonality,
    periods = [],
    startupLines = [],
    pricingBuckets = [],
    // Phase 4d additions (optional — falls back to aggregate when not supplied)
    laborLines = [],
    calcHeur = null,
    marketLaborProfile = null,
  } = params;

  // Slice the passed-in periods to only the contract window
  // [-pre_go_live_months .. contract_term_years*12 - 1]. The caller may
  // have passed a full ref_periods dump.
  const minIdx = -Math.max(0, pre_go_live_months | 0);
  const maxIdx = (contract_term_years * 12) - 1;
  const scopedPeriods = (periods || [])
    .filter(p => p.period_type !== 'quarter' && p.period_type !== 'year')
    .filter(p => p.period_index >= minIdx && p.period_index <= maxIdx)
    .sort((a, b) => a.period_index - b.period_index);

  // Validate seasonality (warn-level per D11, but we do renormalize silently
  // here to keep the engine resilient).
  let sProfile = seasonality;
  const sCheck = validateSeasonality(sProfile);
  if (!sCheck.valid && sProfile?.monthly_shares?.length === 12 && sCheck.sum > 0) {
    sProfile = { monthly_shares: sProfile.monthly_shares.map(v => v / sCheck.sum) };
  } else if (!sCheck.valid) {
    sProfile = { monthly_shares: Array(12).fill(1 / 12) };
  }

  // Total startup expenses (prof_serv + it_integ + onboarding etc.)
  const totalStartupExp = (startupLines || []).reduce((s, l) => s + (Number(l.one_time_cost) || 0), 0);
  const preLiveCount = Math.max(0, pre_go_live_months | 0);
  const preLiveMonthlyExp = preLiveCount > 0 ? (totalStartupExp / preLiveCount) : 0;

  // Annual depreciation amortized monthly (D9 simplification — Phase 2
  // replaces with per-asset schedules).
  const monthlyDepreciation = startup_amort / 12;

  /** @type {Object[]} */ const revenueRows  = [];
  /** @type {Object[]} */ const expenseRows  = [];
  /** @type {Object[]} */ const cashflowRows = [];

  // ---- PASS 1: per-period revenue + expense rows ----
  for (const p of scopedPeriods) {
    if (p.is_pre_go_live) {
      // Pre-go-live: only implementation expenses flow.
      // Allocate evenly across pre_go_live_months (D9 option A).
      if (preLiveMonthlyExp > 0) {
        // Split into prof_serv + it_integ + onboarding evenly, keyed to startupLines
        const totalCost = startupLines.reduce((s, l) => s + (Number(l.one_time_cost) || 0), 0);
        if (totalCost > 0) {
          for (const line of startupLines) {
            const pctOfStartup = (Number(line.one_time_cost) || 0) / totalCost;
            const monthlyAmt = preLiveMonthlyExp * pctOfStartup;
            const code = mapStartupLineToExpenseCode(line);
            expenseRows.push({
              project_id,
              period_id: p.id,
              expense_line_code: code,
              pricing_bucket_id: null,
              amount: monthlyAmt,
              source_line_table: 'cost_model_projects',
              source_line_id: null,
              notes: `pre-go-live allocation (${(pctOfStartup * 100).toFixed(1)}% of total)`,
            });
          }
        }
      }
      continue; // no revenue, no labor, no capex pre-go-live
    }

    // Operational month (period_index >= 0)
    const monthSinceGoLive = p.period_index + 1; // 1-based
    const yearIdx = Math.floor(p.period_index / 12); // 0-based
    const rampMult = rampFactorForMonth(ramp, monthSinceGoLive);
    // Ramp applied to labor COST as a "crew size" multiplier: at go-live we
    // run a smaller crew (lower cost); as the operation ramps we hire to
    // full complement. Labor cost m0 ~ base × 0.55; m12+ = base × 1.0.
    // This makes opex GROW over ramp months (matching the design intent).
    const rampLaborMult = rampMult;
    const seasonalShare = sProfile.monthly_shares[p.calendar_month - 1] ?? (1 / 12);
    const escLaborMult = Math.pow(1 + labor_esc_pct, yearIdx);
    const escCostMult  = Math.pow(1 + cost_esc_pct,  yearIdx);
    const volMult      = Math.pow(1 + vol_growth_pct, yearIdx);

    // ---- Revenue rows ----
    // Phase 1 simplification: if pricingBuckets are populated, route through
    // them; else fall back to the legacy margin-driven proxy split across
    // categories. The fallback keeps existing projects from rendering as $0
    // monthly revenue during the parallel-run window.
    if (pricingBuckets && pricingBuckets.length > 0) {
      for (const bucket of pricingBuckets) {
        const bucketRev = computeBucketRevenueForMonth(bucket, {
          base_orders, vol_growth_pct, yearIdx, seasonalShare, contract_term_years,
        });
        if (bucketRev > 0) {
          revenueRows.push({
            project_id,
            period_id: p.id,
            revenue_line_code: mapBucketToRevenueLine(bucket),
            pricing_bucket_id: bucket.id,
            amount: bucketRev,
            volume_driver: bucket.volumeDriver || null,
            volume_units: bucket.volumeDriver ? base_orders * volMult * seasonalShare : null,
            rate_applied: bucket.rate || null,
            notes: null,
          });
        }
      }
    } else {
      // Margin-driven fallback (matches existing buildYearlyProjections path)
      const monthlyCost = (
        base_labor_cost     * escLaborMult * volMult * rampLaborMult
        + base_facility_cost * escCostMult
        + base_equipment_cost * escCostMult
        + base_overhead_cost  * escCostMult * Math.pow(1 + vol_growth_pct * 0.3, yearIdx)
        + base_vas_cost       * volMult
        + startup_amort
      ) / 12 * seasonalShare * 12; // unwind /12 vs *12 to keep it explicit
      const monthlyRev = monthlyCost * (1 + margin_pct);
      revenueRows.push({
        project_id,
        period_id: p.id,
        revenue_line_code: 'OTHER_REV',
        pricing_bucket_id: null,
        amount: monthlyRev,
        notes: 'margin-driven fallback (no pricing buckets defined)',
      });
    }

    // ---- Expense rows: split by category ----
    // Labor (hourly bucket; salary not split out here — Phase 4 does that)
    // Phase 4d: when laborLines are supplied, build monthly labor from
    // per-line monthlyEffectiveHours × fully-loaded rate. This surfaces
    // peak-month OT and summer-absence effects the aggregate path hides.
    let monthlyLabor;
    if (laborLines && laborLines.length > 0) {
      monthlyLabor = computeMonthlyLaborFromLines(
        laborLines,
        { calcHeur, marketLaborProfile, calendarMonth: p.calendar_month,
          seasonalShare, escLaborMult, volMult, rampLaborMult }
      );
    } else {
      monthlyLabor = base_labor_cost * escLaborMult * volMult * rampLaborMult / 12 * seasonalShare * 12;
    }
    if (monthlyLabor > 0) {
      expenseRows.push({
        project_id, period_id: p.id, expense_line_code: 'LABOR_HOURLY',
        pricing_bucket_id: null, amount: monthlyLabor,
        source_line_table: 'cost_model_labor', source_line_id: null,
      });
    }
    // Facility — flat across the year
    const monthlyFacility = base_facility_cost * escCostMult / 12;
    if (monthlyFacility > 0) {
      expenseRows.push({
        project_id, period_id: p.id, expense_line_code: 'FACILITY',
        pricing_bucket_id: null, amount: monthlyFacility,
        source_line_table: 'cost_model_overhead', source_line_id: null,
      });
    }
    // Equipment (leased)
    const monthlyEquip = base_equipment_cost * escCostMult / 12;
    if (monthlyEquip > 0) {
      expenseRows.push({
        project_id, period_id: p.id, expense_line_code: 'LEASED_EQUIP',
        pricing_bucket_id: null, amount: monthlyEquip,
        source_line_table: 'cost_model_equipment', source_line_id: null,
      });
    }
    // Overhead
    const monthlyOh = base_overhead_cost * escCostMult * Math.pow(1 + vol_growth_pct * 0.3, yearIdx) / 12;
    if (monthlyOh > 0) {
      expenseRows.push({
        project_id, period_id: p.id, expense_line_code: 'OVERHEAD',
        pricing_bucket_id: null, amount: monthlyOh,
        source_line_table: 'cost_model_overhead', source_line_id: null,
      });
    }
    // VAS — varies with volume + seasonality
    const monthlyVas = base_vas_cost * volMult * seasonalShare;
    if (monthlyVas > 0) {
      expenseRows.push({
        project_id, period_id: p.id, expense_line_code: 'PASS_THROUGH_EXP',
        pricing_bucket_id: null, amount: monthlyVas,
        source_line_table: 'cost_model_vas', source_line_id: null,
      });
    }
    // Depreciation — flat monthly amortization of startup_amort
    if (monthlyDepreciation > 0) {
      expenseRows.push({
        project_id, period_id: p.id, expense_line_code: 'DEPRECIATION',
        pricing_bucket_id: null, amount: monthlyDepreciation,
        source_line_table: 'derived', source_line_id: null,
      });
    }
  }

  // ---- PASS 2: cashflow rows (need t-1 for delta_*) ----
  // Build period_index → aggregated revenue/opex/labor maps first
  const revByPeriod   = aggregateByPeriod(revenueRows, periods);
  const expByPeriod   = aggregateByPeriod(expenseRows, periods);
  const laborByPeriod = aggregateByPeriod(
    expenseRows.filter(e => e.expense_line_code === 'LABOR_HOURLY' || e.expense_line_code === 'LABOR_SALARY'),
    periods,
  );
  const depByPeriod   = aggregateByPeriod(
    expenseRows.filter(e => e.expense_line_code === 'DEPRECIATION'),
    periods,
  );

  let prevRev = 0, prevOpex = 0, prevLabor = 0, cumFcf = 0;
  for (const p of scopedPeriods) {
    const revenue = revByPeriod.get(p.period_index) || 0;
    const opex    = expByPeriod.get(p.period_index) || 0;
    const labor   = laborByPeriod.get(p.period_index) || 0;
    const dep     = depByPeriod.get(p.period_index) || 0;

    const grossProfit = revenue - (opex - dep); // dep flows through opex but is non-cash
    const ebitda      = revenue - (opex - dep);
    const ebit        = revenue - opex;
    const taxes       = Math.max(0, ebit * (tax_rate_pct / 100));
    const netIncome   = ebit - taxes;

    const capex   = (p.period_index === 0) ? (startup_capital || 0) : 0;
    let deltaAr, deltaAp, deltaLaborAccrual, wcChange, ocf;
    if (p.is_pre_go_live) {
      // Pre-live implementation work is paid as-incurred; don't accrue
      // working capital offsets that would mask the cash burn. FCF = net
      // income for the period (which is negative since opex > 0, rev = 0).
      deltaAr = 0; deltaAp = 0; deltaLaborAccrual = 0; wcChange = 0;
      ocf = netIncome;
    } else {
      deltaAr = (revenue - prevRev) * (dso_days / 30);
      deltaAp = (opex - prevOpex) * (dpo_days / 30);
      deltaLaborAccrual = (labor - prevLabor) * (labor_payable_days / 30);
      wcChange = deltaAr - deltaAp - deltaLaborAccrual;
      ocf = netIncome + dep - wcChange;
    }
    const fcf = ocf - capex;
    cumFcf += fcf;

    cashflowRows.push({
      project_id,
      period_id: p.id,
      revenue,
      opex,
      gross_profit: grossProfit,
      ebitda,
      ebit,
      depreciation: dep,
      amortization: 0,
      taxes,
      net_income: netIncome,
      capex,
      delta_ar: deltaAr,
      delta_ap: deltaAp,
      delta_labor_accrual: deltaLaborAccrual,
      working_capital_change: wcChange,
      operating_cash_flow: ocf,
      free_cash_flow: fcf,
      cumulative_cash_flow: cumFcf,
    });

    prevRev = revenue; prevOpex = opex; prevLabor = labor;
  }

  // Return the SCOPED period slice (not the original input), so callers
  // can inspect the actual project window without filtering again.
  return { periods: scopedPeriods, revenue: revenueRows, expense: expenseRows, cashflow: cashflowRows };
}

// Aggregate row.amount into a Map<period_index, total> by joining via period_id.
function aggregateByPeriod(rows, periods) {
  const idToIndex = new Map(periods.map(p => [p.id, p.period_index]));
  const m = new Map();
  for (const r of rows) {
    const idx = idToIndex.get(r.period_id);
    if (idx === undefined) continue;
    m.set(idx, (m.get(idx) || 0) + (Number(r.amount) || 0));
  }
  return m;
}

// ============================================================
// HELPER: compute a pricing bucket's monthly revenue
// ============================================================

function computeBucketRevenueForMonth(bucket, ctx) {
  const { base_orders, vol_growth_pct, yearIdx, seasonalShare } = ctx;
  const volMult = Math.pow(1 + vol_growth_pct, yearIdx);
  if (bucket.type === 'fixed') {
    // Monthly fixed fee: assume bucket.rate is the monthly amount.
    return Number(bucket.rate) || 0;
  }
  // Variable: rate × volume × seasonality
  const annualVol = Number(bucket.annualVolume) || base_orders;
  const monthlyVol = annualVol * volMult * seasonalShare;
  return monthlyVol * (Number(bucket.rate) || 0);
}

function mapBucketToRevenueLine(bucket) {
  const id = (bucket.id || '').toLowerCase();
  if (id.includes('storage')) return 'STORAGE';
  if (id.includes('mgmt') || id.includes('management')) return 'FIXED';
  if (id.includes('handling')) return 'HANDLING';
  if (id.includes('labor')) return 'LABOR';
  if (id.includes('vas')) return 'OTHER_REV';
  if (id.includes('lease')) return 'OP_LEASE';
  if (bucket.type === 'fixed') return 'FIXED';
  return 'HANDLING';
}

function mapStartupLineToExpenseCode(line) {
  const desc = (line.description || '').toLowerCase();
  if (desc.includes('it') || desc.includes('integration')) return 'IT_INTEG_EXP';
  if (desc.includes('onboard'))                            return 'ONBOARD_EXP';
  if (desc.includes('prof') || desc.includes('service'))   return 'PROF_SERV_EXP';
  return 'PROF_SERV_EXP';
}

// ============================================================
// COMPUTE REVENUE / EXPENSE ROWS — exposed for unit tests
// ============================================================

export function computeRevenueRows(period, ctx, params) {
  // Convenience wrapper around the inline logic above for direct testing
  if (period.is_pre_go_live) return [];
  const rows = [];
  const { pricingBuckets = [] } = params;
  const seasonalShare = ctx.seasonalShare ?? (1 / 12);
  for (const bucket of pricingBuckets) {
    const amt = computeBucketRevenueForMonth(bucket, {
      base_orders: params.base_orders, vol_growth_pct: params.vol_growth_pct,
      yearIdx: ctx.yearIdx, seasonalShare,
    });
    if (amt > 0) {
      rows.push({
        project_id: params.project_id, period_id: period.id,
        revenue_line_code: mapBucketToRevenueLine(bucket),
        pricing_bucket_id: bucket.id, amount: amt,
      });
    }
  }
  return rows;
}

export function computeExpenseRows(period, ctx, params) {
  // Convenience wrapper — most callers use buildMonthlyProjections directly
  return [];
}

// ============================================================
// YEARLY WRAPPER
// ============================================================

/**
 * Aggregate a monthly bundle into the legacy YearlyProjection[] format.
 * Lets the existing buildYearlyProjections become a thin adapter.
 *
 * @param {{ periods: Period[], revenue: Object[], expense: Object[], cashflow: Object[] }} bundle
 * @param {number} contractTermYears
 * @returns {Object[]} YearlyProjection[]
 */
export function groupMonthlyToYearly(bundle, contractTermYears, opts = {}) {
  const idToPeriod = new Map(bundle.periods.map(p => [p.id, p]));
  // Per-category rollup for the Multi-Year P&L Summary table. Keep these
  // code sets in sync with the expense_line_code values emitted in
  // buildMonthlyProjections above. The sum of the 6 categories reconciles
  // to cashflow.opex for every in-window period, so sumByCategory totals
  // equal sum('opex') (Year-1+ window excludes pre-go-live PROF_SERV_EXP/
  // IT_INTEG_EXP/ONBOARD_EXP by period_index >= 0, matching the legacy
  // yearly path which doesn't model pre-live months).
  //
  // startup in the yearly P&L = annual depreciation of startup capital —
  // DEPRECIATION flows monthly over the whole contract, so per-year sum
  // reproduces the legacy `startupAmort` value.
  const CATEGORY_CODES = {
    labor:     new Set(['LABOR_HOURLY', 'LABOR_SALARY']),
    facility:  new Set(['FACILITY']),
    equipment: new Set(['LEASED_EQUIP']),
    overhead:  new Set(['OVERHEAD']),
    vas:       new Set(['PASS_THROUGH_EXP']),
    startup:   new Set(['DEPRECIATION']),
  };
  const out = [];
  for (let yr = 1; yr <= contractTermYears; yr++) {
    const inYear = (period_id) => {
      const p = idToPeriod.get(period_id);
      return !!p && p.period_index >= (yr - 1) * 12 && p.period_index < yr * 12;
    };
    const yrCfRows  = bundle.cashflow.filter(cf => inYear(cf.period_id));
    const yrExpRows = bundle.expense.filter(e => inYear(e.period_id));
    const sum = (key) => yrCfRows.reduce((s, r) => s + (r[key] || 0), 0);
    const sumByCategory = (codes) => yrExpRows.reduce(
      (s, r) => codes.has(r.expense_line_code) ? s + (Number(r.amount) || 0) : s,
      0,
    );
    // Orders per year = baseOrders × (1 + volGrowthPct)^(yr-1). Mirrors the
    // legacy yearly path (buildYearlyProjections) so the Multi-Year P&L
    // Orders row and top-of-summary Cost/Order tile tie out. Bug pre-2026-04-20:
    // hardcoded to 0 with a Phase 2 TODO.
    const baseOrdersY = Number(opts.baseOrders) || 0;
    const volGrowth   = Number(opts.volGrowthPct) || 0;
    const yearOrders  = baseOrdersY * Math.pow(1 + volGrowth, yr - 1);
    out.push({
      year: yr,
      orders: yearOrders,
      labor:     sumByCategory(CATEGORY_CODES.labor),
      facility:  sumByCategory(CATEGORY_CODES.facility),
      equipment: sumByCategory(CATEGORY_CODES.equipment),
      overhead:  sumByCategory(CATEGORY_CODES.overhead),
      vas:       sumByCategory(CATEGORY_CODES.vas),
      startup:   sumByCategory(CATEGORY_CODES.startup),
      totalCost: sum('opex'),
      revenue: sum('revenue'),
      grossProfit: sum('gross_profit'),
      ebitda: sum('ebitda'),
      ebit: sum('ebit'),
      depreciation: sum('depreciation'),
      taxes: sum('taxes'),
      netIncome: sum('net_income'),
      capex: sum('capex'),
      workingCapitalChange: sum('working_capital_change'),
      operatingCashFlow: sum('operating_cash_flow'),
      freeCashFlow: sum('free_cash_flow'),
    });
  }
  return out;
}

// ============================================================
// MONTHLY PROJECTION VIEW (for Timeline UI)
// ============================================================

/**
 * Build the UI-facing MonthlyProjection[] by joining cashflow + period meta
 * and pivoting revenue/expense by line code into maps.
 *
 * @param {{ periods: Period[], revenue: Object[], expense: Object[], cashflow: Object[] }} bundle
 * @returns {Object[]}
 */
export function monthlyProjectionView(bundle) {
  const idToPeriod = new Map(bundle.periods.map(p => [p.id, p]));
  const view = [];
  // Pre-build per-period pivots
  const revPivot = new Map();
  for (const r of bundle.revenue) {
    if (!revPivot.has(r.period_id)) revPivot.set(r.period_id, {});
    const m = revPivot.get(r.period_id);
    m[r.revenue_line_code] = (m[r.revenue_line_code] || 0) + (r.amount || 0);
  }
  const expPivot = new Map();
  for (const e of bundle.expense) {
    if (!expPivot.has(e.period_id)) expPivot.set(e.period_id, {});
    const m = expPivot.get(e.period_id);
    m[e.expense_line_code] = (m[e.expense_line_code] || 0) + (e.amount || 0);
  }
  for (const cf of bundle.cashflow) {
    const p = idToPeriod.get(cf.period_id);
    if (!p) continue;
    view.push({
      period_index: p.period_index,
      calendar_year: p.calendar_year,
      calendar_month: p.calendar_month,
      customer_fy_index: p.customer_fy_index,
      period_label: p.label,
      is_pre_go_live: p.is_pre_go_live,
      revenue: cf.revenue,
      opex: cf.opex,
      gross_profit: cf.gross_profit,
      ebitda: cf.ebitda,
      net_income: cf.net_income,
      capex: cf.capex,
      free_cash_flow: cf.free_cash_flow,
      cumulative_cash_flow: cf.cumulative_cash_flow,
      revenue_by_line: revPivot.get(cf.period_id) || {},
      expense_by_line: expPivot.get(cf.period_id) || {},
    });
  }
  return view.sort((a, b) => a.period_index - b.period_index);
}

// ============================================================
// MONTHLY DIRECT LABOR VIEW (Brock 2026-04-20 — peak/avg/min staffing)
// ============================================================

/**
 * Build a per-period monthly view of direct labor FTE + downstream MHE/IT
 * equipment counts + indirect-staffing implications. Lets the user see
 * seasonal peaks, decide long-term vs short-term MHE lease mix, and
 * understand how indirect headcount scales with direct peaks.
 *
 * FTE per line per month formula:
 *   monthlyHours = line.annual_hours / 12
 *                × seasonalShare(calendarMonth) × 12   // unwind share to multiplier
 *                × rampMult                            // by month-since-go-live
 *                × volMult                             // by contract year
 *                × (1 + OT%) × (1 − absence%)          // OT/absence profiles
 *   fte = monthlyHours / (annualOpHours / 12)
 *
 * MHE/IT count per type at a given FTE level:
 *   count = ceil(sumFtesOnType / shiftsPerDay)
 *
 * (Shift structure: if 10 FTEs are on forklifts across 2 shifts, only
 * 5 are on-floor at any given time → 5 forklifts. Same for IT devices.)
 *
 * @param {Object} params
 * @param {Array} params.laborLines           — direct labor lines
 * @param {Period[]} params.periods           — scoped period axis
 * @param {number} params.annualOpHours       — from calc.operatingHours()
 * @param {number} params.shiftsPerDay        — from model.shifts.shiftsPerDay
 * @param {Object} [params.calcHeur]          — for overtimePct, absencePct
 * @param {Object|null} [params.marketLaborProfile] — Phase 4c monthly OT/abs
 * @param {Object} [params.ramp]              — RampProfile
 * @param {Object} [params.seasonality]       — SeasonalityProfile
 * @param {number} [params.volGrowthPct=0]
 * @param {Object} [params.indirectGenerator] — fn(state) → indirect lines,
 *                                              used for peak/avg HC implication
 * @param {Object} [params.state]             — for indirect generator input
 * @returns {{ months: Array, summary: Object }}
 */
export function computeMonthlyLaborView(params) {
  const {
    laborLines = [],
    periods = [],
    annualOpHours = 2080,
    shiftsPerDay = 1,
    calcHeur = {},
    marketLaborProfile = null,
    ramp = null,
    seasonality = null,
    volGrowthPct = 0,
    indirectGenerator = null,
    state = null,
  } = params;

  // Normalize seasonality — same treatment as buildMonthlyProjections
  let sProfile = seasonality;
  const sCheck = validateSeasonality(sProfile);
  if (!sCheck.valid && sProfile?.monthly_shares?.length === 12 && sCheck.sum > 0) {
    sProfile = { monthly_shares: sProfile.monthly_shares.map(v => v / sCheck.sum) };
  } else if (!sCheck.valid) {
    sProfile = { monthly_shares: Array(12).fill(1 / 12) };
  }

  const opHoursPerMonth = annualOpHours > 0 ? annualOpHours / 12 : 0;
  const shifts = Math.max(1, Math.floor(shiftsPerDay) || 1);

  // Only live months (period_index >= 0). Pre-go-live doesn't staff up.
  const live = (periods || []).filter(p => p.is_pre_go_live === false && p.period_type !== 'quarter' && p.period_type !== 'year');

  /** @type {Array<{period_index:number, calendar_year:number, calendar_month:number, label:string, total_fte:number, by_line:Object, by_mhe:Object, by_it:Object}>} */
  const months = [];

  for (const p of live) {
    const monthSinceGoLive = p.period_index + 1;
    const yearIdx = Math.floor(p.period_index / 12);
    // rampFactorForMonth crashes when ramp is null and monthSinceGoLive < 3
    // (it expects a RampProfile with wk1/2/4/8/12 anchors). If the caller
    // hasn't set a ramp, treat every month as fully ramped (1.0).
    const rampMult = ramp ? rampFactorForMonth(ramp, monthSinceGoLive) : 1.0;
    const seasonalShare = sProfile.monthly_shares[p.calendar_month - 1] ?? (1 / 12);
    const seasonalMult = seasonalShare * 12; // flat = 1.0
    const volMult = Math.pow(1 + (volGrowthPct || 0) / 100, yearIdx);

    const byLine = {};
    const byMhe = {};
    const byIt = {};
    let totalFte = 0;

    for (let i = 0; i < laborLines.length; i++) {
      const line = laborLines[i];
      const lineId = line.id != null ? String(line.id) : `idx_${i}`;
      // Effective hours for the calendar month — honors OT/absence profiles
      // AND the project-default calcHeur.overtimePct / absenceAllowancePct.
      const calMonth = (((p.calendar_month || 1) - 1) % 12 + 12) % 12;
      const hours = monthlyEffectiveHours(line, calMonth, calcHeur, marketLaborProfile)
                  * seasonalMult * rampMult * volMult;
      const fte = opHoursPerMonth > 0 ? (hours / opHoursPerMonth) : 0;

      byLine[lineId] = { fte, hours, activity: line.activity_name || '' };
      totalFte += fte;

      // Aggregate by MHE type + IT device — legacy `equipment_type` field is
      // a compat fallback for projects that pre-date the split.
      const mheType = line.mhe_type || line.equipment_type || '';
      if (mheType && mheType !== 'manual') {
        byMhe[mheType] = (byMhe[mheType] || 0) + fte;
      }
      const itDevice = line.it_device || '';
      if (itDevice) {
        byIt[itDevice] = (byIt[itDevice] || 0) + fte;
      }
    }

    months.push({
      period_index: p.period_index,
      calendar_year: p.calendar_year,
      calendar_month: p.calendar_month,
      label: p.label,
      total_fte: totalFte,
      by_line: byLine,
      by_mhe: byMhe,
      by_it: byIt,
    });
  }

  // ── SUMMARY: peak / avg / min across all contract months ──
  const safeFindPeakMonth = (keyFn) => {
    let best = null;
    for (const m of months) {
      const v = keyFn(m);
      if (best == null || v > best.v) best = { month: m, v };
    }
    return best;
  };
  const safeFindMinMonth = (keyFn) => {
    let best = null;
    for (const m of months) {
      const v = keyFn(m);
      if (best == null || v < best.v) best = { month: m, v };
    }
    return best;
  };

  const peakDirect = safeFindPeakMonth(m => m.total_fte) || { month: null, v: 0 };
  const minDirect = safeFindMinMonth(m => m.total_fte) || { month: null, v: 0 };
  const avgDirect = months.length ? months.reduce((s, m) => s + m.total_fte, 0) / months.length : 0;

  // ── Per-type roll-up for MHE and IT ──
  // For each equipment type, compute peak-month FTE (across all months),
  // avg-month FTE, min-month FTE, and the implied count at each level.
  const buildTypeSummary = (monthKey) => {
    /** @type {Object<string, {peakFte:number, avgFte:number, minFte:number, peakMonthLabel:string, minMonthLabel:string, peakCount:number, baselineCount:number, seasonalCount:number}>} */
    const out = {};
    // Collect all types that appear in any month
    const allTypes = new Set();
    for (const m of months) for (const t of Object.keys(m[monthKey] || {})) allTypes.add(t);
    for (const type of allTypes) {
      let peakFte = 0, peakLbl = '', minFte = Infinity, minLbl = '', sum = 0, count = 0;
      for (const m of months) {
        const v = (m[monthKey] && m[monthKey][type]) || 0;
        if (v > peakFte) { peakFte = v; peakLbl = m.label; }
        if (v < minFte)  { minFte  = v; minLbl  = m.label; }
        sum += v; count += 1;
      }
      if (!Number.isFinite(minFte)) minFte = 0;
      const avgFte = count > 0 ? sum / count : 0;
      const peakCount = Math.ceil(peakFte / shifts);
      const baselineCount = Math.ceil(minFte / shifts);  // min = what you need year-round
      out[type] = {
        peakFte, avgFte, minFte,
        peakMonthLabel: peakLbl, minMonthLabel: minLbl,
        peakCount, baselineCount,
        seasonalCount: Math.max(0, peakCount - baselineCount),  // short-term lease candidates
        avgCount: Math.ceil(avgFte / shifts),
      };
    }
    return out;
  };
  const byMheSummary = buildTypeSummary('by_mhe');
  const byItSummary  = buildTypeSummary('by_it');

  // ── Indirect staffing implication ──
  // Run autoGenerateIndirectLabor twice: once with peak direct FTE, once
  // with avg. Delta = seasonal indirect flex that might be rebalanced
  // via temps during peak.
  let indirectSummary = null;
  if (typeof indirectGenerator === 'function' && state) {
    try {
      const peakState = { ...state,
        laborLines: laborLines.map((l, i) => ({ ...l, annual_hours: (peakDirect.month?.by_line?.[l.id != null ? String(l.id) : `idx_${i}`]?.fte || 0) * annualOpHours })),
      };
      const avgState = { ...state,
        laborLines: laborLines.map((l, i) => {
          const lineId = l.id != null ? String(l.id) : `idx_${i}`;
          const avgFteThisLine = months.length
            ? months.reduce((s, m) => s + ((m.by_line?.[lineId]?.fte) || 0), 0) / months.length
            : 0;
          return { ...l, annual_hours: avgFteThisLine * annualOpHours };
        }),
      };
      const peakIndirect = indirectGenerator(peakState);
      const avgIndirect = indirectGenerator(avgState);
      const peakHc = peakIndirect.reduce((s, r) => s + (r.headcount || 0), 0);
      const avgHc = avgIndirect.reduce((s, r) => s + (r.headcount || 0), 0);
      // Merge by role name so we can show per-role peak vs avg
      const roleMap = {};
      for (const r of peakIndirect) roleMap[r.role_name] = { role: r.role_name, peakHc: r.headcount, avgHc: 0 };
      for (const r of avgIndirect) {
        if (!roleMap[r.role_name]) roleMap[r.role_name] = { role: r.role_name, peakHc: 0, avgHc: r.headcount };
        else roleMap[r.role_name].avgHc = r.headcount;
      }
      indirectSummary = {
        peakHc, avgHc,
        seasonalHc: Math.max(0, peakHc - avgHc),
        byRole: Object.values(roleMap).map(r => ({ ...r, seasonalHc: Math.max(0, r.peakHc - r.avgHc) })),
      };
    } catch (err) {
      console.warn('[CM] Monthly labor view: indirect generator failed', err);
    }
  }

  return {
    months,
    summary: {
      direct: {
        peakFte: peakDirect.v,
        peakMonthLabel: peakDirect.month?.label || '',
        avgFte: avgDirect,
        minFte: minDirect.v,
        minMonthLabel: minDirect.month?.label || '',
        shiftsPerDay: shifts,
      },
      byMhe: byMheSummary,
      byIt: byItSummary,
      indirect: indirectSummary,
    },
  };
}
