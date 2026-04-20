#!/usr/bin/env node
/**
 * IES Hub v3 — Cost Model Phase 4a Labor Mix acceptance tests
 * Tests effectiveHourlyRate + downstream line-cost helpers for
 * the permanent/temp_agency/contractor employment_type split.
 */

import {
  effectiveHourlyRate,
  fullyLoadedRate,
  directLineAnnual,
  directLineAnnualSimple,
  indirectLineAnnual,
  indirectLineAnnualSimple,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${a}, expected ${b}`); }
function close(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not close'}: got ${a}, expected ≈ ${b}`); }

console.log('\n--- effectiveHourlyRate ---');
test('permanent: base rate unchanged', () => {
  eq(effectiveHourlyRate({ hourly_rate: 20, employment_type: 'permanent' }), 20);
});
test('contractor: base rate unchanged (markup ignored)', () => {
  eq(effectiveHourlyRate({ hourly_rate: 20, employment_type: 'contractor', temp_agency_markup_pct: 50 }), 20);
});
test('temp_agency + 25% markup: $20 → $25', () => {
  eq(effectiveHourlyRate({ hourly_rate: 20, employment_type: 'temp_agency', temp_agency_markup_pct: 25 }), 25);
});
test('temp_agency + 0% markup: same as base', () => {
  eq(effectiveHourlyRate({ hourly_rate: 20, employment_type: 'temp_agency', temp_agency_markup_pct: 0 }), 20);
});
test('missing employment_type defaults to permanent', () => {
  eq(effectiveHourlyRate({ hourly_rate: 30 }), 30);
});

console.log('\n--- fullyLoadedRate with temp markup ---');
test('permanent: $20 base + 30% burden + $1 benefits → $27', () => {
  const r = fullyLoadedRate({ hourly_rate: 20, employment_type: 'permanent', burden_pct: 30, benefits_per_hour: 1 });
  close(r, 27, 0.01);
});
test('temp_agency: $20 base × 1.25 markup + $1 benefits_per_hour → $26 (no wage load — doc §3.3)', () => {
  // Per Labor Build-Up Logic doc §3.3 (Brock 2026-04-20): temp rates from the
  // agency ALREADY INCLUDE the agency's fully-loaded cost (their payroll
  // taxes, workers' comp, benefits, profit). Applying perm burden on top is
  // double-counting. New semantics: temp → markup only; benefits_per_hour is
  // a distinct per-hour dollar line kept additive for rare legacy cases.
  // effective base $20 × 1.25 = $25; wage load = 0; + $1/hr benefits = $26.
  const r = fullyLoadedRate({ hourly_rate: 20, employment_type: 'temp_agency', temp_agency_markup_pct: 25, burden_pct: 30, benefits_per_hour: 1 });
  close(r, 26, 0.01);
});

console.log('\n--- directLineAnnual with temp markup ---');
test('headline: temp_agency @ 25% markup raises annual cost by exactly 25% vs permanent baseline', () => {
  const base = { annual_hours: 2000, hourly_rate: 20, burden_pct: 0, employment_type: 'permanent' };
  const temp = { ...base, employment_type: 'temp_agency', temp_agency_markup_pct: 25 };
  const baseCost = directLineAnnual(base, {});
  const tempCost = directLineAnnual(temp, {});
  close(tempCost / baseCost, 1.25, 0.001, 'temp/perm ratio');
});
test('directLineAnnualSimple: 40% markup example', () => {
  const line = { annual_hours: 1000, hourly_rate: 10, employment_type: 'temp_agency', temp_agency_markup_pct: 40 };
  const cost = directLineAnnualSimple(line, { defaultBurdenPct: 0, benefitLoadPct: 0 });
  // 1000 * 10 * 1.40 = 14000
  close(cost, 14000, 0.01);
});

console.log('\n--- indirectLineAnnual with temp markup ---');
test('indirect permanent baseline', () => {
  const line = { headcount: 1, hourly_rate: 25, burden_pct: 0, employment_type: 'permanent' };
  eq(indirectLineAnnual(line, { operatingHours: 2000, bonusPct: 0 }), 50000);
});
test('indirect temp_agency +50% markup raises cost by 50%', () => {
  const line = { headcount: 1, hourly_rate: 25, burden_pct: 0, employment_type: 'temp_agency', temp_agency_markup_pct: 50 };
  const cost = indirectLineAnnual(line, { operatingHours: 2000, bonusPct: 0 });
  eq(cost, 75000); // 1 × 2000 × 25 × 1.5 = 75000
});
test('indirect contractor ignores markup field (safety)', () => {
  const line = { headcount: 1, hourly_rate: 25, burden_pct: 0, employment_type: 'contractor', temp_agency_markup_pct: 99 };
  const cost = indirectLineAnnualSimple(line, 2000, { defaultBurdenPct: 0, benefitLoadPct: 0 });
  eq(cost, 50000);
});

console.log(`\n${pass}/${pass + fail} tests passed.`);
process.exit(fail ? 1 : 0);
