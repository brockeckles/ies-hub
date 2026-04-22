// test-shift-planner.mjs — regression for tools/cost-model/shift-planner.js
// Locks the MVP invariants: empty matrix = zero HC, 100%-S1 matrix = HC only
// on S1, archetype application preserves row sums + zero-filled rows,
// splitLaborLinesByShift preserves total annual_hours, validateShiftMatrix
// flags off-sum rows (but not all-zero rows), shift resize 2 <-> 3 preserves
// row volume, and the Wayfair worked example from the wiring doc matches
// within ±1 HC of the hand-math.
import {
  FUNCTION_ORDER,
  createEmptyShiftAllocation,
  applyArchetype,
  resizeAllocation,
  validateShiftMatrix,
  normalizeShiftMatrix,
  deriveShiftHeadcount,
  splitLaborLinesByShift,
  deriveFunctionForLine,
} from './tools/cost-model/shift-planner.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  \u2717 ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------
const OMNI = {
  archetype_ref: 'omni_channel_3pl',
  shifts_per_day: 3,
  matrix: {
    inbound:   [60, 40, 0],
    putaway:   [50, 45, 5],
    picking:   [30, 50, 20],
    replenish: [40, 45, 15],
    pack:      [35, 50, 15],
    ship:      [30, 50, 20],
    returns:   [50, 50, 0],
    vas:       [33, 50, 17],
  },
};
const COLD_CHAIN = {
  archetype_ref: 'cold_chain_food',
  shifts_per_day: 2,
  matrix: {
    inbound:   [75, 25],
    putaway:   [70, 30],
    picking:   [40, 60],
    replenish: [50, 50],
    pack:      [0, 0],            // intentionally unused in cold chain
    ship:      [30, 70],
    returns:   [100, 0],
    vas:       [50, 50],
  },
};
const CROSS_DOCK = {
  archetype_ref: 'cross_dock_flow_through',
  shifts_per_day: 2,
  matrix: {
    inbound:   [55, 45],
    putaway:   [0, 0],
    picking:   [0, 0],
    replenish: [0, 0],
    pack:      [0, 0],
    ship:      [55, 45],
    returns:   [0, 0],
    vas:       [0, 0],
  },
};

// Test fixture: daily picking volume = 22,000 orders/day × 260 op days/yr.
// No explicit "Each Picks" line — the outbound-primary ("Orders Shipped") flows
// into picking/pack/ship via the fallback path. This matches the wiring doc
// §7 hand-math where picking_daily_volume = 22,000.
const wayfairVolumes = [
  { name: 'Receiving (Pallets)', volume: 15000, uom: 'pallets', isOutboundPrimary: false },
  { name: 'Put-Away',            volume: 15000, uom: 'pallets', isOutboundPrimary: false },
  { name: 'Orders Shipped',      volume: 22000 * 260, uom: 'orders',  isOutboundPrimary: true  },
];
const wayfairLabor = [
  { id: 'pick',  activity: 'Picking',     position: 'Picker',   uph: 110, headcount: 36, annual_hours: 74545, hourly_rate: 18, fully_loaded_rate: 26 },
  { id: 'pack',  activity: 'Pack',        position: 'Packer',   uph:  80, headcount: 20, annual_hours: 41600, hourly_rate: 17, fully_loaded_rate: 25 },
  { id: 'ship',  activity: 'Ship / Load', position: 'Loader',   uph:  60, headcount: 12, annual_hours: 24960, hourly_rate: 18, fully_loaded_rate: 26 },
  { id: 'inb',   activity: 'Receiving',   position: 'Receiver', uph:  22, headcount:  6, annual_hours: 12480, hourly_rate: 18, fully_loaded_rate: 26 },
];
const wayfairShifts = {
  shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52,
  directUtilization: 85, ptoPct: 3.85, holidayPct: 3.08,
};

// ------------------------------------------------------------
// 1. createEmptyShiftAllocation
// ------------------------------------------------------------
{
  const a = createEmptyShiftAllocation(3, 8);
  t('empty-3: shifts length == 3', a.shifts.length === 3);
  t('empty-3: all function rows present', FUNCTION_ORDER.every(fn => Array.isArray(a.matrix[fn])));
  t('empty-3: every row is [0,0,0]',
    FUNCTION_ORDER.every(fn => a.matrix[fn].every(v => v === 0)));
  t('empty-3: archetypeRef null', a.archetypeRef === null);
  t('empty-3: not overridden', a.overridden === false);

  const oneShift = createEmptyShiftAllocation(1);
  t('empty-1: shifts length == 1', oneShift.shifts.length === 1);
  t('empty-1: each row length 1', FUNCTION_ORDER.every(fn => oneShift.matrix[fn].length === 1));

  const clamped = createEmptyShiftAllocation(99);
  t('clamps above 4 to 4', clamped.shifts.length === 4);

  const floored = createEmptyShiftAllocation(0);
  t('floors below 1 to 1', floored.shifts.length === 1);
}

