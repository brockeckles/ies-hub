// Standalone Node ESM test runner for the Phase 1 channel accessors.
// See project_volumes_nucleus_redesign.md in auto-memory.
//
// Run:  node test-channels.mjs

import {
  getChannels,
  getChannel,
  getPrimaryChannel,
  getOutboundChannels,
  getChannelPrimaryIn,
  getChannelDerived,
  getAnnualVolume,
  getAggregateDerived,
  getTotalReturns,
  getChannelMix,
  convertUom,
  _internals,
} from './tools/cost-model/calc.channels.js';

import { backfillChannelsFromLegacy } from './tools/cost-model/api.js';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}

function approx(a, b, tol = 0.01) {
  if (Math.abs(a - b) > tol) throw new Error(`expected ~${b}, got ${a}`);
}

function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// Fixtures
const dtcChannel = {
  key: 'dtc',
  name: 'DTC e-com',
  archetypeId: 'dtc-ecom',
  sortOrder: 10,
  primary: { value: 18000000, uom: 'units', activity: 'outbound', source: 'manual' },
  conversions: { unitsPerCase: 12, casesPerPallet: 40, linesPerOrder: 2, unitsPerLine: 3, weightPerUnit: 0.85, weightUnit: 'lbs' },
  assumptions: { returnsPercent: 18, inboundOutboundRatio: 1.05, peakSurgeFactor: 2.5 },
  seasonality: { preset: 'ecom_holiday_peak', monthly_shares: [5,5,6,6,7,7,7,8,9,11,14,15] },
  overrides: [],
};

const b2bChannel = {
  key: 'b2b',
  name: 'B2B retail',
  archetypeId: 'b2b-retail',
  sortOrder: 20,
  primary: { value: 7000000, uom: 'units', activity: 'outbound', source: 'manual' },
  conversions: { unitsPerCase: 24, casesPerPallet: 50, linesPerOrder: 80, unitsPerLine: 200, weightPerUnit: 1.5, weightUnit: 'lbs' },
  assumptions: { returnsPercent: 2, inboundOutboundRatio: 1.02, peakSurgeFactor: 1.4 },
  seasonality: { preset: 'flat', monthly_shares: Array(12).fill(100/12) },
  overrides: [],
};

const reverseChannel = {
  key: 'reverse',
  name: 'Reverse',
  archetypeId: 'reverse',
  sortOrder: 70,
  primary: { value: 0, uom: 'units', activity: 'returns', source: 'manual', autoDerived: true },
  conversions: { unitsPerCase: 12, casesPerPallet: 40, linesPerOrder: 1.5, unitsPerLine: 1.5, weightPerUnit: 0.85, weightUnit: 'lbs' },
  assumptions: { returnsPercent: 0, inboundOutboundRatio: 0.85, peakSurgeFactor: 1.8 },
  seasonality: { preset: 'apparel_2_peak', monthly_shares: [18,16,8,6,5,5,5,5,5,7,9,11] },
  overrides: [],
};

const multiChannelModel = {
  channels: [dtcChannel, b2bChannel, reverseChannel],
  facility: { opDaysPerYear: 250 },
};

const legacyModel = {
  volumeLines: [
    { name: 'Outbound Units', volume: 18000000, uom: 'each', isOutboundPrimary: true },
    { name: 'Pallets In', volume: 75000, uom: 'pallet' },
  ],
  orderProfile: { linesPerOrder: 2.5, unitsPerLine: 4, avgOrderWeight: 0.9, weightUnit: 'lbs' },
  seasonalityProfile: { preset: 'ecom_holiday_peak', monthly_shares: [5,5,6,6,7,7,7,8,9,11,14,15] },
  facility: { opDaysPerYear: 250 },
};

// ── Tests ────────────────────────────────────────────────────────

test('getChannels returns channels[] when present', () => {
  eq(getChannels(multiChannelModel).length, 3, 'channel count');
});

test('getChannels synthesizes single channel from legacy shape', () => {
  const chans = getChannels(legacyModel);
  eq(chans.length, 1, 'should synthesize one channel');
  eq(chans[0].key, 'outbound');
  approx(chans[0].primary.value, 18000000);
  eq(chans[0].primary.uom, 'units');
  approx(chans[0].conversions.linesPerOrder, 2.5);
  approx(chans[0].conversions.unitsPerLine, 4);
});

