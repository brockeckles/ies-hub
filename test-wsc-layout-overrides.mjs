// test-wsc-layout-overrides.mjs — locks Phase 1 of "drag changes the design"
// (Brock 2026-05-14). When the user corner-resizes a zone in the 2D plan
// view, the layoutOverride captures w/h in building-relative feet. The
// engine should honor those as SF overrides for Office, Ship Staging,
// Recv Staging, and Forward Pick instead of using its formula-derived value.

import { sizeFacility, formStateToInputs } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// Baseline inputs that produce non-zero office + ship staging.
const baseFacility = { totalSqft: 100000, sizingMode: 'design' };
const baseZones = {
  outboundUnitsPerDay: 1000,
  avgUnitsPerDay: 1000,
  peakUnitsPerDay: 1500,
  operatingDaysPerYear: 250,
  storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
  dockConfig: { inboundDoors: 5, outboundDoors: 5 },
};
const baseVolumes = { daysOnHand: 30 };

// ── formStateToInputs: passes overrides through ──
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, layoutOverrides: { office: { x: 0, y: 0, w: 200, h: 100 } } },
    volumes: baseVolumes,
  });
  t('office override surfaces as officeSqftOverride',
    inputs.officeSqftOverride === 20000,
    `got ${inputs.officeSqftOverride}`);
}
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, layoutOverrides: { shipStaging: { w: 150, h: 50 } } },
    volumes: baseVolumes,
  });
  t('ship-staging override surfaces as shipStagingSqftOverride',
    inputs.shipStagingSqftOverride === 7500,
    `got ${inputs.shipStagingSqftOverride}`);
}

// Move-only overrides (no w/h) must NOT trigger SF override.
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, layoutOverrides: { office: { x: 50, y: 30 } } },
    volumes: baseVolumes,
  });
  t('move-only office override → zero override', inputs.officeSqftOverride === 0,
    `got ${inputs.officeSqftOverride}`);
}

// ── sizeFacility: honors the override ──
{
  const baseline = sizeFacility(formStateToInputs({
    facility: baseFacility, zones: baseZones, volumes: baseVolumes,
  }));
  const overridden = sizeFacility(formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, layoutOverrides: { office: { w: 200, h: 100 } } },
    volumes: baseVolumes,
  }));
  t('office override changes officeSqft',
    overridden.officeSqft === 20000,
    `got ${overridden.officeSqft} (baseline was ${baseline.officeSqft})`);
  t('office override propagates to totalSqft',
    overridden.totalSqft !== baseline.totalSqft,
    `baseline ${baseline.totalSqft}, overridden ${overridden.totalSqft}`);
}

// Ship staging override propagates.
{
  const baseline = sizeFacility(formStateToInputs({
    facility: baseFacility, zones: baseZones, volumes: baseVolumes,
  }));
  const overridden = sizeFacility(formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, layoutOverrides: { shipStaging: { w: 150, h: 50 } } },
    volumes: baseVolumes,
  }));
  t('ship-staging override changes shipStagingSqft',
    overridden.shipStagingSqft === 7500,
    `got ${overridden.shipStagingSqft} (baseline was ${baseline.shipStagingSqft})`);
}

// Forward Pick override.
{
  const fpZones = {
    ...baseZones,
    forwardPick: { enabled: true, skuCount: 2000, type: 'carton_flow', daysInventory: 3 },
  };
  const baseline = sizeFacility(formStateToInputs({
    facility: baseFacility, zones: fpZones, volumes: baseVolumes,
  }));
  const fpItem = baseline.additionalItems?.find(it => it.label === 'Forward Pick');
  t('FP zone present at baseline', !!fpItem && fpItem.sqft > 0,
    `got ${JSON.stringify(fpItem)}`);

  const overridden = sizeFacility(formStateToInputs({
    facility: baseFacility,
    zones: { ...fpZones, layoutOverrides: { forwardPick: { w: 300, h: 25 } } },
    volumes: baseVolumes,
  }));
  const fpItemOv = overridden.additionalItems?.find(it => it.label === 'Forward Pick');
  t('FP resize override changes its sqft',
    fpItemOv?.sqft === 7500,
    `got ${fpItemOv?.sqft}`);
}

// Zero w*h doesn't trigger override.
{
  const inputs = formStateToInputs({
    facility: baseFacility,
    zones: { ...baseZones, layoutOverrides: { office: { w: 0, h: 0 } } },
    volumes: baseVolumes,
  });
  t('zero w*h → zero override',
    inputs.officeSqftOverride === 0,
    `got ${inputs.officeSqftOverride}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
