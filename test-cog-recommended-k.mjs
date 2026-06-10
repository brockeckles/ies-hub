// test-cog-recommended-k.mjs — regression net for 2026-06-10 High #8:
// "Recommended k banner always recommends max k."
//
// Pre-fix: sensitivityAnalysis flagged its pick as `isElbow`, but all three
// consumers (chrome KPI, H8 banner, deck callout) looked for `isRecommended`
// — which never existed — and fell through to "lowest totalCost". With the
// default fixedCostPerDC = 0 the cost curve is monotonically non-increasing,
// so the fallback ALWAYS picked k = maxK and the amber banner told every
// transport-only user to switch to max k.
//
// Post-fix contract: any row flagged isElbow is also flagged isRecommended
// (consumers read isRecommended; isElbow kept for back-compat).
//
// Run:  node test-cog-recommended-k.mjs

import { sensitivityAnalysis } from './tools/center-of-gravity/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Three distinct geographic clusters (East / Central / West) so k has real
// structure: 3-cluster demand makes k=3 the natural interior optimum once
// facility fixed cost penalizes larger k.
function clusteredPoints() {
  const pts = [];
  const centers = [
    { lat: 40.7, lng: -74.0 },   // NYC-ish
    { lat: 41.9, lng: -87.6 },   // Chicago-ish
    { lat: 34.1, lng: -118.2 },  // LA-ish
  ];
  let id = 0;
  for (const c of centers) {
    for (let i = 0; i < 12; i++) {
      pts.push({
        id: 'p' + (id++),
        name: 'pt' + id,
        lat: c.lat + ((i % 4) - 1.5) * 0.8,
        lng: c.lng + (Math.floor(i / 4) - 1) * 0.9,
        weight: 50_000 + (i % 3) * 20_000,
      });
    }
  }
  return pts;
}

t('invariant: every isElbow row is also isRecommended', () => {
  const pts = clusteredPoints();
  for (const fixed of [0, 250_000, 1_000_000]) {
    const rows = sensitivityAnalysis(pts, 8, 2.85, 50, 25_000, fixed);
    for (const r of rows) {
      if (r.isElbow) assert(r.isRecommended === true, `k=${r.k} flagged isElbow but not isRecommended (fixedCostPerDC=${fixed})`);
    }
  }
});

t('U-curve mode (fixed cost > 0): an interior k is flagged isRecommended', () => {
  const pts = clusteredPoints();
  // F=100K: large enough to penalize k>3, small enough that k=1 isn't the
  // optimum — guarantees an interior global minimum (the flag is correctly
  // suppressed when fixed cost pushes the optimum to the k=1 boundary).
  const rows = sensitivityAnalysis(pts, 8, 2.85, 50, 25_000, 100_000);
  const flagged = rows.filter(r => r.isRecommended);
  assert(flagged.length === 1, `expected exactly 1 recommended row, got ${flagged.length}`);
  const k = flagged[0].k;
  assert(k > 1 && k < 8, `recommended k=${k} must be interior (not boundary)`);
  // the row consumers select via isRecommended must be the genuine global
  // minimum — not the k=max fallback the pre-fix code degenerated to.
  const minCostRow = rows.reduce((a, b) => (b.totalCost < a.totalCost ? b : a));
  assert(flagged[0].k === minCostRow.k, `recommended k=${k} must equal min-cost k=${minCostRow.k}`);
});

t('transport-only mode: flag (when present) is interior, never k=maxK', () => {
  const pts = clusteredPoints();
  const rows = sensitivityAnalysis(pts, 8, 2.85, 50, 25_000, 0);
  const flagged = rows.filter(r => r.isRecommended);
  // kneedle may legitimately decline to flag (suppressed knee) — but if it
  // flags, the pick must be interior: the whole point of the fix is that
  // "recommended" stops defaulting to the curve's right edge.
  for (const f of flagged) {
    assert(f.k > 1 && f.k < 8, `transport-only recommended k=${f.k} must be interior`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
