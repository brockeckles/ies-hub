// test-wsc-sizing.mjs — regression tests for I-06 (WSC honor explicit dock config + pallet override)
import { sizeFacility, calcDIOH, orientFacility, elevationParams, crossAisleDefaults, crossAisleLayoutFt, rackPairCapacity, rollupRenderedFacts, allocateRackColsByTarget, suggestedBuildingDimensions, PALLET_BAY_WIDTH_FT, SHELVING_BAY_WIDTH_FT } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Test: explicit door overrides bypass throughput derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    inPalletsDay: 50,       // would derive to 2 (the minimum) from throughput
    outPalletsDay: 50,
    inboundDoorsOverride: 28,
    outboundDoorsOverride: 28,
  });
  t('explicit inbound honored', r.dock.inboundDoors === 28);
  t('explicit outbound honored', r.dock.outboundDoors === 28);
  t('explicit total has no surge buffer', r.dock.totalDoors === 56);
  t('explicit provenance flag set', r.dock.inboundDoorsExplicit === true && r.dock.outboundDoorsExplicit === true);
  t('derived value still reported', r.dock.inboundDoorsDerived === 2);
}

// ── Test: missing overrides fall back to throughput derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    inPalletsDay: 1200,     // 1200 / (20 × 8) = 7.5 → 8
    outPalletsDay: 1200,
    palletsPerDoorHour: 20,
    dockHours: 8,
  });
  t('derived inbound from throughput', r.dock.inboundDoors === 8);
  t('derived outbound from throughput', r.dock.outboundDoors === 8);
  t('derived total includes 25% surge', r.dock.totalDoors === 20);
  t('derived provenance flag false', r.dock.inboundDoorsExplicit === false);
}

// ── Test: partial override (inbound only) ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    inPalletsDay: 200,
    outPalletsDay: 200,
    inboundDoorsOverride: 15,
    // outboundDoorsOverride intentionally omitted
  });
  t('partial inbound override honored', r.dock.inboundDoors === 15);
  t('partial outbound still derived', r.dock.outboundDoors === 2); // 200/160 → ceil = 2
  t('partial skips surge buffer', r.dock.totalDoors === 17);       // no surge
  t('partial inbound explicit flag true', r.dock.inboundDoorsExplicit === true);
  t('partial outbound explicit flag false', r.dock.outboundDoorsExplicit === false);
}

// ── Test: totalPalletsOverride bypasses units→pallets derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,       // would derive ~6250 full-pallet positions
    totalPalletsOverride: 80000,
  });
  // 80000 × 1.1 (honeycomb) = 88000 gross pallet positions
  t('totalPalletsOverride > 0 used as positions', r.positions.grossPositions > 80000);
  t('totalPalletsOverride drives large storage SF', r.storageSqft > 500000);
}

// ── Test: zero override falls back to units derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    totalPalletsOverride: 0,
  });
  // 500000 × 0.60 / 48 = 6250 full-pallet positions + some cartons
  t('zero pallet override falls back to unit derivation', r.positions.grossPositions < 20000);
}

// ── Test: high-throughput Wayfair-like case (regression for I-06 under-sizing) ──
{
  const r = sizeFacility({
    peakUnits: 1000000,
    totalPalletsOverride: 80000,     // engineered pallet count
    inboundDoorsOverride: 28,
    outboundDoorsOverride: 28,
    dockConfig: 'two',
    clearHeightFt: 36,
  });
  // Should produce a warehouse closer to 700K SF, NOT 91K SF
  t('Wayfair-like sizes to 400K+ SF (not 91K)', r.totalSqft > 400000, `got ${r.totalSqft}`);
  t('Wayfair-like honors 56 explicit doors', r.dock.totalDoors === 56);
}

// ── DIOH formula: on-hand ÷ daily outbound, not FP-days-of-cover multiplied in ──
{
  // Typical 3PL: 350K units on-hand, 5K/day outbound = 70 days.
  const dioh = calcDIOH({
    avgUnits: 350000,
    outboundUnitsPerDay: 5000,
  });
  t('DIOH direct: 350K on-hand / 5K daily = 70 days', Math.round(dioh) === 70, `got ${dioh}`);
}
{
  // Derive daily from annual + operating days.
  const dioh = calcDIOH({
    avgUnits: 500000,
    outboundUnitsYr: 2_000_000,
    operatingDaysPerYear: 250,
  });
  // daily = 2M / 250 = 8000; DIOH = 500K / 8K = 62.5
  t('DIOH derived-daily: 500K / (2M/250) = 62.5', Math.abs(dioh - 62.5) < 0.1, `got ${dioh}`);
}
{
  // Legacy zones (avgUnitsPerDay as on-hand proxy, forwardPick.outboundUnitsPerDay):
  // prior bug returned (avg × daysInventory) / outbound = (350K × 3) / 5K = 210
  const dioh = calcDIOH({
    avgUnitsPerDay: 350000,
    forwardPick: { daysInventory: 3, outboundUnitsPerDay: 5000 },
  });
  t('DIOH legacy shape: avgUnitsPerDay/(FP outbound) = 70 (not 210)', Math.round(dioh) === 70, `got ${dioh}`);
}
{
  // Missing inputs return 0 rather than NaN or Infinity.
  t('DIOH empty input = 0', calcDIOH({}) === 0);
  t('DIOH no daily = 0', calcDIOH({ avgUnits: 100000 }) === 0);
  t('DIOH no on-hand = 0', calcDIOH({ outboundUnitsPerDay: 5000 }) === 0);
}
{
  // Realistic Wayfair-like: 1.5M on-hand, 15K daily = 100 days (typical DTC ecomm)
  const dioh = calcDIOH({
    avgUnits: 1_500_000,
    outboundUnitsPerDay: 15_000,
  });
  t('DIOH DTC ecomm: 1.5M / 15K = 100 days', Math.round(dioh) === 100, `got ${dioh}`);
}


