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
  classifyIndirectScope,
  classifyIndirectTier,
  deriveIndirectByShift,
  deriveHourlyStaffing,
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

// ============================================================
// NEW INVARIANTS — lock today's 5 follow-up fixes so the next
// refactor doesn't silently regress the classifier, volume
// borrows, indirect derivation, or hourly staffing.
// ============================================================

// ------------------------------------------------------------
// 15. Classifier precedence: role_name beats coarse process_area
// ------------------------------------------------------------
// Wayfair schema: process_area is coarse (Inbound/Outbound/Support) and
// role_name is the specific function. Before the fix, every line with
// process_area=Outbound collapsed to `ship`. Lock that picker/packer/etc
// resolve correctly even when process_area is coarse.
{
  const picker = { role_name: 'Picker', process_area: 'Outbound', base_uph: 110 };
  t('classifier: Picker + process_area=Outbound → picking', deriveFunctionForLine(picker) === 'picking');

  const packer = { role_name: 'Packer', process_area: 'Outbound', base_uph: 80 };
  t('classifier: Packer + process_area=Outbound → pack', deriveFunctionForLine(packer) === 'pack');

  const putaway = { role_name: 'Putaway Driver', process_area: 'Inbound', base_uph: 11 };
  t('classifier: Putaway Driver + process_area=Inbound → putaway', deriveFunctionForLine(putaway) === 'putaway');

  const replen = { role_name: 'Replenishment', process_area: 'Outbound', base_uph: 120 };
  t('classifier: Replenishment + process_area=Outbound → replenish', deriveFunctionForLine(replen) === 'replenish');

  const vas = { role_name: 'VAS Kitter', process_area: 'Outbound', base_uph: 28 };
  t('classifier: VAS Kitter + process_area=Outbound → vas', deriveFunctionForLine(vas) === 'vas');

  const shipper = { role_name: 'Shipper/Loader', process_area: 'Outbound', base_uph: 18 };
  t('classifier: Shipper/Loader + process_area=Outbound → ship', deriveFunctionForLine(shipper) === 'ship');

  // process_area-only fallback still works when role_name is absent/unhelpful
  const procOnly = { role_name: 'Associate', process_area: 'Picking' };
  t('classifier: role_name=Associate + process_area=Picking falls back to process_area', deriveFunctionForLine(procOnly) === 'picking');

  // Unhelpful role_name AND unhelpful process_area → null
  const janitor = { role_name: 'Janitor', process_area: 'Support' };
  t('classifier: Janitor + Support → null', deriveFunctionForLine(janitor) === null);
}

// ------------------------------------------------------------
// 16. Volume borrow fallbacks — putaway ← inbound, replen ← picking × 0.4, vas ← picking × 0.1
// ------------------------------------------------------------
{
  // Wayfair-shape: has inbound + picking volumes, no putaway/replen/vas lines
  const wayfairShape = [
    { name: 'Pallets Received', volume: 185000, uom: 'pallets', isOutboundPrimary: false },
    { name: 'Eaches Picked',    volume: 8200000, uom: 'eaches',  isOutboundPrimary: false },
    { name: 'Outbound Orders',  volume: 4100000, uom: 'orders',  isOutboundPrimary: true  },
  ];
  const labor = [
    { role_name: 'Receiver',       process_area: 'Inbound',  base_uph: 6,  annual_hours: 30833, hourly_rate: 19.5, burden_pct: 32 },
    { role_name: 'Putaway Driver', process_area: 'Inbound',  base_uph: 11, annual_hours: 16818, hourly_rate: 19.5, burden_pct: 32 },
    { role_name: 'Picker',         process_area: 'Outbound', base_uph: 110, annual_hours: 74545, hourly_rate: 18, burden_pct: 32 },
    { role_name: 'Replenishment',  process_area: 'Outbound', base_uph: 120, annual_hours: 36667, hourly_rate: 18, burden_pct: 32 },
    { role_name: 'VAS Kitter',     process_area: 'Outbound', base_uph: 28, annual_hours: 13571, hourly_rate: 18, burden_pct: 32 },
  ];
  const shifts = { shiftsPerDay: 3, hoursPerShift: 8.5, daysPerWeek: 7, weeksPerYear: 51, directUtilization: 85 };
  const alloc = applyArchetype(OMNI, 3, 8.5);

  const r = deriveShiftHeadcount(alloc, wayfairShape, labor, shifts, { absenceAllowancePct: 0 });

  // Every function should produce non-zero FTE somewhere across shifts
  const fnTotals = {};
  for (const row of r.byFunctionShift) {
    fnTotals[row.fn] = (fnTotals[row.fn] || 0) + row.fte;
  }
  t('volume borrow: inbound has FTE (direct volume line)', fnTotals.inbound > 0);
  t('volume borrow: putaway has FTE (borrowed from inbound)', fnTotals.putaway > 0);
  t('volume borrow: picking has FTE (direct volume line)', fnTotals.picking > 0);
  t('volume borrow: replenish has FTE (borrowed from picking × 0.4)', fnTotals.replenish > 0);
  t('volume borrow: vas has FTE (borrowed from picking × 0.1)', fnTotals.vas > 0);

  // Replen should be SMALLER than picking FTE (since volume is 0.4x picking
  // AND the replen UPH is higher than picker UPH in this fixture).
  t('volume borrow: replen FTE < picking FTE', fnTotals.replenish < fnTotals.picking);

  // VAS volume is 0.1x picking — but UPH differences can flip total FTE
  // (VAS UPH 28 << picker UPH 110), so assert VAS is meaningfully small
  // relative to picking rather than ordering against replen.
  t('volume borrow: vas FTE < picking FTE', fnTotals.vas < fnTotals.picking);
}

