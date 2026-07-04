// test-wsc-profile.mjs — N1 Design-Basis profiler coverage (2026-07-04).
// Pins the DesignProfile contract: both modes produce the same shape,
// provenance is honest, gaps fire when data is missing, and the banding /
// depth / peak math matches hand-computed fixtures.
import {
  parseSkuMaster, parseInventory, parseOrders,
  computeProfile, computeSparseProfile, profileReadiness,
  autoDetectMapping, SKU_MASTER_ROLES, INVENTORY_ROLES, ORDER_ROLES,
  DEPTH_BUCKETS, DEFAULT_ABC, DEFAULT_PEAK_FACTOR,
  DEFAULT_UNITS_PER_CASE, DEFAULT_CASES_PER_PALLET,
} from './tools/warehouse-sizing/profile-calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

// ── Fixtures ──
// SKU master: 4 SKUs; S4 missing Ti-Hi + dims.
const skuRows = [
  ['S1', 'Widget', 10, 50, 12, 12, 12, ''],   // cube from dims = 1 ft³
  ['S2', 'Gadget', 20, 40, '', '', '', 2.5],
  ['S3', 'Gizmo',  5,  80, '', '', '', 0.8],
  ['S4', 'Mystery', '', '', '', '', '', ''],
];
const skuMap = { 0: 'sku', 1: 'description', 2: 'unitsPerCase', 3: 'casesPerPallet',
  4: 'caseLengthIn', 5: 'caseWidthIn', 6: 'caseHeightIn', 7: 'caseCubeFt' };

// Inventory: S1 in units (5000 u ÷ 500 u/plt = 10 plt), S2 in pallets (4),
// S3 in cases (400 ÷ 80 = 5 plt), duplicate S2 row accumulates (+2 = 6).
const invRows = [
  ['S1', 5000, '', ''],
  ['S2', '', '', 4],
  ['S3', '', 400, ''],
  ['S2', '', '', 2],
];
const invMap = { 0: 'sku', 1: 'onHandUnits', 2: 'onHandCases', 3: 'onHandPallets' };

// Orders: 20 lines over 2 ISO weeks. S1: 12 lines, S2: 5, S3: 2, S9 (unknown): 1.
// Week 1 (Mon 2026-01-05..): 15 lines; week 2: 5 lines → peak factor 15/10 = 1.5.
const orderRows = [];
for (let i = 0; i < 12; i++) orderRows.push([i < 9 ? '2026-01-05' : '2026-01-12', `O${i}`, 'S1', 10, '']);
for (let i = 0; i < 5;  i++) orderRows.push([i < 4 ? '2026-01-06' : '2026-01-13', `P${i}`, 'S2', '', 2]);
for (let i = 0; i < 2;  i++) orderRows.push(['2026-01-07', `Q${i}`, 'S3', 25, '']);
orderRows.push(['2026-01-14', 'R0', 'S9', 7, '']);
const orderMap = { 0: 'date', 1: 'orderId', 2: 'sku', 3: 'qtyUnits', 4: 'qtyCases' };

// ── Parsers ──
{
  const { skus, rowCount, skipped } = parseSkuMaster(skuRows, skuMap);
  t('skuMaster rowCount 4', rowCount === 4);
  t('skuMaster skipped 0', skipped === 0);
  t('S1 cube from dims', close(skus.S1.caseCubeFt, 1.0));
  t('S2 cube direct', close(skus.S2.caseCubeFt, 2.5));
  t('S4 conversions null', skus.S4.unitsPerCase === null && skus.S4.casesPerPallet === null);

  const inv = parseInventory(invRows, invMap);
  t('inventory dedupe to 3 SKUs', inv.rowCount === 3);
  t('S2 pallets accumulate', inv.inventory.S2.onHandPallets === 6);

  const ord = parseOrders(orderRows, orderMap);
  t('orders 20 lines', ord.rowCount === 20);
  t('order dates parsed', ord.lines.every(l => l.date instanceof Date));
}