test('getChannels handles missing model gracefully', () => {
  eq(getChannels(null).length, 0);
  eq(getChannels(undefined).length, 0);
  eq(getChannels({}).length, 1, 'empty model synthesizes default channel');
});

test('getChannel finds by key', () => {
  eq(getChannel(multiChannelModel, 'dtc').name, 'DTC e-com');
  eq(getChannel(multiChannelModel, 'nonexistent'), null);
});

test('getPrimaryChannel skips reverse', () => {
  eq(getPrimaryChannel(multiChannelModel).key, 'dtc');
});

test('getOutboundChannels excludes returns activity', () => {
  const chans = getOutboundChannels(multiChannelModel);
  eq(chans.length, 2, 'should exclude reverse');
  eq(chans.map(c => c.key).join(','), 'dtc,b2b');
});

test('convertUom: 1 pallet = 480 units (12 × 40)', () => {
  approx(convertUom(1, 'pallets', 'units', dtcChannel.conversions), 480);
});

test('convertUom: 18M units = 1.5M cases', () => {
  approx(convertUom(18000000, 'units', 'cases', dtcChannel.conversions), 1500000);
});

test('convertUom: 18M units = 37,500 pallets', () => {
  approx(convertUom(18000000, 'units', 'pallets', dtcChannel.conversions), 37500);
});

test('convertUom: same UOM returns identity', () => {
  approx(convertUom(123, 'units', 'units', dtcChannel.conversions), 123);
});

test('convertUom: handles each → eaches synonym', () => {
  approx(convertUom(100, 'each', 'eaches', dtcChannel.conversions), 100);
});

test('getChannelPrimaryIn: DTC primary = 18M units', () => {
  approx(getChannelPrimaryIn(dtcChannel, 'units'), 18000000);
});

test('getChannelPrimaryIn: DTC in cases = 1.5M', () => {
  approx(getChannelPrimaryIn(dtcChannel, 'cases'), 1500000);
});

test('getChannelPrimaryIn: DTC in orders = 3M (units / 2 lines × 3 units = 6 units/order)', () => {
  // 18M / (2 × 3) = 3M orders
  approx(getChannelPrimaryIn(dtcChannel, 'orders'), 3000000);
});

test('getChannelDerived cases: pure-derived', () => {
  const r = getChannelDerived(multiChannelModel, dtcChannel, 'cases');
  approx(r.value, 1500000);
  eq(r.isOverride, false);
});

test('getChannelDerived pallets: 18M / 480 = 37,500', () => {
  const r = getChannelDerived(multiChannelModel, dtcChannel, 'pallets');
  approx(r.value, 37500);
});

test('getChannelDerived dailyAvg: 18M / 250 = 72,000', () => {
  const r = getChannelDerived(multiChannelModel, dtcChannel, 'dailyAvg');
  approx(r.value, 72000);
});

test('getChannelDerived peakDay: dailyAvg × surge 2.5 = 180,000', () => {
  const r = getChannelDerived(multiChannelModel, dtcChannel, 'peakDay');
  approx(r.value, 180000);
});

test('getChannelDerived returns: 18M × 18% = 3,240,000', () => {
  const r = getChannelDerived(multiChannelModel, dtcChannel, 'returns');
  approx(r.value, 3240000);
});

test('getChannelDerived inbound: 18M × 1.05 = 18,900,000', () => {
  const r = getChannelDerived(multiChannelModel, dtcChannel, 'inbound');
  approx(r.value, 18900000);
});

test('Override pinned value takes precedence + variance % computed', () => {
  const ch = { ...dtcChannel, overrides: [{ key: 'pallets', pinnedValue: 40000 }] };
  const r = getChannelDerived(multiChannelModel, ch, 'pallets');
  eq(r.value, 40000);
  eq(r.isOverride, true);
  approx(r.derivedValue, 37500);
  approx(r.variancePct, 6.667, 0.01); // (40000 - 37500) / 37500 * 100
});

