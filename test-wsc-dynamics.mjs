// test-wsc-dynamics.mjs — N4 dynamics engine coverage (2026-07-04; MHE demoted
// to assumption 2026-07-05 — selection is MOST-owned, WSC only derives aisles).
// Pins MHE assumption, rate-method dock math, dwell-driven staging,
// cross-check divergence flag, and orchestrator derivation/gap behavior.
import { resolveMheAssumption, computeDoorsRateMethod, computeStagingSf, computeDynamics }
  from './tools/warehouse-sizing/dynamics-calc.js';
import { pinWscFactors } from './tools/warehouse-sizing/factors-calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const mediaPlan = {
  bands: [
    { family: 'selective', positions: 300 },
    { family: 'double_deep', positions: 400 },
    { family: 'pallet_flow', positions: 300 },
  ],
  shelving: { skuCount: 20, pallets: 30 },
};

// ── resolveMheAssumption ──
{
  const m = resolveMheAssumption({ mediaPlan, clearHeightFt: 32 });
  const types = m.fleet.map(f => f.type);
  t('reach for selective/flow', types.includes('reach'));
  t('double-deep reach present', types.includes('double_deep_reach'));
  t('counterbalance always present', types.includes('counterbalance'));
  t('order picker for shelving band', types.includes('order_picker'));
  t('governing aisle = DD reach 9.5', close(m.governingAisleFt, 9.5));
  t('CB does not govern storage aisle', m.governingAisleFt < 12);
  t('no VNA advisory at 32 ft', m.vnaAdvisory === null);

  const hi = resolveMheAssumption({ mediaPlan, clearHeightFt: 36 });
  t('VNA advisory at 36 ft + 70% selective-class', typeof hi.vnaAdvisory === 'string' && hi.vnaAdvisory.includes('F-min'));

  const deepOnly = resolveMheAssumption({ mediaPlan: { bands: [{ family: 'drive_in', positions: 900 }], shelving: null }, clearHeightFt: 36 });
  t('no VNA advisory when deep-lane dominates', deepOnly.vnaAdvisory === null);
  t('deep-only: no order picker', !deepOnly.fleet.some(f => f.type === 'order_picker'));
  t('deep-only: governing = reach 9', close(deepOnly.governingAisleFt, 9));

  const none = resolveMheAssumption({ mediaPlan: null });
  t('null plan: reach + CB fallback', none.fleet.some(f => f.type === 'reach') && none.fleet.some(f => f.type === 'counterbalance'));
  t('default source flag', none.source === 'default');

  // analyst-asserted storage type governs the aisle
  const ovVna = resolveMheAssumption({ mediaPlan, clearHeightFt: 36, storageTypeOverride: 'vna' });
  t('vna override: source asserted', ovVna.source === 'asserted');
  t('vna override: 66in → 5.5 ft governs', close(ovVna.governingAisleFt, 5.5));
  t('vna override: advisory suppressed', ovVna.vnaAdvisory === null);
  t('vna override: single asserted storage row', ovVna.fleet.filter(f => (f.role || '').startsWith('storage')).length === 1);
  t('vna override: CB dock row still present', ovVna.fleet.some(f => f.type === 'counterbalance' && !(f.role || '').startsWith('storage')));

  const ovReach = resolveMheAssumption({ mediaPlan, storageTypeOverride: 'reach' });
  t('reach override beats DD default (9 not 9.5)', close(ovReach.governingAisleFt, 9));

  const ovBad = resolveMheAssumption({ mediaPlan, storageTypeOverride: 'hoverboard' });
  t('unknown override ignored → default', ovBad.source === 'default' && close(ovBad.governingAisleFt, 9.5));
}

// ── rate-method doors ──
{
  // 1100 plt/day ÷ (27.5 × 8) × 1.25 = 6.25 → 7 doors
  const d = computeDoorsRateMethod({ palletsPerDay: 1100 });
  t('rate mid 27.5', close(d.rateUsed, 27.5));
  t('doorsRaw 6.25', close(d.doorsRaw, 6.25));
  t('doors ceil 7', d.doors === 7);
  t('zero flow → zero doors', computeDoorsRateMethod({ palletsPerDay: 0 }).doors === 0);
  // custom band + window
  const d2 = computeDoorsRateMethod({ palletsPerDay: 400, arrivalWindowHrs: 4, doorRate: { min: 10, max: 30 }, safetyFactor: 1.5 });
  t('custom: 400/(20×4)×1.5 = 7.5 → 8', d2.doors === 8 && close(d2.doorsRaw, 7.5));
}

// ── staging ──
{
  // 500 plt/day × 1 day × 13.333 ÷ 0.5 = 13,333 sqft; floor 3 doors × 510 = 1,530 → dwell governs
  const s = computeStagingSf({ palletsPerDay: 500, dwellDays: 1, doors: 3 });
  t('dwell sqft 13334', s.sqft === Math.ceil(500 * (48 * 40 / 144) / 0.5));
  t('governed by dwell', s.governedBy === 'dwell');
  t('not dwell-sensitive at 1 day', s.dwellSensitive === false);
  // tiny flow → door floor governs
  const s2 = computeStagingSf({ palletsPerDay: 10, dwellDays: 0.5, doors: 4 });
  t('door floor governs small flow', s2.governedBy === 'door floor' && s2.sqft === 4 * 510);
  // dwell sensitivity: 2 days doubles staged pallets
  const s3 = computeStagingSf({ palletsPerDay: 500, dwellDays: 2, doors: 3 });
  t('2-day dwell doubles', close(s3.dwellSqft, 2 * s.dwellSqft, 2) && s3.dwellSensitive === true);
}

