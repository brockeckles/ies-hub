/**
 * IES Hub v3 — Cost Model Shift Planner (pure calc)
 *
 * The matrix layer between volume profile and labor stack. Given a % of daily
 * throughput by shift × function matrix + existing volume lines / UPH /
 * shift hours, derives headcount and hours by shift × function.
 *
 * Design invariants:
 *   - Pure (no DOM / no Supabase / no CDN globals / no window).
 *   - No mutation of inputs; every helper returns a new object / array.
 *   - Additive to the existing engine: consumers feed the output into today's
 *     laborLines / equipmentLines shape — the monthly engine is untouched.
 *
 * See ShiftPlanner_DesignMemo_2026-04-22.md for the mental model and the
 * full design context. See ShiftPlanner_Wiring_2026-04-22.md for the
 * public API contract.
 *
 * @module tools/cost-model/shift-planner
 */

// The canonical function vocabulary. Keep in sync with the CHECK in the
// ref_shift_archetype_defaults matrix JSONB schema.
export const FUNCTION_ORDER = [
  'inbound',
  'putaway',
  'picking',
  'replenish',
  'pack',
  'ship',
  'returns',
  'vas',
];

// Friendly labels + short descriptions for the UI column headers + tooltips.
export const FUNCTION_META = {
  inbound:   { label: 'Inbound',      tip: 'Any trailer unload / receipt work. Drives dock door demand.' },
  putaway:   { label: 'Putaway',      tip: 'Product moved from dock to storage location.' },
  picking:   { label: 'Picking',      tip: 'Any touch of product to an order container (case + each).' },
  replenish: { label: 'Replen',       tip: 'Pick-face replenishment; interior moves.' },
  pack:      { label: 'Pack',         tip: 'Order consolidation, cartonization, final pack.' },
  ship:      { label: 'Ship',         tip: 'Staging, loading, BOL/manifest, dispatch.' },
  returns:   { label: 'Returns',      tip: 'Reverse logistics processing (receive + disposition).' },
  vas:       { label: 'VAS',          tip: 'Value-added services (kitting, labeling, light assembly).' },
};

// Default shift time windows when we have to synthesize them (user has no
// explicit startHour/endHour set on their shifts config).
const DEFAULT_SHIFT_WINDOWS = [
  { startHour: 7,  endHour: 15 },
  { startHour: 15, endHour: 23 },
  { startHour: 23, endHour: 7  },
  { startHour: 0,  endHour: 8  },
];

// Day-of-week order — Mon..Sun. Used to index activeDays / dowVolumeMultipliers
// / dowPremiumPct arrays. Aligned with `deriveHourlyStaffing` heatmap labels.
export const DOW_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

/**
 * Build a default 7-element activeDays mask from a global daysPerWeek count.
 * Days 0..N-1 are active, N..6 are inactive. So daysPerWeek=5 yields
 * `[true,true,true,true,true,false,false]` (Mon-Fri).
 *
 * @param {number} daysPerWeek
 * @returns {boolean[]}
 */
export function defaultActiveDays(daysPerWeek) {
  const n = Math.max(1, Math.min(7, Math.floor(Number(daysPerWeek) || 5)));
  return DOW_ORDER.map((_, i) => i < n);
}

/**
 * Default DOW volume-multiplier vector. Active days get 1.0, inactive 0.0.
 * Callers (UI) override per-DOW (e.g., Sat at 0.5, Sun at 0) to express
 * weekend volume falloff.
 *
 * @param {number} daysPerWeek
 * @returns {number[]}
 */
export function defaultDowVolumeMultipliers(daysPerWeek) {
  const mask = defaultActiveDays(daysPerWeek);
  return mask.map(active => active ? 1 : 0);
}

/**
 * Default DOW premium %. Zero across the week — UI overrides Sat/Sun for
 * weekend OT premium (SP-3).
 *
 * @returns {number[]}
 */
export function defaultDowPremiumPct() {
  return new Array(7).fill(0);
}

/**
 * Normalize per-shift activeDays. If a shift lacks `activeDays`, derive
 * from the global daysPerWeek. Also clamps to length 7 + coerces to bool.
 * Returns a NEW shifts array — does not mutate.
 *
 * @param {Array<Object>} shifts
 * @param {number} daysPerWeek
 * @returns {Array<Object>}
 */
export function normalizeShiftActiveDays(shifts, daysPerWeek) {
  if (!Array.isArray(shifts)) return [];
  const fallback = defaultActiveDays(daysPerWeek);
  return shifts.map(s => {
    if (!s) return s;
    if (Array.isArray(s.activeDays) && s.activeDays.length === 7) {
      return { ...s, activeDays: s.activeDays.map(v => Boolean(v)) };
    }
    return { ...s, activeDays: fallback.slice() };
  });
}

/**
 * Compute the effective operating days/year for a single shift, given its
 * activeDays mask + the project's DOW volume multipliers + weeks/year.
 *   = sum_d (activeDays[d] ? dowMul[d] : 0) × weeksPerYear
 *
 * For backward compat: a shift that runs uniform M-F (activeDays =
 * [1,1,1,1,1,0,0]) with default dowMul (all 1s on active days) and
 * 52 weeks/yr returns 5 × 52 = 260 days — identical to the legacy
 * `daysPerWeek × weeksPerYear` calc.
 *
 * @param {{activeDays?: boolean[]}} shift
 * @param {number[]} dowVolumeMultipliers
 * @param {number} weeksPerYear
 * @returns {number}
 */