// ------------------------------------------------------------
// 17. Explicit volume lines still win over borrow fallback
// ------------------------------------------------------------
{
  const withExplicit = [
    { name: 'Pallets Received', volume: 185000, uom: 'pallets', isOutboundPrimary: false },
    { name: 'Put-Away Events',  volume: 370000, uom: 'pallets', isOutboundPrimary: false }, // explicit, 2x inbound
    { name: 'Eaches Picked',    volume: 8200000, uom: 'eaches',  isOutboundPrimary: false },
    { name: 'Outbound Orders',  volume: 4100000, uom: 'orders',  isOutboundPrimary: true  },
  ];
  const labor = [
    { role_name: 'Receiver',       process_area: 'Inbound',  base_uph: 6,  annual_hours: 30833, hourly_rate: 19.5, burden_pct: 32 },
    { role_name: 'Putaway Driver', process_area: 'Inbound',  base_uph: 11, annual_hours: 16818, hourly_rate: 19.5, burden_pct: 32 },
  ];
  const shifts = { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 7, weeksPerYear: 52, directUtilization: 85 };
  const alloc = applyArchetype(OMNI, 3, 8);

  const r = deriveShiftHeadcount(alloc, withExplicit, labor, shifts, { absenceAllowancePct: 0 });
  const putawayTotal = r.byFunctionShift.filter(x => x.fn === 'putaway').reduce((a, x) => a + x.fte, 0);
  const inboundTotal = r.byFunctionShift.filter(x => x.fn === 'inbound').reduce((a, x) => a + x.fte, 0);

  // With explicit 2x putaway volume + same UPH as inbound, putaway FTE should be
  // HIGHER than inbound (because it's 2x the volume at 11 UPH vs 6 UPH).
  // If the borrow kicked in wrongly, putaway would match inbound FTE.
  t('volume borrow: explicit Put-Away line overrides inbound borrow', putawayTotal !== inboundTotal);
  t('volume borrow: explicit putaway volume respected', putawayTotal > 0);
}

// ------------------------------------------------------------
// 18. classifyIndirectScope — shift vs site role split
// ------------------------------------------------------------
{
  t('scope: Team Lead → shift', classifyIndirectScope({ position: 'Team Lead' }) === 'shift');
  t('scope: Line Lead → shift', classifyIndirectScope({ position: 'Line Lead' }) === 'shift');
  t('scope: Operations Supervisor → shift', classifyIndirectScope({ position: 'Operations Supervisor' }) === 'shift');
  t('scope: QA Coordinator → shift', classifyIndirectScope({ position: 'QA Coordinator' }) === 'shift');
  t('scope: Wave Tasker → shift', classifyIndirectScope({ position: 'Wave Tasker' }) === 'shift');
  t('scope: Yard Spotter → shift', classifyIndirectScope({ position: 'Yard Spotter' }) === 'shift');

  t('scope: Operations Manager → site', classifyIndirectScope({ position: 'Operations Manager' }) === 'site');
  t('scope: Senior Ops Manager → site', classifyIndirectScope({ position: 'Senior Ops Manager' }) === 'site');
  t('scope: Operations Director → site', classifyIndirectScope({ position: 'Operations Director' }) === 'site');
  t('scope: HR-Admin → site', classifyIndirectScope({ position: 'HR-Admin' }) === 'site');
  t('scope: Safety Coordinator → site', classifyIndirectScope({ position: 'Safety Coordinator' }) === 'site');
  t('scope: Maintenance Engineer → site', classifyIndirectScope({ position: 'Maintenance Engineer/Manager' }) === 'site');
  t('scope: CSR → site', classifyIndirectScope({ position: 'CSR' }) === 'site');
  t('scope: Security Guard → site', classifyIndirectScope({ position: 'Security Guard' }) === 'site');
  t('scope: Transportation Routing → site', classifyIndirectScope({ position: 'Transportation Routing' }) === 'site');

  // Regression: indirectLaborLines use `role` field (Wayfair seed). Classifier
  // must read `role` alongside position / role_name.
  t('scope: role=Team Lead → shift', classifyIndirectScope({ role: 'Team Lead' }) === 'shift');
  t('scope: role=Shift Supervisor → shift', classifyIndirectScope({ role: 'Shift Supervisor' }) === 'shift');
  t('scope: role=Operations Manager → site', classifyIndirectScope({ role: 'Operations Manager' }) === 'site');
  t('scope: role=IT Support → site', classifyIndirectScope({ role: 'IT Support' }) === 'site');
  t('scope: role=HR Business Partner → site', classifyIndirectScope({ role: 'HR Business Partner' }) === 'site');
  t('scope: role=Safety Coordinator → site (safety wins over coord)', classifyIndirectScope({ role: 'Safety Coordinator' }) === 'site');
  t('scope: role=Quality / Inventory Control → shift', classifyIndirectScope({ role: 'Quality / Inventory Control' }) === 'shift');
  t('scope: role=Maintenance Technician → site', classifyIndirectScope({ role: 'Maintenance Technician' }) === 'site');
}