// ── Full data-mode profile ──
{
  const { skus } = parseSkuMaster(skuRows, skuMap);
  const { inventory } = parseInventory(invRows, invMap);
  const { lines } = parseOrders(orderRows, orderMap);
  const p = computeProfile({ skus, inventory, orders: lines });

  t('mode data', p.mode === 'data');
  // Universe = S1..S4 + S9
  t('skuCount 5', p.skuCount === 5);
  t('skuCount provenance derived', p.provenance.skuCount === 'derived');

  // Velocity: 20 lines total. Ranked S1(12) S2(5) S3(2) S9(1). cum: 12(60%)→A,
  // 17(85%)→B, 19(95%)→B, 20→C. So A={S1}, B={S2,S3}, C={S9}.
  t('band A = S1 only', p.velocityBands.A.skuCount === 1 && p.velocityBands.A.skus[0] === 'S1');
  t('band A linePct 60', close(p.velocityBands.A.linePct, 60));
  t('band B = {S2,S3}', p.velocityBands.B.skuCount === 2);
  t('band C = {S9}', p.velocityBands.C.skuCount === 1 && p.velocityBands.C.skus[0] === 'S9');

  // Cube movement: S1 units 120 → 12 cases × 1 ft³ = 12; S2 cases 10 → units 200 → 10 × 2.5 = 25;
  // S3 units 50 → 10 cases × 0.8 = 8. Total 45. A share = 12/45.
  t('cubeMovement present', !!p.cubeMovement);
  t('cube A pct', close(p.cubeMovement.A.cubePct, (12 / 45) * 100, 0.01));
  t('cube B pct', close(p.cubeMovement.B.cubePct, (33 / 45) * 100, 0.01));

  // Depth: S1 10 plt, S2 6, S3 5 → avg 7, total 21.
  t('depth avg 7', close(p.depthOfHolding.avgPalletsPerSku, 7));
  t('depth skusMeasured 3', p.depthOfHolding.skusMeasured === 3);
  const b68 = p.depthOfHolding.distribution.find(d => d.bucket === '6-8');
  const b15 = p.depthOfHolding.distribution.find(d => d.bucket === '1-5');
  const b914 = p.depthOfHolding.distribution.find(d => d.bucket === '9-14');
  t('bucket 6-8 has S2', b68.skuCount === 1);
  t('bucket 1-5 has S3', b15.skuCount === 1);
  t('bucket 9-14 has S1', b914.skuCount === 1);
  t('onHand pallets 21', close(p.volumes.onHandPallets, 21));
  t('pallets provenance estimated (converted)', p.provenance.onHandPallets === 'estimated');

  // Ti-Hi: (50+40+80)/3 = 56.667, S4 missing.
  t('tiHi avg', close(p.tiHi.avgCasesPerPallet, 170 / 3));
  t('tiHi missing 1', p.tiHi.skusMissing === 1);

  // Peak: wk1 15 lines, wk2 5 → avg 10, factor 1.5.
  t('peak weeks 2', p.peak.weeksObserved === 2);
  t('peak factor 1.5', close(p.peak.peakFactor, 1.5));
  t('peak provenance derived', p.provenance.peak === 'derived');

  // Gaps: unknown order SKU + short history + missing dims present.
  t('gap ORDER_SKUS_NOT_IN_MASTER', p.dataGaps.some(g => g.code === 'ORDER_SKUS_NOT_IN_MASTER' && g.count === 1));
  t('gap HISTORY_SHORT warn', p.dataGaps.some(g => g.code === 'HISTORY_SHORT' && g.severity === 'warn'));
  t('gap DIMS_MISSING', p.dataGaps.some(g => g.code === 'DIMS_MISSING'));
  t('no error-severity gaps', !p.dataGaps.some(g => g.severity === 'error'));

  const r = profileReadiness(p);
  t('readiness 100', r.score === 100, `got ${r.score}`);
  t('readiness label Design-ready', r.label === 'Design-ready');
}

// ── Partial data-mode: orders only ──
{
  const { lines } = parseOrders(orderRows, orderMap);
  const p = computeProfile({ orders: lines });
  t('orders-only: velocity present', !!p.velocityBands);
  t('orders-only: no depth', p.depthOfHolding === null);
  t('orders-only: gap NO_INVENTORY', p.dataGaps.some(g => g.code === 'NO_INVENTORY'));
  t('orders-only: gap NO_SKU_MASTER', p.dataGaps.some(g => g.code === 'NO_SKU_MASTER'));
  t('orders-only: no cube axis', p.cubeMovement === null);
  const r = profileReadiness(p);
  t('orders-only readiness partial', r.score > 0 && r.score < 85, `got ${r.score}`);
}