test('Override with NaN/empty falls back to derived', () => {
  const ch = { ...dtcChannel, overrides: [{ key: 'pallets', pinnedValue: 'abc' }] };
  const r = getChannelDerived(multiChannelModel, ch, 'pallets');
  eq(r.isOverride, false);
  approx(r.value, 37500);
});

test('getAnnualVolume aggregates 18M + 7M = 25M units (excludes reverse)', () => {
  approx(getAnnualVolume(multiChannelModel, 'units'), 25000000);
});

test('getAnnualVolume in cases: DTC 1.5M + B2B 292K = 1.79M', () => {
  // DTC: 18M / 12 = 1.5M cases
  // B2B: 7M / 24 = 291,666.67 cases
  approx(getAnnualVolume(multiChannelModel, 'cases'), 1791666.67, 1);
});

test('getAggregateDerived returns sums across outbound only', () => {
  // DTC returns: 18M × 18% = 3,240,000
  // B2B returns: 7M × 2% = 140,000
  // Total = 3,380,000
  const v = getAggregateDerived(multiChannelModel, 'returns');
  approx(v, 3380000);
});

test('getTotalReturns sums returns across outbound channels in units', () => {
  approx(getTotalReturns(multiChannelModel, 'units'), 3380000);
});

test('getChannelMix computes pct correctly', () => {
  const mix = getChannelMix(multiChannelModel);
  eq(mix.length, 2, 'reverse excluded');
  approx(mix.find(m => m.channelKey === 'dtc').pct, 72); // 18/25 = 72%
  approx(mix.find(m => m.channelKey === 'b2b').pct, 28); // 7/25 = 28%
});

test('uomMultiplier returns NaN for unknown UOM', () => {
  if (!Number.isNaN(_internals.uomMultiplier('units', 'gizmos', null))) {
    throw new Error('expected NaN for unknown toUom');
  }
});

test('synthesizeChannelFromLegacy with no rows yields zero-volume channel', () => {
  const ch = _internals.synthesizeChannelFromLegacy({});
  eq(ch.primary.value, 0);
  eq(ch.primary.uom, 'units');
});

test('Legacy model accessor returns 18M units via synthesis', () => {
  approx(getAnnualVolume(legacyModel, 'units'), 18000000);
});

test('Legacy model: orderProfile fields populate conversions', () => {
  const chans = getChannels(legacyModel);
  approx(chans[0].conversions.linesPerOrder, 2.5);
  approx(chans[0].conversions.unitsPerLine, 4);
  approx(chans[0].conversions.weightPerUnit, 0.9);
});

test('normalizeUom handles common synonyms', () => {
  eq(_internals.normalizeUom('Each'), 'units');
  eq(_internals.normalizeUom('eaches'), 'units');
  eq(_internals.normalizeUom('Case'), 'cases');
  eq(_internals.normalizeUom('Pallet'), 'pallets');
  eq(_internals.normalizeUom(''), 'units');
});

// ── Output ───────────────────────────────────────────────────────


// ── backfillChannelsFromLegacy tests ─────────────────────────────

test('backfill: legacy model gains channels[] of length 1', () => {
  const m = {
    volumeLines: [
      { name: 'Pallets In', volume: 10000, uom: 'pallet' },
      { name: 'Orders Shipped', volume: 50000, uom: 'orders', isOutboundPrimary: true },
    ],
    orderProfile: { linesPerOrder: 3, unitsPerLine: 4 },
  };
  const did = backfillChannelsFromLegacy(m);
  if (!did) throw new Error('expected migration to run');
  eq(m.channels.length, 1);
  eq(m.channels[0].key, 'outbound');
  approx(m.channels[0].primary.value, 50000);
  eq(m.channels[0].primary.uom, 'orders');
  approx(m.channels[0].conversions.linesPerOrder, 3);
  approx(m.channels[0].conversions.unitsPerLine, 4);
  eq(m.channelMix.mode, 'byVolume');
});

test('backfill: idempotent — does not mutate when channels[] already populated', () => {
  const m = { channels: [{ key: 'pre-existing', primary: { value: 1, uom: 'units' } }] };
  const did = backfillChannelsFromLegacy(m);
  if (did) throw new Error('expected NOT to migrate');
  eq(m.channels.length, 1);
  eq(m.channels[0].key, 'pre-existing');
});

