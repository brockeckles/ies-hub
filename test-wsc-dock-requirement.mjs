// test-wsc-dock-requirement.mjs — Phase 1 redesign coverage for computeDockRequirement.
// Validates trucks-per-peak-day from peak throughput / pallets-per-truck,
// doors-required from dwell × shift, surge buffer application, dock SF.
import { computeDockRequirement, DOCK_SF_PER_DOOR } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// ── Wayfair Memphis FC shape: 5,000 pallets/peak day ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 5000,
    palletsPerTruck: 26,
    dwellHoursPerTruck: 1.5,
    shiftHoursPerDay: 16,
    surgePct: 0.20,
  });
  // 5000/26 = 192.31 trucks
  t('wayfair trucksPerPeakDay ≈ 192.3', close(r.trucksPerPeakDay, 192.3));
  // 192.31 × 1.5 / 16 = 18.0
  t('wayfair doorsRequiredRaw ≈ 18.0', close(r.doorsRequiredRaw, 18.0));
  t('wayfair doorsRequired = 19', r.doorsRequired === 19);     // ceil(18.04) = 19
  // 19 × 1.20 = 22.8 → ceil = 23
  t('wayfair doorsBySurge = 23', r.doorsBySurge === 23);
  t('wayfair dockSfRequired = 34,500', r.dockSfRequired === 23 * DOCK_SF_PER_DOOR);
}

// ── Small DC: 200 pallets/day, 30 pallets/truck floor-loaded ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 200,
    palletsPerTruck: 30,
    dwellHoursPerTruck: 1.0,
    shiftHoursPerDay: 8,
  });
  // 200/30 = 6.67 trucks; × 1.0/8 = 0.83. (Returned value rounded to 1 decimal → 0.8.)
  t('small DC doorsRequiredRaw ≈ 0.8 (1dec)', close(r.doorsRequiredRaw, 0.8, 0.05));
  t('small DC doorsRequired = 1', r.doorsRequired === 1);
  // Default surge 0.20 → ceil(1.2) = 2
  t('small DC doorsBySurge = 2', r.doorsBySurge === 2);
}

// ── Large round-clock 24h DC ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 10000,
    palletsPerTruck: 26,
    dwellHoursPerTruck: 1.5,
    shiftHoursPerDay: 24,
  });
  // 10000/26 = 384.6 trucks; × 1.5/24 = 24.04
  t('24h DC doorsRequired = 25', r.doorsRequired === 25);   // ceil(24.04)
  // 25 × 1.20 = 30
  t('24h DC doorsBySurge = 30', r.doorsBySurge === 30);
}

// ── Zero throughput → 0 doors ──
{
  const r = computeDockRequirement({ peakThroughputPalletsPerDay: 0 });
  t('zero throughput: 0 doors', r.doorsRequired === 0);
  t('zero throughput: 0 doorsBySurge', r.doorsBySurge === 0);
  t('zero throughput: 0 dockSf', r.dockSfRequired === 0);
}

// ── No surge → doors = doorsRequired ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 5000,
    palletsPerTruck: 26,
    dwellHoursPerTruck: 1.5,
    shiftHoursPerDay: 16,
    surgePct: 0,
  });
  t('no surge: doorsBySurge = doorsRequired', r.doorsBySurge === r.doorsRequired);
}

// ── 50% surge ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 1000,
    palletsPerTruck: 25,
    dwellHoursPerTruck: 1.0,
    shiftHoursPerDay: 10,
    surgePct: 0.50,
  });
  // 1000/25 = 40 trucks; × 1.0/10 = 4 doors
  t('50% surge doorsRequired = 4', r.doorsRequired === 4);
  // 4 × 1.50 = 6
  t('50% surge doorsBySurge = 6', r.doorsBySurge === 6);
}

// ── Custom sfPerDoor ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 1000,
    palletsPerTruck: 25,
    dwellHoursPerTruck: 1.0,
    shiftHoursPerDay: 10,
    surgePct: 0.20,
    sfPerDoor: 2000,
  });
  t('custom sfPerDoor', r.dockSfRequired === r.doorsBySurge * 2000);
}

// ── Default sfPerDoor = DOCK_SF_PER_DOOR (1500) ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 1000,
    palletsPerTruck: 25,
    dwellHoursPerTruck: 1.0,
    shiftHoursPerDay: 10,
    surgePct: 0.20,
  });
  t('default sfPerDoor = DOCK_SF_PER_DOOR', r.dockSfRequired === r.doorsBySurge * DOCK_SF_PER_DOOR);
}

// ── Default invocation: all defaults ──
{
  const r = computeDockRequirement({});
  t('default: 0 throughput → 0 doors', r.doorsRequired === 0);
  t('default palletsPerTruck = 26', r.palletsPerTruck === 26);
  t('default dwellHoursPerTruck = 1.5', r.dwellHoursPerTruck === 1.5);
  t('default shiftHoursPerDay = 16', r.shiftHoursPerDay === 16);
}

// ── Negative throughput clamped to 0 ──
{
  const r = computeDockRequirement({ peakThroughputPalletsPerDay: -100 });
  t('negative throughput: 0 doors', r.doorsRequired === 0);
}

// ── Zero shift hours falls back to default 16 (defensible default for bad input) ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 1000,
    shiftHoursPerDay: 0,
  });
  t('zero shift hours falls back to default 16', r.shiftHoursPerDay === 16);
}

// ── Zero pallets-per-truck: 0 doors (degenerate, no truck capacity) ──
{
  const r = computeDockRequirement({
    peakThroughputPalletsPerDay: 1000,
    palletsPerTruck: 0,
  });
  // Defaults to 26 (since 0 fails > 0 check)
  t('zero pallets-per-truck → default 26', r.palletsPerTruck === 26);
}

console.log(`\n\ntest-wsc-dock-requirement: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