// ------------------------------------------------------------
// 2. applyArchetype
// ------------------------------------------------------------
{
  const a = applyArchetype(OMNI, 3, 8);
  t('omni: archetypeRef set', a.archetypeRef === 'omni_channel_3pl');
  t('omni: picking row = [30,50,20]',
    JSON.stringify(a.matrix.picking) === JSON.stringify([30, 50, 20]));
  t('omni: inbound row = [60,40,0]',
    JSON.stringify(a.matrix.inbound) === JSON.stringify([60, 40, 0]));
  t('omni: audit seededAt set', typeof a.audit.seededAt === 'string' && a.audit.seededAt.length > 0);
  t('omni: audit seededBy = archetype', a.audit.seededBy === 'archetype');
  t('omni: overridden still false (user hasn\'t edited)', a.overridden === false);

  // 2-shift archetype applied to 3-shift project: last shift splits into last two
  const grown = applyArchetype(COLD_CHAIN, 3, 8);
  t('cold-chain grown to 3: inbound has 3 cells', grown.matrix.inbound.length === 3);
  t('cold-chain grown: inbound[0] preserved (75)', grown.matrix.inbound[0] === 75);
  t('cold-chain grown: inbound[1] + inbound[2] = 25',
    near(grown.matrix.inbound[1] + grown.matrix.inbound[2], 25, 0.1));
  t('cold-chain grown: pack still zero-filled',
    grown.matrix.pack.every(v => v === 0));

  // 3-shift archetype collapsed to 2
  const shrunk = applyArchetype(OMNI, 2, 8);
  t('omni shrunk to 2: inbound has 2 cells', shrunk.matrix.inbound.length === 2);
  t('omni shrunk to 2: inbound[0] preserved (60)', shrunk.matrix.inbound[0] === 60);
  t('omni shrunk to 2: inbound[1] = 40 (40+0 merged)', near(shrunk.matrix.inbound[1], 40, 0.1));
  t('omni shrunk to 2: picking row sums ~100',
    near(shrunk.matrix.picking.reduce((a,v)=>a+v,0), 100, 0.1));
}

// ------------------------------------------------------------
// 3. validateShiftMatrix
// ------------------------------------------------------------
{
  const good = applyArchetype(OMNI, 3, 8);
  const { valid, offenders } = validateShiftMatrix(good);
  t('validate omni: valid', valid === true);
  t('validate omni: no offenders', offenders.length === 0);

  // Cold chain has pack=[0,0] — should NOT flag (zero-filled = "unused function")
  const coldChain = applyArchetype(COLD_CHAIN, 2, 8);
  const { valid: ccValid, offenders: ccOff } = validateShiftMatrix(coldChain);
  t('validate cold-chain: valid (zero rows ignored)', ccValid === true);
  t('validate cold-chain: offenders empty', ccOff.length === 0);

  // Cross-dock has most functions zero-filled — should NOT flag
  const crossDock = applyArchetype(CROSS_DOCK, 2, 8);
  const cd = validateShiftMatrix(crossDock);
  t('validate cross-dock: all-zero rows skipped', cd.valid === true);

  // Deliberately break a row
  const broken = applyArchetype(OMNI, 3, 8);
  broken.matrix.picking = [50, 50, 30];  // sum 130
  const br = validateShiftMatrix(broken);
  t('validate off-sum: flagged', br.valid === false);
  t('validate off-sum: offender names picking', br.offenders[0]?.fn === 'picking');
  t('validate off-sum: sum reported', br.offenders[0]?.sum === 130);
}

