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
  // Baseline year-round cost
  const baseline = hc * opHours * rate * (1 + burden + benefits);
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
    const seasonalAnnualRate = peakHc * opHours * rate * (1 + burden + benefits);
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
  const burden = line.burden_pct != null
    ? line.burden_pct / 100
    : (c.defaultBurdenPct ?? 30) / 100;
  const benefits = (c.benefitLoadPct ?? 0) / 100;
  const baseline = hc * opHours * rate * (1 + burden + benefits);
  let seasonal = 0;
  const peakHc = Number(line.peak_only_hc) || 0;
  const peakMonths = Number(line.peak_months) || 0;
  const peakMarkupPct = Number(line.peak_markup_pct) || 0;
  if (peakHc > 0 && peakMonths > 0) {
    const monthFraction = Math.min(12, peakMonths) / 12;
    const markupFactor = 1 + (peakMarkupPct / 100);
    seasonal = peakHc * opHours * rate * (1 + burden + benefits) * monthFraction * markupFactor;
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
  const type = line.acquisition_type || 'lease';

  let monthlyRate;
  if (type === 'purchase') {
    // Purchase: only maintenance counts as operating expense
    monthlyRate = (line.monthly_maintenance || 0);
  } else {
    // Lease or service: monthly cost + maintenance
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
  const type = line.acquisition_type || 'lease';
  const monthlyRate = type === 'purchase'
    ? (line.monthly_maintenance || 0)
    : (line.monthly_cost || 0) + (line.monthly_maintenance || 0);
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
export function equipLineTableCost(line, peakOverflowByMonth) {
  const qty = line.quantity || 1;
  const type = line.acquisition_type || 'lease';
  const markupPct = Number(line.peak_markup_pct) || 0;
  const hasOverflow = markupPct > 0 && Array.isArray(peakOverflowByMonth) && peakOverflowByMonth.length === 12;

  if (type === 'purchase') {
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
    const revenue = totalCost * (1 + marginPct);
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

  // If the P&L rollup didn't separate D&A, derive a "true" EBITDA by adding
  // back annual depreciation × years so EBIT Margin < EBITDA Margin holds.
  // When caller passes annualDepreciation: 0, behavior collapses to the raw path.
  const ebitdaAdjustment = Math.max(0, annualDepreciation * years - Math.max(0, totalEbitdaRaw - totalEbitRaw));
  const totalEbit   = totalEbitRaw;
  const totalEbitda = totalEbitdaRaw + ebitdaAdjustment;

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
  // Working-capital estimate (if caller didn't supply one directly).
  let estimatedNWC = avgWorkingCapitalOpt;
  if (estimatedNWC == null) {
    const dsoDays = Number(opts.dsoDays) || 0;
    const dpoDays = Number(opts.dpoDays) || 0;
    if (projections.length > 0 && dsoDays > 0) {
      const y1 = projections[0];
      const y1Revenue = Number(y1.revenue) || 0;
      const y1Cogs    = Number(y1.cogs) || Number(y1.totalCost) || 0;
      estimatedNWC = Math.max(0, y1Revenue * (dsoDays / 365) - y1Cogs * (dpoDays / 365));
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
 * Derive per-bucket rates from assigned costs + margin + volume driver.
 *
 * Mirrors the rate math the Pricing Schedule UI shows on-screen so that the
 * monthly engine (which reads `bucket.rate` literally) can fall back to the
 * same derived rate when no explicit rate is stored. This is the single
 * source of truth for "what rate does this bucket actually produce given
 * the cost rollup."
 *
 * @param {Object} params
 * @param {Array} params.buckets — model.pricingBuckets
 * @param {Record<string, number>} params.bucketCosts — output of computeBucketCosts
 * @param {number} params.marginPct — target margin (0-based fraction, e.g. 0.12)
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

  /** @type {Record<string, { rate: number, annualVolume: number, withMargin: number }>} */
  const out = {};
  for (const b of buckets) {
    const cost = bucketCosts[b.id] || 0;
    const withMargin = cost * (1 + marginPct);
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
 * Return a shallow-copied pricingBuckets array with `rate` and `annualVolume`
 * filled in from derived values when the bucket didn't have them set
 * explicitly. Explicit values always win — this is only a fallback so
 * brand-new models don't render $0 revenue until a user hand-wires each
 * bucket's rate.
 *
 * @param {Object} params — same shape as computeBucketRates
 * @returns {Array} — pricingBuckets with rate/annualVolume defaulted in
 */
export function enrichBucketsWithDerivedRates(params) {
  const derived = computeBucketRates(params);
  return (params.buckets || []).map(b => {
    const d = derived[b.id] || { rate: 0, annualVolume: 0 };
    const hasExplicitRate = Number(b.rate) > 0;
    const hasExplicitVol  = Number(b.annualVolume) > 0;
    return {
      ...b,
      rate:         hasExplicitRate ? Number(b.rate)         : d.rate,
      annualVolume: hasExplicitVol  ? Number(b.annualVolume) : d.annualVolume,
      // Diagnostic: surface where the value came from so UI can badge it.
      _rateSource:  hasExplicitRate ? 'explicit' : 'derived',
    };
  });
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
    // Phase 4d — per-line monthly labor cost when laborLines + calcHeur available
    laborLines:          p.laborLines        || [],
    calcHeur:            p._calcHeur         || null,
    marketLaborProfile:  p.marketLaborProfile || null,
  };
}