export function effectiveOperatingDaysForShift(shift, dowVolumeMultipliers, weeksPerYear) {
  const days = (shift && Array.isArray(shift.activeDays) && shift.activeDays.length === 7)
    ? shift.activeDays
    : defaultActiveDays(5);
  const muls = (Array.isArray(dowVolumeMultipliers) && dowVolumeMultipliers.length === 7)
    ? dowVolumeMultipliers
    : new Array(7).fill(1);
  let sum = 0;
  for (let d = 0; d < 7; d++) {
    if (days[d]) sum += Number(muls[d]) || 0;
  }
  const wks = Math.max(1, Number(weeksPerYear) || 52);
  return sum * wks;
}

/**
 * Compute a DOW-weighted premium factor for a shift's labor cost. Returns
 * a multiplier ≥ 1.0 that's applied to the shift's annual labor cost.
 *   factor = sum_d active_d × dowMul_d × (1 + premium_d/100)
 *          / sum_d active_d × dowMul_d
 * If denominator is 0 (shift runs zero days) returns 1.0.
 *
 * @param {{activeDays?: boolean[]}} shift
 * @param {number[]} dowVolumeMultipliers
 * @param {number[]} dowPremiumPct
 * @returns {number}
 */
export function dowWeightedPremiumFactor(shift, dowVolumeMultipliers, dowPremiumPct) {
  const days = (shift && Array.isArray(shift.activeDays) && shift.activeDays.length === 7)
    ? shift.activeDays
    : defaultActiveDays(5);
  const muls = (Array.isArray(dowVolumeMultipliers) && dowVolumeMultipliers.length === 7)
    ? dowVolumeMultipliers
    : new Array(7).fill(1);
  const prems = (Array.isArray(dowPremiumPct) && dowPremiumPct.length === 7)
    ? dowPremiumPct
    : new Array(7).fill(0);
  let weighted = 0;
  let denom = 0;
  for (let d = 0; d < 7; d++) {
    if (!days[d]) continue;
    const w = Number(muls[d]) || 0;
    const p = Number(prems[d]) || 0;
    weighted += w * (1 + p / 100);
    denom += w;
  }
  return denom > 0 ? weighted / denom : 1;
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * @typedef {Object} ShiftAllocation
 * @property {string|null} archetypeRef
 * @property {boolean} overridden
 * @property {Array<{num:number,startHour:number,endHour:number}>} shifts
 * @property {Record<string, number[]>} matrix
 * @property {Record<string, Record<string, number>>} roleShiftAssignment
 * @property {{ seededAt:string|null, seededBy:string|null, lastEditedAt:string|null }} audit
 */

/**
 * Build a default-empty ShiftAllocation compatible with the project's shift
 * structure. Every matrix cell starts at 0 — the user picks an archetype or
 * fills by hand.
 *
 * @param {number} shiftsPerDay
 * @param {number} [hoursPerShift]   only used to synthesize default time windows
 * @returns {ShiftAllocation}
 */
export function createEmptyShiftAllocation(shiftsPerDay, hoursPerShift) {
  const n = clampShiftCount(shiftsPerDay);
  const shifts = buildDefaultShifts(n, hoursPerShift);
  const matrix = {};
  for (const fn of FUNCTION_ORDER) matrix[fn] = new Array(n).fill(0);
  return {
    archetypeRef: null,
    overridden: false,
    shifts,
    matrix,
    roleShiftAssignment: {},
    audit: { seededAt: null, seededBy: null, lastEditedAt: null },
  };
}

/**
 * Seed a ShiftAllocation from an archetype catalog row. If the catalog row's
 * shifts_per_day disagrees with the project's shift structure, resize via
 * proportional scaling (expanding 2→3 splits the last shift's share evenly
 * between the new last two; collapsing 3→2 merges the last two shifts).
 *
 * @param {{ archetype_ref:string, shifts_per_day:number, matrix:Object }} archetype
 * @param {number} projectShiftsPerDay
 * @param {number} [hoursPerShift]
 * @param {string} [nowIso]
 * @returns {ShiftAllocation}
 */
export function applyArchetype(archetype, projectShiftsPerDay, hoursPerShift, nowIso) {
  const when = nowIso || new Date().toISOString();
  const target = clampShiftCount(projectShiftsPerDay);
  const src = archetype && archetype.matrix ? archetype.matrix : {};
  const srcN = archetype?.shifts_per_day || FUNCTION_ORDER.reduce((max, fn) => {
    const a = Array.isArray(src[fn]) ? src[fn].length : 0;
    return a > max ? a : max;
  }, 0);

  const matrix = {};
  for (const fn of FUNCTION_ORDER) {
    const row = Array.isArray(src[fn]) ? src[fn].slice() : new Array(srcN || target).fill(0);
    matrix[fn] = resizeRow(row, target);
  }

  return {
    archetypeRef: archetype?.archetype_ref || null,
    overridden: false,
    shifts: buildDefaultShifts(target, hoursPerShift),
    matrix,
    roleShiftAssignment: {},
    audit: { seededAt: when, seededBy: 'archetype', lastEditedAt: null },
  };
}

/**
 * Resize an existing ShiftAllocation to a new shift count (because the user
 * changed shifts_per_day on the Labor Factors section). Uses proportional
 * scaling per-row and preserves audit metadata + override flag.
 *
 * @param {ShiftAllocation} allocation
 * @param {number} newShiftsPerDay
 * @param {number} [hoursPerShift]
 * @returns {ShiftAllocation}
 */
export function resizeAllocation(allocation, newShiftsPerDay, hoursPerShift) {
  if (!allocation) return createEmptyShiftAllocation(newShiftsPerDay, hoursPerShift);
  const target = clampShiftCount(newShiftsPerDay);
  const matrix = {};
  for (const fn of FUNCTION_ORDER) {
    const row = Array.isArray(allocation.matrix?.[fn]) ? allocation.matrix[fn].slice() : [];
    matrix[fn] = resizeRow(row, target);
  }
  return {
    ...allocation,
    shifts: buildDefaultShifts(target, hoursPerShift, allocation.shifts),
    matrix,
  };
}

/**
 * Validate rows sum to ~100%. Rows that are entirely zero are treated as
 * "this function is not used in this archetype" and are not flagged —
 * consistent with how cross-dock / cold-chain archetypes zero out non-
 * applicable functions.
 *
 * @param {ShiftAllocation} allocation
 * @param {number} [tolerance]
 * @returns {{ valid: boolean, offenders: Array<{ fn:string, sum:number }> }}
 */
export function validateShiftMatrix(allocation, tolerance) {
  const tol = tolerance == null ? 0.5 : tolerance;
  const offenders = [];
  if (!allocation || !allocation.matrix) {
    return { valid: true, offenders };
  }
  for (const fn of FUNCTION_ORDER) {
    const row = allocation.matrix[fn];
    if (!Array.isArray(row) || row.length === 0) continue;
    const sum = row.reduce((acc, v) => acc + (Number(v) || 0), 0);
    // Zero-filled rows are "unused function" — skip validation.
    if (sum === 0) continue;
    if (Math.abs(sum - 100) > tol) offenders.push({ fn, sum });
  }
  return { valid: offenders.length === 0, offenders };
}

/**
 * Normalize matrix rows to sum to 100% via proportional scaling. Zero-filled
 * rows are left alone. Returns a NEW allocation with audit lastEditedAt
 * updated.
 *
 * @param {ShiftAllocation} allocation
 * @param {string} [nowIso]
 * @returns {ShiftAllocation}
 */
export function normalizeShiftMatrix(allocation, nowIso) {
  if (!allocation || !allocation.matrix) return allocation;
  const when = nowIso || new Date().toISOString();
  const matrix = {};
  for (const fn of FUNCTION_ORDER) {
    const row = allocation.matrix[fn];
    if (!Array.isArray(row)) { matrix[fn] = row; continue; }
    const sum = row.reduce((a, v) => a + (Number(v) || 0), 0);
    if (sum === 0) { matrix[fn] = row.slice(); continue; }
    matrix[fn] = row.map(v => +((Number(v) || 0) * 100 / sum).toFixed(2));
    // Clean up rounding drift by nudging the largest cell to make the sum exact
    const drift = +(100 - matrix[fn].reduce((a, v) => a + v, 0)).toFixed(4);
    if (Math.abs(drift) > 0.0001) {
      let maxIdx = 0;
      for (let i = 1; i < matrix[fn].length; i++) {
        if (matrix[fn][i] > matrix[fn][maxIdx]) maxIdx = i;
      }
      matrix[fn][maxIdx] = +(matrix[fn][maxIdx] + drift).toFixed(2);
    }
  }
  return {
    ...allocation,
    matrix,
    audit: { ...(allocation.audit || {}), lastEditedAt: when },
  };
}

/**
 * Given volumes × shift allocation × labor lines → derived HC/hours by shift
 * and by function × shift. Output drives the preview panel + the Labor line
 * shift column.
 *
 * @param {ShiftAllocation} allocation
 * @param {Array<Object>} volumeLines
 * @param {Array<Object>} laborLines
 * @param {Object} shifts               e.g. { shiftsPerDay, hoursPerShift, daysPerWeek, weeksPerYear, directUtilization, ptoPct, holidayPct }
 * @param {Object} [opts]
 * @param {number} [opts.absenceAllowancePct]
 * @param {Record<string,number>} [opts.shiftPremiumPct]  e.g. { '2': 5, '3': 10 }
 * @param {number} [opts.operatingDaysPerYear]
 * @param {number[]} [opts.dowVolumeMultipliers]   7-element Mon..Sun multiplier
 *   on daily volume. Default `[1,1,1,1,1,0,0]` (M-F uniform, weekend off).
 *   SP-2: lets users express weekend volume falloff (e.g., Sat at 0.5).
 * @param {number[]} [opts.dowPremiumPct]   7-element Mon..Sun additive labor
 *   premium %. Default `[0,0,0,0,0,0,0]`. SP-3: typical Sat=50 Sun=100 for
 *   weekend OT shifts.
 * @returns {{
 *   byShift: Array<{ num:number, directHc:number, hours:number, costAnnual:number, premiumAnnual:number, operatingDays:number, dowPremiumFactor:number }>,
 *   byFunctionShift: Array<{ fn:string, shift:number, volume:number, hours:number, fte:number }>,
 *   byRole: Array<{ roleId:(string|number), shift:number, hours:number, fte:number, cost:number }>,
 *   totals: { directHc:number, hoursAnnual:number, costAnnual:number, peakShift:number|null, premiumAnnual:number, dowPremiumAnnual:number }
 * }}
 */
export function deriveShiftHeadcount(allocation, volumeLines, laborLines, shifts, opts) {
  const o = opts || {};
  const emptyResult = {
    byShift: [],
    byFunctionShift: [],
    byRole: [],
    totals: { directHc: 0, hoursAnnual: 0, costAnnual: 0, peakShift: null, premiumAnnual: 0, dowPremiumAnnual: 0 },
  };
  if (!allocation || !allocation.matrix) return emptyResult;

  const shiftCount = Math.max(1, Math.min(
    allocation.shifts?.length || 0,
    4,
  ) || clampShiftCount(shifts?.shiftsPerDay || 1));

  const hoursPerShift = Number(shifts?.hoursPerShift) || 8;
  const daysPerWeek = Number(shifts?.daysPerWeek) || 5;
  const weeksPerYear = Number(shifts?.weeksPerYear) || 52;

  // SP-2/SP-3: per-DOW multipliers. Default = active days at 1, inactive at 0.
  // When the project hasn't customized dowVolumeMultipliers, this collapses to
  // the legacy daysPerWeek×weeksPerYear math (per-shift activeDays defaults to
  // `defaultActiveDays(daysPerWeek)`).
  const dowMul = (Array.isArray(o.dowVolumeMultipliers) && o.dowVolumeMultipliers.length === 7)
    ? o.dowVolumeMultipliers
    : defaultDowVolumeMultipliers(daysPerWeek);
  const dowPrem = (Array.isArray(o.dowPremiumPct) && o.dowPremiumPct.length === 7)
    ? o.dowPremiumPct
    : defaultDowPremiumPct();

  // Per-shift active days (auto-migrated from global daysPerWeek if missing).
  const normalizedShifts = normalizeShiftActiveDays(allocation.shifts || [], daysPerWeek);

  // Operating-days-per-year is now per-shift (SP-2 enabler). The matrix calc
  // below uses each shift's effective operating days. The old global
  // `operatingDays` is preserved as a fallback for shift-less callers + the
  // by-function rollup (which doesn't yet split by shift).
  const fallbackOperatingDays = Number(o.operatingDaysPerYear) || (daysPerWeek * weeksPerYear);
  const opDaysByShift = normalizedShifts.map(s =>
    effectiveOperatingDaysForShift(s, dowMul, weeksPerYear) || fallbackOperatingDays
  );
  // Average across shifts for the per-function volume calc — the matrix
  // splits this by shift weight, so an avg keeps the existing total math
  // accurate when shifts share the same DOW pattern (the common case).
  const operatingDays = opDaysByShift.length > 0
    ? opDaysByShift.reduce((a, v) => a + v, 0) / opDaysByShift.length
    : fallbackOperatingDays;

  // Productive-hours factor: applied to raw shift hours to get FTE.
  // We only apply absenceAllowancePct here — directUtilization (PF&D) is
  // already baked into UPH values at the labor-line level (the engine's
  // existing convention), so applying it again would double-count.
  const absence = (Number(o.absenceAllowancePct) || 0) / 100;               // 0..1
  const productiveHoursPerShift = Math.max(1, hoursPerShift * (1 - absence));

  // Daily volume per function. If a volumeLine matches a function keyword we
  // use it; fall back to split the outbound-primary volume across picking/
  // pack/ship when no explicit function matches (covers most projects today).
  const dailyVolumeByFn = computeDailyVolumeByFunction(volumeLines, operatingDays);

  // Aggregate UPH per function from laborLines (weighted by line's uph × hc).
  // Lines without a matching function are ignored for the derivation (they
  // still show up in the by-role breakdown via direct labor hours).
  const uphByFn = computeUphByFunction(laborLines);

  // Weighted loaded hourly rate for the "implied labor $" preview tile.
  const loadedHourlyRate = computeWeightedLoadedRate(laborLines);

  // Main derivation.
  const byFunctionShift = [];
  const shiftHours = new Array(shiftCount).fill(0);

  for (const fn of FUNCTION_ORDER) {
    const row = allocation.matrix[fn];
    if (!Array.isArray(row)) continue;
    const dailyVol = Number(dailyVolumeByFn[fn]) || 0;
    const uph = Number(uphByFn[fn]) || 0;
    for (let s = 0; s < shiftCount; s++) {
      const pct = Number(row[s]) || 0;
      const vol = dailyVol * (pct / 100);
      // Daily hours needed for this shift+fn.
      const hoursDay = uph > 0 ? vol / uph : 0;
      // SP-2: each shift now has its own effective operating-days/yr based
      // on per-shift activeDays + DOW volume multipliers. A shift that runs
      // 7 days at 1.0× has 365 op-days; a shift that runs M-F + Sat at 0.5
      // has 5.5 × 52 = 286 op-days.
      const opDaysShift = opDaysByShift[s] || operatingDays;
      const hoursAnnual = hoursDay * opDaysShift;
      const fte = hoursDay / productiveHoursPerShift;
      byFunctionShift.push({ fn, shift: s + 1, volume: vol, hours: hoursAnnual, fte });
      shiftHours[s] += hoursAnnual;
    }
  }

  // Per-shift rollup.
  const byShift = [];
  let peakHc = 0;
  let peakShift = null;
  let totalDirectHc = 0;
  let totalCost = 0;
  let totalPremium = 0;
  let totalDowPremium = 0;
  for (let s = 0; s < shiftCount; s++) {
    const hoursAnnual = shiftHours[s];
    const opDaysShift = opDaysByShift[s] || operatingDays;
    const fteExact = hoursAnnual > 0 && opDaysShift > 0
      ? hoursAnnual / (productiveHoursPerShift * opDaysShift)
      : 0;
    const hc = Math.ceil(fteExact);
    // Base annual cost (before any premium adjustment).
    const baseCostAnnual = hoursAnnual * loadedHourlyRate;
    // SP-3: DOW-weighted premium factor — multiplies base cost so weekend
    // labor lands at higher unit cost than weekday labor for the same shift.
    // Factor=1.0 when no DOW premium configured (all-zero `dowPremiumPct`).
    const dowFactor = dowWeightedPremiumFactor(normalizedShifts[s], dowMul, dowPrem);
    const costAnnual = baseCostAnnual * dowFactor;
    const dowPremiumAnnual = costAnnual - baseCostAnnual;
    // Existing shift-tier premium (Shift 2/3 differential) applies to the
    // already DOW-weighted cost so it compounds correctly.
    const premiumPct = (o.shiftPremiumPct && o.shiftPremiumPct[String(s + 1)]) || 0;
    const premium = costAnnual * (premiumPct / 100);
    byShift.push({
      num: s + 1,
      directHc: hc,
      hours: hoursAnnual,
      costAnnual,
      premiumAnnual: premium,
      operatingDays: opDaysShift,
      dowPremiumFactor: dowFactor,
      dowPremiumAnnual,
    });
    totalDirectHc += hc;
    totalCost += costAnnual;
    totalPremium += premium;
    totalDowPremium += dowPremiumAnnual;
    if (hc > peakHc) { peakHc = hc; peakShift = s + 1; }
  }

  // Per-role view — attributes each role's UPH-derived hours back to the shift
  // based on the matrix. Used by the Labor grid chip + tooltip.
  const byRole = [];
  for (const line of laborLines || []) {
    const fn = deriveFunctionForLine(line);
    if (!fn) continue;
    const row = allocation.matrix[fn];
    if (!Array.isArray(row)) continue;
    const totalRoleHours = Number(line.annual_hours) || 0;
    if (totalRoleHours <= 0) continue;
    const rowSum = row.reduce((a, v) => a + (Number(v) || 0), 0) || 1;
    const rate = Number(line.hourly_rate) || loadedHourlyRate || 0;
    for (let s = 0; s < shiftCount; s++) {
      const pct = Number(row[s]) || 0;
      if (pct === 0) continue;
      const hours = totalRoleHours * (pct / rowSum);
      const fteShift = hours / (productiveHoursPerShift * operatingDays);
      byRole.push({
        roleId: line.id || line.position || line.activity || line.name,
        shift: s + 1,
        hours,
        fte: fteShift,
        cost: hours * rate,
      });
    }
  }

  return {
    byShift,
    byFunctionShift,
    byRole,
    totals: {
      directHc: totalDirectHc,
      hoursAnnual: shiftHours.reduce((a, v) => a + v, 0),
      costAnnual: totalCost,
      peakShift,
      premiumAnnual: totalPremium,
      dowPremiumAnnual: totalDowPremium,
    },
  };
}

/**
 * Classify an indirect labor role as shift-level (one per shift) vs
 * site-level (one per building regardless of shift count). Keyword based —
 * captures the common GXO position catalog without needing a schema column.
 *
 * Shift-level: Team Lead, Line Lead, Supervisor, QA Coord, Wave Tasker.
 * Site-level: Ops Mgr, Director, HR, Admin, Safety, Maintenance, Engineer,
 *             Routing, CSR, Security, Compliance, anything "Mgr" or "Director".
 *
 * @param {{ position?:string, role_name?:string, name?:string, activity?:string, ratio_to_direct?:number }} line
 * @returns {'shift' | 'site'}
 */
export function classifyIndirectScope(line) {
  // Read chain covers every shape the CM schema uses today:
  //   indirectLaborLines items often use `role` (Wayfair seed);
  //   laborLines use `role_name` / `activity_name`; position catalog uses `position`.
  const raw = String(line?.position || line?.role_name || line?.role || line?.name || line?.activity || '').toLowerCase();
  // Explicit site-level keywords win first
  if (/manager|director|hr[- ]?admin|\bhr\b|admin[- ]?ops|safety|maintenance|engineer|\bit\b|it\s?support|csr|routing|compliance|security|super user|wms|facilit/.test(raw)) {
    return 'site';
  }
  // Shift-level: leads, supervisors, coordinators, taskers, QA/QC, inventory control
  if (/lead|supervisor|coord|tasker|spotter|\bqa\b|\bqc\b|quality|inventory\s?control/.test(raw)) {
    return 'shift';
  }
  // Default to site-level (safer — doesn't inflate per-shift HC)
  return 'site';
}

/**
 * Classify an indirect role by management tier for display grouping.
 * Four tiers: supv (line-level supervision), indirect (team leads / QA / support),
 * mgmt (managers / directors), admin (HR / safety / IT etc — overhead admin).
 *
 * @param {{ position?:string, role_name?:string, name?:string, activity?:string }} line
 * @returns {'supv' | 'indirect' | 'mgmt' | 'admin'}
 */
export function classifyIndirectTier(line) {
  const raw = String(line?.position || line?.role_name || line?.role || line?.name || line?.activity || '').toLowerCase();
  if (/director|sr\.?\s*ops|senior\s*ops|operations\s*manager|ops\s*mgr|ops\s*manager/.test(raw)) return 'mgmt';
  if (/supervisor/.test(raw)) return 'supv';
  if (/hr|admin|safety|maintenance|engineer|\bit\b|it\s?support|csr|routing|compliance|security|super user|wms|manager/.test(raw)) return 'admin';
  return 'indirect';
}

/**
 * Derive indirect HC by shift, grouped by tier. Site-level roles stay as
 * a single site count (displayed once, not per shift). Shift-level roles
 * are allocated across shifts proportional to direct HC per shift so the
 * Team Lead ratio actually lands where the direct people are.
 *
 * @param {Array<Object>} indirectLines
 * @param {Array<{ num:number, directHc:number }>} byShiftDirect
 * @returns {{
 *   byShift: Array<{ num:number, supv:number, indirect:number, mgmt:number, admin:number, total:number }>,
 *   site: { supv:number, indirect:number, mgmt:number, admin:number, total:number }
 * }}
 */
export function deriveIndirectByShift(indirectLines, byShiftDirect) {
  const shiftCount = byShiftDirect?.length || 0;
  const byShift = [];
  for (let i = 0; i < shiftCount; i++) {
    byShift.push({ num: i + 1, supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 });
  }
  const site = { supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 };

  if (!Array.isArray(indirectLines) || shiftCount === 0) return { byShift, site };

  // Sum direct HC for proportional allocation.
  const totalDirect = byShiftDirect.reduce((a, s) => a + (s.directHc || 0), 0) || 1;

  for (const line of indirectLines) {
    const scope = classifyIndirectScope(line);
    const tier = classifyIndirectTier(line);
    const hc = Number(line.headcount) || Number(line.hc) || Number(line.fte) || 0;
    if (hc <= 0) continue;

    if (scope === 'site') {
      site[tier] += hc;
      site.total += hc;
    } else {
      // Shift-level — allocate proportional to direct HC, then round each shift
      // independently so totals are sensible (not < actual total — we floor/ceil
      // the bigger shifts first).
      const shares = byShiftDirect.map(s => (s.directHc || 0) / totalDirect);
      const rawAlloc = shares.map(sh => sh * hc);
      const rounded = rawAlloc.map(v => Math.round(v));
      // Reconcile rounding drift — if the rounded sum is off, adjust the
      // biggest-share shift by the delta.
      const drift = hc - rounded.reduce((a, v) => a + v, 0);
      if (drift !== 0) {
        let maxIdx = 0;
        for (let i = 1; i < shares.length; i++) {
          if (shares[i] > shares[maxIdx]) maxIdx = i;
        }
        rounded[maxIdx] = Math.max(0, rounded[maxIdx] + drift);
      }
      for (let i = 0; i < shiftCount; i++) {
        byShift[i][tier] += rounded[i];
        byShift[i].total += rounded[i];
      }
    }
  }

  return { byShift, site };
}

/**
 * Produce an hour-by-weekday staffing grid for the ops walkthrough heatmap.
 * For each hour of each operating day, sums the direct + indirect HC from
 * any shift that's active during that hour. Days where a shift doesn't run
 * get 0 (e.g., S3 running only Mon-Fri has empty Sat/Sun cells).
 *
 * 2026-04-27 (SP-2): per-shift `activeDays` is now honored. A shift with
 * `activeDays = [1,1,1,1,1,0,0]` shows direct HC Mon-Fri and 0 on weekend
 * cells; a 24/7 shift with all-true activeDays fills all 7 days.
 * The `daysPerWeek` arg is now optional and only used as a fallback for
 * shifts that lack `activeDays` (older saved configs).
 *
 * @param {Array<{ num:number, startHour:number, endHour:number, activeDays?:boolean[] }>} shifts
 * @param {Array<{ num:number, directHc:number }>} byShiftDirect
 * @param {{ byShift: Array<{ num:number, supv:number, indirect:number, mgmt:number, admin:number, total:number }>, site:{ supv:number, indirect:number, mgmt:number, admin:number, total:number } }} indirectByShift
 * @param {number} [daysPerWeek=7]   fallback when a shift lacks activeDays
 * @returns {{
 *   days: Array<{
 *     dayIdx: number,
 *     label: string,
 *     hours: Array<{ hour:number, direct:number, supv:number, indirect:number, mgmt:number, admin:number, total:number }>
 *   }>,
 *   peakHourTotal: number
 * }}
 */
export function deriveHourlyStaffing(shifts, byShiftDirect, indirectByShift, daysPerWeek) {
  const fallbackMask = defaultActiveDays(daysPerWeek);
  const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  // Per-shift activeDays: read from shift if provided, else fall back to
  // the global daysPerWeek-derived mask. Returns 7-element bool array.
  function shiftActiveOnDay(shift, dayIdx) {
    if (!shift) return false;
    const mask = (Array.isArray(shift.activeDays) && shift.activeDays.length === 7)
      ? shift.activeDays
      : fallbackMask;
    return Boolean(mask[dayIdx]);
  }
  // Whether ANY shift runs on this day — drives site-level mgmt/admin
  // attribution (which is present whenever the building's operating).
  function buildingActiveOnDay(dayIdx) {
    if (!Array.isArray(shifts)) return false;
    for (let i = 0; i < shifts.length; i++) {
      if (shiftActiveOnDay(shifts[i], dayIdx)) return true;
    }
    return false;
  }

  // Precompute "is this shift active at this hour" — handles overnight shifts
  // (e.g. S3 = 23-7 wraps past midnight).
  function shiftCoversHour(s, hour) {
    const startH = ((Number(s.startHour) || 0) + 24) % 24;
    const endH = ((Number(s.endHour) || 0) + 24) % 24;
    if (startH === endH) return false;
    if (startH < endH) return hour >= startH && hour < endH;
    // Wrap-around (23 -> 7)
    return hour >= startH || hour < endH;
  }

  const days = [];
  let peakHourTotal = 0;
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const buildingOpen = buildingActiveOnDay(dayIdx);
    const hours = [];
    for (let hour = 0; hour < 24; hour++) {
      let direct = 0, supv = 0, indirect = 0, mgmt = 0, admin = 0;
      if (Array.isArray(shifts)) {
        for (let si = 0; si < shifts.length; si++) {
          const s = shifts[si];
          // Per-shift activeDays gate (SP-2 enabler).
          if (!shiftActiveOnDay(s, dayIdx)) continue;
          if (!shiftCoversHour(s, hour)) continue;
          direct += Number(byShiftDirect?.[si]?.directHc) || 0;
          const ind = indirectByShift?.byShift?.[si];
          if (ind) {
            supv += ind.supv; indirect += ind.indirect; mgmt += ind.mgmt; admin += ind.admin;
          }
        }
      }
      // Site-level indirect/mgmt — present during the building's operating
      // envelope (roughly any hour where at least one shift is active).
      // For MVP, attribute site-level to the day-shift window only (7a-5p)
      // since most mgmt / admin are day-only. Ops SMEs can refine later.
      if (buildingOpen) {
        const site = indirectByShift?.site;
        if (site && hour >= 7 && hour < 17) {
          supv += site.supv; indirect += site.indirect; mgmt += site.mgmt; admin += site.admin;
        }
      }
      const total = direct + supv + indirect + mgmt + admin;
      if (total > peakHourTotal) peakHourTotal = total;
      hours.push({ hour, direct, supv, indirect, mgmt, admin, total });
    }
    days.push({ dayIdx, label: dayLabels[dayIdx], hours });
  }
  return { days, peakHourTotal };
}

