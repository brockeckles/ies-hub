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

import * as monthly from './calc.monthly.js?v=20260418-sV';

// ============================================================
// OPERATING HOURS
// ============================================================

/**
 * Calculate annual operating hours from shift configuration.
 * @param {import('./types.js?v=20260418-sK').ShiftConfig} shifts
 * @returns {number} annual operating hours per person
 */
export function operatingHours(shifts) {
  const h = shifts.hoursPerShift || 8;
  const d = shifts.daysPerWeek || 5;
  const w = shifts.weeksPerYear ?? 52;
  return h * d * w;
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
 * Fully loaded hourly rate: rate × (1 + burden%) + benefits.
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine | import('./types.js?v=20260418-sK').IndirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.benefitLoadFallback] — default burden fraction if line has no burden_pct
 * @returns {number}
 */
export function fullyLoadedRate(line, opts = {}) {
  const rate = effectiveHourlyRate(line);
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (opts.benefitLoadFallback ?? 0.30);
  const benefits = line.benefits_per_hour || 0;
  return rate * (1 + burden) + benefits;
}

/**
 * Annual cost for a direct labor line.
 * Includes shift differential and overtime adjustments.
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.shiftDiffPct] — shift differential multiplier (0-based, e.g. 0.05 = 5%)
 * @param {number} [opts.otPct] — overtime % (0-based), applied at 1.5× rate
 * @param {number} [opts.benefitLoadFallback]
 * @returns {number}
 */
export function directLineAnnual(line, opts = {}) {
  const hours = line.annual_hours || 0;
  const rate = effectiveHourlyRate(line);
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (opts.benefitLoadFallback ?? 0.30);
  const otMult = 1 + (opts.otPct || 0) * 0.5; // OT hours paid at 1.5×
  const effectiveRate = rate * (1 + burden) * otMult;
  return hours * effectiveRate;
}

/**
 * Simplified direct labor annual cost — no shift/OT (for inline cell display).
 * Formula: annual_hours × hourly_rate × (1 + burden% + benefitLoad%)
 * Burden and benefit load are global (from model.laborCosting).
 * @param {import('./types.js?v=20260418-sK').DirectLaborLine} line
 * @param {{ defaultBurdenPct?: number, benefitLoadPct?: number }} [costing]
 * @returns {number}
 */
export function directLineAnnualSimple(line, costing) {
  const hours = line.annual_hours || 0;
  const rate = effectiveHourlyRate(line);
  const c = costing || {};
  const burden = (c.defaultBurdenPct ?? 30) / 100;
  const benefits = (c.benefitLoadPct ?? 0) / 100;
  return hours * rate * (1 + burden + benefits);
}

/**
 * Annual cost for an indirect labor line.
 * Includes bonus multiplier.
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine} line
 * @param {Object} opts
 * @param {number} opts.operatingHours — annual operating hours
 * @param {number} [opts.bonusPct] — bonus % (0-based)
 * @param {number} [opts.benefitLoadFallback]
 * @returns {number}
 */
export function indirectLineAnnual(line, opts) {
  const hc = line.headcount || 0;
  const rate = effectiveHourlyRate(line);
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (opts.benefitLoadFallback ?? 0.30);
  const bonusMult = 1 + (opts.bonusPct || 0);
  return hc * opts.operatingHours * rate * (1 + burden) * bonusMult;
}

/**
 * Simplified indirect labor annual cost — for inline cell display.
 * Formula: headcount × operatingHours × hourly_rate × (1 + burden% + benefitLoad%)
 * Burden and benefit load are global (from model.laborCosting). If per-row
 * burden_pct is present (legacy indirect rows), it still overrides — indirect
 * roles can have materially different burden rates (management vs. warehouse).
 * @param {import('./types.js?v=20260418-sK').IndirectLaborLine} line
 * @param {number} opHours
 * @param {{ defaultBurdenPct?: number, benefitLoadPct?: number }} [costing]
 * @returns {number}
 */