// ── orchestrator: asserted flows ──
{
  const plan = computeDynamics({
    mediaPlan,
    volumes: { avgDailyInbound: 400, avgDailyOutbound: 500, peakMultiplier: 1.4, daysOnHand: 30 },
    facility: { clearHeight: 32, totalSqft: 150000 },
    policy: { arrivalWindowHrs: 8, dwellDaysIn: 1, dwellDaysOut: 0.5 },
  });
  t('plan produced', !!plan);
  t('peak flows 560/700', plan.flow.peakIn === 560 && plan.flow.peakOut === 700);
  t('flow provenance asserted', plan.flow.provenance === 'asserted');
  // in: 560/(27.5×8)×1.25 = 3.18 → 4; out: 700/(27.5×8)×1.25 = 3.98 → 4
  t('inbound doors 4', plan.docks.inbound.doors === 4);
  t('outbound doors 4', plan.docks.outbound.doors === 4);
  t('total 8', plan.docks.totalDoors === 8);
  t('dwell cross-check present', plan.docks.dwellCheck.doors > 0);
  t('sanity note printed (150K/8 = 18,750 outside band)', plan.docks.sanityNote.includes('OUTSIDE'));
  t('sanity gap is info not warn', plan.gaps.find(g => g.code === 'DOOR_RATIO_OUTSIDE_BAND')?.severity === 'info');
  t('staging in = dwell-governed 560×13.33/0.5', plan.staging.inbound.sqft === Math.ceil(560 * (48 * 40 / 144) / 0.5));
  t('staging totals add', plan.staging.totalSqft === plan.staging.inbound.sqft + plan.staging.outbound.sqft);
  t('MHE fleet rides along', plan.mhe.fleet.length === 4);
  t('citations include dock rate + staging', plan.citations.includes('wsc.dock.palletized_pallets_per_door_hr')
    && plan.citations.includes('wsc.staging.min_sqft_per_door'));
  t('INBOUND_BALANCED not flagged (both asserted)', !plan.gaps.some(g => g.code === 'INBOUND_BALANCED'));
  t('FACTORS_UNPINNED flagged (none passed)', plan.gaps.some(g => g.code === 'FACTORS_UNPINNED'));
  t('MHE_ASSUMPTION gap always flagged', plan.gaps.some(g => g.code === 'MHE_ASSUMPTION' && g.severity === 'info'));
  t('policy echoes null mheStorageType', plan.policy.mheStorageType === null);

  // policy override threads through orchestrator
  const ovPlan = computeDynamics({
    mediaPlan,
    volumes: { avgDailyInbound: 400, avgDailyOutbound: 500, peakMultiplier: 1.4, daysOnHand: 30 },
    facility: { clearHeight: 32, totalSqft: 150000 },
    policy: { arrivalWindowHrs: 8, dwellDaysIn: 1, dwellDaysOut: 0.5, mheStorageType: 'vna' },
  });
  t('orchestrator override: asserted + 5.5 ft', ovPlan.mhe.source === 'asserted' && close(ovPlan.mhe.governingAisleFt, 5.5));
  t('orchestrator override: policy echoed', ovPlan.policy.mheStorageType === 'vna');
}

// ── orchestrator: derived flows + dwell warning ──
{
  const plan = computeDynamics({
    profile: { volumes: { onHandPallets: 9000 }, peak: { peakFactor: 1.35 } },
    volumes: { daysOnHand: 30, peakMultiplier: 0 },
    facility: { clearHeight: 36 },
    policy: { dwellDaysIn: 2 },
  });
  t('derived: out = 9000/30 = 300/day', plan.flow.outPerDay === 300);
  t('derived: inbound balanced', plan.flow.inPerDay === 300);
  t('derived: peak from profile 1.35', close(plan.flow.peakFactor, 1.35));
  t('FLOW_ESTIMATED gap', plan.gaps.some(g => g.code === 'FLOW_ESTIMATED'));
  t('provenance estimated', plan.provenance === 'estimated');
  t('DWELL_DOMINANT warn at 2 days', plan.gaps.some(g => g.code === 'DWELL_DOMINANT' && g.severity === 'warn'));
  t('NO_MEDIA_PLAN info', plan.gaps.some(g => g.code === 'NO_MEDIA_PLAN'));
  t('no sanity note without sqft', plan.docks.sanityNote === null);
}

// ── pinned factors flow through ──
{
  const pinned = pinWscFactors([
    { category_code: 'wsc_dynamics', ratio_code: 'wsc.dock.palletized_pallets_per_door_hr', value_jsonb: { min: 10, max: 10 }, sort_order: 30 },
    { category_code: 'wsc_dynamics', ratio_code: 'wsc.dock.mulcahy_safety_factor', numeric_value: '2', sort_order: 10 },
  ]);
  const plan = computeDynamics({
    volumes: { avgDailyInbound: 400, avgDailyOutbound: 400, peakMultiplier: 1 },
    facility: {}, pinnedFactors: pinned,
  });
  // 400/(10×8)×2 = 10 doors each way
  t('pinned rate + safety applied (10 doors)', plan.docks.inbound.doors === 10 && plan.docks.outbound.doors === 10);
  t('no FACTORS_UNPINNED when pinned', !plan.gaps.some(g => g.code === 'FACTORS_UNPINNED'));
}

// ── degenerate ──
{
  t('no flow signal → null', computeDynamics({ volumes: {}, facility: {} }) === null);
}

console.log(`\ntest-wsc-dynamics: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
