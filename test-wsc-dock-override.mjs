// test-wsc-dock-override.mjs — P1-5 guard (2026-07-02 assessment).
// Explicit door overrides must reach the headline totalSqft. Pre-fix, the
// requirements-driven aggregate consumed only computeDockRequirement
// (throughput-derived), so a "customer gave us 56 doors" scenario with no
// dock-capacity inputs contributed 0 dock SF to the headline while the
// Dock Doors KPI showed 56.
// Run:  node test-wsc-dock-override.mjs

import { sizeFacility, DOCK_SF_PER_DOOR } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, eps, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`); }

console.log('WSC dock-override → headline totalSqft');

const BASE = {
  peakUnits: 1_000_000,
  unitsPerPallet: 50,
  fullPalletPct: 0.50,
  cartonOnPalletPct: 0.35,
  cartonOnShelvingPct: 0.15,
  clearHeightFt: 32,
  officeSqft: 4_000,
  fullPalletSkus: 400,
  cartonPalletSkus: 900,
  shelvingSkus: 2_000,
};

// The audit's exact shape: explicit doors, NO dock capacity/throughput inputs.
t('56 explicit doors with zero dock-capacity inputs contribute 56×SF/door to the headline', () => {
  const r = sizeFacility({ ...BASE, inboundDoorsOverride: 28, outboundDoorsOverride: 28 });
  const dockRow = r.zoneBreakdown.find(z => z.label === 'Dock Area');
  assert(dockRow, 'Dock Area row missing from zoneBreakdown');
  near(dockRow.sqft, 56 * DOCK_SF_PER_DOOR, 0.5, 'Dock Area row');
  assert(r.dockRequirement.explicitDoorsApplied === true, 'explicitDoorsApplied flag not set');
  near(r.dockRequirement.dockSfRequired, 56 * DOCK_SF_PER_DOOR, 0.5, 'dockSfRequired');
});

t('zoneBreakdown still sums exactly to totalSqft with overrides active', () => {
  const r = sizeFacility({ ...BASE, inboundDoorsOverride: 28, outboundDoorsOverride: 28 });
  const rowSum = r.zoneBreakdown.reduce((s, z) => s + z.sqft, 0);
  near(rowSum, r.totalSqft, 0.5, 'Σ zoneBreakdown vs totalSqft');
});

t('two-sided dock config applies 1.15 factor to explicit-doors SF', () => {
  const r = sizeFacility({ ...BASE, inboundDoorsOverride: 28, outboundDoorsOverride: 28, dockConfig: 'two' });
  near(r.dockRequirement.dockSfRequired, Math.ceil(56 * DOCK_SF_PER_DOOR * 1.15), 1, 'two-sided dockSfRequired');
});

t('throughput-dominant scenario is unchanged (no overrides → pure Phase-1 derivation)', () => {
  const withT = { ...BASE, inPalletsDay: 800, outPalletsDay: 800, palletsPerDoorHour: 20, dockHours: 8 };
  const r = sizeFacility(withT);
  assert(!r.dockRequirement.explicitDoorsApplied, 'flag must not be set without overrides');
  // 1600 pallets/day ÷ 26/truck × 1.5h ÷ 16h = 5.77 → 6 doors → ×1.2 surge → 8 doors
  near(r.dockRequirement.dockSfRequired, 8 * DOCK_SF_PER_DOOR, 0.5, 'derived dockSfRequired');
});

t('when throughput demands MORE than explicit doors, throughput wins (max semantics)', () => {
  const r = sizeFacility({
    ...BASE, inPalletsDay: 5000, outPalletsDay: 5000,
    palletsPerDoorHour: 20, dockHours: 16,
    inboundDoorsOverride: 2, outboundDoorsOverride: 2,
  });
  assert(r.dockRequirement.dockSfRequired > 4 * DOCK_SF_PER_DOOR,
    `expected throughput-derived > 4-door SF, got ${r.dockRequirement.dockSfRequired}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
