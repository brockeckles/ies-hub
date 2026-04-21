// Brock 2026-04-20: Task #6 — TI Upfront → Facility rent roll-up.
//
// Per Asset Defaults Guidance doc: TI items (dock levelers, office
// build-out, CCTV, break room) don't flow as equipment capex or opex.
// Design intent is to amortize them into facility rent over the
// contract term. Verifies:
//   - tiAmortAnnual(lines, years) returns upfront/years
//   - totalFacilityCost(facility, fr, ur, {tiAmort}) folds tiAmort in
//   - facilityCostBreakdown exposes tiAmort as a distinct field
//   - computeSummary threads equipmentLines through so TI lands in
//     facilityCost automatically

import {
  tiAmortAnnual,
  totalFacilityCost,
  facilityCostBreakdown,
  totalEquipmentTiUpfront,
  computeSummary,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function near(a, b, tol = 0.01, msg = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${a}, expected ${b}`); }

const TI_LINES = [
  { equipment_name: 'Dock Levelers', category: 'Dock', quantity: 22, acquisition_type: 'ti', acquisition_cost: 4500 }, // 99,000
  { equipment_name: 'Office Build-Out', category: 'Office', quantity: 1, acquisition_type: 'ti', acquisition_cost: 450000 },
  { equipment_name: 'CCTV System', category: 'Security', quantity: 1, acquisition_type: 'ti', acquisition_cost: 60000 },
];
const MIXED_LINES = [
  ...TI_LINES,
  { equipment_name: 'Reach Truck', category: 'MHE', quantity: 6, acquisition_type: 'lease', monthly_cost: 800, monthly_maintenance: 150 },
  { equipment_name: 'RF Handheld', category: 'IT', quantity: 20, acquisition_type: 'capital', acquisition_cost: 2850, amort_years: 3 },
];

// ─────────────────────────────────────────────────────────
// tiAmortAnnual
// ─────────────────────────────────────────────────────────

t('tiAmortAnnual: TI upfront / contract years', () => {
  // 99,000 + 450,000 + 60,000 = 609,000 upfront; ÷ 5 = 121,800/yr
  const up = totalEquipmentTiUpfront(TI_LINES);
  near(up, 609000, 1, 'TI upfront');
  near(tiAmortAnnual(TI_LINES, 5), 121800, 1, 'TI amort y5');
  near(tiAmortAnnual(TI_LINES, 10), 60900, 1, 'TI amort y10');
});

t('tiAmortAnnual: no TI lines → 0', () => {
  const onlyCapital = [{ acquisition_type: 'capital', acquisition_cost: 5000, quantity: 1 }];
  eq(tiAmortAnnual(onlyCapital, 5), 0);
});

t('tiAmortAnnual: null/empty line list → 0', () => {
  eq(tiAmortAnnual(null, 5), 0);
  eq(tiAmortAnnual([], 5), 0);
});

t('tiAmortAnnual: contractYears=0 falls back to 5 default', () => {
  // Number(0) || 5 → 5, so amort = 609K / 5 = 121,800
  near(tiAmortAnnual(TI_LINES, 0), 121800, 1);
});

t('tiAmortAnnual: negative contractYears clamped to 1 (prevent div-by-zero)', () => {
  near(tiAmortAnnual(TI_LINES, -5), 609000, 1); // Math.max(1, -5) = 1
});

// ─────────────────────────────────────────────────────────
// totalFacilityCost + facilityCostBreakdown
// ─────────────────────────────────────────────────────────

const FACILITY = { totalSqft: 500000 };
const RATE = { lease_rate_psf_yr: 7.20, cam_rate_psf_yr: 1.10, tax_rate_psf_yr: 0.80, insurance_rate_psf_yr: 0.25 };
const UTIL = { avg_monthly_per_sqft: 0.12 };

t('totalFacilityCost: no tiAmort passes through unchanged (backward compat)', () => {
  const before = totalFacilityCost(FACILITY, RATE, UTIL);
  // 500K × 7.20 + 1.10 + 0.80 + 0.25 = 500K × 9.35 = 4,675,000
  // + 500K × 12 × 0.12 = 720,000 → 5,395,000
  near(before, 5395000, 1);
});

t('totalFacilityCost: tiAmort folded into total', () => {
  const withTi = totalFacilityCost(FACILITY, RATE, UTIL, { tiAmort: 121800 });
  near(withTi, 5395000 + 121800, 1);
});

t('facilityCostBreakdown: tiAmort exposed as distinct field', () => {
  const bd = facilityCostBreakdown(FACILITY, RATE, UTIL, { tiAmort: 121800 });
  near(bd.tiAmort, 121800, 1);
  near(bd.lease, 3600000, 1);      // 500K × 7.20
  near(bd.cam, 550000, 1);         // 500K × 1.10
  near(bd.tax, 400000, 1);         // 500K × 0.80
  near(bd.insurance, 125000, 1);   // 500K × 0.25
  near(bd.utility, 720000, 1);     // 500K × 12 × 0.12
  near(bd.total, 5395000 + 121800, 1);
});

t('facilityCostBreakdown: negative tiAmort clamped to 0 (defensive)', () => {
  const bd = facilityCostBreakdown(FACILITY, RATE, UTIL, { tiAmort: -50000 });
  eq(bd.tiAmort, 0);
});

// ─────────────────────────────────────────────────────────
// computeSummary integration — TI flows through facilityCost
// ─────────────────────────────────────────────────────────

t('computeSummary: facilityCost includes TI amortization when equipmentLines are passed', () => {
  const s = computeSummary({
    laborLines: [],
    indirectLaborLines: [],
    equipmentLines: MIXED_LINES,
    overheadLines: [],
    vasLines: [],
    startupLines: [],
    facility: FACILITY,
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    facilityRate: RATE,
    utilityRate: UTIL,
    contractYears: 5,
    targetMarginPct: 12,
    annualOrders: 0,
  });
  // base facility (no TI) = 5,395,000; + 121,800 TI amort = 5,516,800
  near(s.facilityCost, 5516800, 1, 'facilityCost with TI');
});

t('computeSummary: exposes tiUpfront + tiAmortAnnual as distinct summary fields (Brock 2026-04-21)', () => {
  const s = computeSummary({
    laborLines: [], indirectLaborLines: [], equipmentLines: MIXED_LINES,
    overheadLines: [], vasLines: [], startupLines: [],
    facility: FACILITY, shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    facilityRate: RATE, utilityRate: UTIL,
    contractYears: 5, targetMarginPct: 12, annualOrders: 0,
  });
  // 99K + 450K + 60K = 609K upfront
  near(s.tiUpfront, 609000, 1, 'summary.tiUpfront');
  // 609K / 5 = 121,800 amort/yr
  near(s.tiAmortAnnual, 121800, 1, 'summary.tiAmortAnnual');
  // equipmentCapital must NOT include TI (it's TI, not capital) — only the
  // capital line (RF Handheld: 20 × $2,850 = $57,000) should be here
  near(s.equipmentCapital, 57000, 1, 'summary.equipmentCapital excludes TI');
});

t('computeSummary: zero contractYears defaults to 5 via clamp', () => {
  const s = computeSummary({
    laborLines: [], indirectLaborLines: [], equipmentLines: MIXED_LINES,
    overheadLines: [], vasLines: [], startupLines: [],
    facility: FACILITY, shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    facilityRate: RATE, utilityRate: UTIL,
    contractYears: 0, targetMarginPct: 12, annualOrders: 0,
  });
  // 609,000 / 5 default = 121,800 → still 5,516,800
  near(s.facilityCost, 5516800, 1);
});

if (fail === 0) {
  console.log(`${pass}/${pass} passed`);
  console.log('TI rollup invariants pass ✓');
} else {
  console.log(`${pass}/${pass + fail} passed, ${fail} FAILED`);
  process.exit(1);
}