test('backfill: empty model produces zero-volume channel', () => {
  const m = {};
  backfillChannelsFromLegacy(m);
  eq(m.channels.length, 1);
  eq(m.channels[0].primary.value, 0);
});

test('backfill: preserves seasonality when present', () => {
  const m = {
    volumeLines: [{ volume: 1000, uom: 'units', isOutboundPrimary: true }],
    seasonalityProfile: { preset: 'ecom_holiday_peak', monthly_shares: [5,5,6,6,7,7,7,8,9,11,14,15] },
  };
  backfillChannelsFromLegacy(m);
  eq(m.channels[0].seasonality.preset, 'ecom_holiday_peak');
  approx(m.channels[0].seasonality.monthly_shares[10], 14);
});

test('backfill: defaults seasonality to flat when missing or malformed', () => {
  const m = { volumeLines: [{ volume: 1000, uom: 'units', isOutboundPrimary: true }] };
  backfillChannelsFromLegacy(m);
  eq(m.channels[0].seasonality.preset, 'flat');
  eq(m.channels[0].seasonality.monthly_shares.length, 12);
});

test('backfill: legacy fields preserved on model (Phase 1 backward compat)', () => {
  const m = {
    volumeLines: [{ volume: 1000, uom: 'units', isOutboundPrimary: true }],
    orderProfile: { linesPerOrder: 2 },
  };
  backfillChannelsFromLegacy(m);
  // Phase 1 keeps legacy fields so unmigrated calc consumers still work.
  if (!Array.isArray(m.volumeLines)) throw new Error('volumeLines should remain on model');
  if (!m.orderProfile) throw new Error('orderProfile should remain on model');
});

test('backfill + getAnnualVolume agree on total', () => {
  const m = {
    volumeLines: [{ volume: 100000, uom: 'orders', isOutboundPrimary: true }],
    orderProfile: { linesPerOrder: 2, unitsPerLine: 5 },
  };
  backfillChannelsFromLegacy(m);
  // 100k orders × (2 lines × 5 units) = 1M units
  approx(getAnnualVolume(m, 'units'), 1000000);
});

// ────────────────────────────────────────────────────────────────
// Phase 3 multi-channel calc-consumer integration tests.
// These exercise the migrated calc paths (computeBucketRates,
// autoGenerateIndirectLabor as autoGenerateIndirect, autoGenerateEquipment, autoGenerateOverhead,
// autoGenerateStartup, generateHeuristics as getDesignHeuristics, deriveShiftHeadcount) with
// a 2-channel model and confirm the outputs fold across channels.
// ────────────────────────────────────────────────────────────────

import {
  computeBucketRates,
  autoGenerateIndirectLabor as autoGenerateIndirect,
  autoGenerateEquipment,
  autoGenerateOverhead,
  autoGenerateStartup,
  generateHeuristics as getDesignHeuristics,
} from './tools/cost-model/calc.js';
import { deriveShiftHeadcount, createEmptyShiftAllocation } from './tools/cost-model/shift-planner.js';
import { getAggregateInbound } from './tools/cost-model/calc.channels.js';

function twoChannelModel() {
  return {
    facility: { totalSqft: 200000, opDaysPerYear: 250 },
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    channels: [
      {
        key: 'dtc', name: 'DTC e-com', sortOrder: 10,
        primary: { value: 1000000, uom: 'orders', activity: 'outbound', source: 'manual' },
        conversions: { unitsPerCase: 12, casesPerPallet: 40, linesPerOrder: 2, unitsPerLine: 5 },
        assumptions: { returnsPercent: 15, inboundOutboundRatio: 1.0, peakSurgeFactor: 2.0 },
        seasonality: { preset: 'flat', monthly_shares: Array.from({length:12},()=>1/12) },
        overrides: [],
      },
      {
        key: 'b2b', name: 'B2B retail', sortOrder: 20,
        primary: { value: 50000, uom: 'pallets', activity: 'outbound', source: 'manual' },
        conversions: { unitsPerCase: 24, casesPerPallet: 50, linesPerOrder: 5, unitsPerLine: 10 },
        assumptions: { returnsPercent: 1, inboundOutboundRatio: 1.0, peakSurgeFactor: 1.2 },
        seasonality: { preset: 'flat', monthly_shares: Array.from({length:12},()=>1/12) },
        overrides: [],
      },
    ],
    volumeLines: [],   // Phase 3: channels[] is the source of truth
    orderProfile: {},
    seasonalityProfile: { preset: 'flat', monthly_shares: Array.from({length:12},()=>1/12) },
    pricingBuckets: [
      { id: 'mgmt', name: 'Mgmt Fee', type: 'fixed', uom: 'month' },
      { id: 'inbound', name: 'Inbound', type: 'variable', uom: 'pallet' },
      { id: 'orders', name: 'Order Handling', type: 'variable', uom: 'order' },
    ],
    laborLines: [],
    indirectLaborLines: [],
    equipmentLines: [],
    overheadLines: [],
    vasLines: [],
    startupLines: [],
    financial: { contractTermYears: 5 },
  };
}