/**
 * Split labor lines into per-shift rows when calc_from='matrix'. The engine
 * still sums them back up in buildYearlyProjections — this is purely an
 * exploded labor table for Direct Labor visibility + shift premium math.
 *
 * Does NOT mutate inputs. Preserves total annual_hours: sum of split rows ===
 * original annual_hours within rounding tolerance.
 *
 * @param {Array<Object>} laborLines
 * @param {ShiftAllocation} allocation
 * @returns {Array<Object>}
 */
export function splitLaborLinesByShift(laborLines, allocation) {
  if (!Array.isArray(laborLines)) return [];
  if (!allocation || !allocation.matrix) return laborLines.slice();
  const out = [];
  const shiftCount = allocation.shifts?.length || 0;
  for (const line of laborLines) {
    if (line.calc_from !== 'matrix') { out.push(line); continue; }
    const fn = deriveFunctionForLine(line);
    const row = fn ? allocation.matrix[fn] : null;
    if (!Array.isArray(row) || shiftCount === 0) { out.push(line); continue; }
    const rowSum = row.reduce((a, v) => a + (Number(v) || 0), 0);
    if (rowSum === 0) { out.push(line); continue; }
    const totalHours = Number(line.annual_hours) || 0;
    for (let s = 0; s < shiftCount; s++) {
      const pct = Number(row[s]) || 0;
      if (pct === 0) continue;
      const weight = pct / rowSum;
      out.push({
        ...line,
        id: `${line.id || line.activity || line.name || 'row'}__s${s + 1}`,
        shift: s + 1,
        annual_hours: +(totalHours * weight).toFixed(2),
        _split_from: line.id || null,
        _split_weight: +weight.toFixed(4),
      });
    }
  }
  return out;
}