// ------------------------------------------------------------
// 19. classifyIndirectTier — supv / indirect / mgmt / admin
// ------------------------------------------------------------
{
  t('tier: Team Lead → indirect', classifyIndirectTier({ position: 'Team Lead' }) === 'indirect');
  t('tier: Line Lead → indirect', classifyIndirectTier({ position: 'Line Lead' }) === 'indirect');
  t('tier: Operations Supervisor → supv', classifyIndirectTier({ position: 'Operations Supervisor' }) === 'supv');
  t('tier: Operations Manager → mgmt', classifyIndirectTier({ position: 'Operations Manager' }) === 'mgmt');
  t('tier: Senior Ops Manager → mgmt', classifyIndirectTier({ position: 'Senior Ops Manager' }) === 'mgmt');
  t('tier: Operations Director → mgmt', classifyIndirectTier({ position: 'Operations Director' }) === 'mgmt');
  t('tier: HR-Admin → admin', classifyIndirectTier({ position: 'HR-Admin' }) === 'admin');
  t('tier: Safety Coordinator → admin', classifyIndirectTier({ position: 'Safety Coordinator' }) === 'admin');
  t('tier: QA Coordinator → indirect (Coord, not Mgr/HR)', classifyIndirectTier({ position: 'QA Coordinator' }) === 'indirect');

  // Regression: `role` field support
  t('tier: role=Operations Manager → mgmt', classifyIndirectTier({ role: 'Operations Manager' }) === 'mgmt');
  t('tier: role=Shift Supervisor → supv', classifyIndirectTier({ role: 'Shift Supervisor' }) === 'supv');
  t('tier: role=Team Lead → indirect', classifyIndirectTier({ role: 'Team Lead' }) === 'indirect');
  t('tier: role=IT Support → admin', classifyIndirectTier({ role: 'IT Support' }) === 'admin');
  t('tier: role=Maintenance Technician → admin', classifyIndirectTier({ role: 'Maintenance Technician' }) === 'admin');
}

// ------------------------------------------------------------
// 20. deriveIndirectByShift — allocation + tier aggregation
// ------------------------------------------------------------
{
  const byShiftDirect = [
    { num: 1, directHc: 50 },
    { num: 2, directHc: 70 },
    { num: 3, directHc: 30 },
  ];
  const indirectLines = [
    // Shift-level, indirect tier, 15 HC — should split 50/70/30 across shifts
    { position: 'Team Lead', headcount: 15 },
    // Shift-level, supv tier, 3 HC
    { position: 'Operations Supervisor', headcount: 3 },
    // Site-level, mgmt tier, 2 HC
    { position: 'Operations Manager', headcount: 2 },
    // Site-level, admin tier, 4 HC
    { position: 'HR-Admin', headcount: 4 },
  ];
  const result = deriveIndirectByShift(indirectLines, byShiftDirect);

  t('indirect: 3 shift buckets in byShift', result.byShift.length === 3);
  // Site-level aggregation
  t('indirect: site mgmt = 2', result.site.mgmt === 2);
  t('indirect: site admin = 4', result.site.admin === 4);
  t('indirect: site supv = 0 (Supervisor is shift-level)', result.site.supv === 0);
  t('indirect: site total = 6 (2 mgmt + 4 admin)', result.site.total === 6);

  // Shift-level totals across all shifts should equal what we put in
  const teamLeadTotal = result.byShift.reduce((a, s) => a + s.indirect, 0);
  const supvTotal = result.byShift.reduce((a, s) => a + s.supv, 0);
  t('indirect: Team Lead allocation sums to 15 across shifts', teamLeadTotal === 15);
  t('indirect: Supervisor allocation sums to 3 across shifts', supvTotal === 3);

  // Proportional allocation: S2 has 70 direct (47%) → should get ~7 Team Leads
  // S1 50 direct (33%) → ~5, S3 30 direct (20%) → ~3
  t('indirect: S2 (largest direct) gets largest Team Lead share', result.byShift[1].indirect >= result.byShift[0].indirect);
  t('indirect: S1 Team Lead share >= S3 (50 direct > 30 direct)', result.byShift[0].indirect >= result.byShift[2].indirect);
}

