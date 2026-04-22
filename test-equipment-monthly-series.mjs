// 2026-04-22 — Phase 2e follow-up: month-indexed equipment expense series
// so rented_mhe lines with seasonal_months land in peak months rather than
// smoothed /12 across the calendar year.
//
// Invariants:
//   1. computeEquipmentMonthlySeries returns length-12 array
//   2. Owned/IT/Facility lines contribute equally to every month (annual/12)
//   3. rented_mhe lines add qty × monthly_cost ONLY to each month in seasonal_months
//   4. Sum-of-series equals totalEquipmentCost (mass-conservation)
//   5. Mixed-bag project: Q4 months carry the rental bump, Q1-Q3 carry only owned
//
// Run:  node test-equipment-monthly-series.mjs

import {
  computeEquipmentMonthlySeries,
  totalEquipmentCost,
  equipLineAnnual,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function near(a, b, tol = 0.01, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not near'}: got ${a}, expected ${b} (±${tol})`); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

// ────────────────────────────────────────────────────────────────────────────
// 1. Shape
// ────────────────────────────────────────────────────────────────────────────

t('empty lines: zero-filled 12-array', () => {
  const s = computeEquipmentMonthlySeries([]);
  eq(s.length, 12);
  for (const v of s) eq(v, 0);
});

t('null lines: zero-filled 12-array, no throw', () => {
  const s = computeEquipmentMonthlySeries(null);
  eq(s.length, 12);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Owned lines spread evenly
// ────────────────────────────────────────────────────────────────────────────

t('owned_mhe lease: $120K/yr → $10K every month', () => {
  const lines = [{ line_type: 'owned_mhe', quantity: 10, acquisition_type: 'lease', monthly_cost: 1000, monthly_maintenance: 0 }];
  // 10 × 1000 × 12 = 120K annual
  const s = computeEquipmentMonthlySeries(lines);
  for (const v of s) near(v, 10000, 0.01);
});

t('it_equipment capital: maintenance-only opex spread evenly', () => {
  const lines = [{ line_type: 'it_equipment', quantity: 48, acquisition_type: 'capital', acquisition_cost: 2850, monthly_maintenance: 15 }];
  // 48 × 15 × 12 = 8640; /12 = 720 per month
  const s = computeEquipmentMonthlySeries(lines);
  for (const v of s) near(v, 720, 0.01);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. rented_mhe only in seasonal months
// ────────────────────────────────────────────────────────────────────────────

t('rented_mhe Oct-Dec: zero Jan-Sep, qty×rate Oct-Dec', () => {
  const lines = [{ line_type: 'rented_mhe', quantity: 6, monthly_cost: 1000, seasonal_months: [10, 11, 12] }];
  const s = computeEquipmentMonthlySeries(lines);
  for (let i = 0; i < 9; i++) eq(s[i], 0, `month ${i+1} should be $0`);
  for (let i = 9; i < 12; i++) near(s[i], 6000, 0.01, `month ${i+1} should be $6K`);
});

t('rented_mhe Nov-Dec only: 2 months, zero everywhere else', () => {
  const lines = [{ line_type: 'rented_mhe', quantity: 4, monthly_cost: 2500, seasonal_months: [11, 12] }];
  const s = computeEquipmentMonthlySeries(lines);
  eq(s[9], 0);            // October
  near(s[10], 10000, 0.01); // Nov
  near(s[11], 10000, 0.01); // Dec
});

t('rented_mhe default months: uses [10,11,12] when missing', () => {
  const lines = [{ line_type: 'rented_mhe', quantity: 2, monthly_cost: 1500 }];
  const s = computeEquipmentMonthlySeries(lines);
  for (let i = 0; i < 9; i++) eq(s[i], 0);
  for (let i = 9; i < 12; i++) near(s[i], 3000, 0.01);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Mass conservation — sum of series = annual total
// ────────────────────────────────────────────────────────────────────────────

t('sum of monthly series equals totalEquipmentCost', () => {
  const lines = [
    { line_type: 'owned_mhe', quantity: 20, acquisition_type: 'lease', monthly_cost: 800, monthly_maintenance: 150 },
    { line_type: 'rented_mhe', quantity: 6, monthly_cost: 1000, seasonal_months: [10, 11, 12] },
    { line_type: 'it_equipment', quantity: 48, acquisition_type: 'capital', acquisition_cost: 2850, monthly_maintenance: 15 },
    { line_type: 'owned_facility', quantity: 1000, acquisition_type: 'lease', monthly_cost: 1, monthly_maintenance: 0.15 },
  ];
  const s = computeEquipmentMonthlySeries(lines);
  const sumSeries = s.reduce((a, b) => a + b, 0);
  const totalAnnual = totalEquipmentCost(lines);
  near(sumSeries, totalAnnual, 0.5, 'series sum ≈ annual total');
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Mixed-bag project: Q4 carries rental spike on top of steady baseline
// ────────────────────────────────────────────────────────────────────────────

t('mixed bag: Q4 months higher than non-Q4 by rental amount', () => {
  const lines = [
    { line_type: 'owned_mhe', quantity: 10, acquisition_type: 'lease', monthly_cost: 800, monthly_maintenance: 150 },
    { line_type: 'rented_mhe', quantity: 4, monthly_cost: 1000, seasonal_months: [10, 11, 12] },
  ];
  const s = computeEquipmentMonthlySeries(lines);
  // Baseline = 10 × 950 = $9,500 / month for Jan-Sep
  // Q4 add = 4 × 1000 = $4,000 on top for Oct-Nov-Dec
  near(s[0], 9500, 0.01, 'Jan baseline only');
  near(s[6], 9500, 0.01, 'Jul baseline only');
  near(s[9], 13500, 0.01, 'Oct baseline + rental');
  near(s[10], 13500, 0.01);
  near(s[11], 13500, 0.01);
  const q1 = s[0] + s[1] + s[2];
  const q4 = s[9] + s[10] + s[11];
  assert(q4 > q1, 'Q4 > Q1 because of rental');
  near(q4 - q1, 12000, 0.01, 'Q4 delta = 3 × $4K rental');
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Skip null entries safely
// ────────────────────────────────────────────────────────────────────────────

t('handles null/undefined lines gracefully', () => {
  const lines = [null, { line_type: 'owned_mhe', quantity: 1, acquisition_type: 'lease', monthly_cost: 100, monthly_maintenance: 0 }, undefined];
  const s = computeEquipmentMonthlySeries(lines);
  for (const v of s) near(v, 100, 0.01);
});

// ────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
