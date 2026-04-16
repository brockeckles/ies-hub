/**
 * IES Hub v3 — Cost Model Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 * Tested with Vitest in Node.js environment.
 *
 * Every formula that was duplicated across v2 (30+ inline calculations)
 * is now a single-source-of-truth function here.
 *
 * @module tools/cost-model/calc
 */

// ============================================================
// OPERATING HOURS
// ============================================================

/**
 * Calculate annual operating hours from shift configuration.
 * @param {import('./types.js').ShiftConfig} shifts
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
 * Fully loaded hourly rate: rate × (1 + burden%) + benefits.
 * @param {import('./types.js').DirectLaborLine | import('./types.js').IndirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.benefitLoadFallback] — default burden fraction if line has no burden_pct
 * @returns {number}
 */
export function fullyLoadedRate(line, opts = {}) {
  const rate = line.hourly_rate || 0;
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (opts.benefitLoadFallback ?? 0.30);
  const benefits = line.benefits_per_hour || 0;
  return rate * (1 + burden) + benefits;
}

/**
 * Annual cost for a direct labor line.
 * Includes shift differential and overtime adjustments.
 * @param {import('./types.js').DirectLaborLine} line
 * @param {Object} [opts]
 * @param {number} [opts.shiftDiffPct] — shift differential multiplier (0-based, e.g. 0.05 = 5%)
 * @param {number} [opts.otPct] — overtime % (0-based), applied at 1.5× rate
 * @param {number} [opts.benefitLoadFallback]
 * @returns {number}
 */
export function directLineAnnual(line, opts = {}) {
  const hours = line.annual_hours || 0;
  const rate = line.hourly_rate || 0;
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (opts.benefitLoadFallback ?? 0.30);
  const otMult = 1 + (opts.otPct || 0) * 0.5; // OT hours paid at 1.5×
  const effectiveRate = rate * (1 + burden) * otMult;
  return hours * effectiveRate;
}

/**
 * Simplified direct labor annual cost — no shift/OT (for inline cell display).
 * Formula: annual_hours × hourly_rate × (1 + burden%)
 * @param {import('./types.js').DirectLaborLine} line
 * @returns {number}
 */
export function directLineAnnualSimple(line) {
  const hours = line.annual_hours || 0;
  const rate = line.hourly_rate || 0;
  const burden = (line.burden_pct || 0) / 100;
  return hours * rate * (1 + burden);
}

/**
 * Annual cost for an indirect labor line.
 * Includes bonus multiplier.
 * @param {import('./types.js').IndirectLaborLine} line
 * @param {Object} opts
 * @param {number} opts.operatingHours — annual operating hours
 * @param {number} [opts.bonusPct] — bonus % (0-based)
 * @param {number} [opts.benefitLoadFallback]
 * @returns {number}
 */
export function indirectLineAnnual(line, opts) {
  const hc = line.headcount || 0;
  const rate = line.hourly_rate || 0;
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (opts.benefitLoadFallback ?? 0.30);
  const bonusMult = 1 + (opts.bonusPct || 0);
  return hc * opts.operatingHours * rate * (1 + burden) * bonusMult;
}

/**
 * Simplified indirect labor annual cost — for inline cell display.
 * Formula: headcount × operatingHours × hourly_rate × (1 + burden%)
 * @param {import('./types.js').IndirectLaborLine} line
 * @param {number} opHours
 * @returns {number}
 */
export function indirectLineAnnualSimple(line, opHours) {
  const hc = line.headcount || 0;
  const rate = line.hourly_rate || 0;
  const burden = (line.burden_pct || 0) / 100;
  return hc * opHours * rate * (1 + burden);
}

/**
 * FTE calculation: annual_hours / operatingHours.
 * @param {import('./types.js').DirectLaborLine} line
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
 * @param {import('./types.js').DirectLaborLine[]} directLines
 * @param {import('./types.js').IndirectLaborLine[]} indirectLines
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
 * @param {import('./types.js').DirectLaborLine[]} directLines
 * @param {import('./types.js').IndirectLaborLine[]} indirectLines
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
 * @param {import('./types.js').EquipmentLine} line
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
 * @param {import('./types.js').EquipmentLine} line
 * @returns {number}
 */
export function equipTotalAcq(line) {
  return (line.acquisition_cost || 0) * (line.quantity || 1);
}

/**
 * Annual amortization for a purchase equipment line.
 * @param {import('./types.js').EquipmentLine} line
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
 * @param {import('./types.js').EquipmentLine} line
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
 * @param {import('./types.js').EquipmentLine} line
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
 * @param {import('./types.js').EquipmentLine[]} lines
 * @returns {number}
 */
export function totalEquipmentCost(lines) {
  return lines.reduce((sum, line) => sum + equipLineAnnual(line), 0);
}

