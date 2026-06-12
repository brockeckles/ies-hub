// test-cm-asset-loaded-cost.mjs — Phase 2 asset master (2026-06-12):
// capital loading factor (contingency / freight / tax / allowances),
// residual values, and life-months-aware amortization.
//
// Acceptance pinned (Roadmap §Phase 2): "For an existing equipment line,
// adding 5% contingency changes the loaded cost by exactly 5% and the
// monthly amort by 5%."

import * as calc from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
function eq(actual, expected, label, tol = 1e-6) {
  const ok = Math.abs(actual - expected) < tol;
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}

// 1. Legacy invariance — no loading fields → factor 1, identical totals
const legacy = { acquisition_type: 'capital', quantity: 4, acquisition_cost: 25000, amort_years: 5 };
eq(calc.equipLoadingFactor(legacy), 1, 'legacy line: loading factor 1');
eq(calc.equipTotalAcq(legacy), 100000, 'legacy line: total acq unchanged');
eq(calc.equipLineAmort(legacy), 20000, 'legacy line: amort unchanged (100k / 5yr)');

// 2. Acceptance: +5% contingency ⇒ +5% loaded cost AND +5% amort
const withCont = { ...legacy, contingency_pct: 5 };
eq(calc.equipTotalAcq(withCont), 105000, 'acceptance: 5% contingency ⇒ loaded +5%');
eq(calc.equipLineAmort(withCont), 21000, 'acceptance: 5% contingency ⇒ amort +5%');
eq(calc.equipTotalAcq(withCont) / calc.equipTotalAcq(legacy), 1.05, 'acceptance: exact 1.05 ratio');

// 3. All four loadings stack additively
const fullLoad = { ...legacy, contingency_pct: 5, freight_pct: 3, tax_pct: 7, allowances_pct: 2 };
eq(calc.equipLoadingFactor(fullLoad), 1.17, 'four loadings stack: 1 + 17/100');
eq(calc.equipTotalAcq(fullLoad), 117000, 'four loadings: loaded total');

// 4. Breakdown components sum to loaded unit
const bd = calc.assetLoadedCostBreakdown(fullLoad);
eq(bd.baseUnit, 25000, 'breakdown: base unit');
eq(bd.contingency, 1250, 'breakdown: contingency $');
eq(bd.freight, 750, 'breakdown: freight $');
eq(bd.tax, 1750, 'breakdown: tax $');
eq(bd.allowances, 500, 'breakdown: allowances $');
eq(bd.loadedUnit, 29250, 'breakdown: loaded unit = base + components');
eq(bd.total, 117000, 'breakdown: total = loadedUnit × qty');
eq(bd.total, calc.equipTotalAcq(fullLoad), 'breakdown total agrees with equipTotalAcq');

// 5. Residual: absolute wins over pct; clamped to loaded total
eq(calc.equipResidualValue({ ...legacy, residual_value: 10000 }), 10000, 'residual: absolute');
eq(calc.equipResidualValue({ ...legacy, residual_pct: 10 }), 10000, 'residual: 10% of loaded');
eq(calc.equipResidualValue({ ...legacy, residual_value: 8000, residual_pct: 10 }), 8000, 'residual: absolute wins');
eq(calc.equipResidualValue({ ...legacy, residual_value: 999999999 }), 100000, 'residual: clamped to loaded');
eq(calc.equipResidualValue(legacy), 0, 'residual: defaults to 0');

// 6. Amort subtracts residual: (100k − 10k) / 5
eq(calc.equipLineAmort({ ...legacy, residual_value: 10000 }), 18000, 'amort: (loaded − residual)/years');

// 7. Life months: useful_life_months wins over amort_years
eq(calc.equipLifeMonths(legacy), 60, 'life: amort_years × 12');
eq(calc.equipLifeMonths({ ...legacy, useful_life_months: 84 }), 84, 'life: explicit months wins');
eq(calc.equipLifeMonths({}), 60, 'life: default 60');
eq(calc.equipLineAmort({ ...legacy, useful_life_months: 120 }), 10000, 'amort honors life months (100k/10yr)');

// 8. Loading flows into capital + TI totals
eq(calc.totalEquipmentCapital([withCont]), 105000, 'totalEquipmentCapital uses loaded cost');
const tiLine = { acquisition_type: 'ti', quantity: 1, acquisition_cost: 100000, contingency_pct: 10 };
eq(calc.totalEquipmentTiUpfront([tiLine]), 110000, 'TI upfront uses loaded cost');

// 9. Lease/service lines: amort stays 0 regardless of loading fields
eq(calc.equipLineAmort({ acquisition_type: 'lease', quantity: 2, acquisition_cost: 5000, contingency_pct: 5 }), 0, 'lease: no amort');

console.log(`test-cm-asset-loaded-cost: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
