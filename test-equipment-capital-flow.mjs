// test-equipment-capital-flow.mjs — regression net for 2026-06-10 Critical #3:
// "capital-equipment purchase cost vanishes from the P&L, FCF, and NPV entirely."
//
// Pre-fix: computeSummary.totalCost excluded equipment amortization, the revenue
// gross-up never recovered acquisition cost, and no projection caller passed
// amort into baseEquipmentCost — so capital lines (RF handhelds, switches,
// security capex) appeared in NO cost, NO depreciation, NO capex, NO cash flow.
//
// Post-fix contract (opex-amortization accounting per the R5 inline doc):
//   1. summary.totalCost includes totalEquipmentAmort (capital lines only)
//   2. summary.equipmentRevenue grosses up (equipmentCost + equipmentAmort)
//   3. adding acquisition_cost to a capital line moves totalCost by exactly
//      acquisition/amort_years — and moves revenue by its gross-up
//   4. lease/service/ti lines contribute ZERO amort (no double count)
//   5. legacy projections carry amort via baseEquipmentCost; NPV @ r=0 still
//      ties to cumFcf (the R5 identity survives the fix)
//
// Run:  node test-equipment-capital-flow.mjs

import {
  computeSummary,
  totalEquipmentAmort,
  buildYearlyProjections,
  computeFinancialMetrics,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function near(a, b, eps = 0.5, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const CAPITAL_LINE = {
  line_type: 'it_equipment', description: 'RF handhelds',
  quantity: 48, acquisition_type: 'capital',
  acquisition_cost: 2850, amort_years: 5, monthly_maintenance: 15,
};
// 48 × 2850 / 5 = 27,360/yr amort; 48 × 15 × 12 = 8,640/yr maintenance

function summarize(equipmentLines) {
  return computeSummary({
    laborLines: [], indirectLaborLines: [],
    equipmentLines,
    overheadLines: [], vasLines: [], startupLines: [],
    facility: { squareFeet: 0 },
    contractYears: 5,
    targetMarginPct: 12,
    annualOrders: 1_000_000,
  });
}

// ── 1. amort flows into totalCost ──────────────────────────────────────────
t('capital amort included in summary.totalCost', () => {
  const s = summarize([CAPITAL_LINE]);
  near(s.equipmentAmort, 27_360, 0.5, 'equipmentAmort');
  near(s.equipmentCost, 8_640, 0.5, 'equipmentCost (opex stays maintenance-only)');
  near(s.totalCost, 8_640 + 27_360, 0.5, 'totalCost = opex + amort');
});

// ── 2. revenue gross-up recovers capital ───────────────────────────────────
t('equipmentRevenue grosses up opex + amort', () => {
  const s = summarize([CAPITAL_LINE]);
  near(s.equipmentRevenue, (8_640 + 27_360) / (1 - 0.12), 1, 'equipmentRevenue');
  near(s.totalRevenue, s.equipmentRevenue, 1, 'only category present');
});

// ── 3. delta test: acquisition cost moves the P&L by exactly amort ─────────
t('adding acquisition cost moves totalCost by acquisition/amort_years', () => {
  const withCap = summarize([CAPITAL_LINE]);
  const noCap   = summarize([{ ...CAPITAL_LINE, acquisition_cost: 0 }]);
  near(withCap.totalCost - noCap.totalCost, 27_360, 0.5, 'totalCost delta');
  assert(withCap.totalRevenue > noCap.totalRevenue, 'revenue must recover capital');
});

// ── 4. non-capital acquisition types contribute zero amort ─────────────────
t('lease/service/ti lines contribute zero amort (no double count)', () => {
  const lines = [
    { line_type: 'owned_mhe', quantity: 10, acquisition_type: 'lease', monthly_cost: 800, monthly_maintenance: 150, acquisition_cost: 35_000 },
    { line_type: 'it_equipment', quantity: 2, acquisition_type: 'service', monthly_cost: 500, acquisition_cost: 10_000 },
    { line_type: 'facility_equipment', quantity: 1, acquisition_type: 'ti', acquisition_cost: 250_000 },
  ];
  near(totalEquipmentAmort(lines), 0, 0.001, 'amort must be capital-only');
  const s = summarize(lines);
  near(s.equipmentAmort, 0, 0.001, 'summary.equipmentAmort');
});

// ── 5. projections + metrics: amort flows, R5 NPV identity survives ────────
t('projections carry amort via baseEquipmentCost; NPV @ r=0 ties to cumFcf', () => {
  const s = summarize([CAPITAL_LINE]);
  const baseEquipment = s.equipmentCost + (s.equipmentAmort || 0); // new caller convention
  const { projections, startupCapital } = buildYearlyProjections({
    years: 5,
    baseLaborCost: 1_000_000,
    baseFacilityCost: 500_000,
    baseEquipmentCost: baseEquipment,
    baseOverheadCost: 0, baseVasCost: 0,
    startupAmort: 0, startupCapital: 100_000,
    baseOrders: 1_000_000,
    targetMarginPct: 12,
    laborEscPct: 0, costEscPct: 0, volumeGrowthPct: 0,
    useMonthlyEngine: false,
  });
  near(projections[0].equipment, baseEquipment, 1, 'Y1 equipment expense includes amort');
  const metrics = computeFinancialMetrics(projections, {
    startupCapital, equipmentCapital: s.equipmentCapital,
    discountRatePct: 0, reinvestRatePct: 8, totalFtes: 10,
  });
  const cumFcf = projections[projections.length - 1].cumFcf;
  near(metrics.npv, cumFcf, 1, 'NPV @ r=0 === cumFcf(YN)');
  near(metrics.totalInvestment, startupCapital, 0.5, 'Y0 outflow stays startup-only (no double count)');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
