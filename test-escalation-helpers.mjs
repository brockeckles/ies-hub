// test-escalation-helpers.mjs — Verify the 3 pure helpers relocated from
// cost-model/ui.js to calc.js in S13 of the 2026-05-11 port-readiness
// sprint.
//
//   escalationFactor(ratePct, year)     — multiplier (year 1 → 1.0)
//   cumulativeEscalation(ratePct, year) — additive form (year 1 → 0)
//   benefitLoadTotal(lc)                — sum of 5 % fields
//
// Run:  node test-escalation-helpers.mjs

import {
  escalationFactor,
  cumulativeEscalation,
  benefitLoadTotal,
  escalatedWage,
} from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('Escalation helpers (S13)');

// --- escalationFactor ---
{
  ok('escalationFactor(5, 1) === 1.0 (year 1 = no escalation)', escalationFactor(5, 1) === 1.0);
  ok('escalationFactor(0, 5) === 1.0 (zero rate)',              escalationFactor(0, 5) === 1.0);
  ok('escalationFactor(5, 2) ≈ 1.05',                            near(escalationFactor(5, 2), 1.05));
  ok('escalationFactor(3, 4) ≈ 1.092727',                        near(escalationFactor(3, 4), Math.pow(1.03, 3)));
  ok('escalationFactor(10, 5) ≈ 1.4641',                         near(escalationFactor(10, 5), Math.pow(1.10, 4)));
  ok('escalationFactor(-5, 3) === 1.0 (negative clamped to 0)', escalationFactor(-5, 3) === 1.0);
  ok('escalationFactor(5, 0) === 1.0 (year clamped to 1 min)',  escalationFactor(5, 0) === 1.0);
  ok('escalationFactor("3", "4") works on string inputs',       near(escalationFactor('3', '4'), Math.pow(1.03, 3)));
  ok('escalationFactor(NaN, 5) === 1.0 (NaN rate → 0)',         escalationFactor(NaN, 5) === 1.0);
}

// --- cumulativeEscalation ---
{
  ok('cumulativeEscalation(5, 1) === 0 (no escalation in y1)',  cumulativeEscalation(5, 1) === 0);
  ok('cumulativeEscalation(5, 2) ≈ 0.05',                        near(cumulativeEscalation(5, 2), 0.05));
  ok('cumulativeEscalation(3, 4) ≈ 0.092727',                    near(cumulativeEscalation(3, 4), Math.pow(1.03, 3) - 1));
  ok('cumulativeEscalation(0, 10) === 0',                        cumulativeEscalation(0, 10) === 0);
  ok('cumulativeEscalation(-5, 3) === 0 (negative clamped)',    cumulativeEscalation(-5, 3) === 0);
  ok('factor = 1 + cumulative for any rate/year',
     near(escalationFactor(7, 6), 1 + cumulativeEscalation(7, 6)));
}

// --- benefitLoadTotal ---
{
  ok('benefitLoadTotal(null) === 0',     benefitLoadTotal(null) === 0);
  ok('benefitLoadTotal(undefined) === 0', benefitLoadTotal(undefined) === 0);
  ok('benefitLoadTotal({}) === 0',        benefitLoadTotal({}) === 0);

  const lc = {
    benefitLoadPayrollTaxesPct:  7.65,
    benefitLoadWorkersCompPct:   3.50,
    benefitLoadHealthWelfarePct: 12.00,
    benefitLoadRetirementPct:    4.00,
    benefitLoadOtherPct:         1.50,
  };
  ok('benefitLoadTotal sums all 5 fields',         near(benefitLoadTotal(lc), 28.65));

  // Partial — only some fields populated
  ok('benefitLoadTotal handles missing fields',    near(benefitLoadTotal({ benefitLoadPayrollTaxesPct: 7.65 }), 7.65));

  // String coercion
  ok('benefitLoadTotal coerces strings',           near(benefitLoadTotal({ benefitLoadPayrollTaxesPct: '7.65', benefitLoadHealthWelfarePct: '12' }), 19.65));

  // Garbage values coerce to 0, not NaN
  ok('benefitLoadTotal stays finite on garbage',
     Number.isFinite(benefitLoadTotal({ benefitLoadPayrollTaxesPct: 'lots', benefitLoadOtherPct: null, benefitLoadRetirementPct: undefined })));
}

// --- escalatedWage now delegates to escalationFactor — confirm parity ---
{
  // escalatedWage takes wage + fraction (0.03 = 3%), unlike escalationFactor
  // which takes percent. Both should produce identical results when the
  // arithmetic is right.
  ok('escalatedWage(100, 1, 0.03) === 100 (year 1 base)',       escalatedWage(100, 1, 0.03) === 100);
  ok('escalatedWage(100, 4, 0.03) ≈ 100 × escalationFactor(3, 4)',
     near(escalatedWage(100, 4, 0.03), 100 * escalationFactor(3, 4)));
  ok('escalatedWage(50, 5, 0.05) ≈ 50 × (1.05)^4',             near(escalatedWage(50, 5, 0.05), 50 * Math.pow(1.05, 4)));
  ok('escalatedWage clamps neg fraction',                       escalatedWage(100, 5, -0.05) === 100);
}

console.log(`\nEscalation helpers (S13): ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);
