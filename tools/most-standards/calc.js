/**
 * IES Hub v3 — MOST Labor Standards Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 * Tested with Vitest in Node.js environment.
 *
 * @module tools/most-standards/calc
 */

// ============================================================
// CONSTANTS
// ============================================================

/** 1 TMU = 0.00001 hours = 0.036 seconds */
export const TMU_TO_SECONDS = 0.036;
export const TMU_TO_HOURS = 0.00001;
export const TMU_PER_HOUR = 100_000;

/** Default allowance percentages */
export const DEFAULT_PFD = { personal: 5, fatigue: 4, delay: 5 }; // 14% total

/** Standard operating days per year */
export const DEFAULT_OPERATING_DAYS = 260;

// ============================================================
// TMU CONVERSIONS
// ============================================================

/**
 * Convert TMU to seconds.
 * @param {number} tmu
 * @returns {number}
 */
export function tmuToSeconds(tmu) {
  return (tmu || 0) * TMU_TO_SECONDS;
}

/**
 * Convert TMU to hours.
 * @param {number} tmu
 * @returns {number}
 */
export function tmuToHours(tmu) {
  return (tmu || 0) * TMU_TO_HOURS;
}

/**
 * Convert TMU to minutes.
 * @param {number} tmu
 * @returns {number}
 */
export function tmuToMinutes(tmu) {
  return tmuToSeconds(tmu) / 60;
}

/**
 * Compute base UPH (units per hour) from total TMU.
 * @param {number} tmuTotal
 * @returns {number}
 */
export function baseUph(tmuTotal) {
  if (!tmuTotal || tmuTotal <= 0) return 0;
  return TMU_PER_HOUR / tmuTotal;
}

// ============================================================
// ALLOWANCES (PFD)
// ============================================================

/**
 * Compute total PFD percentage from an allowance profile.
 * @param {import('./types.js?v=20260418-s5').AllowanceProfile | { personal_pct?: number, fatigue_pct?: number, delay_pct?: number }} profile
 * @returns {number} total PFD percent (e.g., 14 for 14%)
 */
export function totalPfd(profile) {
  if (!profile) return 0;
  return (profile.personal_pct || 0) + (profile.fatigue_pct || 0) + (profile.delay_pct || 0);
}

/**
 * Apply PFD allowance to a base UPH.
 * Formula: adjustedUPH = baseUPH × (100 / (100 + PFD%))
 * @param {number} uph — base units per hour
 * @param {number} pfdPct — PFD percentage (e.g., 14 for 14%)
 * @returns {number} adjusted UPH
 */
export function adjustedUph(uph, pfdPct) {
  if (!uph || uph <= 0) return 0;
  const pfd = pfdPct || 0;
  return uph * (100 / (100 + pfd));
}

/**
 * Compute the cycle time in seconds after PFD adjustment.
 * @param {number} tmuTotal
 * @param {number} pfdPct
 * @returns {number} seconds per unit
 */
export function adjustedCycleTime(tmuTotal, pfdPct) {
  const uph = adjustedUph(baseUph(tmuTotal), pfdPct);
  if (uph <= 0) return 0;
  return 3600 / uph;
}

// ============================================================
// ELEMENT CALCULATIONS
// ============================================================

/**
 * Sum TMU across elements.
 * @param {import('./types.js?v=20260418-s5').MostElement[]} elements
 * @returns {number}
 */
export function sumElementTmu(elements) {
  return (elements || []).reduce((sum, el) => sum + (el.tmu || 0), 0);
}

/**
 * Count variable vs fixed elements.
 * @param {import('./types.js?v=20260418-s5').MostElement[]} elements
 * @returns {{ variable: number, fixed: number, total: number }}
 */
export function elementBreakdown(elements) {
  const list = elements || [];
  const variable = list.filter(e => e.is_variable).length;
  return { variable, fixed: list.length - variable, total: list.length };
}

/**
 * Compute effective TMU for a variable element given a complexity factor (0–1).
 * Linear interpolation between variable_min and variable_max.
 * @param {import('./types.js?v=20260418-s5').MostElement} element
 * @param {number} [factor=0.5] — 0 = min, 1 = max
 * @returns {number}
 */
export function variableElementTmu(element, factor = 0.5) {
  if (!element.is_variable) return element.tmu || 0;
  const min = element.variable_min ?? element.tmu;
  const max = element.variable_max ?? element.tmu;
  const f = Math.max(0, Math.min(1, factor));
  return min + (max - min) * f;
}

// ============================================================
// ANALYSIS LINE CALCULATIONS
// ============================================================

/**
 * Compute derived fields for a single analysis line.
 * @param {Object} params
 * @param {number} params.base_uph
 * @param {number} params.pfd_pct — PFD allowance %
 * @param {number} params.daily_volume
 * @param {number} params.shift_hours — e.g., 8 or 10
 * @param {number} [params.hourly_rate]
 * @returns {{ adjusted_uph: number, hours_per_day: number, fte: number, headcount: number, daily_cost: number }}
 */