// ============================================================
// INTERNAL
// ============================================================

/** Clamp shifts_per_day to the 1..4 range the migration allows. */
function clampShiftCount(n) {
  const v = Math.floor(Number(n) || 1);
  if (v < 1) return 1;
  if (v > 4) return 4;
  return v;
}

/** Build a shifts-metadata array of the given length with sensible time windows.
 *  Each shift gets a default `activeDays` mask (Mon-Fri = 5 days) — callers
 *  override per-shift via the UI when an op runs different DOW patterns
 *  (e.g., S1 M-F + S2 7-day for 24/7 fulfillment). */
function buildDefaultShifts(n, hoursPerShift, existing) {
  const hrs = Number(hoursPerShift) || 8;
  const out = [];
  const defaultMask = defaultActiveDays(5);
  for (let i = 0; i < n; i++) {
    const from = existing && existing[i];
    if (from) {
      const activeDays = Array.isArray(from.activeDays) && from.activeDays.length === 7
        ? from.activeDays.map(v => Boolean(v))
        : defaultMask.slice();
      out.push({ ...from, num: i + 1, activeDays });
      continue;
    }
    const base = DEFAULT_SHIFT_WINDOWS[i] || DEFAULT_SHIFT_WINDOWS[DEFAULT_SHIFT_WINDOWS.length - 1];
    // Honor the project's hoursPerShift when deriving endHour from startHour.
    const endHour = (base.startHour + hrs) % 24;
    out.push({ num: i + 1, startHour: base.startHour, endHour, activeDays: defaultMask.slice() });
  }
  return out;
}