// ============================================================
// WSC-A2 / A3 / B2 (2026-04-25) — building dimensions drive storage geometry
// ============================================================
import { computeStorage } from './tools/warehouse-sizing/calc.js';

{
  // Heuristic fallback: no buildingWidth/Depth → flagged heuristic
  const r = computeStorage(
    { totalSqft: 500000, clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A2 heuristic flag set when no dims', r.geometryIsHeuristic === true);
  t('A2 heuristic still produces positions', r.totalPalletPositions > 0);
}
{
  // With dims: HEURISTIC flag clears, dims drive geometry
  const r = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A2 measured flag when dims set', r.geometryIsHeuristic === false);
  t('A2 storage SF reflects dims × dims − non-storage',
    r.storageSqft === 800 * 625 - 25000,
    `expected ${800*625 - 25000} got ${r.storageSqft}`);
}
{
  // Aisle width drives module count: 6 ft VNA gives more positions than 12 ft wide
  const wide = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 12,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  const vna = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 6,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('B2 VNA produces > wide aisles',
    vna.aisleCount > wide.aisleCount,
    `wide=${wide.aisleCount} vna=${vna.aisleCount}`);
  t('B2 VNA produces > wide positions',
    vna.totalPalletPositions > wide.totalPalletPositions);
}
{
  // Double-deep produces ~2x positions of single in same footprint
  const single = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  const dbl = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'double', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A3 double > single positions in same footprint',
    dbl.totalPalletPositions > single.totalPalletPositions,
    `single=${single.totalPalletPositions} double=${dbl.totalPalletPositions}`);
}
{
  // Rack levels canonical formula: 36 ft clear + 48" load + 18" sprinkler →
  // floor((36*12 - 18) / (48+10)) = floor(414/58) = 7, capped at 7
  const r = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A3 canonical levels match v2 formula', r.rackLevels === 7,
    `got ${r.rackLevels}`);
}
{
  // Lower clear height → fewer levels, bounded ≥ 2
  const low = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 16, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A3 low clear height → bounded levels',
    low.rackLevels >= 2 && low.rackLevels <= 7,
    `got ${low.rackLevels}`);
}



// ── Phase 4 Layer B (volumes-as-nucleus, 2026-04-29) — calcStorageByType
//    aggregates per-channel positions when channelMixes present ──
import { calcStorageByType } from './tools/warehouse-sizing/calc.js';

{
  // Single-mix legacy path (no channelMixes) preserves backwards-compat shape.
  const r = calcStorageByType(
    { clearHeight: 32 },
    {
      peakUnitsPerDay: 100000,
      storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
      productDimensions: { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 },
    }
  );
  t('Phase 4B legacy path returns positions', r.totalPositions > 0);
  t('Phase 4B legacy path has no byChannel field', r.byChannel === undefined);
}

{
  // Per-channel path: 2 channels with different storageAllocations.
  const r = calcStorageByType(
    { clearHeight: 32 },
    {
      peakUnitsPerDay: 100000,
      storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
      productDimensions: { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 },
      channelMixes: [
        { channelKey: 'dtc',  name: 'DTC',  peakUnitsPerDay: 30000, storageAllocation: { fullPallet: 10, cartonOnPallet: 30, cartonOnShelving: 60 } },
        { channelKey: 'b2b',  name: 'B2B',  peakUnitsPerDay: 70000, storageAllocation: { fullPallet: 90, cartonOnPallet:  8, cartonOnShelving:  2 } },
      ],
    }
  );
  t('Phase 4B per-channel returns byChannel array', Array.isArray(r.byChannel) && r.byChannel.length === 2);
  t('Phase 4B per-channel preserves channelKey ordering',
    r.byChannel[0].channelKey === 'dtc' && r.byChannel[1].channelKey === 'b2b');
  // DTC: 30k * 60% / (6 * 4) shelving locations = 750. B2B: 70k * 2% / (6 * 4) = 59 → ceil = 59.
  t('Phase 4B DTC channel uses 60% shelving (high carton-shelving)', r.byChannel[0].cartonOnShelvingLocations >= r.byChannel[1].cartonOnShelvingLocations * 5,
    `DTC=${r.byChannel[0].cartonOnShelvingLocations} B2B=${r.byChannel[1].cartonOnShelvingLocations}`);
  // B2B: 70k * 90% / 48 = 1313 full pallet. DTC: 30k * 10% / 48 = 63.
  t('Phase 4B B2B channel uses 90% full-pallet (high pallet count)', r.byChannel[1].fullPalletPositions > r.byChannel[0].fullPalletPositions * 5,
    `DTC=${r.byChannel[0].fullPalletPositions} B2B=${r.byChannel[1].fullPalletPositions}`);
  // Total positions sums per-channel.
  const sum = r.byChannel.reduce((s,c)=>s + c.fullPalletPositions + c.cartonOnPalletPositions + c.cartonOnShelvingLocations, 0);
  t('Phase 4B totalPositions equals byChannel sum', r.totalPositions === sum, `total=${r.totalPositions} sum=${sum}`);
}

