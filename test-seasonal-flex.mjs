// test-seasonal-flex.mjs — Brock 2026-04-20
// Verifies seasonal flex flows into Equipment + Indirect Labor cost:
//   - equipLineAnnual with peakOverflowByMonth
//   - equipLineAnnualBreakdown
//   - totalEquipmentCost / totalEquipmentCostBreakdown with MLV
//   - indirectLineAnnualSimple with peak_only_hc + peak_months + peak_markup_pct
//   - equipmentOverflowByLine matching logic

import {
  equipLineAnnual,
  equipLineAnnualBreakdown,
  equipmentOverflowByLine,
  totalEquipmentCost,
  totalEquipmentCostBreakdown,
  indirectLineAnnualSimple,
  indirectLineAnnualBreakdown,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ─── Equipment: no seasonal overflow means baseline unchanged ───
{
  const line = { quantity: 10, monthly_cost: 800, monthly_maintenance: 100, acquisition_type: 'lease' };
  // Baseline: 10 × 900 × 12 = 108,000
  t('equipLineAnnual: no overflow returns baseline',
    equipLineAnnual(line) === 108000);
  t('equipLineAnnual: overflow but no markup → baseline',
    equipLineAnnual(line, [0,0,0,0,0,0,0,0,0,2,2,2]) === 108000);
}

// ─── Equipment: overflow with markup adds seasonal uplift ───
{
  const line = { quantity: 10, monthly_cost: 800, monthly_maintenance: 100,
                 acquisition_type: 'lease', peak_markup_pct: 20 };
  // Overflow: 2 extra units in Oct/Nov/Dec → 3 months of 2 extras
  // Seasonal = 2 × 900 × 1.20 × 3 months = 6,480
  // Total = 108,000 + 6,480 = 114,480
  const overflow = [0,0,0,0,0,0,0,0,0,2,2,2];
  t('equipLineAnnual: 20% markup + 3 mo × 2 units → +$6480',
    equipLineAnnual(line, overflow) === 114480, `got ${equipLineAnnual(line, overflow)}`);
  const bd = equipLineAnnualBreakdown(line, overflow);
  t('breakdown baseline = 108000', bd.baseline === 108000);
  t('breakdown seasonal = 6480',   bd.seasonal === 6480);
  t('breakdown total matches',     bd.total === 114480);
}

// ─── Equipment purchase lines: only maintenance counts + peak uses maint rate ───
{
  const line = { quantity: 5, monthly_cost: 0, monthly_maintenance: 200,
                 acquisition_type: 'purchase', peak_markup_pct: 30 };
  // baseline: 5 × 200 × 12 = 12,000
  // overflow 1 × 3 mo × 200 × 1.30 = 780
  const bd = equipLineAnnualBreakdown(line, [0,0,0,0,0,0,0,0,0,1,1,1]);
  t('purchase line baseline: only maintenance', bd.baseline === 12000);
  t('purchase seasonal uses maintenance rate + markup',
    near(bd.seasonal, 780, 0.01), `got ${bd.seasonal}`);
}

// ─── equipmentOverflowByLine: MHE type match + shift divide ───
{
  const lines = [
    { equipment_name: 'Reach Truck', category: 'MHE', mhe_type: 'reach_truck', quantity: 6, monthly_cost: 800, peak_markup_pct: 20 },
    { equipment_name: 'Order Picker', category: 'MHE', mhe_type: 'order_picker', quantity: 9, monthly_cost: 600, peak_markup_pct: 15 },
    { equipment_name: 'Pallet Rack', category: 'Racking', quantity: 5000, monthly_cost: 0 }, // no MHE
  ];
  // Synthetic MLV: reach_truck needs 19.1 FTE in peak months, 16.3 in min
  // With 3 shifts: peak count = ceil(19.1/3) = 7, min count = ceil(16.3/3) = 6
  // So overflow for reach_truck = 1 unit during peak calendar months
  const mlv = {
    months: [
      // 12 months × 1 year × alternating peak vs min for simplicity
      { calendar_month: 10, by_mhe: { reach_truck: 19.1, order_picker: 31.0 }, by_it: {} },
      { calendar_month: 11, by_mhe: { reach_truck: 19.1, order_picker: 31.0 }, by_it: {} },
      { calendar_month: 12, by_mhe: { reach_truck: 19.1, order_picker: 31.0 }, by_it: {} },
      { calendar_month: 1,  by_mhe: { reach_truck: 16.3, order_picker: 26.5 }, by_it: {} },
      { calendar_month: 2,  by_mhe: { reach_truck: 16.3, order_picker: 26.5 }, by_it: {} },
    ],
  };
  const overflows = equipmentOverflowByLine(lines, { mlv, shiftsPerDay: 3 });
  t('equipmentOverflowByLine: 3 outputs',   overflows.length === 3);
  t('equipmentOverflowByLine: reach_truck curve present', Array.isArray(overflows[0]) && overflows[0].length === 12);
  // Reach truck: Oct/Nov/Dec need ceil(19.1/3) = 7 → overflow 7-6 = 1 each
  //              Jan/Feb need ceil(16.3/3) = 6 → overflow 0 each
  //              Other months not in data → 0 each
  t('reach_truck Oct overflow = 1',  overflows[0][9]  === 1);
  t('reach_truck Nov overflow = 1',  overflows[0][10] === 1);
  t('reach_truck Dec overflow = 1',  overflows[0][11] === 1);
  t('reach_truck Jan overflow = 0',  overflows[0][0]  === 0);
  t('reach_truck Feb overflow = 0',  overflows[0][1]  === 0);
  // Order picker: peak = ceil(31/3) = 11, min = ceil(26.5/3) = 9
  // Oct/Nov/Dec need 11 → overflow 11-9 = 2 each
  t('order_picker Oct overflow = 2', overflows[1][9]  === 2);
  // Non-MHE line (pallet rack) gets no overflow curve
  t('non-MHE line: no overflow',     overflows[2] === null);
}

// ─── totalEquipmentCost with MLV passes overflow to each line ───
{
  const lines = [
    { equipment_name: 'Reach Truck', category: 'MHE', mhe_type: 'reach_truck',
      quantity: 6, monthly_cost: 800, monthly_maintenance: 0, peak_markup_pct: 20 },
  ];
  const mlv = {
    months: [
      { calendar_month: 10, by_mhe: { reach_truck: 19.1 }, by_it: {} },
      { calendar_month: 11, by_mhe: { reach_truck: 19.1 }, by_it: {} },
      { calendar_month: 12, by_mhe: { reach_truck: 19.1 }, by_it: {} },
    ],
  };
  const total = totalEquipmentCost(lines, { mlv, shiftsPerDay: 3 });
  // baseline = 6 × 800 × 12 = 57,600
  // overflow = 3 mo × 1 unit × 800 × 1.20 = 2,880
  // total = 60,480
  t('totalEquipmentCost with MLV → seasonal uplift included',
    total === 60480, `got ${total}`);
  const bd = totalEquipmentCostBreakdown(lines, { mlv, shiftsPerDay: 3 });
  t('breakdown baseline = 57600',  bd.baseline === 57600);
  t('breakdown seasonal = 2880',   bd.seasonal === 2880);
}

// ─── Indirect labor: no peak fields → baseline only ───
{
  const line = { role_name: 'Team Lead', headcount: 5, hourly_rate: 22, burden_pct: 30 };
  // baseline = 5 × 2080 × 22 × 1.30 = 297,440
  const simple = indirectLineAnnualSimple(line, 2080);
  t('indirect: no peak → baseline only', near(simple, 297440, 1), `got ${simple}`);
}

// ─── Indirect labor: peak_only_hc + peak_months + peak_markup_pct → uplift ───
{
  const line = {
    role_name: 'Team Lead', headcount: 5, hourly_rate: 22, burden_pct: 30,
    peak_only_hc: 2, peak_months: 3, peak_markup_pct: 30,
  };
  // baseline = 5 × 2080 × 22 × 1.30 = 297,440
  // 1 peak HC costs = 2080 × 22 × 1.30 = 59,488 annual full-year
  // 2 peak × 3/12 × 1.30 markup = 2 × 59,488 × 0.25 × 1.30 = 38,667.2
  const bd = indirectLineAnnualBreakdown(line, 2080);
  t('indirect breakdown: baseline correct', near(bd.baseline, 297440, 1));
  t('indirect breakdown: seasonal = 2×59488×0.25×1.30 ≈ 38,667',
    near(bd.seasonal, 38667.2, 1), `got ${bd.seasonal}`);
  t('indirect simple matches breakdown total',
    near(indirectLineAnnualSimple(line, 2080), bd.total, 0.01));
}

// ─── Indirect labor: peak_only_hc=0 → no seasonal (even with months/markup set) ───
{
  const line = { role_name: 'X', headcount: 1, hourly_rate: 20, burden_pct: 30,
                 peak_only_hc: 0, peak_months: 3, peak_markup_pct: 30 };
  t('indirect: peak_only_hc=0 → seasonal=0', indirectLineAnnualBreakdown(line, 2080).seasonal === 0);
}

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
