// test-cm-depreciation-schedule.mjs — Phase 2 asset master (2026-06-12):
// per-asset monthly depreciation schedules (straight-line + declining-balance).
//
// Acceptance pinned (Roadmap §Phase 2): "Depreciation schedules sum to
// loaded_cost − residual over useful_life_months within rounding tolerance."

import * as calc from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
function eq(actual, expected, label, tol = 1e-6) {
  const ok = Math.abs(actual - expected) < tol;
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${label}`); }
}
const sum = rows => rows.reduce((s, r) => s + r.depreciation_amount, 0);

// 1. Straight-line basics: 120k over 60 months, no residual
const sl = calc.buildDepreciationSchedule({ total_loaded_cost: 120000, useful_life_months: 60 });
eq(sl.length, 60, 'SL: one row per life month');
eq(sl[0].depreciation_amount, 2000, 'SL: monthly dep = loaded/life');
eq(sum(sl), 120000, 'SL: schedule sums to loaded cost', 1e-6);
eq(sl[59].book_value, 0, 'SL: ends at book 0');
eq(sl[0].accumulated_depreciation, 2000, 'SL: accumulated starts at first month dep');
eq(sl[29].book_value, 60000, 'SL: halfway book = half loaded');

// 2. SL with residual: sums to loaded − residual, book floors at residual
const slr = calc.buildDepreciationSchedule({ total_loaded_cost: 100000, residual_value: 10000, useful_life_months: 48 });
eq(sum(slr), 90000, 'SL+residual: sums to loaded − residual');
eq(slr[47].book_value, 10000, 'SL+residual: final book = residual');
ok(slr.every(r => r.book_value >= 10000 - 1e-9), 'SL+residual: book never dips below residual');

// 3. Rounding absorption: indivisible amounts still sum exactly
const odd = calc.buildDepreciationSchedule({ total_loaded_cost: 100000, useful_life_months: 7 });
eq(sum(odd), 100000, 'rounding: 100k over 7 months sums exactly', 1e-9);
eq(odd[6].book_value, 0, 'rounding: final book exactly 0', 1e-9);

// 4. Declining balance: sums to loaded − residual, dep decreases, early months > SL
const db = calc.buildDepreciationSchedule({ total_loaded_cost: 120000, useful_life_months: 60, amort_method: 'declining_balance' });
eq(sum(db), 120000, 'DDB: sums to loaded cost', 1e-6);
ok(db[0].depreciation_amount > 2000, 'DDB: first month exceeds SL rate');
eq(db[0].depreciation_amount, 4000, 'DDB: first month = book × 2/life');
ok(db[0].depreciation_amount >= db[1].depreciation_amount, 'DDB: declining over time (pre-switch)');
ok(db.length <= 60, 'DDB: never exceeds life');
ok(db.every(r => r.book_value >= -1e-9), 'DDB: book never negative');

// 5. DDB with residual floor
const dbr = calc.buildDepreciationSchedule({ total_loaded_cost: 50000, residual_value: 5000, useful_life_months: 36, amort_method: 'declining_balance' });
eq(sum(dbr), 45000, 'DDB+residual: sums to loaded − residual', 1e-6);
ok(dbr.every(r => r.book_value >= 5000 - 1e-9), 'DDB+residual: book floors at residual');

// 6. Go-live offset shifts period indices
const off = calc.buildDepreciationSchedule({ total_loaded_cost: 12000, useful_life_months: 12 }, { goLivePeriodIndex: 3 });
eq(off[0].period_index, 3, 'offset: first row at go-live index');
eq(off[11].period_index, 14, 'offset: last row at go-live + life − 1');

// 7. Degenerate inputs
eq(calc.buildDepreciationSchedule({ total_loaded_cost: 0 }).length, 0, 'zero cost: empty schedule');
eq(calc.buildDepreciationSchedule({}).length, 0, 'missing cost: empty schedule');
const oneMo = calc.buildDepreciationSchedule({ total_loaded_cost: 5000, useful_life_months: 1 });
eq(oneMo.length, 1, 'one-month life: single row');
eq(oneMo[0].depreciation_amount, 5000, 'one-month life: full dep in month 1');

console.log(`test-cm-depreciation-schedule: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