{
  // Channel without storageAllocation override inherits the facility-level mix.
  const r = calcStorageByType(
    { clearHeight: 32 },
    {
      peakUnitsPerDay: 60000,
      storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
      productDimensions: { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 },
      channelMixes: [
        { channelKey: 'inherit',  name: 'Inheriting',  peakUnitsPerDay: 60000 },  // no storageAllocation
      ],
    }
  );
  // Inheriting path = same as facility mix = 60/30/10.
  // 60k × 60% = 36000 / 48 = 750 full pallet.
  t('Phase 4B channel without override matches facility-allocated full-pallet', r.byChannel[0].fullPalletPositions === 750,
    `got ${r.byChannel[0].fullPalletPositions}`);
}

// ── Phase 4 — buildWscLaunchPayload emits channelMixes ──
import { buildWscLaunchPayload } from './tools/cost-model/api.js';

{
  const m = {
    facility: { totalSqft: 200000, opDaysPerYear: 250, clearHeight: 32 },
    channels: [
      { key: 'dtc', name: 'DTC',
        primary: { value: 1000000, uom: 'orders', activity: 'outbound' },
        conversions: { unitsPerCase: 12, casesPerPallet: 40, linesPerOrder: 2, unitsPerLine: 5 },
        assumptions: { returnsPercent: 15, inboundOutboundRatio: 1.0, peakSurgeFactor: 2.0 },
        seasonality: { preset: 'flat', monthly_shares: Array.from({length:12},()=>1/12) },
      },
      { key: 'b2b', name: 'B2B',
        primary: { value: 50000, uom: 'pallets', activity: 'outbound' },
        conversions: { unitsPerCase: 24, casesPerPallet: 50, linesPerOrder: 5, unitsPerLine: 10 },
        assumptions: { returnsPercent: 1, inboundOutboundRatio: 1.0, peakSurgeFactor: 1.2 },
        seasonality: { preset: 'flat', monthly_shares: Array.from({length:12},()=>1/12) },
        storageAllocation: { fullPallet: 90, cartonOnPallet: 8, cartonOnShelving: 2 },
      },
    ],
  };
  const p = buildWscLaunchPayload(m);
  t('Phase 4B payload carries channelMixes', Array.isArray(p.channelMixes) && p.channelMixes.length === 2,
    `len=${(p.channelMixes||[]).length}`);
  t('Phase 4B B2B mix keeps storageAllocation override', !!p.channelMixes[1].storageAllocation && p.channelMixes[1].storageAllocation.fullPallet === 90);
  t('Phase 4B DTC mix has no storageAllocation override', !p.channelMixes[0].storageAllocation);
}

// ── Phase 4 — assignDemand resolves per-demand modeMix from channelMixMap ──
import { assignDemand } from './tools/network-opt/calc.js';