/**
 * Proportional resize of a single percentage row.
 * Growing 2→3: split the last value equally between the new last two.
 * Shrinking 3→2: merge the last two.
 * Bigger jumps handled via repeated single-step ops to keep the math obvious.
 */
function resizeRow(row, targetLen) {
  if (!Array.isArray(row) || row.length === 0) return new Array(targetLen).fill(0);
  let r = row.slice();
  while (r.length < targetLen) {
    const last = r.pop() || 0;
    r.push(+(last / 2).toFixed(2), +(last / 2).toFixed(2));
  }
  while (r.length > targetLen) {
    const last = r.pop() || 0;
    r[r.length - 1] = +((Number(r[r.length - 1]) || 0) + last).toFixed(2);
  }
  // Preserve zero-filled semantics
  if (r.every(v => !Number.isFinite(v))) return new Array(targetLen).fill(0);
  return r.map(v => Number.isFinite(v) ? v : 0);
}

/**
 * Map a labor line to a functional area. Checks role_name / activity_name
 * FIRST (most specific — "Picker" / "Packer" / "Putaway Driver"), falls
 * back to process_area only as a coarse hint when the role_name doesn't
 * resolve. Wayfair-style models use process_area="Inbound/Outbound/Support"
 * as a bucket and the actual function lives on role_name — the old order
 * caused every outbound-bucket role (Picker, Packer, Shipper, VAS Kitter)
 * to resolve to `ship` and collapse into one function. (Brock 2026-04-22.)
 *
 * Returns null when nothing matches (line is dropped from matrix derivation).
 */