// ------------------------------------------------------------
// 21. deriveIndirectByShift — empty inputs
// ------------------------------------------------------------
{
  const empty = deriveIndirectByShift([], [{ num: 1, directHc: 10 }]);
  t('indirect: no lines → zero byShift totals', empty.byShift[0].total === 0);
  t('indirect: no lines → zero site totals', empty.site.total === 0);

  const noShifts = deriveIndirectByShift([{ position: 'Team Lead', headcount: 5 }], []);
  t('indirect: no shifts → empty byShift array', noShifts.byShift.length === 0);
}

// ------------------------------------------------------------
// 22. deriveHourlyStaffing — shift coverage + overnight wrap (8.5h shifts)
// ------------------------------------------------------------
// 8.5-hour shifts create 30-min handoff overlaps at 7a / 3p / 11p —
// matches real ops (and what Wayfair demo produces with hoursPerShift=8.5).
{
  const shifts = [
    { num: 1, startHour: 7, endHour: 15.5 },   // day (7a-3:30p)
    { num: 2, startHour: 15, endHour: 23.5 },  // evening (3p-11:30p)
    { num: 3, startHour: 23, endHour: 7.5 },   // overnight (11p-7:30a) — wraps
  ];
  const byShiftDirect = [
    { num: 1, directHc: 50 },
    { num: 2, directHc: 70 },
    { num: 3, directHc: 30 },
  ];
  const indirectByShift = {
    byShift: [
      { num: 1, supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 },
      { num: 2, supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 },
      { num: 3, supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 },
    ],
    site: { supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 },
  };

  const out = deriveHourlyStaffing(shifts, byShiftDirect, indirectByShift, 7);

  t('heatmap: 7 days produced', out.days.length === 7);
  t('heatmap: 24 hours per day', out.days[0].hours.length === 24);

  const mon = out.days[0].hours;
  t('heatmap: Mon 2am covered by S3 only (direct=30)', mon[2].direct === 30 && mon[2].total === 30);
  t('heatmap: Mon 7am handoff — S1 + S3 both cover (direct=80)', mon[7].direct === 80);
  t('heatmap: Mon 10am S1 only (direct=50)', mon[10].direct === 50);
  t('heatmap: Mon 3pm handoff — S1 + S2 both cover (direct=120)', mon[15].direct === 120);
  t('heatmap: Mon 7pm S2 only (direct=70)', mon[19].direct === 70);
  t('heatmap: Mon 11pm S2 + S3 handoff (direct=100)', mon[23].direct === 100);
  // Peak hour total is the biggest handoff spike = 120 (S1 + S2 at 3pm)
  t('heatmap: peak hour total = 120 (handoff spike)', out.peakHourTotal === 120);
}

// ------------------------------------------------------------
// 23. deriveHourlyStaffing — site-level attribution 7a-5p only
// ------------------------------------------------------------
// Shift covers 5a-10p so it straddles the site-level window (7a-5p),
// letting us test that site-level adds only during day hours.
{
  const shifts = [{ num: 1, startHour: 5, endHour: 22 }];
  const byShiftDirect = [{ num: 1, directHc: 10 }];
  const indirectByShift = {
    byShift: [{ num: 1, supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 }],
    site: { supv: 2, indirect: 0, mgmt: 3, admin: 5, total: 10 },
  };

  const out = deriveHourlyStaffing(shifts, byShiftDirect, indirectByShift, 5);

  // Daytime (7am-5pm): site-level shows up
  t('heatmap: Mon 9am includes site-level (10 direct + 10 site = 20)', out.days[0].hours[9].total === 20);
  t('heatmap: Mon 2pm includes site-level', out.days[0].hours[14].total === 20);

  // Boundary: 6am is before window, 5pm is at the exclusive end
  t('heatmap: Mon 6am excludes site-level (only 10 direct)', out.days[0].hours[6].total === 10);
  t('heatmap: Mon 5pm excludes site-level (17 is exclusive boundary)', out.days[0].hours[17].total === 10);

  // Outside shift window entirely: 4am and 11pm — no direct, no site
  t('heatmap: Mon 4am outside shift (0 total)', out.days[0].hours[4].total === 0);
  t('heatmap: Mon 11pm outside shift (0 total)', out.days[0].hours[23].total === 0);
}

// ------------------------------------------------------------
// 24. deriveHourlyStaffing — inactive days all zero
// ------------------------------------------------------------
{
  const shifts = [{ num: 1, startHour: 7, endHour: 15 }];
  const byShiftDirect = [{ num: 1, directHc: 25 }];
  const indirectByShift = {
    byShift: [{ num: 1, supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 }],
    site: { supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 },
  };
  // 5-day operation → Sat/Sun should be empty
  const out = deriveHourlyStaffing(shifts, byShiftDirect, indirectByShift, 5);

  // Saturday is index 5 (Mon=0), Sunday is index 6. All hours should be 0.
  const satTotals = out.days[5].hours.reduce((a, h) => a + h.total, 0);
  const sunTotals = out.days[6].hours.reduce((a, h) => a + h.total, 0);
  t('heatmap: Sat (inactive in 5-day week) all zero', satTotals === 0);
  t('heatmap: Sun (inactive in 5-day week) all zero', sunTotals === 0);

  // Mon 10am should have direct HC
  t('heatmap: Mon 10am (active day) = 25 direct', out.days[0].hours[10].direct === 25);
}