/**
 * Total capital investment (purchase equipment only).
 * @param {import('./types.js').EquipmentLine[]} lines
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
 * @param {import('./types.js').EquipmentLine[]} lines
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
 * @param {import('./types.js').OverheadLine} line
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
 * @param {import('./types.js').OverheadLine[]} lines
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
 * @param {import('./types.js').VASLine} line
 * @returns {number}
 */
export function vasLineAnnual(line) {
  if (line.total_cost) return line.total_cost;
  return (line.rate || 0) * (line.volume || 0);
}

/**
 * Total annual VAS cost.
 * @param {import('./types.js').VASLine[]} lines
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
 * @param {import('./types.js').FacilityConfig} facility
 * @param {import('./types.js').FacilityRate} [facilityRate]
 * @param {import('./types.js').UtilityRate} [utilityRate]
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
 * @param {import('./types.js').FacilityConfig} facility
 * @param {import('./types.js').FacilityRate} [facilityRate]
 * @param {import('./types.js').UtilityRate} [utilityRate]
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
 * @param {import('./types.js').StartupLine[]} lines
 * @param {number} contractYears
 * @returns {number}
 */
export function totalStartupAmort(lines, contractYears) {
  const years = Math.max(1, contractYears || 5);
  return lines.reduce((sum, line) => sum + (line.one_time_cost || 0) / years, 0);
}

/**
 * Total startup capital (one-time costs).
 * @param {import('./types.js').StartupLine[]} lines
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
 * @param {import('./types.js').DirectLaborLine[]} params.laborLines
 * @param {import('./types.js').IndirectLaborLine[]} params.indirectLaborLines
 * @param {import('./types.js').EquipmentLine[]} params.equipmentLines
 * @param {import('./types.js').OverheadLine[]} params.overheadLines
 * @param {import('./types.js').VASLine[]} params.vasLines
 * @param {import('./types.js').StartupLine[]} params.startupLines
 * @param {import('./types.js').FacilityConfig} params.facility
 * @param {import('./types.js').ShiftConfig} params.shifts
 * @param {import('./types.js').FacilityRate} [params.facilityRate]
 * @param {import('./types.js').UtilityRate} [params.utilityRate]
 * @param {number} params.contractYears
 * @param {number} params.targetMarginPct
 * @param {number} params.annualOrders
 * @param {Object} [params.laborOpts] — otPct, bonusPct, benefitLoadFallback
 * @returns {import('./types.js').CostSummary}
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
 * @param {import('./types.js').DirectLaborLine[]} [params.laborLines] — for learning curve calc
 * @returns {{ projections: import('./types.js').YearlyProjection[], startupCapital: number }}
 */
export function buildYearlyProjections(params) {
  const {
    years, baseLaborCost, baseFacilityCost, baseEquipmentCost,
    baseOverheadCost, baseVasCost, startupAmort, startupCapital,
    baseOrders, marginPct,
    volGrowthPct = 0, laborEscPct = 0, costEscPct = 0.03,
    laborLines = [],
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

  /** @type {import('./types.js').YearlyProjection[]} */
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

    const taxes = Math.max(0, ebit * 0.25);
    const netIncome = ebit - taxes;
    const capex = yr === 1 ? startupCapital : 0;
    const workingCapitalChange = yr === 1
      ? revenue * 0.08
      : revenue * volGrowthPct * 0.08;
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
 * @param {import('./types.js').YearlyProjection[]} projections
 * @param {Object} opts
 * @param {number} opts.startupCapital
 * @param {number} opts.discountRatePct — e.g. 10 for 10%
 * @param {number} opts.reinvestRatePct — e.g. 8 for 8%
 * @param {number} opts.totalFtes
 * @param {number} [opts.fixedCost] — annual fixed cost (for operating leverage)
 * @returns {import('./types.js').FinancialMetrics}
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

/** @returns {import('./types.js').FinancialMetrics} */
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
 * @param {import('./types.js').PricingBucket[]} params.buckets
 * @param {import('./types.js').DirectLaborLine[]} params.laborLines
 * @param {import('./types.js').IndirectLaborLine[]} params.indirectLaborLines
 * @param {import('./types.js').EquipmentLine[]} params.equipmentLines
 * @param {import('./types.js').OverheadLine[]} params.overheadLines
 * @param {import('./types.js').VASLine[]} params.vasLines
 * @param {import('./types.js').StartupLine[]} params.startupLines
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
 * @param {import('./types.js').CostModelData} model
 * @param {Object} [opts]
 * @param {number} [opts.operatingHours]
 * @returns {import('./types.js').ValidationWarning[]}
 */
export function validateModel(model, opts = {}) {
  /** @type {import('./types.js').ValidationWarning[]} */
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