export function deriveFunctionForLine(line) {
  if (!line) return null;

  // Specific role fields win first — match against role_name / activity / position.
  const specific = String(line.role_name || line.activity_name || line.activity || line.role || line.position || line.name || '').toLowerCase();
  if (specific) {
    if (/put.?away/.test(specific)) return 'putaway';
    if (/replen/.test(specific)) return 'replenish';
    if (/pack/.test(specific)) return 'pack';
    if (/picker|picking|pick\s/.test(specific)) return 'picking';
    if (/loader|shipper|load\s?truck|dispatch/.test(specific)) return 'ship';
    if (/receiv|inbound/.test(specific)) return 'inbound';
    if (/return|rma|reverse/.test(specific)) return 'returns';
    if (/vas|kitter|kitting|label|assembly/.test(specific)) return 'vas';
  }

  // Process_area fallback — coarse ("Inbound" / "Outbound" / "Support").
  // If role_name didn't resolve, treat process_area as a best-guess.
  const proc = String(line.process_area || line.processArea || line.function || '').toLowerCase().trim();
  if (proc) {
    if (/put.?away/.test(proc)) return 'putaway';
    if (/replen/.test(proc)) return 'replenish';
    if (/pack/.test(proc)) return 'pack';
    if (/pick/.test(proc)) return 'picking';
    if (/return|rma|reverse/.test(proc)) return 'returns';
    if (/vas|kit|label|assembly/.test(proc)) return 'vas';
    if (/inbound|receiv/.test(proc)) return 'inbound';
    if (/ship|outbound|load/.test(proc)) return 'ship';
  }
  return null;
}

