// test-wsc-media.mjs — N3 media-selection engine coverage (2026-07-04).
// Pins the pivot contract: depth→media map + Rule of 3 + FIFO filter +
// occupancy math + cost bands + the legacy-mix bridge.
import { selectMedia, pickMedium, allocationBridge, MEDIA_DEFS, FALLBACK_DEPTH_MAP }
  from './tools/warehouse-sizing/media-calc.js';
import { DEPTH_BUCKETS } from './tools/warehouse-sizing/profile-calc.js';
import { pinWscFactors } from './tools/warehouse-sizing/factors-calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

// ── MEDIA_DEFS ↔ seed-map consistency ──
{
  const mapKeys = new Set(FALLBACK_DEPTH_MAP.flatMap(r => r.media));
  for (const k of mapKeys) t(`MEDIA_DEFS has ${k}`, !!MEDIA_DEFS[k]);
  t('map buckets mirror profile-calc DEPTH_BUCKETS', FALLBACK_DEPTH_MAP.length === DEPTH_BUCKETS.length
    && FALLBACK_DEPTH_MAP.every((r, i) => r.minPltPerSku === DEPTH_BUCKETS[i].min));
  t('flow media are FIFO-ok', ['flow_8d','flow_12d','flow_20d','flow_24d'].every(k => MEDIA_DEFS[k].fifoOk));
  t('drive-in/pushback are LIFO', ['drive_in_2d','pushback_2d','pushback_6d'].every(k => !MEDIA_DEFS[k].fifoOk));
}

// ── pickMedium ──
{
  // avg 28 in 24–35 bucket: drive_in_2d needs 3×2=6 ✓; pushback_4_5d needs 15 ✓; flow_8d needs 24 ✓
  // densest first → flow_8d (depth 8) passes 28 ≥ 24
  const p1 = pickMedium({ avgDepth: 28, candidates: ['drive_in_2d','pushback_4_5d','flow_8d'], ruleOf3: 3, fifoStrict: false });
  t('densest passing wins (flow_8d at avg 28)', p1.key === 'flow_8d');
  // avg 25: flow_8d needs 24 ✓ still. avg 20 → flow_8d needs 24 ✗ → pushback_4_5d needs 15 ✓
  const p2 = pickMedium({ avgDepth: 20, candidates: ['drive_in_2d','pushback_4_5d','flow_8d'], ruleOf3: 3, fifoStrict: false });
  t('Rule of 3 demotes flow at avg 20', p2.key === 'pushback_4_5d');
  t('rejection audit recorded', p2.checks.some(c => c.includes('Pallet flow 8-deep: rejected')));
  // strict FIFO: pushback/drive-in out → flow_8d needs 24 ✗ at 20 → selective fallback
  const p3 = pickMedium({ avgDepth: 20, candidates: ['drive_in_2d','pushback_4_5d','flow_8d'], ruleOf3: 3, fifoStrict: true });
  t('strict FIFO forces fallback selective', p3.key === 'selective');
  // selective never subject to Rule of 3
  const p4 = pickMedium({ avgDepth: 2, candidates: ['selective'], ruleOf3: 3, fifoStrict: false });
  t('selective passes at shallow depth', p4.key === 'selective' && !p4.checks.some(c => c.includes('rejected')));
  // double_deep at avg 7: needs 3×2=6 ✓
  const p5 = pickMedium({ avgDepth: 7, candidates: ['double_deep','pushback_2d'], ruleOf3: 3, fifoStrict: false });
  t('double_deep passes at avg 7', p5.key === 'double_deep');
  const p6 = pickMedium({ avgDepth: 5, candidates: ['double_deep','pushback_2d'], ruleOf3: 3, fifoStrict: false });
  t('avg 5 fails 3×2 → selective', p6.key === 'selective');
}