export function computeAnalysisLine(params) {
  const adjUph = adjustedUph(params.base_uph || 0, params.pfd_pct || 0);
  const hoursPerDay = adjUph > 0 ? (params.daily_volume || 0) / adjUph : 0;
  const shiftHrs = params.shift_hours || 8;
  const fte = shiftHrs > 0 ? hoursPerDay / shiftHrs : 0;
  const headcount = Math.ceil(fte);
  const dailyCost = hoursPerDay * (params.hourly_rate || 0);

  return { adjusted_uph: adjUph, hours_per_day: hoursPerDay, fte, headcount, daily_cost: dailyCost };
}

/**
 * Compute full analysis summary from a set of lines.
 * @param {import('./types.js?v=20260418-s5').AnalysisLine[]} lines
 * @param {number} operatingDays — annual operating days
 * @returns {import('./types.js?v=20260418-s5').AnalysisSummary}
 */
export function computeAnalysisSummary(lines, operatingDays = DEFAULT_OPERATING_DAYS) {
  const result = {
    totalFtes: 0,
    totalHeadcount: 0,
    totalHoursPerDay: 0,
    dailyCost: 0,
    annualCost: 0,
    operatingDays,
    ftesByCategory: { manual: 0, mhe: 0, hybrid: 0 },
    hoursByCategory: { manual: 0, mhe: 0, hybrid: 0 },
  };

  for (const line of (lines || [])) {
    result.totalFtes += line.fte || 0;
    result.totalHeadcount += line.headcount || 0;
    result.totalHoursPerDay += line.hours_per_day || 0;
    result.dailyCost += line.daily_cost || 0;

    const cat = line.labor_category || 'manual';
    if (result.ftesByCategory[cat] !== undefined) {
      result.ftesByCategory[cat] += line.fte || 0;
      result.hoursByCategory[cat] += line.hours_per_day || 0;
    }
  }

  result.annualCost = result.dailyCost * operatingDays;
  return result;
}

// ============================================================
// WORKFLOW COMPOSER
// ============================================================

/**
 * Compute derived fields for a workflow step.
 * @param {Object} params
 * @param {number} params.base_uph
 * @param {number} params.pfd_pct
 * @param {number} params.target_volume — total daily target volume
 * @param {number} params.volume_ratio — fraction flowing through this step (0–1)
 * @param {number} params.shift_hours
 * @returns {{ adjusted_uph: number, daily_volume: number, hours_per_day: number, fte: number }}
 */
export function computeWorkflowStep(params) {
  const adjUph = adjustedUph(params.base_uph || 0, params.pfd_pct || 0);
  const dailyVol = (params.target_volume || 0) * (params.volume_ratio ?? 1);
  const hoursPerDay = adjUph > 0 ? dailyVol / adjUph : 0;
  const fte = (params.shift_hours || 8) > 0 ? hoursPerDay / (params.shift_hours || 8) : 0;

  return { adjusted_uph: adjUph, daily_volume: dailyVol, hours_per_day: hoursPerDay, fte };
}

/**
 * Analyze a full workflow pipeline.
 * @param {import('./types.js?v=20260418-s5').WorkflowStep[]} steps — with computed adjusted_uph
 * @returns {import('./types.js?v=20260418-s5').WorkflowResult}
 */
export function analyzeWorkflow(steps) {
  const result = {
    bottleneckUph: Infinity,
    bottleneckStep: '',
    totalFtes: 0,
    totalHoursPerDay: 0,
    ftesByCategory: { manual: 0, mhe: 0, hybrid: 0 },
  };

  for (const step of (steps || [])) {
    const adjUph = step.adjusted_uph || 0;
    if (adjUph > 0 && adjUph < result.bottleneckUph) {
      result.bottleneckUph = adjUph;
      result.bottleneckStep = step.step_name || '';
    }

    result.totalFtes += step.fte || 0;
    result.totalHoursPerDay += step.hours_per_day || 0;

    const cat = step.labor_category || 'manual';
    if (result.ftesByCategory[cat] !== undefined) {
      result.ftesByCategory[cat] += step.fte || 0;
    }
  }

  if (result.bottleneckUph === Infinity) result.bottleneckUph = 0;
  return result;
}

/**
 * Identify workflow bottleneck: the step with lowest adjusted UPH.
 * Returns bottleneck index, UPH, and % impact compared to average.
 * @param {import('./types.js?v=20260418-s5').WorkflowStep[]} steps — with computed adjusted_uph
 * @returns {{ bottleneckIdx: number, bottleneckUph: number, impactPercent: number }}
 */