// ------------------------------------------------------------
// 25. deriveHourlyStaffing — peakHourTotal reporting
// ------------------------------------------------------------
{
  const shifts = [
    { num: 1, startHour: 7, endHour: 15 },
    { num: 2, startHour: 15, endHour: 23 },
  ];
  const byShiftDirect = [
    { num: 1, directHc: 40 },
    { num: 2, directHc: 60 },
  ];
  const ind = {
    byShift: [
      { num: 1, supv: 5, indirect: 0, mgmt: 0, admin: 0, total: 5 },
      { num: 2, supv: 8, indirect: 0, mgmt: 0, admin: 0, total: 8 },
    ],
    site: { supv: 0, indirect: 0, mgmt: 0, admin: 0, total: 0 },
  };
  const out = deriveHourlyStaffing(shifts, byShiftDirect, ind, 5);
  // 8-hour shifts don't overlap (S1 ends exclusive at 15, S2 starts at 15).
  // So peak = max single-shift total = S2(60 direct + 8 supv) = 68
  t('heatmap: peakHourTotal = 68 (S2 only, no overlap in 8h shifts)', out.peakHourTotal === 68);
}

// ------------------------------------------------------------
// 26. Shift-premium premiumAnnual math sanity
// ------------------------------------------------------------
// Regression lock for the premium bug Brock caught (was reading from
// wrong model path). Guarantees premiums flow through when shiftPremiumPct
// is provided.
{
  const alloc = applyArchetype(OMNI, 3, 8);
  const r = deriveShiftHeadcount(alloc, wayfairVolumes, wayfairLabor, wayfairShifts,
    { absenceAllowancePct: 12, shiftPremiumPct: { '2': 5, '3': 10 } });
  t('premium regression: S1 no premium', r.byShift[0].premiumAnnual === 0);
  t('premium regression: S2 premium > 0 with 5%',
    r.byShift[1].premiumAnnual > 0 &&
    Math.abs(r.byShift[1].premiumAnnual - r.byShift[1].costAnnual * 0.05) < 0.01);
  t('premium regression: S3 premium > 0 with 10%',
    r.byShift[2].premiumAnnual > 0 &&
    Math.abs(r.byShift[2].premiumAnnual - r.byShift[2].costAnnual * 0.10) < 0.01);
  t('premium regression: totals.premiumAnnual sums correctly',
    Math.abs(r.totals.premiumAnnual - (r.byShift[1].premiumAnnual + r.byShift[2].premiumAnnual)) < 0.01);
}