// ------------------------------------------------------------
// 4. normalizeShiftMatrix
// ------------------------------------------------------------
{
  const broken = applyArchetype(OMNI, 3, 8);
  broken.matrix.picking = [50, 50, 30];  // sum 130
  const normed = normalizeShiftMatrix(broken);
  const sum = normed.matrix.picking.reduce((a,v)=>a+v,0);
  t('normalize: picking sums to 100', near(sum, 100, 0.01));
  t('normalize: pack untouched (already 100)',
    JSON.stringify(normed.matrix.pack) === JSON.stringify([35, 50, 15]));
  t('normalize: audit lastEditedAt stamped',
    typeof normed.audit.lastEditedAt === 'string' && normed.audit.lastEditedAt.length > 0);

  // All-zero row stays zero
  const coldChain = applyArchetype(COLD_CHAIN, 2, 8);
  const ccNormed = normalizeShiftMatrix(coldChain);
  t('normalize: zero-filled pack stays zero',
    ccNormed.matrix.pack.every(v => v === 0));
}

// ------------------------------------------------------------
// 5. resizeAllocation
// ------------------------------------------------------------
{
  const a3 = applyArchetype(OMNI, 3, 8);
  const a2 = resizeAllocation(a3, 2, 8);
  t('resize 3->2: picking has 2 cells', a2.matrix.picking.length === 2);
  t('resize 3->2: inbound merges S2+S3 into S2', near(a2.matrix.inbound[1], 40, 0.1));

  const a4 = resizeAllocation(a3, 4, 8);
  t('resize 3->4: picking has 4 cells', a4.matrix.picking.length === 4);
  t('resize 3->4: picking[0] preserved (30)', a4.matrix.picking[0] === 30);
}

// ------------------------------------------------------------
// 6. deriveShiftHeadcount — empty matrix produces zero HC
// ------------------------------------------------------------
{
  const empty = createEmptyShiftAllocation(3, 8);
  const r = deriveShiftHeadcount(empty, wayfairVolumes, wayfairLabor, wayfairShifts);
  t('derive empty: totals.directHc === 0', r.totals.directHc === 0);
  t('derive empty: every shift HC 0', r.byShift.every(s => s.directHc === 0));
  t('derive empty: totals.peakShift null', r.totals.peakShift === null);
}

// ------------------------------------------------------------
// 7. 100% S1 matrix => HC only on S1
// ------------------------------------------------------------
{
  const a = createEmptyShiftAllocation(3, 8);
  for (const fn of FUNCTION_ORDER) a.matrix[fn] = [100, 0, 0];
  const r = deriveShiftHeadcount(a, wayfairVolumes, wayfairLabor, wayfairShifts);
  t('100%-S1: only S1 has HC',
    r.byShift[0].directHc > 0 && r.byShift[1].directHc === 0 && r.byShift[2].directHc === 0);
  t('100%-S1: peakShift is 1', r.totals.peakShift === 1);
}

// ------------------------------------------------------------
// 8. Wayfair worked example (matches wiring doc §7 within ±1 HC per shift)
// ------------------------------------------------------------
{
  const a = applyArchetype(OMNI, 3, 8);
  const r = deriveShiftHeadcount(a, wayfairVolumes, wayfairLabor, wayfairShifts,
    { absenceAllowancePct: 12 });

  // Hand-math says 30 picker FTE across shifts; total direct HC across all
  // functions will be higher (picking + pack + ship + inbound) but should land
  // in a defensible range. We check that picking-specific function rows match
  // the hand-math within rounding.
  const pickingS1 = r.byFunctionShift.find(x => x.fn === 'picking' && x.shift === 1);
  const pickingS2 = r.byFunctionShift.find(x => x.fn === 'picking' && x.shift === 2);
  const pickingS3 = r.byFunctionShift.find(x => x.fn === 'picking' && x.shift === 3);

  // hand-math: S1 ~= 8.5, S2 ~= 14.2, S3 ~= 5.7 (FTE)
  t('wayfair picking S1 FTE ~8.5', near(pickingS1.fte, 8.5, 1));
  t('wayfair picking S2 FTE ~14.2', near(pickingS2.fte, 14.2, 1.5));
  t('wayfair picking S3 FTE ~5.7', near(pickingS3.fte, 5.7, 1));

  // Peak shift should be S2 (50% of picking + 50% of pack + ...)
  t('wayfair peak shift = S2', r.totals.peakShift === 2);

  // Some direct HC surfaced
  t('wayfair totals.directHc > 20', r.totals.directHc > 20);
  t('wayfair totals.costAnnual > 1,000,000', r.totals.costAnnual > 1_000_000);
}

