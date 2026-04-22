// 2026-04-22 — Phase 2b: rented_mhe seasonal-only cost path.
//
// Verifies:
//   1. rented_mhe annual = qty × monthly × seasonal_months.length (no baseline)
//   2. seasonal_months normalizer handles arrays, strings, defaults, invalid
//   3. equipLineAnnualBreakdown splits correctly (baseline=0, seasonal=full)
//   4. Non-rented lines untouched by the new path
//   5. Mixed bag of legacy lines produces correct totals
//
// Run:  node test-equipment-rented-mhe.mjs

import {
  equipLineAnnual,
  equipLineAnnualBreakdown,
  _normalizeSeasonalMonths,
  totalEquipmentCost,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function near(a, b, tol = 0.01, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not near'}: got ${a}, expected ${b} (±${tol})`); }
function deepEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not deep eq'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

// ────────────────────────────────────────────────────────────────────────────
// 1. _normalizeSeasonalMonths
// ────────────────────────────────────────────────────────────────────────────

t('normalizer: array passes through, sorted + deduped', () => {
  deepEq(_normalizeSeasonalMonths([12, 10, 11]), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths([10, 10, 11]), [10, 11]);
});

t('normalizer: comma string parses', () => {
  deepEq(_normalizeSeasonalMonths('10,11,12'), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths('12, 10 , 11'), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths('1 3 5'), [1, 3, 5]);  // whitespace-sep also works
});

t('normalizer: null/undefined/empty → default [10,11,12]', () => {
  deepEq(_normalizeSeasonalMonths(null), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths(undefined), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths([]), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths(''), [10, 11, 12]);
});

t('normalizer: out-of-range values dropped', () => {
  deepEq(_normalizeSeasonalMonths([0, 5, 13, 11]), [5, 11]);
  deepEq(_normalizeSeasonalMonths([-1, 10, 100]), [10]);
});

t('normalizer: garbage → default', () => {
  deepEq(_normalizeSeasonalMonths('foo,bar'), [10, 11, 12]);
  deepEq(_normalizeSeasonalMonths({}), [10, 11, 12]);
});

t('normalizer: mixed string/number entries', () => {
  deepEq(_normalizeSeasonalMonths(['10', 11, '12']), [10, 11, 12]);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. rented_mhe annual cost — seasonal only
// ────────────────────────────────────────────────────────────────────────────

t('rented_mhe: 3-month rental = qty × monthly × 3', () => {
  const line = {
    equipment_name: 'Peak Reach Truck',
    line_type: 'rented_mhe',
    quantity: 6,
    monthly_cost: 1000,
    seasonal_months: [10, 11, 12],
  };
  eq(equipLineAnnual(line), 6 * 1000 * 3, '6 trucks × $1000 × 3 months');
});

t('rented_mhe: 2-month rental', () => {
  const line = {
    line_type: 'rented_mhe',
    quantity: 4,
    monthly_cost: 650,
    seasonal_months: [11, 12],
  };
  eq(equipLineAnnual(line), 4 * 650 * 2);
});

t('rented_mhe: default months [10,11,12] when missing', () => {
  const line = { line_type: 'rented_mhe', quantity: 2, monthly_cost: 2500 };
  eq(equipLineAnnual(line), 2 * 2500 * 3, 'defaults to Oct-Dec');
});

t('rented_mhe: includes maintenance in monthly rate', () => {
  const line = {
    line_type: 'rented_mhe',
    quantity: 3,
    monthly_cost: 900,
    monthly_maintenance: 50,
    seasonal_months: [11, 12],
  };
  eq(equipLineAnnual(line), 3 * 950 * 2);
});

t('rented_mhe: qty=0 → $0', () => {
  const line = { line_type: 'rented_mhe', quantity: 0, monthly_cost: 1000 };
  eq(equipLineAnnual(line), 0);
});

t('rented_mhe: ignores peak_markup_pct (whole line IS peak)', () => {
  const line = {
    line_type: 'rented_mhe',
    quantity: 2,
    monthly_cost: 1000,
    peak_markup_pct: 50,  // should be ignored
    seasonal_months: [10, 11, 12],
  };
  eq(equipLineAnnual(line, [1,1,1,1,1,1,1,1,1,1,1,1]), 2 * 1000 * 3,
    'no overflow markup applied');
});

t('rented_mhe: ignores acquisition_type (always opex)', () => {
  // Even if someone flipped acq_type to 'capital', the rented_mhe path
  // overrides and charges monthly rental. Prevents mis-config.
  const line = {
    line_type: 'rented_mhe',
    quantity: 1,
    monthly_cost: 1000,
    acquisition_type: 'capital',  // misconfig — should be ignored
    seasonal_months: [10, 11, 12],
  };
  eq(equipLineAnnual(line), 3000);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Breakdown — baseline=0, seasonal=full
// ────────────────────────────────────────────────────────────────────────────

t('breakdown rented_mhe: baseline=0, seasonal=total', () => {
  const line = {
    line_type: 'rented_mhe',
    quantity: 5,
    monthly_cost: 1200,
    seasonal_months: [10, 11, 12],
  };
  const bd = equipLineAnnualBreakdown(line);
  eq(bd.baseline, 0);
  eq(bd.seasonal, 5 * 1200 * 3);
  eq(bd.total, 5 * 1200 * 3);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Non-rented lines still behave the same
// ────────────────────────────────────────────────────────────────────────────

t('owned_mhe lease unchanged by Phase 2b', () => {
  const line = {
    line_type: 'owned_mhe',
    quantity: 10,
    acquisition_type: 'lease',
    monthly_cost: 800,
    monthly_maintenance: 150,
  };
  // 10 × (800+150) × 12 = 114,000
  eq(equipLineAnnual(line), 114000);
});

t('it_equipment capital unchanged — maintenance only as opex', () => {
  const line = {
    line_type: 'it_equipment',
    quantity: 48,
    acquisition_type: 'capital',
    acquisition_cost: 2850,
    monthly_maintenance: 15,
  };
  // Capital → opex is maintenance only: 48 × 15 × 12 = 8,640
  eq(equipLineAnnual(line), 8640);
});

t('owned_facility TI line unchanged', () => {
  const line = {
    line_type: 'owned_facility',
    quantity: 6,
    acquisition_type: 'ti',
    acquisition_cost: 12000,
  };
  eq(equipLineAnnual(line), 0, 'TI is $0 opex on equip line');
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Mixed-bag aggregate: totalEquipmentCost sums correctly across types
// ────────────────────────────────────────────────────────────────────────────

t('totalEquipmentCost: mixed owned + rented + IT', () => {
  const lines = [
    { equipment_name: 'Reach (owned)', line_type: 'owned_mhe', quantity: 20, acquisition_type: 'lease', monthly_cost: 800, monthly_maintenance: 150 },
    { equipment_name: 'Reach (rental)', line_type: 'rented_mhe', quantity: 6, monthly_cost: 1000, seasonal_months: [10,11,12] },
    { equipment_name: 'RF (capital)', line_type: 'it_equipment', quantity: 48, acquisition_type: 'capital', acquisition_cost: 2850, monthly_maintenance: 15 },
  ];
  // Owned: 20 × 950 × 12 = 228,000
  // Rental: 6 × 1000 × 3 = 18,000
  // IT:    48 × 15 × 12 = 8,640
  // Total: 254,640
  near(totalEquipmentCost(lines), 254640, 0.5);
});

// ────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