{
  const facilities = [{ id: 'F1', lat: 40, lng: -75, isOpen: true, capacity: 0 }];
  const demands = [
    { id: 'D1', lat: 40.5, lng: -75.5, annualDemand: 10000, channelKey: 'dtc' },
    { id: 'D2', lat: 41.0, lng: -76.0, annualDemand: 20000, channelKey: 'b2b' },
    { id: 'D3', lat: 39.5, lng: -75.0, annualDemand: 5000 },  // no channelKey
  ];
  const projectMix = { tlPct: 30, ltlPct: 40, parcelPct: 30 };
  const channelMixMap = {
    dtc: { tlPct: 0,   ltlPct: 0,   parcelPct: 100 },
    b2b: { tlPct: 70,  ltlPct: 30,  parcelPct: 0 },
  };
  const baselineLanes = assignDemand(facilities, demands, projectMix);
  const channelLanes = assignDemand(facilities, demands, projectMix, undefined, undefined, { channelMixMap });
  // Both should produce 3 lanes.
  t('Phase 4 assignDemand legacy path returns 3 lanes', baselineLanes.length === 3);
  t('Phase 4 assignDemand channel-aware path returns 3 lanes', channelLanes.length === 3);
  // Same demand set + facility — lane structure shouldn't change. Per-lane costs SHOULD change since the mix shifts.
  // Easiest invariant: total transport cost typically differs across the two paths because each demand uses a different mix.
  const baselineTotal = baselineLanes.reduce((s, l) => s + (l.blendedCost || 0), 0);
  const channelTotal  = channelLanes.reduce((s, l) => s + (l.blendedCost || 0), 0);
  t('Phase 4 channel-aware total cost diverges from baseline (mix override applied)',
    Math.abs(baselineTotal - channelTotal) > 1,
    `baseline=$${baselineTotal.toFixed(0)} channel=$${channelTotal.toFixed(0)}`);
  // Demand without channelKey falls back to project mix in both paths — the
  // per-lane transport cost on D3 should match between baseline and channel.
  const baselineD3 = baselineLanes.find(l => l.demandId === 'D3');
  const channelD3  = channelLanes.find(l => l.demandId === 'D3');
  if (baselineD3 && channelD3) {
    t('Phase 4 unmapped demand falls back to project mix',
      Math.abs((baselineD3.blendedCost || 0) - (channelD3.blendedCost || 0)) < 0.01);
  }
}

// ──────────────────────────────────────────────────────────────────
// WSC-O1 (2026-05-04) — orientFacility() canonical dock-on-long-edge
// ──────────────────────────────────────────────────────────────────
{
  // Landscape user input — long stays long, short stays short.
  const a = orientFacility({ buildingWidth: 1000, buildingDepth: 750 });
  t('O1 landscape: longFt = 1000', a.longFt === 1000);
  t('O1 landscape: shortFt = 750', a.shortFt === 750);
  t('O1 landscape: derived = false', a.derived === false);

  // Portrait user input — engine swaps so longFt is always >= shortFt.
  const b = orientFacility({ buildingWidth: 500, buildingDepth: 1000 });
  t('O1 portrait: longFt = 1000 (swap)', b.longFt === 1000);
  t('O1 portrait: shortFt = 500 (swap)', b.shortFt === 500);
  t('O1 portrait: derived = false', b.derived === false);

  // Single-dim or no-dim: derive 1.5:1 landscape from totalSqft.
  const c = orientFacility({ totalSqft: 750000 });
  t('O1 totalSqft fallback: long >= short', c.longFt >= c.shortFt);
  t('O1 totalSqft fallback: derived = true', c.derived === true);
  // 1.5:1 landscape: long ≈ sqrt(750000 * 1.5) ≈ 1061, short ≈ 750000/1061 ≈ 707
  t('O1 totalSqft fallback: long ~ sqrt(SF * 1.5)', Math.abs(c.longFt - 1061) <= 1);

  // Empty input: returns zeros.
  const d = orientFacility({});
  t('O1 empty input: longFt = 0', d.longFt === 0);
  t('O1 empty input: shortFt = 0', d.shortFt === 0);

  // Symmetry — should not depend on which axis the user labelled "width" vs "depth".
  const e = orientFacility({ buildingWidth: 800, buildingDepth: 1200 });
  const f = orientFacility({ buildingWidth: 1200, buildingDepth: 800 });
  t('O1 swap symmetry: longFt matches', e.longFt === f.longFt && e.longFt === 1200);
  t('O1 swap symmetry: shortFt matches', e.shortFt === f.shortFt && e.shortFt === 800);

  // elevationParams now exposes longFt / shortFt and uses longFt as the section dim.
  const ep1 = elevationParams({ buildingWidth: 500, buildingDepth: 1000, clearHeight: 36, palletHeight: 54, beamHeight: 5, flueSpace: 3, topClearance: 36 });
  t('O1 elev portrait: buildingWidth = longFt = 1000', ep1.buildingWidth === 1000);
  t('O1 elev portrait: longFt = 1000', ep1.longFt === 1000);
  t('O1 elev portrait: shortFt = 500', ep1.shortFt === 500);

  const ep2 = elevationParams({ buildingWidth: 1000, buildingDepth: 750, clearHeight: 36 });
  t('O1 elev landscape: buildingWidth = longFt = 1000', ep2.buildingWidth === 1000);
  t('O1 elev landscape: shortFt = 750', ep2.shortFt === 750);
}