// ── selectMedia: data-mode profile ──
const dataProfile = {
  mode: 'data', skuCount: 130,
  velocityBands: { A: { linePct: 60 }, B: { linePct: 25 }, C: { linePct: 15 } },
  depthOfHolding: {
    avgPalletsPerSku: 11.1, p50: 8, p90: 30, skusMeasured: 120,
    distribution: [
      { bucket: '1-5',   skuCount: 60, pallets: 180 },   // avg 3  → selective
      { bucket: '6-8',   skuCount: 30, pallets: 210 },   // avg 7  → double_deep
      { bucket: '24-35', skuCount: 10, pallets: 280 },   // avg 28 → flow_8d
    ],
  },
  volumes: { onHandPallets: 700, observedLines: 5000 },  // 30 plt sub-pallet slack
  tiHi: { avgCasesPerPallet: 50 }, peak: { peakFactor: 1.4 },
  dataGaps: [], provenance: {},
};
{
  const plan = selectMedia({ profile: dataProfile });
  t('plan produced', !!plan);
  t('provenance derived', plan.provenance === 'derived');
  t('3 bands', plan.bands.length === 3);
  const byBucket = Object.fromEntries(plan.bands.map(b => [b.bucket, b]));
  t('1-5 → selective', byBucket['1-5'].media === 'selective');
  t('6-8 → double_deep', byBucket['6-8'].media === 'double_deep');
  t('24-35 → flow_8d', byBucket['24-35'].media === 'flow_8d');
  t('selective occupancy 85%', byBucket['1-5'].occupancyPct === 85);
  t('deep occupancy 75%', byBucket['24-35'].occupancyPct === 75);
  t('positions = ceil(pallets/occ) selective', byBucket['1-5'].positions === Math.ceil(180 / 0.85));
  t('positions = ceil(pallets/occ) deep', byBucket['24-35'].positions === Math.ceil(280 / 0.75));
  t('cost band uses pallet_flow $250-500', byBucket['24-35'].costBand.min === byBucket['24-35'].positions * 250
    && byBucket['24-35'].costBand.max === byBucket['24-35'].positions * 500);
  t('rationale cites Rule of 3', byBucket['24-35'].rationale.includes('Rule of 3'));
  t('citations include map + rule', byBucket['24-35'].citations.includes('wsc.media.depth_to_media_map')
    && byBucket['24-35'].citations.includes('wsc.media.rule_of_3'));
  // shelving: 120 measured − 100 bucketed = 20 SKUs; 700 − 670 = 30 plt
  t('sub-pallet shelving band', plan.shelving && plan.shelving.skuCount === 20 && close(plan.shelving.pallets, 30));
  t('totals sum', plan.totals.positions === plan.bands.reduce((s, b) => s + b.positions, 0));
  t('media count families+shelving', plan.totals.mediaCount === 4);
  t('FACTORS_UNPINNED gap (no pin passed)', plan.gaps.some(g => g.code === 'FACTORS_UNPINNED'));
  // allocation bridge: shelf 30/700≈4%; case = min(35, round(25)) = 25; full = 71
  t('allocation sums to 100', plan.allocation.fullPallet + plan.allocation.cartonOnPallet + plan.allocation.cartonOnShelving === 100);
  t('allocation shelf ≈4', plan.allocation.cartonOnShelving === 4);
  t('allocation case = B proxy 25', plan.allocation.cartonOnPallet === 25);
}

// ── strict FIFO policy ──
{
  const plan = selectMedia({ profile: dataProfile, policy: { rotation: 'fifo_strict' } });
  const byBucket = Object.fromEntries(plan.bands.map(b => [b.bucket, b]));
  t('FIFO: 24-35 stays flow (fifoOk)', byBucket['24-35'].media === 'flow_8d');
  t('FIFO: 6-8 keeps double_deep (fifoOk)', byBucket['6-8'].media === 'double_deep');
  t('FIFO gap recorded', plan.gaps.some(g => g.code === 'FIFO_CONSTRAINED'));
  t('policy persisted', plan.policy.rotation === 'fifo_strict');
}

// ── pinned factors override defaults ──
{
  const pinned = pinWscFactors([
    { category_code: 'wsc_media_selection', ratio_code: 'wsc.media.rule_of_3', numeric_value: '4', sort_order: 10 },
    { category_code: 'wsc_media_selection', ratio_code: 'wsc.media.occupancy_floor_pct', numeric_value: '80', sort_order: 20 },
  ]);
  const plan = selectMedia({ profile: dataProfile, pinnedFactors: pinned });
  const byBucket = Object.fromEntries(plan.bands.map(b => [b.bucket, b]));
  // rule of 3 → 4: flow_8d needs 32 > 28 → falls to pushback_4_5d? candidates for 24-35 = drive_in_2d, pushback_4_5d, flow_8d.
  // pushback_4_5d needs 4×5=20 ≤ 28 ✓
  t('pinned ruleOf3=4 demotes flow → pushback_4_5d', byBucket['24-35'].media === 'pushback_4_5d');
  t('pinned deep occupancy 80% applied', byBucket['24-35'].occupancyPct === 80);
  t('no FACTORS_UNPINNED gap when pinned', !plan.gaps.some(g => g.code === 'FACTORS_UNPINNED'));
}

// ── sparse profile ──
{
  const sparse = {
    mode: 'sparse', skuCount: 1200,
    velocityBands: { A: {}, B: {}, C: {} },
    depthOfHolding: { avgPalletsPerSku: 7.5, p50: null, p90: null, skusMeasured: null, distribution: null },
    volumes: { onHandPallets: 9000, observedLines: null },
    dataGaps: [], provenance: {},
  };
  const plan = selectMedia({ profile: sparse });
  t('sparse: single band', plan.bands.length === 1);
  t('sparse: provenance estimated', plan.provenance === 'estimated');
  t('sparse: avg 7.5 → double_deep (3×2=6 ≤ 7.5)', plan.bands[0].media === 'double_deep');
  t('sparse: positions from 9000 pallets', plan.bands[0].positions === Math.ceil(9000 / 0.75));
  t('sparse: MEDIA_FROM_SPARSE gap', plan.gaps.some(g => g.code === 'MEDIA_FROM_SPARSE'));
  t('sparse: no shelving band', plan.shelving === null);
  t('sparse: allocation 100 full (no case/shelf signal)', plan.allocation.fullPallet === 100);
}

// ── degenerate inputs ──
{
  t('null profile → null', selectMedia({ profile: null }) === null);
  t('no depth → null', selectMedia({ profile: { mode: 'sparse', depthOfHolding: null } }) === null);
  const empty = allocationBridge({ bands: [], shelving: null }, null);
  t('empty bridge defaults 100/0/0', empty.fullPallet === 100 && empty.cartonOnShelving === 0);
}

console.log(`\ntest-wsc-media: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