export function indirectLineAnnualSimple(line, opHours, costing) {
  const hc = line.headcount || 0;
  const rate = effectiveHourlyRate(line);
  const c = costing || {};
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (c.defaultBurdenPct ?? 30) / 100;
  const benefits = (c.benefitLoadPct ?? 0) / 100;
  return hc * opHours * rate * (1 + burden + benefits);
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
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipLineAnnual(line) {
  const qty = line.quantity || 1;
  const type = line.acquisition_type || 'lease';

  if (type === 'purchase') {
    // Purchase: only maintenance counts as operating expense
    return (line.monthly_maintenance || 0) * 12 * qty;
  }
  // Lease or service: monthly cost + maintenance
  const monthly = (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
  return monthly * 12 * qty;
}

/**
 * Total acquisition cost for a purchase equipment line.
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipTotalAcq(line) {
  return (line.acquisition_cost || 0) * (line.quantity || 1);
}

/**
 * Annual amortization for a purchase equipment line.
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipLineAmort(line) {
  if ((line.acquisition_type || 'lease') !== 'purchase') return 0;
  const total = equipTotalAcq(line);
  const years = Math.max(1, line.amort_years || 5);
  return total / years;
}

/**
 * Full summary for an equipment line (used in equipment table row + pricing).
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {{ annual: number, capital: number, amort: number, leaseMo: number, maintAnnual: number }}
 */
export function equipLineSummary(line) {
  const qty = line.quantity || 1;
  const type = line.acquisition_type || 'lease';
  return {
    annual: equipLineAnnual(line),
    capital: type === 'purchase' ? equipTotalAcq(line) : 0,
    amort: equipLineAmort(line),
    leaseMo: type !== 'purchase' ? (line.monthly_cost || 0) * qty : 0,
    maintAnnual: (line.monthly_maintenance || 0) * 12 * qty,
  };
}

/**
 * Annual cost displayed in the equipment table row.
 * Includes amortization for purchase items (different from equipLineAnnual).
 * @param {import('./types.js?v=20260418-sK').EquipmentLine} line
 * @returns {number}
 */
export function equipLineTableCost(line) {
  const qty = line.quantity || 1;
  const type = line.acquisition_type || 'lease';

  if (type === 'purchase') {
    const maintenance = (line.monthly_maintenance || 0) * 12 * qty;
    const acqCost = (line.acquisition_cost || 0) * qty;
    const years = Math.max(1, line.amort_years || 5);
    return maintenance + acqCost / years;
  }
  const monthly = ((line.monthly_cost || 0) + (line.monthly_maintenance || 0)) * qty;
  return monthly * 12;
}

// ============================================================
// EQUIPMENT — AGGREGATE CALCULATIONS
// ============================================================

/**
 * Total annual equipment operating cost (lease/service + maintenance only).
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalEquipmentCost(lines) {
  return lines.reduce((sum, line) => sum + equipLineAnnual(line), 0);
}

/**
 * Total capital investment (purchase equipment only).
 * @param {import('./types.js?v=20260418-sK').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalEquipmentCapital(lines) {
  return lines.reduce((sum, line) => {
    if ((line.acquisition_type || 'lease') === 'purchase') {
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
 * @param {import('./types.js?v=20260418-sK').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sK').FacilityRate} [facilityRate]
 * @param {import('./types.js?v=20260418-sK').UtilityRate} [utilityRate]
 * @returns {number}
 */
export function totalFacilityCost(facility, facilityRate, utilityRate) {
  const sqft = facility.totalSqft || 0;
  const fr = facilityRate || {};
  const ur = utilityRate || {};

  const lease = sqft * (fr.lease_rate_psf_yr || 0);
  const cam = sqft * (fr.cam_rate_psf_yr || 0);
  const tax = sqft * (fr.tax_rate_psf_yr || 0);
  const insurance = sqft * (fr.insurance_rate_psf_yr || 0);
  const utility = sqft * 12 * (ur.avg_monthly_per_sqft || 0);

  return lease + cam + tax + insurance + utility;
}

/**
 * Facility cost breakdown by component.
 * @param {import('./types.js?v=20260418-sK').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sK').FacilityRate} [facilityRate]
 * @param {import('./types.js?v=20260418-sK').UtilityRate} [utilityRate]
 * @returns {{ lease: number, cam: number, tax: number, insurance: number, utility: number, total: number }}
 */
export function facilityCostBreakdown(facility, facilityRate, utilityRate) {
  const sqft = facility.totalSqft || 0;
  const fr = facilityRate || {};
  const ur = utilityRate || {};

  const lease = sqft * (fr.lease_rate_psf_yr || 0);
  const cam = sqft * (fr.cam_rate_psf_yr || 0);
  const tax = sqft * (fr.tax_rate_psf_yr || 0);
  const insurance = sqft * (fr.insurance_rate_psf_yr || 0);
  const utility = sqft * 12 * (ur.avg_monthly_per_sqft || 0);

  return { lease, cam, tax, insurance, utility, total: lease + cam + tax + insurance + utility };
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
  const facilityCost = totalFacilityCost(params.facility, params.facilityRate, params.utilityRate);
  const equipmentCost = totalEquipmentCost(params.equipmentLines);
  const overheadCost = totalOverheadCost(params.overheadLines);
  const vasCost = totalVasCost(params.vasLines);
  const startupAmort = totalStartupAmort(params.startupLines, params.contractYears);

  const totalCost = laborCost + facilityCost + equipmentCost + overheadCost + vasCost + startupAmort;
  const totalRevenue = totalCost * (1 + (params.targetMarginPct || 0) / 100);
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
    totalFtes: totalFtes(params.laborLines, params.indirectLaborLines, opHrs),
    costPerOrder: totalCost / orders,
    equipmentCapital: totalEquipmentCapital(params.equipmentLines),
    equipmentAmort: totalEquipmentAmort(params.equipmentLines),
    startupCapital: totalStartupCapital(params.startupLines),
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
    (typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE === true);
  // Require periods; ramp + seasonality are defaulted in the adapter if absent.
  if (useMonthly && Array.isArray(params.periods) && params.periods.length > 0) {
    const bundle = monthly.buildMonthlyProjections(adaptYearlyToMonthlyParams(params));
    return {
      projections: monthly.groupMonthlyToYearly(bundle, params.years),
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
    const revenue = totalCost * (1 + marginPct);
    const grossProfit = revenue - totalCost;
    const depreciation = startupAmort;
    const ebitda = grossProfit + depreciation;
    const ebit = grossProfit;
    const orders = baseOrders * volMult;

    // Phase 0 fix: per-project tax rate (was hardcoded 25%).
    const taxes = Math.max(0, ebit * (taxRatePct / 100));
    const netIncome = ebit - taxes;
    const capex = yr === 1 ? startupCapital : 0;
    // TODO (CM Phase 1): replace 8%-of-revenue working-capital proxy with
    // DSO/DPO/labor-payable model in calc.monthly.js. This proxy understates
    // WC volatility on growing accounts and overstates on shrinking ones.
    const WC_PROXY_PCT = 0.08;
    const workingCapitalChange = yr === 1
      ? revenue * WC_PROXY_PCT
      : revenue * volGrowthPct * WC_PROXY_PCT;
    const operatingCashFlow = netIncome + depreciation - workingCapitalChange;
    const freeCashFlow = operatingCashFlow - capex;

    projections.push({
      year: yr, orders, labor, facility, equipment, overhead, vas, startup,
      totalCost, revenue, grossProfit, ebitda, ebit, depreciation,
      taxes, netIncome, capex, workingCapitalChange, operatingCashFlow, freeCashFlow,
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
  const startupCapital = opts.startupCapital || 0;

  const totalRevenue = projections.reduce((s, p) => s + p.revenue, 0);
  const _totalCost = projections.reduce((s, p) => s + p.totalCost, 0);
  const totalGrossProfit = totalRevenue - _totalCost;
  const totalEbitda = projections.reduce((s, p) => s + p.ebitda, 0);
  const totalEbit = projections.reduce((s, p) => s + p.ebit, 0);

  const grossMarginPct = totalRevenue > 0 ? (totalGrossProfit / totalRevenue) * 100 : 0;
  const ebitdaMarginPct = totalRevenue > 0 ? (totalEbitda / totalRevenue) * 100 : 0;
  const ebitMarginPct = totalRevenue > 0 ? (totalEbit / totalRevenue) * 100 : 0;

  // ROIC
  const avgAnnualEbit = totalEbit / years;
  const investedCapital = startupCapital > 0 ? startupCapital : _totalCost * 0.1;
  const roicPct = investedCapital > 0 ? (avgAnnualEbit / investedCapital) * 100 : 0;

  // MIRR
  const cashFlows = [-startupCapital, ...projections.map(p => p.grossProfit)];
  let mirrPct = 0;
  if (startupCapital > 0 && cashFlows.length > 1) {
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

  // NPV
  let npv = 0;
  for (let i = 0; i < cashFlows.length; i++) {
    npv += cashFlows[i] / Math.pow(1 + discountRate, i);
  }

  // Payback period (months)
  let paybackMonths = years * 12;
  let cumCash = -startupCapital;
  for (let yr = 0; yr < years; yr++) {
    const monthlyProfit = projections[yr].grossProfit / 12;
    for (let m = 0; m < 12; m++) {
      cumCash += monthlyProfit;
      if (cumCash >= 0) {
        paybackMonths = yr * 12 + m + 1;
        yr = years; // break outer
        break;
      }
    }
  }

  // Revenue per FTE
  const revenuePerFte = opts.totalFtes > 0 ? projections[0].revenue / opts.totalFtes : 0;

  // Contribution margin per order
  const yr1 = projections[0];
  const contribPerOrder = yr1.orders > 0 ? yr1.grossProfit / yr1.orders : 0;

  // Operating leverage (fixed cost as % of total)
  const opLeveragePct = yr1.totalCost > 0 ? ((opts.fixedCost || 0) / yr1.totalCost) * 100 : 0;

  // Contract value & total investment
  const contractValue = totalRevenue;
  const totalInvestment = startupCapital + totalEquipmentCapitalFromProjections(projections);

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

  // Facility → storage bucket
  add('storage', params.facilityCost);

  // Roll unassigned into mgmt_fee
  if (costs['_unassigned'] > 0) {
    costs['mgmt_fee'] = (costs['mgmt_fee'] || 0) + costs['_unassigned'];
  }

  return costs;
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
    if ((line.acquisition_type || 'lease') === 'purchase' && (line.acquisition_cost || 0) <= 0) {
      warnings.push({ level: 'warning', area: 'equipment', message: `"${line.equipment_name}" is marked purchase but has $0 acquisition cost` });
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
export function sensitivityTable(baseCosts, baseOrders, adjustments = [-0.10, -0.05, 0.05, 0.10]) {
  const baseTotalCost = baseCosts.labor + baseCosts.facility + baseCosts.equipment +
    baseCosts.overhead + baseCosts.vas + baseCosts.startup;

  const drivers = [
    { label: 'Volume', key: 'volume' },
    { label: 'Labor Rate', key: 'labor' },
    { label: 'Facility Size', key: 'facility' },
    { label: 'Burden %', key: 'labor' }, // simplified — adjusts labor bucket
  ];

  return drivers.map(driver => ({
    label: driver.label,
    adjustments: adjustments.map(adj => {
      let adjusted = { ...baseCosts };
      if (driver.key === 'volume') {
        // Volume affects labor (proportional) and VAS
        adjusted.labor = baseCosts.labor * (1 + adj);
        adjusted.vas = baseCosts.vas * (1 + adj);
      } else {
        adjusted[driver.key] = baseCosts[driver.key] * (1 + adj);
      }
      const totalCost = adjusted.labor + adjusted.facility + adjusted.equipment +
        adjusted.overhead + adjusted.vas + adjusted.startup;
      const orders = driver.label === 'Volume' ? baseOrders * (1 + adj) : baseOrders;
      return {
        pct: adj * 100,
        totalCost,
        costPerOrder: orders > 0 ? totalCost / orders : 0,
        delta: totalCost - baseTotalCost,
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
 * @param {Object} state — { laborLines, indirectLaborLines, facility, shifts, financial }
 * @returns {import('./types.js?v=20260418-sK').IndirectLaborLine[]}
 */
export function autoGenerateIndirectLabor(state) {
  const lines = [];
  const opHrs = operatingHours(state.shifts || {});

  // Calculate total direct FTEs
  const totalDirectFtes = (state.laborLines || []).reduce((sum, l) => {
    if (!opHrs || opHrs <= 0) return sum;
    return sum + ((l.annual_hours || 0) / opHrs);
  }, 0);

  const totalDirectHC = Math.ceil(totalDirectFtes);

  // Helper to add indirect line
  const addRole = (name, headcount, rate, burden = 30) => {
    if (headcount > 0) {
      lines.push({
        role_name: name,
        headcount: Math.ceil(headcount),
        hourly_rate: rate,
        burden_pct: burden,
      });
    }
  };

  // 1. Team Leads: 1 per 8 direct FTEs (if >= 3 FTEs)
  if (totalDirectFtes >= 3) {
    addRole('Team Lead', Math.ceil(totalDirectFtes / 8), 22);
  }

  // 2. Supervisors: 1 per 15 FTEs (if >= 8 FTEs)
  if (totalDirectFtes >= 8) {
    addRole('Supervisor', Math.ceil(totalDirectFtes / 15), 28);
  }

  // 3. Operations Manager: 1 for 20+ FTEs, 2 for 80+
  if (totalDirectFtes >= 20) {
    const opsManagers = totalDirectFtes >= 80 ? 2 : 1;
    addRole('Operations Manager', opsManagers, 42);
  }

  // 4. Inventory Control: 1 per 25 direct FTEs
  if (totalDirectFtes > 0) {
    addRole('Inventory Control', Math.ceil(totalDirectFtes / 25), 20);
  }

  // 5. Receiving/Shipping Clerk: 1 per shift
  const shiftsPerDay = state.shifts?.shiftsPerDay || 1;
  addRole('Receiving / Shipping Clerk', Math.max(1, shiftsPerDay), 18);

  // 6. Customer Service: 1 per 500K orders/yr
  const annualOrders = (state.volumeLines || [])
    .filter(v => v.isOutboundPrimary)
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  if (annualOrders >= 500000) {
    addRole('Customer Service Rep', Math.ceil(annualOrders / 500000), 18);
  }

  // 7. Returns Processor: 1 per 100K returns/yr (estimate as 5% of outbound orders)
  const estimatedReturns = annualOrders * 0.05;
  if (estimatedReturns >= 100000) {
    addRole('Returns Processor', Math.ceil(estimatedReturns / 100000), 17);
  }

  // 8. IT Support: 0.5-2 based on FTE count
  if (totalDirectFtes >= 20) {
    const itHeadcount = Math.max(0.5, Math.min(2, Math.ceil(totalDirectFtes / 40)));
    addRole('IT Support', itHeadcount, 35);
  }

  // 9. Maintenance: 1 per 100K sqft
  const totalSqft = state.facility?.totalSqft || 0;
  if (totalSqft >= 100000) {
    addRole('Maintenance Technician', Math.ceil(totalSqft / 100000), 25);
  }

  // 10. Janitorial: 1 per 150K sqft (often outsourced, include as benchmark)
  if (totalSqft >= 150000) {
    addRole('Janitorial Supervisor', Math.ceil(totalSqft / 150000), 20);
  }

  // 11. Account Manager: 0.5-1 based on FTE
  if (totalDirectFtes >= 10) {
    addRole('Account Manager', totalDirectFtes >= 50 ? 1 : 0.5, 40);
  }

  // 12. General Manager: 1 if total HC >= 50
  if (totalDirectHC + lines.reduce((s, l) => s + l.headcount, 0) >= 50) {
    addRole('General Manager', 1, 55);
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
export function autoGenerateEquipment(state) {
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

  // Helper to add equipment
  const addEquip = (name, category, qty, monthlyLease = 0, acquisitionCost = 0, monthlyMaint = 0, drivenBy = '') => {
    if (qty > 0) {
      lines.push({
        equipment_name: name,
        category: category || 'Other',
        quantity: Math.ceil(qty),
        acquisition_type: acquisitionCost > 0 ? 'purchase' : 'lease',
        monthly_cost: monthlyLease,
        acquisition_cost: acquisitionCost,
        monthly_maintenance: monthlyMaint,
        amort_years: 5,
        driven_by: drivenBy,
      });
    }
  };

  // 1. MHE — From labor equipment assignments
  // Simplified: assume average labor needs 1 MHE per 2-3 FTEs
  if (totalDirectFtes > 0) {
    addEquip('Reach Truck', 'MHE', Math.ceil(totalDirectFtes / 3) * spareFactor, 800, 0, 150, 'Direct labor + 15% spare');
    addEquip('Order Picker', 'MHE', Math.max(0, Math.ceil(totalDirectFtes / 5) * spareFactor), 600, 0, 100, 'Picking labor');
  }

  // 2. IT — RF terminals, label printers, WiFi
  if (totalDirectFtes > 0) {
    addEquip('RF Terminal / Mobile Computer', 'IT', Math.ceil(totalDirectFtes * spareFactor) * 0.3, 150, 0, 20, 'Direct labor coverage (30%)');
  }
  addEquip('Label Printer (Thermal)', 'IT', Math.max(1, Math.ceil(totalHC / 50)), 0, 2500, 50, 'Pack stations + Receiving/Shipping');
  if (sqft > 0) {
    addEquip('WiFi Access Point', 'IT', Math.max(2, Math.ceil(sqft / 10000)), 100, 0, 20, sqft.toLocaleString() + ' sqft @ 1 per 10K sqft');
  }

  // 3. Racking — Based on pallet positions
  const annualPalletsIn = (state.volumeLines || [])
    .filter(v => v.uom === 'pallet')
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  if (annualPalletsIn > 0) {
    const turnsPerYear = 12;
    const avgPalletsOnHand = Math.ceil(annualPalletsIn / turnsPerYear);
    const rackPositions = Math.ceil(avgPalletsOnHand * 1.15);
    addEquip('Selective Pallet Rack', 'Racking', rackPositions, 0, 85, 10,
      avgPalletsOnHand.toLocaleString() + ' avg pallets + 15% buffer');
  }

  // 4. Dock Equipment — Levelers based on daily throughput
  const daysPerYear = (state.shifts?.daysPerWeek || 5) * (state.shifts?.weeksPerYear ?? 52);
  const dailyPalletsTotal = (annualPalletsIn || 0) / Math.max(1, daysPerYear);
  if (dailyPalletsTotal > 0) {
    const dockDoors = Math.max(2, Math.ceil(dailyPalletsTotal / 90));
    addEquip('Dock Leveler (Hydraulic)', 'Dock', dockDoors, 0, 3500, 200,
      Math.ceil(dailyPalletsTotal) + ' daily pallets / 90 per door = ' + dockDoors + ' doors');
  }

  // 5. Charging — 1 station per 6 electric MHE
  const forkliftCount = lines.filter(l =>
    l.equipment_name.toLowerCase().includes('truck') ||
    l.equipment_name.toLowerCase().includes('picker')
  ).reduce((s, l) => s + l.quantity, 0);
  if (forkliftCount > 0) {
    addEquip('Battery Charging Station (6-unit)', 'Charging', Math.max(1, Math.ceil(forkliftCount / 6)), 200, 0, 50,
      forkliftCount + ' electric MHE units');
  }

  // 6. Office Build-Out — 120 sqft per indirect HC
  if (totalIndirectHC > 0) {
    addEquip('Office Build-Out (sqft)', 'Office', Math.ceil(totalIndirectHC * 120), 0, 45, 5,
      totalIndirectHC + ' indirect HC @ 120 sqft/person');
    addEquip('Break Room Build-Out (sqft)', 'Office', Math.max(200, Math.ceil(totalHC * 15)), 0, 30, 3,
      totalHC + ' total HC @ 15 sqft/person');
  }

  // 7. Security — 1 camera system per 30K sqft
  if (sqft >= 50000) {
    addEquip('Security Camera System (8-cam)', 'Security', Math.max(1, Math.ceil(sqft / 30000)), 200, 0, 100,
      sqft.toLocaleString() + ' sqft @ 1 system per 30K sqft');
    addEquip('Access Control System', 'Security', 1, 150, 0, 50, 'Facility entry/exit');
  }

  // 8. Conveyor — Only for >= 500K orders/yr
  const annualOrders = (state.volumeLines || [])
    .filter(v => v.isOutboundPrimary)
    .reduce((s, v) => s + (v.volume || 0), 0) || 0;
  if (annualOrders >= 500000) {
    const conveyorLF = Math.min(500, Math.max(100, Math.ceil(annualOrders / 5000)));
    addEquip('Belt Conveyor (linear ft)', 'Conveyor', conveyorLF, 2, 0, 10,
      annualOrders.toLocaleString() + ' orders/yr');
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
  };
}