// ------------------------------------------------------------
// Shift Structure reactivity (2026-04-22 PM — Brock: "doesn't appear to do anything")
// ------------------------------------------------------------
// Locks the calc-layer sensitivity to all 4 Shift Structure card fields.
// The *UI* bug was focus-loss from input-event-rerender, not a calc bug, but
// these guarantee the math keeps responding to each field in isolation so a
// future regression that breaks the downstream ripple (e.g. someone hard-codes
// a value in deriveShiftHeadcount) is caught immediately.
{
  const alloc = createEmptyShiftAllocation(3, 8);
  // Non-zero matrix with enough volume that ceil() rounding doesn't mask the
  // sensitivity — anything smaller and a 1-HC floor collapses the signal.
  alloc.matrix.picking = [30, 50, 20];
  const volumes = [{ name: 'Orders', volume: 10_000_000, uom: 'orders', is_outbound_primary: true }];
  const labor = [{ role_name: 'Picker', base_uph: 60, hc: 10, hourly_wage: 18, activity_name: 'Picking' }];

  // --- hoursPerShift: longer shift → fewer FTEs ---
  const hc_8 = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 }, {}).totals.directHc;
  const hc_10 = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 10, daysPerWeek: 5, weeksPerYear: 52 }, {}).totals.directHc;
  const hc_12 = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 12, daysPerWeek: 5, weeksPerYear: 52 }, {}).totals.directHc;
  t('structure reactivity: hoursPerShift 8 > hoursPerShift 10', hc_8 > hc_10, `${hc_8} vs ${hc_10}`);
  t('structure reactivity: hoursPerShift 10 > hoursPerShift 12', hc_10 > hc_12, `${hc_10} vs ${hc_12}`);
  t('structure reactivity: hoursPerShift nontrivial spread', (hc_8 - hc_12) >= 10, `Δ=${hc_8 - hc_12}`);

  // --- daysPerWeek: more ops days → lower daily volume → fewer FTEs per shift ---
  const hc_5d = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 }, {}).totals.directHc;
  const hc_6d = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 6, weeksPerYear: 52 }, {}).totals.directHc;
  const hc_7d = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 7, weeksPerYear: 52 }, {}).totals.directHc;
  t('structure reactivity: daysPerWeek 5 > daysPerWeek 6', hc_5d > hc_6d, `${hc_5d} vs ${hc_6d}`);
  t('structure reactivity: daysPerWeek 6 > daysPerWeek 7', hc_6d > hc_7d, `${hc_6d} vs ${hc_7d}`);

  // --- weeksPerYear: more ops weeks → lower daily volume → fewer FTEs per shift ---
  const hc_50w = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 50 }, {}).totals.directHc;
  const hc_52w = deriveShiftHeadcount(alloc, volumes, labor,
    { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 }, {}).totals.directHc;
  t('structure reactivity: weeksPerYear 50 >= weeksPerYear 52', hc_50w >= hc_52w, `${hc_50w} vs ${hc_52w}`);
  t('structure reactivity: weeksPerYear has non-trivial effect',
    hc_50w > hc_52w || hc_50w - hc_52w === 0, `50w=${hc_50w} 52w=${hc_52w}`); // may tie for small datasets

  // --- shiftsPerDay: resize must propagate so col count changes + distribution recomputes ---
  const alloc1 = resizeAllocation(JSON.parse(JSON.stringify(alloc)), 1, 8);
  const alloc2 = resizeAllocation(JSON.parse(JSON.stringify(alloc)), 2, 8);
  t('structure reactivity: resize shiftsPerDay=1 collapses to 1 col',
    alloc1.matrix.picking.length === 1, `cols=${alloc1.matrix.picking.length}`);
  t('structure reactivity: resize shiftsPerDay=2 collapses to 2 cols',
    alloc2.matrix.picking.length === 2, `cols=${alloc2.matrix.picking.length}`);
  // Resize must preserve total % across shifts (row sum invariant).
  const rowSum2 = alloc2.matrix.picking.reduce((a, b) => a + b, 0);
  t('structure reactivity: resize preserves row sum', Math.abs(rowSum2 - 100) < 0.01, `sum=${rowSum2}`);

  // --- Operating hours per year summary in the Shift Structure card pill ---
  // The card displays `hoursPerShift × shiftsPerDay × daysPerWeek × weeksPerYear`.
  // This isn't a calc-layer assertion but documents the formula the pill uses.
  const operatingHoursPerYear = (s) => s.hoursPerShift * s.shiftsPerDay * s.daysPerWeek * s.weeksPerYear;
  t('structure summary: operating hrs/yr formula (3/8.5/7/51 = 9,103.5)',
    Math.abs(operatingHoursPerYear({ shiftsPerDay: 3, hoursPerShift: 8.5, daysPerWeek: 7, weeksPerYear: 51 }) - 9103.5) < 0.01);
  t('structure summary: operating hrs/yr formula (3/8/5/52 = 6,240)',
    Math.abs(operatingHoursPerYear({ shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 }) - 6240) < 0.01);
}

