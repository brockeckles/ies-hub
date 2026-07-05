// test-wsc-scene-plan.mjs — N7 3D scene-plan coverage (2026-07-05).
// Pins media→run translation (merge, order, deep-lane level cap), engineered
// aisle/staging sourcing, shelving run, legacy degradation, recon target,
// and the per-face position math the placer relies on.
import { buildScenePlan, positionsPerFaceSegment, FAMILY_STYLE }
  from './tools/warehouse-sizing/scene-plan.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const mediaPlan = {
  bands: [
    { bucket: 'A', media: 'selective', mediaLabel: 'Single-deep selective', family: 'selective', laneDepth: 1, positions: 3000, occupancyPct: 85 },
    { bucket: 'B', media: 'double_deep', mediaLabel: 'Double-deep', family: 'double_deep', laneDepth: 2, positions: 4000 },
    { bucket: 'C', media: 'flow_8d', mediaLabel: 'Pallet flow 8-deep', family: 'pallet_flow', laneDepth: 8, positions: 2000 },
    { bucket: 'D', media: 'double_deep', mediaLabel: 'Double-deep', family: 'double_deep', laneDepth: 2, positions: 1000 },
  ],
  shelving: { skuCount: 150, pallets: 60 },
  totals: { positions: 10000 },
};
const dynamicsPlan = {
  mhe: { governingAisleFt: 9.5, fleet: [
    { type: 'reach', aisleFt: 9 }, { type: 'order_picker', aisleFt: 4.5 },
  ] },
  staging: { inbound: { sqft: 21200 }, outbound: { sqft: 10334 } },
};
const sized = { rackLevels: 6, shelfLevels: 7, positions: { shelvingGrossPositions: 2400 }, locations: { shelving: { locationsRequired: 2200 } } };

// ── media mode: runs ──
{
  const p = buildScenePlan({ mediaPlan, dynamicsPlan, sized, facility: {}, zones: {} });
  t('source media', p.source === 'media');
  t('4 runs (3 media merged from 4 bands + shelving)', p.runs.length === 4);
  t('deep-lane first order: flow → DD → selective', p.runs[0].key === 'flow_8d' && p.runs[1].key === 'double_deep' && p.runs[2].key === 'selective');
  t('shelving run last', p.runs[3].key === 'shelving');
  const dd = p.runs.find(r => r.key === 'double_deep');
  t('same-media bands merged: DD 5000 pos, 2 buckets', dd.targetPositions === 5000 && dd.buckets.length === 2);
  t('flow levels capped at 4 (deep-lane viz cap)', p.runs[0].levels === 4);
  t('DD keeps full levels (6)', dd.levels === 6);
  t('selective keeps full levels (6)', p.runs[2].levels === 6);
  t('shelving levels from sized (7)', p.runs[3].levels === 7);
  t('pallet runs get storage aisle 9.5', p.runs[0].aisleFt === 9.5 && dd.aisleFt === 9.5);
  t('shelving run gets pick aisle 4.5', p.runs[3].aisleFt === 4.5);
  t('shelving target = engine gross 2400', p.runs[3].targetPositions === 2400);
  t('family styles attached', p.runs[0].style === FAMILY_STYLE.pallet_flow && dd.style === FAMILY_STYLE.double_deep);
  t('recon required = media totals 10000', p.recon.requiredPositions === 10000);
  t('deep-lane fill defaults 0.75', close(p.runs[0].fillPct, 0.75));
  t('selective fill defaults 0.85', close(p.runs[2].fillPct, 0.85));
}

// ── aisle + staging sourcing ──
{
  const p = buildScenePlan({ mediaPlan, dynamicsPlan, sized, facility: { aisleWidth: 12 }, zones: {} });
  t('dynamics aisle beats facility', close(p.aisles.storageFt, 9.5) && p.aisles.source === 'dynamics');
  t('staging from dynamics', p.staging.inboundSqft === 21200 && p.staging.source === 'dynamics');

  const p2 = buildScenePlan({ mediaPlan, sized, facility: { aisleWidth: 10 }, zones: { receiveStagingSqft: 5000, shipStagingSqft: 3000 } });
  t('no dynamics: facility aisle', close(p2.aisles.storageFt, 10) && p2.aisles.source === 'facility');
  t('no dynamics: configured staging', p2.staging.inboundSqft === 5000 && p2.staging.source === 'configured');

  const p3 = buildScenePlan({ mediaPlan, sized, facility: {}, zones: {} });
  t('fallback aisle 12 default', close(p3.aisles.storageFt, 12) && p3.aisles.source === 'default');
  t('fallback staging default source', p3.staging.source === 'default');
}

// ── legacy degradation ──
{
  const p = buildScenePlan({ mediaPlan: null, dynamicsPlan, sized, facility: {}, zones: {} });
  t('no media plan → legacy', p.source === 'legacy' && p.runs.length === 0);
  t('legacy still carries engineered aisles', close(p.aisles.storageFt, 9.5));
  const p2 = buildScenePlan({ mediaPlan: { bands: [] }, sized });
  t('empty bands → legacy', p2.source === 'legacy');
}

// ── recon fallback when totals missing ──
{
  const noTotals = { ...mediaPlan, totals: null };
  const p = buildScenePlan({ mediaPlan: noTotals, sized });
  t('recon falls back to Σ pallet-run targets', p.recon.requiredPositions === 10000);
}

// ── positionsPerFaceSegment ──
{
  t('20 bays × 5 lvl × 1 deep = 100', positionsPerFaceSegment({ segLenFt: 86.6, bayWidthFt: 4.33, levels: 5, laneDepth: 1 }) === 100);
  t('deep lane multiplies: ×8', positionsPerFaceSegment({ segLenFt: 86.6, bayWidthFt: 4.33, levels: 5, laneDepth: 8 }) === 800);
  t('zero segment = 0', positionsPerFaceSegment({ segLenFt: 0 }) === 0);
  t('defaults sane (levels 5, depth 1)', positionsPerFaceSegment({ segLenFt: 43.3 }) === 50);
}

console.log(`\ntest-wsc-scene-plan: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