function computeDailyVolumeByFunction(volumeLines, operatingDays) {
  const out = {};
  for (const fn of FUNCTION_ORDER) out[fn] = 0;
  if (!Array.isArray(volumeLines) || volumeLines.length === 0) return out;
  const opDays = Math.max(1, operatingDays);

  // First pass: first-match-wins per function. Accumulating would double-count
  // when a project has multiple volume lines matching the same keyword (e.g.
  // Wayfair has "Pallets Received" AND "Cases Received" — only one should
  // drive inbound math). Users can pre-process if they want finer granularity.
  for (const v of volumeLines) {
    const rawName = String(v.name || v.label || '').toLowerCase();
    if (!rawName) continue;
    const vol = Number(v.volume) || 0;
    const daily = vol / opDays;
    // Match tense-flexibly: "Pallets Received", "Receiving", "Inbound" all → inbound
    if (out.inbound === 0 && /receiv|inbound/.test(rawName)) { out.inbound = daily; continue; }
    if (out.putaway === 0 && /put.?away/.test(rawName)) { out.putaway = daily; continue; }
    if (out.replenish === 0 && /replen/.test(rawName)) { out.replenish = daily; continue; }
    if (out.pack === 0 && /pack/.test(rawName)) { out.pack = daily; continue; }
    if (out.picking === 0 && /pick/.test(rawName)) { out.picking = daily; continue; }
    if (out.ship === 0 && /ship|outbound/.test(rawName)) { out.ship = daily; continue; }
    if (out.returns === 0 && /return/.test(rawName)) { out.returns = daily; continue; }
    if (out.vas === 0 && /vas|kit|label|assembly/.test(rawName)) { out.vas = daily; continue; }
  }

  // Second pass: if key fulfillment functions (picking/pack/ship) are still
  // at zero, infer them from the outbound-primary volume line.
  const outboundPrimary = volumeLines.find(v => v.isOutboundPrimary);
  if (outboundPrimary) {
    const dailyOutbound = (Number(outboundPrimary.volume) || 0) / opDays;
    if (out.picking === 0) out.picking = dailyOutbound;
    if (out.pack === 0) out.pack = dailyOutbound;
    if (out.ship === 0) out.ship = dailyOutbound;
  } else {
    // Fallback — derive from any volume line whose name looks fulfillment-adjacent.
    const pickish = volumeLines.find(v => /pick|order|unit/.test(String(v.name || '').toLowerCase()));
    if (pickish) {
      const daily = (Number(pickish.volume) || 0) / opDays;
      if (out.picking === 0) out.picking = daily;
      if (out.pack === 0) out.pack = daily;
      if (out.ship === 0) out.ship = daily;
    }
  }

  // Third pass — inferred borrows for functions users rarely declare as
  // separate volume lines. These follow physical logic:
  //   putaway  ← inbound (every received pallet gets put away)
  //   replenish ← picking × 0.4 (typical replen events per pick)
  //   vas       ← picking × 0.1 (if there's any picking but no VAS line, assume light)
  // Users with explicit lines keep winning since first-pass already set the fn.
  if (out.putaway === 0 && out.inbound > 0) out.putaway = out.inbound;
  if (out.replenish === 0 && out.picking > 0) out.replenish = out.picking * 0.4;
  if (out.vas === 0 && out.picking > 0) out.vas = out.picking * 0.1;

  return out;
}