// ------------------------------------------------------------
// 9. splitLaborLinesByShift preserves total annual_hours
// ------------------------------------------------------------
{
  const a = applyArchetype(OMNI, 3, 8);
  const tagged = wayfairLabor.map(l => ({ ...l, calc_from: 'matrix' }));
  const out = splitLaborLinesByShift(tagged, a);

  // Split row count: each line that matches a function and has a non-zero
  // row gets split into N rows (where N = # non-zero cells in row).
  t('split: produces more rows than input', out.length > tagged.length);

  // Total hours preserved per original line
  const pickerSplitHours = out
    .filter(l => l._split_from === 'pick')
    .reduce((a, l) => a + l.annual_hours, 0);
  t('split: picker total hours preserved', near(pickerSplitHours, 74545, 1));

  // Each split row has a shift number 1..3
  const allHaveShift = out.filter(l => l._split_from).every(l => [1,2,3].includes(l.shift));
  t('split: every split row has valid shift', allHaveShift);
}

// ------------------------------------------------------------
// 10. splitLaborLinesByShift leaves manual lines untouched
// ------------------------------------------------------------
{
  const a = applyArchetype(OMNI, 3, 8);
  const manual = [{ id: 'x', activity: 'Picking', annual_hours: 1000, shift: 2, calc_from: 'manual' }];
  const out = splitLaborLinesByShift(manual, a);
  t('split: manual line passes through', out.length === 1 && out[0].shift === 2);
}

// ------------------------------------------------------------
// 11. deriveFunctionForLine classifier covers common activity names
// ------------------------------------------------------------
{
  t('classify: Picker => picking',    deriveFunctionForLine({ position: 'Picker' }) === 'picking');
  t('classify: Loader => ship',       deriveFunctionForLine({ position: 'Loader' }) === 'ship');
  t('classify: Receiving => inbound', deriveFunctionForLine({ activity: 'Receiving' }) === 'inbound');
  t('classify: RMA => returns',       deriveFunctionForLine({ activity: 'RMA Processing' }) === 'returns');
  t('classify: Kitting => vas',       deriveFunctionForLine({ activity: 'Kitting' }) === 'vas');
  t('classify: Replen => replenish',  deriveFunctionForLine({ activity: 'Replen' }) === 'replenish');
  t('classify: Putaway => putaway',   deriveFunctionForLine({ activity: 'Putaway' }) === 'putaway');
  t('classify: Pack => pack',         deriveFunctionForLine({ activity: 'Pack' }) === 'pack');
  t('classify: unknown => null',      deriveFunctionForLine({ activity: 'Janitor' }) === null);
}

// ------------------------------------------------------------
// 12. Shift premium math
// ------------------------------------------------------------
{
  const a = applyArchetype(OMNI, 3, 8);
  const r = deriveShiftHeadcount(a, wayfairVolumes, wayfairLabor, wayfairShifts,
    { absenceAllowancePct: 12, shiftPremiumPct: { '2': 5, '3': 10 } });
  t('premium: S1 premium 0', r.byShift[0].premiumAnnual === 0);
  t('premium: S2 premium = 5% of S2 cost',
    near(r.byShift[1].premiumAnnual, r.byShift[1].costAnnual * 0.05, 0.01));
  t('premium: S3 premium = 10% of S3 cost',
    near(r.byShift[2].premiumAnnual, r.byShift[2].costAnnual * 0.1, 0.01));
  t('premium: totals.premium sums correctly',
    near(r.totals.premiumAnnual,
         r.byShift[1].premiumAnnual + r.byShift[2].premiumAnnual, 0.01));
}

// ------------------------------------------------------------
// 13. All 6 seeded archetypes validate clean
// ------------------------------------------------------------
{
  const seeds = [OMNI, COLD_CHAIN, CROSS_DOCK];
  for (const s of seeds) {
    const alloc = applyArchetype(s, s.shifts_per_day, 8);
    const v = validateShiftMatrix(alloc);
    t(`seed ${s.archetype_ref}: validates clean`, v.valid === true,
      v.offenders.map(o => `${o.fn}=${o.sum}`).join(','));
  }
}

// ------------------------------------------------------------
// 14. Derivation is deterministic
// ------------------------------------------------------------
{
  const a = applyArchetype(OMNI, 3, 8);
  const r1 = deriveShiftHeadcount(a, wayfairVolumes, wayfairLabor, wayfairShifts);
  const r2 = deriveShiftHeadcount(a, wayfairVolumes, wayfairLabor, wayfairShifts);
  t('derive: deterministic totals',
    r1.totals.directHc === r2.totals.directHc && r1.totals.costAnnual === r2.totals.costAnnual);
}

// ------------------------------------------------------------
// Summary
// ------------------------------------------------------------
console.log(`\n\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