// ── Sparse mode ──
{
  const p = computeSparseProfile({
    skuCount: 1200, onHandPallets: 9000, annualOutboundUnits: 5_000_000,
    avgCasesPerPallet: 55,
  });
  t('sparse mode', p.mode === 'sparse');
  t('sparse same top-level shape', ['skuCount','velocityBands','cubeMovement','depthOfHolding','tiHi','peak','volumes','dataGaps','provenance'].every(k => k in p));
  t('sparse ABC defaulted Pareto', close(p.velocityBands.A.skuPct, DEFAULT_ABC.A.skuPct));
  t('sparse ABC provenance estimated', p.provenance.velocityBands === 'estimated');
  t('sparse gap ABC_DEFAULTED', p.dataGaps.some(g => g.code === 'ABC_DEFAULTED'));
  t('sparse depth derived 7.5', close(p.depthOfHolding.avgPalletsPerSku, 7.5));
  t('sparse depth provenance derived', p.provenance.depthOfHolding === 'derived');
  t('sparse tiHi asserted', p.provenance.tiHi === 'asserted' && close(p.tiHi.avgCasesPerPallet, 55));
  t('sparse peak defaulted', close(p.peak.peakFactor, DEFAULT_PEAK_FACTOR) && p.provenance.peak === 'estimated');
  t('sparse gap PEAK_DEFAULTED', p.dataGaps.some(g => g.code === 'PEAK_DEFAULTED'));
  t('sparse A skuCount 240', p.velocityBands.A.skuCount === 240);
  const r = profileReadiness(p);
  t('sparse readiness Design-ready', r.score === 100, `got ${r.score}`);
}

// ── Sparse mode: minimal + explicit ABC/peak override provenance ──
{
  const p = computeSparseProfile({ skuCount: 100, avgPalletsPerSku: 12, peakFactor: 1.8,
    abcSplit: { A: { skuPct: 10, linePct: 70 }, B: { skuPct: 30, linePct: 20 }, C: { skuPct: 60, linePct: 10 } } });
  t('sparse asserted ABC provenance', p.provenance.velocityBands === 'asserted');
  t('sparse asserted peak', close(p.peak.peakFactor, 1.8) && p.provenance.peak === 'asserted');
  t('sparse asserted depth', close(p.depthOfHolding.avgPalletsPerSku, 12) && p.provenance.depthOfHolding === 'asserted');
  t('sparse gap OUTBOUND_MISSING', p.dataGaps.some(g => g.code === 'OUTBOUND_MISSING'));
}
{
  const p = computeSparseProfile({});
  t('sparse empty: error gap', p.dataGaps.some(g => g.code === 'SKU_COUNT_MISSING' && g.severity === 'error'));
  const r = profileReadiness(p);
  t('sparse empty: blocking listed', r.blocking.length === 1);
}

// ── Auto-detect ──
{
  const m = autoDetectMapping(['Item Number', 'Desc', 'Units/Case', 'Cases per Pallet', 'Cube'], SKU_MASTER_ROLES);
  t('autodetect sku', m[0] === 'sku');
  t('autodetect unitsPerCase', m[2] === 'unitsPerCase');
  t('autodetect casesPerPallet', m[3] === 'casesPerPallet');
  t('autodetect cube', m[4] === 'caseCubeFt');
  const m2 = autoDetectMapping(['SKU', 'On Hand Units'], INVENTORY_ROLES);
  t('autodetect onHandUnits', m2[1] === 'onHandUnits');
  const m3 = autoDetectMapping(['Order Date', 'Order #', 'SKU', 'Qty'], ORDER_ROLES);
  t('autodetect order date/id/qty', m3[0] === 'date' && m3[1] === 'orderId' && m3[3] === 'qtyUnits');
  t('autodetect no role leakage', !Object.values(m3).includes('onHandUnits'));
}

// ── Depth buckets are contiguous + exhaustive ──
{
  for (let i = 0; i < DEPTH_BUCKETS.length - 1; i++) {
    t(`bucket ${DEPTH_BUCKETS[i].key} contiguous`, DEPTH_BUCKETS[i + 1].min === DEPTH_BUCKETS[i].max + 1);
  }
  t('last bucket unbounded', DEPTH_BUCKETS[DEPTH_BUCKETS.length - 1].max === Infinity);
}

console.log(`\ntest-wsc-profile: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