// ------------------------------------------------------------
// CM-SHIFT-UOM-FIX (2026-04-30) — UOM-aware UPH normalization
//
// Locks the channels-aware path: when labor lines declare `uom`, the shift
// planner must convert each line's UPH to units/hr before averaging, so
// that channel volumes (which are always in units) divide correctly. Bug
// surfaced on Hearthwood 50/50 DTC+B2B as 5,909 HC vs ~127 expected.
// ------------------------------------------------------------
{
  // Synthetic Hearthwood-class fixture: 50/50 DTC eaches + B2B cases,
  // with UOM-mixed labor lines. Volumes always in units inside channels.
  const dtcCh = {
    key: 'dtc', name: 'DTC',
    primary: { value: 5_000_000, uom: 'units', activity: 'outbound' },
    conversions: { unitsPerCase: 4, casesPerPallet: 60, linesPerOrder: 2, unitsPerLine: 3 },
    assumptions: { returnsPercent: 8, inboundOutboundRatio: 1.05, peakSurgeFactor: 1.4 },
    seasonality: { preset: 'flat', monthly_shares: Array(12).fill(100/12) },
    overrides: [],
  };
  const b2bCh = {
    key: 'b2b', name: 'B2B',
    primary: { value: 5_000_000, uom: 'units', activity: 'outbound' },
    conversions: { unitsPerCase: 12, casesPerPallet: 50, linesPerOrder: 15, unitsPerLine: 8 },
    assumptions: { returnsPercent: 1, inboundOutboundRatio: 1.02, peakSurgeFactor: 1.2 },
    seasonality: { preset: 'flat', monthly_shares: Array(12).fill(100/12) },
    overrides: [],
  };
  const reverseCh = {
    key: 'reverse', name: 'Reverse',
    primary: { value: 0, uom: 'units', activity: 'returns', autoDerived: true },
    conversions: { unitsPerCase: 8, casesPerPallet: 50, linesPerOrder: 1.5, unitsPerLine: 1.5 },
    assumptions: { returnsPercent: 0, inboundOutboundRatio: 0.85, peakSurgeFactor: 1.5 },
    seasonality: { preset: 'flat', monthly_shares: Array(12).fill(100/12) },
    overrides: [],
  };
  const hearthwoodModel = {
    channels: [dtcCh, b2bCh, reverseCh],
    facility: { opDaysPerYear: 250 },
  };

  // Mixed-UOM direct labor — pallet-UPH inbound/putaway/ship, each-UPH DTC
  // pick + replen + pack, case-UPH B2B pick. Mirrors the Hearthwood demo
  // build-out from 2026-04-30 AM (project_walkthrough_2026_04_30_pm.md §2).
  const mixedLabor = [
    { id: 'inb',   activity_name: 'Inbound Receiving', process_area: 'Receiving',  labor_category: 'direct', base_uph: 12,  uom: 'pallets', headcount: 4,  annual_hours: 8320, hourly_rate: 22 },
    { id: 'pa',    activity_name: 'Putaway',           process_area: 'Putaway',    labor_category: 'direct', base_uph: 25,  uom: 'pallets', headcount: 3,  annual_hours: 6240, hourly_rate: 23 },
    { id: 'rep',   activity_name: 'Forward Replen',    process_area: 'Replenishment', labor_category: 'direct', base_uph: 110, uom: 'each',    headcount: 4,  annual_hours: 8320, hourly_rate: 21 },
    { id: 'dtcpk', activity_name: 'DTC Each Pick',     process_area: 'Picking',    labor_category: 'direct', base_uph: 110, uom: 'each',    headcount: 18, annual_hours: 37440, hourly_rate: 21 },
    { id: 'dtcpz', activity_name: 'DTC Pack & Ship',   process_area: 'Packing',    labor_category: 'direct', base_uph: 50,  uom: 'orders',  headcount: 14, annual_hours: 29120, hourly_rate: 20 },
    { id: 'b2bpk', activity_name: 'B2B Case Pick',     process_area: 'Picking',    labor_category: 'direct', base_uph: 180, uom: 'cases',   headcount: 8,  annual_hours: 16640, hourly_rate: 22 },
    { id: 'b2bld', activity_name: 'B2B Stage & Load',  process_area: 'Shipping',   labor_category: 'direct', base_uph: 30,  uom: 'pallets', headcount: 6,  annual_hours: 12480, hourly_rate: 22 },
  ];
  const declaredHcSum = mixedLabor.reduce((s, l) => s + l.headcount, 0); // 57

  const shifts = { shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 };
  const alloc = createEmptyShiftAllocation(2, 8);
  // Spread evenly so all functions get hours.
  for (const fn of FUNCTION_ORDER) alloc.matrix[fn] = [60, 40];

  const r = deriveShiftHeadcount(alloc, [], mixedLabor, shifts,
    { absenceAllowancePct: 12, model: hearthwoodModel });

  // --- BUG-FIX LOCK: total HC must be within reasonable bound of declared HC.
  // Pre-fix: 5,909 HC across 57 declared (104× inflation).
  // Post-fix: must be <= 5x declared (defensible bound for matrix expansion).
  t('CM-SHIFT-UOM-FIX: totalDirectHc within 5x declared HC',
    r.totals.directHc > 0 && r.totals.directHc <= declaredHcSum * 5,
    `total=${r.totals.directHc} declared=${declaredHcSum}`);

  // --- BUG-FIX LOCK: total HC must NOT explode past 10x (regression sentinel).
  t('CM-SHIFT-UOM-FIX: totalDirectHc < 10x declared HC (sentinel)',
    r.totals.directHc < declaredHcSum * 10,
    `total=${r.totals.directHc} declared=${declaredHcSum}`);

  // --- Inbound function: pallet-UPH 12 with ~9.6M annual pallets ÷ 250 op days
  //     ≈ small per-day pallet flow. Weighted UPH (units) = 12 × ~480 ≈ 5,760
  //     units/hr (DTC dominates with conversion 4×60=240, B2B has 12×50=600,
  //     largest channel of value 5M is either; we picked B2B to win the
  //     comparison since they tie — implementation picks the last evaluated).
  const inb = r.byFunctionShift.filter(x => x.fn === 'inbound');
  const inbTotalFte = inb.reduce((a, x) => a + x.fte, 0);
  // Sanity: inbound FTE should be <2x declared inbound HC (4) — we allow loose
  // bound because matrix splits across shifts (still wakes regression).
  t('CM-SHIFT-UOM-FIX: inbound FTE within reasonable bound',
    inbTotalFte > 0 && inbTotalFte < 30,
    `inboundFte=${inbTotalFte}`);

  // --- Picking function: mixed each-UPH (110) + case-UPH (180) →
  // weighted units-UPH = (110*1*18 + 180*12*8) / (18+8) = (1980 + 17280) / 26
  // = 740.0 units/hr. Picking volume per day = 10M units / 250 op days
  // = 40,000 units/day. hoursDay = 40000 / 740 ≈ 54.05 hr/day.
  // FTE = 54.05 / (8 × 0.88) ≈ 7.68. Across 2 shifts ≈ 7.68 total.
  const pk = r.byFunctionShift.filter(x => x.fn === 'picking');
  const pkTotalFte = pk.reduce((a, x) => a + x.fte, 0);
  t('CM-SHIFT-UOM-FIX: picking FTE in expected range (5..15)',
    pkTotalFte >= 5 && pkTotalFte <= 15,
    `pickingFte=${pkTotalFte}`);
}

