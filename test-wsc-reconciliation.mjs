// test-wsc-reconciliation.mjs — invariant net for the 2026-06-10 ground-up
// assessment's WSC findings #2/#3/#5/#6. These are the two cheap invariant
// tests the audit said "would have caught the three biggest findings
// mechanically", plus the dock div-by-zero guard.
//
//   #5  zoneBreakdown rows must sum to the returned totalSqft (previously
//       rows used the legacy dock + no circulation against legacyTotalSqft —
//       they could not sum to the headline shown beside them)
//   #3  shelving locationsRequired contract: derived = demand × buffers;
//       explicit override = the user's engineered count with NO hidden
//       inflation (dock-override philosophy), flagged via explicit/mode
//   #2  totalPalletsOverride is FP+CP positions (per its UI tooltip) — the
//       shelving basis must reconstruct total pallets, not consume it raw
//   #6  calcDockAnalysis must not emit Infinity doors on zeroed defaults
//
// Run:  node test-wsc-reconciliation.mjs

import { sizeFacility, calcDockAnalysis } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, eps, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`); }

const BASE = {
  peakUnits: 1_000_000,
  unitsPerPallet: 50,
  fullPalletPct: 0.50,
  cartonOnPalletPct: 0.35,
  cartonOnShelvingPct: 0.15,
  clearHeightFt: 32,
  inPalletsDay: 800,
  outPalletsDay: 800,
  palletsPerDoorHour: 20,
  dockHours: 8,
  officeSqft: 4_000,
  fullPalletSkus: 400,
  cartonPalletSkus: 900,
  shelvingSkus: 2_000,
};

// ── #5: zone breakdown mass-conservation ────────────────────────────────────
t('zoneBreakdown rows sum exactly to returned totalSqft', () => {
  const r = sizeFacility({ ...BASE });
  const rowSum = r.zoneBreakdown.reduce((s, z) => s + z.sqft, 0);
  near(rowSum, r.totalSqft, 0.5, 'Σ zoneBreakdown vs totalSqft');
});

t('zoneBreakdown carries a Circulation row when requirements-driven total is active', () => {
  const r = sizeFacility({ ...BASE });
  assert(r.zoneBreakdown.some(z => z.label === 'Circulation'),
    'circulation must be a visible row — it is part of the headline total');
});

t('zoneBreakdown mass-conservation holds across configs (overrides, two-sided dock, no office)', () => {
  const variants = [
    { ...BASE, totalPalletsOverride: 30_000 },
    { ...BASE, dockConfig: 'two', officeSqft: 0 },
    { ...BASE, totalShelvingLocationsOverride: 5_000 },
    { ...BASE, inboundDoorsOverride: 12, outboundDoorsOverride: 14 },
  ];
  for (const [idx, v] of variants.entries()) {
    const r = sizeFacility(v);
    const rowSum = r.zoneBreakdown.reduce((s, z) => s + z.sqft, 0);
    near(rowSum, r.totalSqft, 0.5, `variant ${idx}:`);
  }
});

// ── #3: locationsRequired contract ──────────────────────────────────────────
t('derived shelving: locationsRequired = raw × (1+honeycomb) × (1+surge)', () => {
  const r = sizeFacility({ ...BASE });
  const sh = r.locations.shelving;
  assert(sh.explicit === false, 'derived path flagged explicit=false');
  near(sh.locationsRequired, Math.ceil(sh.locationsRaw * 1.10 * 1.20), 1.5,
    'buffered relationship (default 10% honeycomb + 20% surge)');
});

t('explicit shelving override: engineered count passes through with NO hidden buffers', () => {
  const r = sizeFacility({ ...BASE, totalShelvingLocationsOverride: 8_000 });
  const sh = r.locations.shelving;
  assert(sh.explicit === true && sh.mode === 'override', 'provenance flags');
  assert(sh.locationsRequired === 8_000, `locationsRequired must be the engineered 8,000, got ${sh.locationsRequired}`);
  assert(sh.grossLocations === 8_000 && sh.surgeLocations === 8_000,
    'no hidden ×1.1/×1.2 inflation fields (dock-override philosophy)');
});

// ── #2: pallet-override shelving basis ──────────────────────────────────────
t('setting totalPalletsOverride to the engine-derived FP+CP count ≈ fully-derived shelving', () => {
  const derived = sizeFacility({ ...BASE });
  const fpcp = derived.positions.fullPalletPositions + derived.positions.cartonPalletPositions;
  const overridden = sizeFacility({ ...BASE, totalPalletsOverride: fpcp });
  const a = derived.locations.shelving.locationsRequired;
  const b = overridden.locations.shelving.locationsRequired;
  // First-order reconstruction (FP vs CP carton densities differ), so allow
  // a generous band — the pre-fix double-dip landed ~15% LOW by construction
  // (×0.15 of an already-shelving-excluded count) and arbitrarily off as the
  // mix shifts; the reconstructed basis must stay in the same neighborhood.
  assert(Math.abs(a - b) / Math.max(1, a) < 0.35,
    `override==derived-count should give similar shelving: derived=${a}, overridden=${b}`);
});

// ── #6: dock analysis div-by-zero guard ─────────────────────────────────────
t('calcDockAnalysis: zeroed dock throughput yields 0 doors, not Infinity', () => {
  const res = calcDockAnalysis(
    {},
    { dockConfig: { sided: 'single', inboundDoors: 0, outboundDoors: 0, palletsPerDockHour: 0, dockOperatingHours: 0 } },
    { avgDailyInbound: 500, avgDailyOutbound: 500, peakMultiplier: 1.3 },
  );
  assert(Number.isFinite(res.inboundDoorsNeeded) && Number.isFinite(res.outboundDoorsNeeded),
    `doors must be finite: in=${res.inboundDoorsNeeded}, out=${res.outboundDoorsNeeded}`);
  assert(res.inboundDoorsNeeded === 0 && res.outboundDoorsNeeded === 0, 'no throughput → no derived doors');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
