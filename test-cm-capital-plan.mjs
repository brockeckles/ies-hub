// test-cm-capital-plan.mjs — Phase 2 asset master (2026-06-12):
// computeCapital (capex vs operating-lease split), buildAssetInstances,
// rackProfileCost (BOM expansion).
//
// Acceptance pinned (Roadmap §Phase 2):
//   "Operating leases never hit the capex line in monthly cashflow;
//    capital purchases always do."
//   "A rack profile decomposed to 8 component types produces the same
//    total cost as a single-line-item equivalent, ± BOM-level rounding."

import * as calc from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
function eq(actual, expected, label, tol = 1e-6) {
  const ok = Math.abs(actual - expected) < tol;
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${label}`); }
}

const lines = [
  { equipment_name: 'Reach truck',   category: 'MHE',      acquisition_type: 'capital', quantity: 4, acquisition_cost: 42000, useful_life_months: 84, residual_value: 16800 },
  { equipment_name: 'Forklift',      category: 'MHE',      acquisition_type: 'lease',   quantity: 6, monthly_cost: 850, monthly_maintenance: 50 },
  { equipment_name: 'WMS licensing', category: 'IT',       acquisition_type: 'service', quantity: 1, monthly_cost: 4000 },
  { equipment_name: 'Office build',  category: 'Office',   acquisition_type: 'ti',      quantity: 1, acquisition_cost: 500000 },
  { equipment_name: 'RF terminals',  category: 'IT',       acquisition_type: 'capital', quantity: 30, acquisition_cost: 1800, contingency_pct: 5 },
];

// 1. computeCapital — capex split
const cap = calc.computeCapital(lines, { contractMonths: 60 });
eq(cap.totalCapex, 4 * 42000 + 30 * 1800 * 1.05, 'capex = capital lines only, loaded');
eq(cap.series[0].capex, cap.totalCapex, 'all capex lands at go-live month');
ok(cap.series.slice(1).every(s => s.capex === 0), 'no capex after month 0');
eq(cap.series.length, 60, 'series spans contract months');

// 2. Acceptance: leases NEVER hit capex; they flow as lease_opex
const leaseOnly = calc.computeCapital([lines[1], lines[2]], { contractMonths: 12 });
eq(leaseOnly.totalCapex, 0, 'acceptance: operating leases never hit capex');
ok(leaseOnly.series.every(s => s.capex === 0), 'acceptance: zero capex every month');
eq(leaseOnly.series[0].lease_opex, 6 * 900 + 4000, 'lease opex = monthly lease + service');
eq(leaseOnly.totalLeaseOpexMo, 9400, 'totalLeaseOpexMo rollup');

// 3. TI excluded from equipment capital plan (amortizes via facility rent)
const tiOnly = calc.computeCapital([lines[3]], { contractMonths: 12 });
eq(tiOnly.totalCapex, 0, 'TI excluded from equipment capex');

// 4. Depreciation + book value roll-forward
const reachLoaded = 4 * 42000;
eq(cap.series[0].depreciation, (reachLoaded - 16800) / 84 + (30 * 1800 * 1.05) / 60,
   'month-0 dep = sum of per-asset SL dep');
ok(cap.series[1].book_value < cap.series[0].book_value, 'book value declines');
// After RF terminals fully depreciate (60 mo), only reach-truck book remains in a longer window
const cap96 = calc.computeCapital([lines[0]], { contractMonths: 96 });
eq(cap96.series[95].book_value, 16800, 'book value floors at residual after life ends');

// 5. capexByCategory
eq(cap.capexByCategory['MHE'], reachLoaded, 'capex by category: MHE');
eq(cap.capexByCategory['IT'], 30 * 1800 * 1.05, 'capex by category: IT');

// 6. buildAssetInstances — capital + TI only, loaded fields materialized
const inst = calc.buildAssetInstances(lines);
eq(inst.length, 3, 'instances: capital ×2 + ti ×1 (lease/service skipped)');
ok(inst.every(i => i.financing_type === 'capital' || i.financing_type === 'ti'), 'instances: financing types');
const rf = inst.find(i => i.name === 'RF terminals');
eq(rf.unit_cost, 1800, 'instance: base unit cost (DB recomputes loaded)');
eq(rf.contingency_pct, 5, 'instance: loading pct carried');
eq(rf._total_loaded_cost, 30 * 1800 * 1.05, 'instance: client-side loaded total');
eq(rf.useful_life_months, 60, 'instance: default life 60');
ok(Object.keys(rf).filter(k => k.startsWith('_')).length === 1, 'instance: only client-side keys are underscore-prefixed');

// 7. Acceptance: rack BOM == single-line equivalent (8 component types)
const bom = [
  { component_type: 'upright',          qty: 2, unit_cost: 165.0 },
  { component_type: 'beam',             qty: 6, unit_cost: 46.0 },
  { component_type: 'footplate',        qty: 2, unit_cost: 6.0 },
  { component_type: 'anchor',           qty: 4, unit_cost: 2.5 },
  { component_type: 'row_spacer',       qty: 2, unit_cost: 8.0 },
  { component_type: 'wire_deck',        qty: 6, unit_cost: 28.0 },
  { component_type: 'pallet_support',   qty: 4, unit_cost: 9.0 },
  { component_type: 'column_protector', qty: 1, unit_cost: 24.0 },
];
const bayCost = calc.rackProfileCost(bom);
eq(bayCost, 872, 'rack BOM: 8-component bay prices at $872 (matches seeded profile)');
const singleLine = { acquisition_type: 'capital', quantity: 1, acquisition_cost: 872 };
eq(calc.equipTotalAcq(singleLine), bayCost, 'acceptance: BOM total == single-line equivalent');
eq(calc.rackProfileCost([]), 0, 'rack BOM: empty profile = $0');

console.log(`test-cm-capital-plan: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
