// test-wsc-staging-seam.mjs — locks the staging-divergence fix (2026-07-22,
// parked since W1). Configure's Recv/Ship Staging SF zones fields — which
// applyDynamicsPlan also writes with the dwell-driven plan figures — must
// reach the sizing engine as staging overrides. Before the fix,
// formStateToInputs only honored drawn 2D-resize layoutOverrides, so the
// sized output (Dashboard / 2D strip labels / CM writeback / basis-doc §11
// "provided") used the 0.15 × 18 SF/plt heuristic while the plan card,
// Configure, the 3D scene, and §11 "required" carried the dwell figure.
//
// Precedence pinned here: drawn resize > typed/applied zones value >
// engine heuristic. Zones default to 0 (createDefaultZones), so scenarios
// without an asserted or applied staging figure size byte-identically.

import { readFileSync } from 'node:fs';
import { sizeFacility, formStateToInputs } from './tools/warehouse-sizing/calc.js';
import { computeDynamics } from './tools/warehouse-sizing/dynamics-calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const baseFacility = { totalSqft: 100000, sizingMode: 'design' };
const baseZones = {
  outboundUnitsPerDay: 1000,
  avgUnitsPerDay: 1000,
  peakUnitsPerDay: 1500,
  operatingDaysPerYear: 250,
  storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
  dockConfig: { inboundDoors: 5, outboundDoors: 5 },
};
const baseVolumes = { daysOnHand: 30, totalPallets: 9000, avgDailyInbound: 400, avgDailyOutbound: 400 };

// ── 1. Zones staging values surface as engine overrides ──
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, receiveStagingSqft: 4200, shipStagingSqft: 3100 },
    volumes: baseVolumes,
  });
  t('zones.receiveStagingSqft → recvStagingSqftOverride',
    inputs.recvStagingSqftOverride === 4200, `got ${inputs.recvStagingSqftOverride}`);
  t('zones.shipStagingSqft → shipStagingSqftOverride',
    inputs.shipStagingSqftOverride === 3100, `got ${inputs.shipStagingSqftOverride}`);
}

// ── 2. Drawn 2D resize still wins over the zones value ──
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: {
      ...baseZones, receiveStagingSqft: 4200, shipStagingSqft: 3100,
      layoutOverrides: { shipStaging: { w: 150, h: 50 }, recvStaging: { w: 100, h: 40 } },
    },
    volumes: baseVolumes,
  });
  t('drawn resize beats zones value (ship)',
    inputs.shipStagingSqftOverride === 7500, `got ${inputs.shipStagingSqftOverride}`);
  t('drawn resize beats zones value (recv)',
    inputs.recvStagingSqftOverride === 4000, `got ${inputs.recvStagingSqftOverride}`);
}

// ── 3. Zero-diff pin: no zones staging → override 0 → heuristic path ──
{
  const inputs = formStateToInputs({
    facility: baseFacility, zones: baseZones, volumes: baseVolumes,
  });
  t('no staging assert → zero overrides (heuristic path preserved)',
    inputs.recvStagingSqftOverride === 0 && inputs.shipStagingSqftOverride === 0,
    `got recv=${inputs.recvStagingSqftOverride} ship=${inputs.shipStagingSqftOverride}`);
  const sized = sizeFacility(inputs);
  const expRecv = Math.ceil((inputs.inPalletsDay || 0) * 0.15 * 18 * (inputs.dockConfig === 'two' ? 1.25 : 1.0));
  t('heuristic figure unchanged for unasserted scenarios',
    sized.recvStagingSqft === expRecv,
    `got ${sized.recvStagingSqft}, expected ${expRecv}`);
}

// ── 4. sizeFacility honors the asserted figures end to end ──
{
  const baseline = sizeFacility(formStateToInputs({
    facility: baseFacility, zones: baseZones, volumes: baseVolumes,
  }));
  const sized = sizeFacility(formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, receiveStagingSqft: 4200, shipStagingSqft: 3100 },
    volumes: baseVolumes,
  }));
  t('sized recvStagingSqft = asserted 4,200', sized.recvStagingSqft === 4200,
    `got ${sized.recvStagingSqft}`);
  t('sized shipStagingSqft = asserted 3,100', sized.shipStagingSqft === 3100,
    `got ${sized.shipStagingSqft}`);
  t('asserted staging propagates to totalSqft', sized.totalSqft !== baseline.totalSqft,
    `baseline ${baseline.totalSqft}, asserted ${sized.totalSqft}`);
}

