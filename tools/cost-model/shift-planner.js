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
 * @returns {{
 *   byShift: Array<{ num:number, directHc:number, hours:number, costAnnual:number, premiumAnnual:number }>,
 *   byFunctionShift: Array<{ fn:string, shift:number, volume:number, hours:number, fte:number }>,
 *   byRole: Array<{ roleId:(string|number), shift:number, hours:number, fte:number, cost:number }>,
 *   totals: { directHc:number, hoursAnnual:number, costAnnual:number, peakShift:number|null, premiumAnnual:number }
 * }}
 */
export function deriveShiftHeadcount(allocation, volumeLines, laborLines, shifts, opts) {
  const o = opts || {};
  const emptyResult = {
    byShift: [],
    byFunctionShift: [],
    byRole: [],
    totals: { directHc: 0, hoursAnnual: 0, costAnnual: 0, peakShift: null, premiumAnnual: 0 },
  };
  if (!allocation || !allocation.matrix) return emptyResult;

  const shiftCount = Math.max(1, Math.min(
    allocation.shifts?.length || 0,
    4,
  ) || clampShiftCount(shifts?.shiftsPerDay || 1));

  const hoursPerShift = Number(shifts?.hoursPerShift) || 8;
  const daysPerWeek = Number(shifts?.daysPerWeek) || 5;
  const weeksPerYear = Number(shifts?.weeksPerYear) || 52;
  const operatingDays = Number(o.operatingDaysPerYear) || (daysPerWeek * weeksPerYear);

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
      const hoursAnnual = hoursDay * operatingDays;
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
  for (let s = 0; s < shiftCount; s++) {
    const hoursAnnual = shiftHours[s];
    const fteExact = hoursAnnual > 0 ? hoursAnnual / (productiveHoursPerShift * operatingDays) : 0;
    const hc = Math.ceil(fteExact);
    const costAnnual = hoursAnnual * loadedHourlyRate;
    const premiumPct = (o.shiftPremiumPct && o.shiftPremiumPct[String(s + 1)]) || 0;
    const premium = costAnnual * (premiumPct / 100);
    byShift.push({
      num: s + 1,
      directHc: hc,
      hours: hoursAnnual,
      costAnnual,
      premiumAnnual: premium,
    });
    totalDirectHc += hc;
    totalCost += costAnnual;
    totalPremium += premium;
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
    },
  };
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

/** Build a shifts-metadata array of the given length with sensible time windows. */
function buildDefaultShifts(n, hoursPerShift, existing) {
  const hrs = Number(hoursPerShift) || 8;
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = existing && existing[i];
    if (from) { out.push({ ...from, num: i + 1 }); continue; }
    const base = DEFAULT_SHIFT_WINDOWS[i] || DEFAULT_SHIFT_WINDOWS[DEFAULT_SHIFT_WINDOWS.length - 1];
    // Honor the project's hoursPerShift when deriving endHour from startHour.
    const endHour = (base.startHour + hrs) % 24;
    out.push({ num: i + 1, startHour: base.startHour, endHour });
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
 * Map a labor line to a functional area. Prefers an explicit `process_area`
 * field (the CM schema's authoritative function tag — "Inbound" / "Picking"
 * / etc.). Falls back to activity / role / position / name keyword matches.
 * Returns null when nothing matches (line is dropped from matrix derivation).
 */
export function deriveFunctionForLine(line) {
  if (!line) return null;
  // Authoritative field wins if present
  const proc = String(line.process_area || line.processArea || line.function || '').toLowerCase().trim();
  if (proc) {
    if (/inbound|receiv/.test(proc)) return 'inbound';
    if (/put.?away/.test(proc)) return 'putaway';
    if (/replen/.test(proc)) return 'replenish';
    if (/pack/.test(proc)) return 'pack';
    if (/ship|outbound|load/.test(proc)) return 'ship';
    if (/return|rma|reverse/.test(proc)) return 'returns';
    if (/vas|kit|label|assembly/.test(proc)) return 'vas';
    if (/pick/.test(proc)) return 'picking';
  }
  // Fallback keyword sweep
  const raw = String(line.activity_name || line.activity || line.role_name || line.role || line.position || line.name || '').toLowerCase();
  if (!raw) return null;
  if (/inbound|receiv/.test(raw)) return 'inbound';
  if (/put.?away/.test(raw)) return 'putaway';
  if (/replen/.test(raw)) return 'replenish';
  if (/pack/.test(raw)) return 'pack';
  if (/(^|\s)ship|loader|load.truck|dispatch|outbound/.test(raw)) return 'ship';
  if (/return|rma|reverse/.test(raw)) return 'returns';
  if (/vas|kitting|label|assembly/.test(raw)) return 'vas';
  if (/pick/.test(raw)) return 'picking';
  return null;
}

function computeDailyVolumeByFunction(volumeLines, operatingDays) {
  const out = {};
  for (const fn of FUNCTION_ORDER) out[fn] = 0;
  if (!Array.isArray(volumeLines) || volumeLines.length === 0) return out;
  const opDays = Math.max(1, operatingDays);

  // First pass: any explicit volume mapping wins.
  for (const v of volumeLines) {
    const rawName = String(v.name || v.label || '').toLowerCase();
    if (!rawName) continue;
    const vol = Number(v.volume) || 0;
    const daily = vol / opDays;
    // Match tense-flexibly: "Pallets Received", "Receiving", "Inbound" all → inbound
    if (/receiv|inbound/.test(rawName)) out.inbound += daily;
    else if (/put.?away/.test(rawName)) out.putaway += daily;
    else if (/replen/.test(rawName)) out.replenish += daily;
    else if (/pack/.test(rawName)) out.pack += daily;
    else if (/pick/.test(rawName)) out.picking += daily;
    else if (/ship|outbound/.test(rawName)) out.ship += daily;
    else if (/return/.test(rawName)) out.returns += daily;
    else if (/vas|kit|label|assembly/.test(rawName)) out.vas += daily;
    // "Orders" falls through to the outbound fallback below
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