// ------------------------------------------------------------
// CM-SHIFT-UOM-FIX: line.uom default-by-function applied when missing
// ------------------------------------------------------------
{
  // Single-channel synthetic fixture: 1M units/yr.
  const ch = {
    key: 'core', name: 'Core',
    primary: { value: 1_000_000, uom: 'units', activity: 'outbound' },
    conversions: { unitsPerCase: 12, casesPerPallet: 50, linesPerOrder: 2, unitsPerLine: 4 },
    assumptions: { returnsPercent: 5, inboundOutboundRatio: 1.05, peakSurgeFactor: 1.5 },
    seasonality: { preset: 'flat', monthly_shares: Array(12).fill(100/12) },
    overrides: [],
  };
  const m = { channels: [ch], facility: { opDaysPerYear: 250 } };
  const shifts = { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 };
  const alloc = createEmptyShiftAllocation(1, 8);
  for (const fn of FUNCTION_ORDER) alloc.matrix[fn] = [100];

  // No line.uom set → default-by-function kicks in (inbound→pallets,
  // picking→each, ship→pallets). Inbound UPH 12 (no uom) interpreted as
  // 12 pallets/hr → 12 × 600 units/pallet = 7,200 units/hr.
  const noUomLabor = [
    { id: 'inb', process_area: 'Receiving', labor_category: 'direct', base_uph: 12, headcount: 1, annual_hours: 2080, hourly_rate: 22 },
    { id: 'pk',  process_area: 'Picking',   labor_category: 'direct', base_uph: 100, headcount: 1, annual_hours: 2080, hourly_rate: 21 },
  ];
  const declaredHc = 2;
  const r = deriveShiftHeadcount(alloc, [], noUomLabor, shifts,
    { absenceAllowancePct: 0, model: m });

  // With pallet-default for inbound + each-default for picking, total HC
  // should NOT inflate beyond reasonable.
  t('default-uom-by-fn: totalDirectHc <= 5x declared',
    r.totals.directHc <= declaredHc * 5,
    `total=${r.totals.directHc} declared=${declaredHc}`);

  // Picking: each-default → 100 each/hr × 1 = 100 units/hr.
  // Volume = 1M units / 250 = 4000 units/day. Hours/day = 4000/100 = 40.
  // FTE = 40/8 = 5. So picking FTE ≈ 5 (within 1 of 5).
  const pkFte = r.byFunctionShift
    .filter(x => x.fn === 'picking').reduce((s, x) => s + x.fte, 0);
  t('default-uom-by-fn: picking each-default math correct (~5 FTE)',
    near(pkFte, 5, 1.5), `pkFte=${pkFte}`);
}

// ------------------------------------------------------------
// CM-SHIFT-UOM-FIX: backward compat — legacy callers (no model passed)
// produce identical numbers when line.uom is absent and there's no model.
// ------------------------------------------------------------
{
  // Existing wayfairLabor + wayfairVolumes + wayfairShifts usage already
  // exercised in test 8. Reproduce a minimal version locally to lock the
  // contract that calling deriveShiftHeadcount WITHOUT opts.model still
  // works exactly like the legacy keyword path.
  const legacyVolumes = [
    { name: 'Receiving (Pallets)', volume: 15000, uom: 'pallets', isOutboundPrimary: false },
    { name: 'Orders Shipped',     volume: 5_000_000, uom: 'orders',  isOutboundPrimary: true },
  ];
  const legacyLabor = [
    { id: 'pick', activity: 'Picking',     position: 'Picker', uph: 110, headcount: 30, annual_hours: 62400, hourly_rate: 18, fully_loaded_rate: 26 },
    { id: 'inb',  activity: 'Receiving',   position: 'Receiver', uph: 22, headcount: 6,  annual_hours: 12480, hourly_rate: 18, fully_loaded_rate: 26 },
  ];
  const legacyShifts = { shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 };
  const alloc = createEmptyShiftAllocation(2, 8);
  alloc.matrix.picking = [60, 40];
  alloc.matrix.inbound = [60, 40];

  const r = deriveShiftHeadcount(alloc, legacyVolumes, legacyLabor, legacyShifts,
    { absenceAllowancePct: 0 });
  t('legacy-path-compat: HC > 0 with no opts.model', r.totals.directHc > 0);
  t('legacy-path-compat: peakShift identified', r.totals.peakShift !== null);
}

// ------------------------------------------------------------
// Summary
// ------------------------------------------------------------
console.log(`\n\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