test('Phase 3 — computeBucketRates: order bucket folds DTC + B2B orders', () => {
  const m = twoChannelModel();
  // DTC: 1,000,000 orders. B2B: 50,000 pallets × (24 units/case × 50 cases/pallet) = 60M units;
  // 60M units / (5 lines × 10 units/line) = 1,200,000 orders. Total expected ≈ 2,200,000.
  const out = computeBucketRates({
    buckets: m.pricingBuckets,
    bucketCosts: { mgmt: 120000, inbound: 500000, orders: 5000000 },
    marginPct: 0.16,
    model: m,
  });
  // Order bucket annualVolume should reflect the cross-channel order total.
  approx(out.orders.annualVolume, 2200000, 200);
});

test('Phase 3 — computeBucketRates: pallet bucket folds DTC + B2B pallets', () => {
  const m = twoChannelModel();
  // DTC pallets: 1M orders × (2 lines × 5 units) / (12 × 40) = 10M units / 480 ≈ 20,833 pallets.
  // B2B pallets: 50,000 (already in pallets).
  const out = computeBucketRates({
    buckets: m.pricingBuckets,
    bucketCosts: { mgmt: 120000, inbound: 500000, orders: 5000000 },
    marginPct: 0.16,
    model: m,
  });
  approx(out.inbound.annualVolume, 70833, 200);
});

test('Phase 3 — autoGenerateIndirect: CS rep sized off cross-channel orders', () => {
  const m = twoChannelModel();
  const ind = autoGenerateIndirect(m);
  // 2.2M orders / 500k = 4.4 → ceil = 5 CS reps.
  const cs = ind.find(l => /customer service/i.test(l.role_name || ''));
  if (!cs) throw new Error('CS rep not generated');
  eq(cs.headcount, 5);
});

test('Phase 3 — autoGenerateIndirect: Returns processor uses per-channel returnsPercent', () => {
  const m = twoChannelModel();
  // DTC returns: 1M orders × (2 × 5 units) = 10M units × 15% = 1.5M units.
  // B2B returns: 50k pallets × (24 × 50 units) = 60M units × 1% = 600k units.
  // Total returns: 2.1M units. /100k = 21 processors.
  const ind = autoGenerateIndirect(m);
  const rp = ind.find(l => /returns processor/i.test(l.role_name || ''));
  if (!rp) throw new Error('Returns processor not generated');
  // Should be far more than the legacy flat-5% would have given.
  if (rp.headcount < 15) throw new Error(`Expected channel-aware headcount > 15, got ${rp.headcount}`);
});

test('Phase 3 — autoGenerateEquipment: pallets-in folds inbound across channels', () => {
  const m = twoChannelModel();
  const aggregate = getAggregateInbound(m, 'pallets');
  // Inbound = primary × inboundOutboundRatio (1.0) → equals outbound pallets across channels ≈ 70,833.
  approx(aggregate, 70833, 200);
});

test('Phase 3 — autoGenerateOverhead: per-unit scalers fold cross-channel units', () => {
  const m = twoChannelModel();
  const oh = autoGenerateOverhead(m);
  const supplies = oh.find(l => /supplies/i.test(l.category || l.description || ''));
  if (!supplies) throw new Error('Supplies & Consumables not generated');
  // DTC: 10M units × 0.15 = 1.5M. B2B: 60M units × 0.15 = 9M. Total ≈ 10.5M.
  if ((supplies.annual_cost || 0) < 9000000) {
    throw new Error(`Expected supplies annual_cost > 9M, got ${supplies.annual_cost}`);
  }
});