// ── 5. THE divergence proof: applied dynamics plan → engine agrees ──
// Mirrors applyDynamicsPlan (ui.js): plan.staging.{inbound,outbound}.sqft
// are written into zones.receiveStagingSqft / shipStagingSqft on Apply/Adopt.
{
  const plan = computeDynamics({
    volumes: { avgDailyInbound: 400, avgDailyOutbound: 400, peakMultiplier: 1.3 },
    facility: { clearHeight: 32 },
  });
  t('dynamics plan derives staging', plan?.staging?.inbound?.sqft > 0 && plan?.staging?.outbound?.sqft > 0,
    `got ${JSON.stringify(plan?.staging ?? null)}`);
  const sized = sizeFacility(formStateToInputs({
    facility: baseFacility,
    zones: {
      ...baseZones,
      receiveStagingSqft: plan.staging.inbound.sqft,
      shipStagingSqft: plan.staging.outbound.sqft,
    },
    volumes: baseVolumes,
  }));
  t('sized recv staging == plan dwell figure (no more two answers)',
    sized.recvStagingSqft === plan.staging.inbound.sqft,
    `sized ${sized.recvStagingSqft} vs plan ${plan.staging.inbound.sqft}`);
  t('sized ship staging == plan dwell figure',
    sized.shipStagingSqft === plan.staging.outbound.sqft,
    `sized ${sized.shipStagingSqft} vs plan ${plan.staging.outbound.sqft}`);
}

// ── 6. Source pins — the mechanism, not just the behavior ──
{
  const calcSrc = readFileSync(new URL('./tools/warehouse-sizing/calc.js', import.meta.url), 'utf8');
  t('formStateToInputs maps zones.shipStagingSqft into the override',
    /shipStagingSqftOverride\s*=\s*_resizedSqft\('shipStaging'\)\s*\|\|[\s\S]{0,80}zones\.shipStagingSqft/.test(calcSrc));
  t('formStateToInputs maps zones.receiveStagingSqft into the override',
    /recvStagingSqftOverride\s*=\s*_resizedSqft\('recvStaging'\)\s*\|\|[\s\S]{0,80}zones\.receiveStagingSqft/.test(calcSrc));
  const uiSrc = readFileSync(new URL('./tools/warehouse-sizing/ui.js', import.meta.url), 'utf8');
  t('applyDynamicsPlan still writes plan staging into zones (the feed)',
    /zones\.receiveStagingSqft\s*=\s*plan\.staging\.inbound\.sqft/.test(uiSrc)
    && /zones\.shipStagingSqft\s*=\s*plan\.staging\.outbound\.sqft/.test(uiSrc));
}

// ── 7. Office SF — same wart class, same precedence (2026-07-22) ──
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, officeSqft: 25000 },
    volumes: baseVolumes,
  });
  t('zones.officeSqft → officeSqftOverride',
    inputs.officeSqftOverride === 25000, `got ${inputs.officeSqftOverride}`);
  const drawn = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, officeSqft: 25000, layoutOverrides: { office: { w: 200, h: 100 } } },
    volumes: baseVolumes,
  });
  t('drawn resize beats typed Office SF',
    drawn.officeSqftOverride === 20000, `got ${drawn.officeSqftOverride}`);
  const none = formStateToInputs({
    facility: baseFacility, zones: baseZones, volumes: baseVolumes,
  });
  t('no office assert → zero override (officePct heuristic preserved)',
    none.officeSqftOverride === 0, `got ${none.officeSqftOverride}`);
  const sized = sizeFacility(inputs);
  t('sized officeSqft = asserted 25,000', sized.officeSqft === 25000,
    `got ${sized.officeSqft}`);
}

console.log(`\ntest-wsc-staging-seam: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