// ──────────────────────────────────────────────────────────────────
// WSC-X1 (2026-05-04) — cross-aisle layout (engine governs all surfaces)
// ──────────────────────────────────────────────────────────────────
{
  // crossAisleDefaults — sprinkler-aware spacing
  const dESFR = crossAisleDefaults({ sprinklerType: 'ESFR' });
  t('X1 ESFR target spacing 250 ft', dESFR.targetSpacingFt === 250);
  const dStd = crossAisleDefaults({ sprinklerType: 'standard' });
  t('X1 standard sprinkler 200 ft', dStd.targetSpacingFt === 200);
  const dNone = crossAisleDefaults({ sprinklerType: 'none' });
  t('X1 unsprinklered 150 ft', dNone.targetSpacingFt === 150);

  // crossAisleDefaults — truck-class-aware clear width
  const tCB = crossAisleDefaults({ truckClass: 'counterbalance' });
  t('X1 counterbalance 12 ft clear', tCB.clearFt === 12);
  const tReach = crossAisleDefaults({ truckClass: 'reach' });
  t('X1 reach truck 10 ft clear', tReach.clearFt === 10);
  const tTurret = crossAisleDefaults({ truckClass: 'turret' });
  t('X1 turret 8 ft clear', tTurret.clearFt === 8);

  // Default (no opts) = ESFR + counterbalance
  const dDef = crossAisleDefaults();
  t('X1 defaults: ESFR 250 ft', dDef.targetSpacingFt === 250);
  t('X1 defaults: counterbalance 12 ft', dDef.clearFt === 12);

  // Short rack run — no cross-aisle needed
  const short = crossAisleLayoutFt(150);
  t('X1 short run: 1 segment', short.segmentCount === 1);
  t('X1 short run: 0 cross-aisles', short.totalCrossAisleFt === 0);
  t('X1 short run: full length preserved', short.segmentLenFt === 150);

  // Long rack run — splits into segments
  const long500 = crossAisleLayoutFt(500); // ESFR 250+12 → 1 split needed (262 < 500)
  t('X1 500 ft run splits', long500.segmentCount >= 2);
  // segments * segmentLen + (segments-1) * clearFt should equal input
  const reconstructed = long500.segmentCount * long500.segmentLenFt + (long500.segmentCount - 1) * long500.crossAisleClearFt;
  t('X1 segment math reconciles to input', Math.abs(reconstructed - 500) < 0.01);

  // Specific case: 1000 ft long rack run on ESFR + counterbalance
  // 250+12 = 262 fits ~3 times into 1000 → 4 segments with 3 cross-aisles
  const long1000 = crossAisleLayoutFt(1000);
  t('X1 1000 ft ESFR+cb: 4 segments', long1000.segmentCount === 4);
  t('X1 1000 ft: 3 cross-aisles', long1000.segmentCount - 1 === 3);
  t('X1 1000 ft: 36 ft total cross-aisle', long1000.totalCrossAisleFt === 36);

  // Run = exactly target+clear → still 1 segment (boundary)
  const boundary = crossAisleLayoutFt(262); // ESFR target 250 + 12 clear
  t('X1 boundary 262 ft: 1 segment (no split needed)', boundary.segmentCount === 1);

  // Negative / zero / NaN inputs return safe values
  const zero = crossAisleLayoutFt(0);
  t('X1 zero input: 1 segment, 0 length', zero.segmentCount === 1 && zero.segmentLenFt === 0);
  const neg = crossAisleLayoutFt(-100);
  t('X1 negative input clamped to 0', neg.segmentLenFt === 0);
  const nanL = crossAisleLayoutFt(NaN);
  t('X1 NaN input clamped to 0', nanL.segmentLenFt === 0);

  // Mixed opts: standard sprinkler + reach truck
  const std = crossAisleLayoutFt(600, { sprinklerType: 'standard', truckClass: 'reach' });
  // 200+10=210 fits 2 times into 600 → 3 segments with 2 cross-aisles
  t('X1 600 ft std+reach: 3 segments', std.segmentCount === 3);
  t('X1 600 ft std+reach: 10 ft clear', std.crossAisleClearFt === 10);
}

// ── P0-2: rackPairCapacity ──
{
  // Standard 200 ft segment, 5 levels, default 4.33 ft pallet bay.
  // baysPerFace = floor(200/4.33) = 46; baysTotal = 92; positions = 92*5 = 460
  const cap1 = rackPairCapacity({ segmentLenFt: 200, levels: 5 });
  t('P0-2 200ft x 5lvl: 46 bays per face', cap1.baysPerFace === 46);
  t('P0-2 200ft x 5lvl: 92 bays total (2 faces)', cap1.baysTotal === 92);
  t('P0-2 200ft x 5lvl: 460 positions', cap1.positions === 460);

  // Shelving — 200 ft segment, 5 levels, 3 ft bay
  const capS = rackPairCapacity({ segmentLenFt: 200, levels: 5, bayWidthFt: 3 });
  t('P0-2 200ft x 5lvl x 3ft bay: 66 bays per face', capS.baysPerFace === 66);
  t('P0-2 200ft x 5lvl x 3ft bay: 660 locations', capS.positions === 660);

  // Edge cases
  const z1 = rackPairCapacity({ segmentLenFt: 0, levels: 5 });
  t('P0-2 zero segment: 0 positions', z1.positions === 0 && z1.baysPerFace === 0);
  const z2 = rackPairCapacity({ segmentLenFt: 200, levels: 0 });
  t('P0-2 zero levels: 0 positions', z2.positions === 0);
  const z3 = rackPairCapacity({ segmentLenFt: NaN, levels: 5 });
  t('P0-2 NaN segment: 0 positions', z3.positions === 0);
  const z4 = rackPairCapacity({ segmentLenFt: -50, levels: 5 });
  t('P0-2 negative segment: 0 positions', z4.positions === 0);
  const z5 = rackPairCapacity({ segmentLenFt: 200, levels: 5, bayWidthFt: 0 });
  t('P0-2 zero bayWidth falls back to default', z5.baysPerFace === 46);

  // Constants exposed for UI
  t('P0-2 PALLET_BAY_WIDTH_FT = 4.33', PALLET_BAY_WIDTH_FT === 4.33);
  t('P0-2 SHELVING_BAY_WIDTH_FT = 3', SHELVING_BAY_WIDTH_FT === 3);
}