test('Phase 3 — autoGenerateStartup: racking sized off cross-channel inbound pallets', () => {
  const m = twoChannelModel();
  const su = autoGenerateStartup(m);
  const racking = su.find(l => /racking/i.test(l.description || ''));
  if (!racking) throw new Error('Racking startup line not generated');
  // 70,833 pallets / 12 turns × 1.15 spare ≈ 6,789 positions × $85 ≈ $577k.
  if ((racking.one_time_cost || 0) < 400000) {
    throw new Error(`Expected racking cost > $400k, got ${racking.one_time_cost}`);
  }
});

test('Phase 3 — getDesignHeuristics: throughput density uses cross-channel orders', () => {
  const m = twoChannelModel();
  const dummySummary = { laborCost: 1000000, totalCost: 5000000, facilityCost: 1000000 };
  const checks = getDesignHeuristics(m, dummySummary);
  // 1.012M orders / 200k sqft = 5.06 orders/sqft → "in range" not "low density".
  const dens = checks.find(c => /throughput density|orders\/sqft/i.test(c.title || ''));
  // Either no warning fires (density healthy) or it fires as info — but should not be the low-density variant.
  if (dens && /low throughput/i.test(dens.title)) {
    throw new Error(`Expected mid/high density, got: ${dens.title}`);
  }
});

test('Phase 3 — deriveShiftHeadcount: channel-aware path handles multi-channel volumes', () => {
  const m = twoChannelModel();
  m.laborLines = [
    { id: 'pick1', labor_category: 'direct', function: 'picking', base_uph: 100, headcount: 10, annual_hours: 20000, hourly_rate: 20, burden_pct: 30 },
    { id: 'pack1', labor_category: 'direct', function: 'pack',    base_uph: 200, headcount:  5, annual_hours: 10000, hourly_rate: 20, burden_pct: 30 },
    { id: 'in1',   labor_category: 'direct', function: 'inbound', base_uph: 30,  headcount:  4, annual_hours:  8000, hourly_rate: 20, burden_pct: 30 },
  ];
  const alloc = createEmptyShiftAllocation(1, 8);
  // Set picking/pack/ship/inbound/returns matrix to 100% on shift 1.
  for (const fn of ['picking','pack','ship','inbound','returns','putaway','replenish','vas']) {
    if (Array.isArray(alloc.matrix[fn])) alloc.matrix[fn][0] = 100;
  }
  const result = deriveShiftHeadcount(alloc, [], m.laborLines, m.shifts, { model: m });
  // With model passed, both channels' primaries should drive picking/pack/ship.
  // DTC: 10M units/year, B2B: 60M units/year → 70M total / (5×52 = 260 op-days) ≈ 269k/day picking.
  const pickRow = result.byFunctionShift.find(r => r.fn === 'picking' && r.shift === 1);
  if (!pickRow) throw new Error('picking row missing');
  approx(pickRow.volume, 269230, 500);
});

test('Phase 3 — deriveShiftHeadcount: legacy path still works when model is omitted', () => {
  // Single-channel legacy fixture — make sure the keyword-matched fallback
  // hasn't regressed.
  const volumeLines = [
    { name: 'Daily Picks', volume: 250000, uom: 'orders', isOutboundPrimary: true },
  ];
  const labor = [
    { id: 'p', labor_category: 'direct', function: 'picking', base_uph: 100, headcount: 10, annual_hours: 20000 },
  ];
  const alloc = createEmptyShiftAllocation(1, 8);
  for (const fn of ['picking','pack','ship']) {
    if (Array.isArray(alloc.matrix[fn])) alloc.matrix[fn][0] = 100;
  }
  const result = deriveShiftHeadcount(alloc, volumeLines, labor, { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 });
  const row = result.byFunctionShift.find(r => r.fn === 'picking' && r.shift === 1);
  if (!row) throw new Error('legacy picking row missing');
  // 250k orders / (5×52 = 260 days) ≈ 962/day.
  approx(row.volume, 962, 5);
});

console.log(`\n\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