export function calcWorkflowBottleneck(steps) {
  if (!steps || steps.length === 0) {
    return { bottleneckIdx: -1, bottleneckUph: 0, impactPercent: 0 };
  }

  const uphs = steps.map(s => s.adjusted_uph || 0).filter(u => u > 0);
  if (uphs.length === 0) {
    return { bottleneckIdx: -1, bottleneckUph: 0, impactPercent: 0 };
  }

  const avgUph = uphs.reduce((a, b) => a + b, 0) / uphs.length;
  let bottleneckIdx = -1;
  let minUph = Infinity;

  for (let i = 0; i < steps.length; i++) {
    const uph = steps[i].adjusted_uph || 0;
    if (uph > 0 && uph < minUph) {
      minUph = uph;
      bottleneckIdx = i;
    }
  }

  const impactPercent = bottleneckIdx >= 0 && minUph < Infinity
    ? ((avgUph - minUph) / avgUph * 100)
    : 0;

  return { bottleneckIdx, bottleneckUph: minUph < Infinity ? minUph : 0, impactPercent };
}

/**
 * Break down labor by category (manual / MHE / hybrid) for a set of steps.
 * @param {import('./types.js?v=20260418-s5').WorkflowStep[]} steps
 * @returns {{ manual: { hours: number, ftes: number }, mhe: { hours: number, ftes: number }, hybrid: { hours: number, ftes: number } }}
 */
export function calcCategoryBreakdown(steps) {
  const breakdown = {
    manual: { hours: 0, ftes: 0 },
    mhe: { hours: 0, ftes: 0 },
    hybrid: { hours: 0, ftes: 0 },
  };

  for (const step of (steps || [])) {
    const cat = step.labor_category || 'manual';
    if (breakdown[cat]) {
      breakdown[cat].hours += step.hours_per_day || 0;
      breakdown[cat].ftes += step.fte || 0;
    }
  }

  return breakdown;
}

/**
 * Compute annualized cost from daily cost and operating days.
 * @param {number} dailyCost
 * @param {number} operatingDays — e.g., 260
 * @returns {number}
 */
export function calcAnnualizedCost(dailyCost, operatingDays) {
  return (dailyCost || 0) * (operatingDays || DEFAULT_OPERATING_DAYS);
}

// ============================================================
// MOST → COST MODEL CONVERSION
// ============================================================

/**
 * Convert analysis lines into Cost Model direct labor lines.
 * This is the integration bridge: MOST analysis → CM laborLines.
 *
 * @param {import('./types.js?v=20260418-s5').AnalysisLine[]} lines
 * @param {Object} opts
 * @param {number} opts.operatingDays — annual operating days
 * @param {number} opts.shiftHours — hours per shift
 * @param {number} [opts.defaultBurdenPct=30]
 * @returns {import('./types.js?v=20260418-s5').MostToCmPayload['laborLines']}
 */
export function convertToCmLaborLines(lines, opts) {
  const opDays = opts.operatingDays || DEFAULT_OPERATING_DAYS;
  const shiftHrs = opts.shiftHours || 8;
  const burdenPct = opts.defaultBurdenPct ?? 30;

  return (lines || []).map(line => {
    const annualVolume = (line.daily_volume || 0) * opDays;
    const annualHours = (line.hours_per_day || 0) * opDays;

    return {
      activity_name: line.activity_name || '',
      process_area: line.process_area || '',
      labor_category: line.labor_category || 'manual',
      annual_hours: annualHours,
      base_uph: line.adjusted_uph || line.base_uph || 0,
      volume: annualVolume,
      hourly_rate: line.hourly_rate || 0,
      burden_pct: burdenPct,
      most_template_id: line.template_id || '',
      most_template_name: line.activity_name || '',
    };
  });
}

// ============================================================
// FORMATTING HELPERS (pure — no DOM)
// ============================================================

/**
 * Format TMU as a human-readable time string.
 * @param {number} tmu
 * @returns {string} e.g., "12.6s" or "2.1min"
 */
export function formatTmu(tmu) {
  const secs = tmuToSeconds(tmu);
  if (secs < 60) return secs.toFixed(1) + 's';
  return tmuToMinutes(tmu).toFixed(1) + 'min';
}

/**
 * Format UPH with appropriate precision.
 * @param {number} uph
 * @returns {string}
 */
export function formatUph(uph) {
  if (!uph || uph <= 0) return '—';
  return uph >= 100 ? Math.round(uph).toLocaleString() : uph.toFixed(1);
}

/**
 * Format FTE value.
 * @param {number} fte
 * @returns {string}
 */
export function formatFte(fte) {
  if (!fte || fte <= 0) return '0.0';
  return fte.toFixed(1);
}

/**
 * Get labor category display color.
 * @param {string} category — manual | mhe | hybrid
 * @returns {string} CSS color
 */
export function categoryColor(category) {
  switch (category) {
    case 'manual': return '#0047AB';
    case 'mhe': return '#20c997';
    case 'hybrid': return '#ff9500';
    default: return '#6c757d';
  }
}