// ── P0-2: rollupRenderedFacts — happy path ──
{
  // Simulate a 3D scene that placed:
  //   2 fullPallet rack pairs, each broken into 2 segments of 200 ft, 5 levels
  //   1 cartonPallet rack pair, 1 segment of 200 ft, 5 levels
  //   1 shelving rack pair, 1 segment of 200 ft, 5 levels (3 ft bay)
  const placed = [
    { typeKey: 'fullPallet',   colKey: 0,  segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet',   colKey: 0,  segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet',   colKey: 1,  segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet',   colKey: 1,  segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'cartonPallet', colKey: 2,  segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'shelving',     colKey: 3,  segmentLenFt: 200, levels: 5, bayWidthFt: 3 },
  ];
  const sized = {
    positions: {
      fullPalletPositions: 1840,
      cartonPalletPositions: 460,
      shelvingPositions: 660,
      grossPositions: 2960,
    },
  };
  const facts = rollupRenderedFacts(placed, sized);

  // 4 fullPallet segments of 460 each = 1840
  t('P0-2 rollup fp segments = 4', facts.byType.fullPallet.segments === 4);
  t('P0-2 rollup fp columns (unique colKeys) = 2', facts.byType.fullPallet.columns === 2);
  t('P0-2 rollup fp positions = 1840', facts.byType.fullPallet.positions === 1840);

  // 1 cartonPallet segment = 460
  t('P0-2 rollup cp positions = 460', facts.byType.cartonPallet.positions === 460);
  t('P0-2 rollup cp columns = 1', facts.byType.cartonPallet.columns === 1);

  // 1 shelving segment of 660 each = 660
  t('P0-2 rollup shelving positions = 660', facts.byType.shelving.positions === 660);

  t('P0-2 rollup totalPositions = 2960', facts.totalPositions === 2960);
  t('P0-2 rollup totalSegments = 6', facts.totalSegments === 6);
  t('P0-2 rollup totalColumns = 4', facts.totalColumns === 4);
  t('P0-2 rollup targets pulled from sized.positions', facts.targets.total === 2960 && facts.targets.fullPallet === 1840);
  t('P0-2 rollup deltaPct = 0 when on target', facts.deltaPct === 0);
  t('P0-2 rollup status = on_target', facts.status === 'on_target');
}

// ── P0-2: rollupRenderedFacts — under-built detection ──
{
  // Engine sized 5000 positions, scene only placed 1840.
  const placed = [
    { typeKey: 'fullPallet', colKey: 0, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet', colKey: 0, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet', colKey: 1, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet', colKey: 1, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
  ];
  const sized = {
    positions: { fullPalletPositions: 5000, cartonPalletPositions: 0, shelvingPositions: 0, grossPositions: 5000 },
  };
  const facts = rollupRenderedFacts(placed, sized);
  t('P0-2 under-built: status=under_built', facts.status === 'under_built');
  t('P0-2 under-built: deltaPct negative', facts.deltaPct < 0);
  t('P0-2 under-built: deltaPct ~ -63.2%', Math.abs(facts.deltaPct - (-63.2)) < 0.5);
}

// ── P0-2: rollupRenderedFacts — over-built detection ──
{
  // Engine sized 100 positions, scene placed 920 — over-built.
  const placed = [
    { typeKey: 'fullPallet', colKey: 0, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'fullPallet', colKey: 1, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
  ];
  const sized = {
    positions: { fullPalletPositions: 100, cartonPalletPositions: 0, shelvingPositions: 0, grossPositions: 100 },
  };
  const facts = rollupRenderedFacts(placed, sized);
  t('P0-2 over-built: status=over_built', facts.status === 'over_built');
  t('P0-2 over-built: deltaPct positive', facts.deltaPct > 0);
}

// ── P0-2: rollupRenderedFacts — empty inputs are safe ──
{
  const facts = rollupRenderedFacts([], {});
  t('P0-2 empty: totalPositions = 0', facts.totalPositions === 0);
  t('P0-2 empty: totalColumns = 0', facts.totalColumns === 0);
  t('P0-2 empty: status=on_target (no target to compare)', facts.status === 'on_target');
  t('P0-2 empty: deltaPct=0', facts.deltaPct === 0);

  const factsNull = rollupRenderedFacts(null, null);
  t('P0-2 null inputs: safe', factsNull.totalPositions === 0);

  const factsUndef = rollupRenderedFacts(undefined);
  t('P0-2 undefined inputs: safe', factsUndef.totalPositions === 0);
}

// ── P0-2: rollupRenderedFacts — unknown typeKey ignored ──
{
  const placed = [
    { typeKey: 'fullPallet', colKey: 0, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
    { typeKey: 'mystery',    colKey: 1, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 }, // unknown
    { typeKey: undefined,    colKey: 2, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
  ];
  const facts = rollupRenderedFacts(placed, {});
  t('P0-2 unknown typeKey ignored', facts.totalPositions === 460);
  t('P0-2 unknown typeKey: only fullPallet counted', facts.byType.fullPallet.positions === 460);
}

// ── P0-2: rollupRenderedFacts — fallback target = sum-of-types when grossPositions=0 ──
{
  const placed = [
    { typeKey: 'fullPallet', colKey: 0, segmentLenFt: 200, levels: 5, bayWidthFt: 4.33 },
  ];
  // Engine returned types but no grossPositions (corrupt sized object).
  const sized = {
    positions: { fullPalletPositions: 460, cartonPalletPositions: 0, shelvingPositions: 0, grossPositions: 0 },
  };
  const facts = rollupRenderedFacts(placed, sized);
  t('P0-2 fallback: target falls back to sum of types', facts.targets.total === 460);
  t('P0-2 fallback: status=on_target when achieved matches summed target', facts.status === 'on_target');
}

// ── P0-2: integration — sizeFacility output feeds rollupRenderedFacts cleanly ──
{
  // Run a real sizing scenario and confirm rollupRenderedFacts accepts the
  // engine output directly without shape mismatch.
  const sized = sizeFacility({
    peakUnits: 500000,
    fullPalletPct: 0.6,
    cartonOnPalletPct: 0.3,
    cartonOnShelvingPct: 0.1,
    clearHeightFt: 36,
  });
  // Empty placedRacks → all zeros, but targets pulled from sized
  const facts = rollupRenderedFacts([], sized);
  // Targets now use per-type GROSS positions (honeycomb + surge applied) so
  // per-row HUD breakdowns sum to total. fullPalletGrossPositions is the
  // canonical per-row target — see calc.js positions block (2026-05-04 PM s3).
  t('P0-2 integration: targets.fullPallet matches sized gross', facts.targets.fullPallet === sized.positions.fullPalletGrossPositions);
  t('P0-2 integration: targets.total matches sized.grossPositions', facts.targets.total === sized.positions.grossPositions);
  // Per-type gross targets sum to total (within ±1 for rounding).
  const _sumPerType = facts.targets.fullPallet + facts.targets.cartonPallet + facts.targets.shelving;
  t('P0-2 integration: per-type targets sum to total', Math.abs(_sumPerType - facts.targets.total) <= 1);
  t('P0-2 integration: empty placement under-built', facts.status === 'under_built');
}


// ── allocateRackColsByTarget — target-driven 3D col allocation ──
// (2026-05-05 — replaces inventory-mix-driven allocation that was
// over-filling shelving by ~6× because shelving bays are 1.4× denser
// than pallet bays AND shelving levels typically exceed pallet levels.
// New helper sizes cols so rendered positions ≈ engine GROSS targets;
// leftover cols become unused floor for over-built buildings.)
{
  // Wayfair Memphis FC scenario: 1000ft × 750ft, 89,926 gross targets,
  // mix 40/45/15 with totalPalletsOverride=65000.
  const segs = Array.from({ length: 3 }, () => 238); // 3 master segments × 238 ft
  const r = allocateRackColsByTarget({
    totalCols: 118,
    segmentLensFt: segs,
    palletLevels: 6,
    shelvingLevels: 7,
    fullPalletTarget:   40377,
    cartonPalletTarget: 45424,
    shelvingTarget:     4125,
  });
  // Per-pair capacity for 3 segments of 238 ft:
  //   pallet: floor(238/4.33) × 2 × 6 × 3 segs = 54 × 2 × 6 × 3 = 1944
  //   shelving: floor(238/3) × 2 × 7 × 3 segs = 79 × 2 × 7 × 3 = 3318
  t('allocate: palletPosPerPair = 1944', r.palletPosPerPair === 1944);
  t('allocate: shelvingPosPerPair = 3318', r.shelvingPosPerPair === 3318);
  // Round-to-nearest target:
  //   fp: round(40377/1944) = 21 pairs → 42 cols
  //   cp: round(45424/1944) = 23 pairs → 46 cols
  //   sh: round(4125/3318) = 1 pair  → 2 cols
  t('allocate: fullPalletCols = 42', r.fullPalletCols === 42);
  t('allocate: cartonPalletCols = 46', r.cartonPalletCols === 46);
  t('allocate: shelvingCols = 2', r.shelvingCols === 2);
  // Building has 59 pairs (118 cols); 21+23+1 = 45 pairs used → 14 unused
  t('allocate: unusedCols = 28', r.unusedCols === 28);
  t('allocate: cols sum to totalCols', r.fullPalletCols + r.cartonPalletCols + r.shelvingCols + r.unusedCols === 118);
  t('allocate: mode = over_built', r.mode === 'over_built');
}
{
  // Under-built: targets sum exceeds available cols → scale proportionally.
  const segs = Array.from({ length: 3 }, () => 238);
  const r = allocateRackColsByTarget({
    totalCols: 10, // tiny building
    segmentLensFt: segs,
    palletLevels: 6,
    shelvingLevels: 7,
    fullPalletTarget:   40377,
    cartonPalletTarget: 45424,
    shelvingTarget:     4125,
  });
  t('allocate under-built: cols never exceed totalCols', r.fullPalletCols + r.cartonPalletCols + r.shelvingCols <= 10);
  t('allocate under-built: mode = under_built', r.mode === 'under_built');
  t('allocate under-built: full pallet still gets bulk of cols', r.fullPalletCols >= r.shelvingCols);
}
{
  // Zero shelving target → zero shelving cols.
  const segs = Array.from({ length: 3 }, () => 238);
  const r = allocateRackColsByTarget({
    totalCols: 118,
    segmentLensFt: segs,
    palletLevels: 6,
    shelvingLevels: 7,
    fullPalletTarget:   40000,
    cartonPalletTarget: 40000,
    shelvingTarget:     0,
  });
  t('allocate: zero shelving target → zero shelving cols', r.shelvingCols === 0);
}
{
  // Non-zero target that rounds to zero pairs → floored at 1 pair so the
  // type still appears in the scene.
  const segs = Array.from({ length: 1 }, () => 1000); // one huge segment
  const r = allocateRackColsByTarget({
    totalCols: 20,
    segmentLensFt: segs,
    palletLevels: 6,
    shelvingLevels: 7,
    fullPalletTarget:   100,
    cartonPalletTarget: 100,
    shelvingTarget:     50,
  });
  // shelvingPosPerPair = floor(1000/3) × 2 × 7 = 4662; 50/4662 = 0.011 → round = 0; floored to 1.
  t('allocate: tiny target floors to 1 pair (2 cols)', r.shelvingCols === 2);
}
{
  // Empty inputs are safe.
  const r = allocateRackColsByTarget({});
  t('allocate empty: returns zeros', r.fullPalletCols === 0 && r.cartonPalletCols === 0 && r.shelvingCols === 0);
  t('allocate empty: unusedCols = 0', r.unusedCols === 0);
}

// ── suggestedBuildingDimensions — over-built shrink CTA ──
{
  // Wayfair Memphis FC scenario: 1000ft wide, 116 cols available, only 90
  // used (after target-driven allocation). 26 unused cols → suggest shrink.
  const r = suggestedBuildingDimensions({
    totalCols: 116,
    usedCols: 90,         // 45 pairs used, 13 pairs unused
    moduleFt: 18.5,       // 2*4.25 (back-to-back rack) + 10ft aisle
    sideMarginFt: 6,
    safetyPadFt: 6,
    currentWidthFt: 1000,
    currentDepthFt: 750,
  });
  t('suggest: recommended for 22%+ over-built', r.recommended === true);
  t('suggest: depth unchanged', r.suggestedDepthFt === 750);
  t('suggest: width is shrinkage of original', r.suggestedWidthFt < r.currentWidthFt);
  // 45 pairs * 18.5 + 12 + 6 = 850.5 → round up to 860
  t('suggest: width rounded to 10 ft', r.suggestedWidthFt % 10 === 0);
  t('suggest: oversize % computed', r.oversizePct >= 10 && r.oversizePct <= 25);
}
{
  // Building exactly fits → no recommendation.
  const r = suggestedBuildingDimensions({
    totalCols: 50, usedCols: 50,
    moduleFt: 18.5, currentWidthFt: 1000, currentDepthFt: 750,
  });
  t('suggest: no rec when used == totalCols', r.recommended === false);
}
{
  // Tiny shrink under threshold → no recommendation. usedCols=98 of 100
  // (49 pairs) → 943 ft min → rounds to 950 ft → 5% shrink, BELOW the 10%
  // custom threshold the caller passes here.
  const r = suggestedBuildingDimensions({
    totalCols: 100, usedCols: 98,
    moduleFt: 18.5, currentWidthFt: 1000, currentDepthFt: 750,
    minOversizePctToRecommend: 10,
  });
  t('suggest: no rec when shrink under custom threshold', r.recommended === false);
}
{
  // Bad inputs are safe.
  const r = suggestedBuildingDimensions({});
  t('suggest: empty inputs return not-recommended', r.recommended === false);
}

console.log(`

${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