function computeUphByFunction(laborLines) {
  const out = {};
  const weights = {};
  for (const fn of FUNCTION_ORDER) { out[fn] = 0; weights[fn] = 0; }
  if (!Array.isArray(laborLines)) return out;
  for (const line of laborLines) {
    // Skip indirect-labor lines — matrix drives direct HC only.
    if (line.labor_category && line.labor_category !== 'direct') continue;
    const fn = deriveFunctionForLine(line);
    if (!fn) continue;
    // CM schema uses base_uph (primary) + falls back to uph/UPH on older models
    const uph = Number(line.base_uph) || Number(line.uph) || Number(line.UPH) || 0;
    if (uph <= 0) continue;
    // Weight by annual_hours (proxy for size) when no HC field present
    const weight = (Number(line.headcount) || Number(line.hc) || Number(line.annual_hours) || 1);
    out[fn] += uph * weight;
    weights[fn] += weight;
  }
  for (const fn of FUNCTION_ORDER) {
    if (weights[fn] > 0) out[fn] = out[fn] / weights[fn];
  }
  return out;
}

function computeWeightedLoadedRate(laborLines) {
  if (!Array.isArray(laborLines) || laborLines.length === 0) return 0;
  let numer = 0;
  let denom = 0;
  for (const line of laborLines) {
    if (line.labor_category && line.labor_category !== 'direct') continue;
    // Prefer explicit fully_loaded_rate; otherwise build from hourly_rate × (1 + burden_pct/100)
    let rate = Number(line.fully_loaded_rate) || 0;
    if (!rate) {
      const hr = Number(line.hourly_rate) || 0;
      const burden = Number(line.burden_pct) || 0;
      rate = hr > 0 ? hr * (1 + burden / 100) : 0;
    }
    const hours = Number(line.annual_hours) || 0;
    if (rate <= 0 || hours <= 0) continue;
    numer += rate * hours;
    denom += hours;
  }
  return denom > 0 ? numer / denom : 0;
}
