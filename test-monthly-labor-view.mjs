// test-monthly-labor-view.mjs — Brock 2026-04-20
// Verifies computeMonthlyLaborView builds the right peak/avg/min FTE per
// month + per-MHE-type counts (ceil(FTE / shifts)) + seasonal flex deltas.

import { computeMonthlyLaborView } from './tools/cost-model/calc.monthly.js';
import { autoGenerateIndirectLabor, operatingHours } from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ── Synthetic 12-month period axis, single year, no pre-go-live ──
function periods(years = 1) {
  const out = [];
  for (let i = 0; i < years * 12; i++) {
    const d = new Date(2026, i, 1);
    out.push({
      id: i + 1,
      period_type: 'month',
      period_index: i,
      calendar_year: d.getFullYear(),
      calendar_month: d.getMonth() + 1,
      customer_fy_index: Math.floor(i / 12) + 1,
      customer_fm_index: (i % 12) + 1,
      label: `M${i + 1}`,
      is_pre_go_live: false,
    });
  }
  return out;
}

const FLAT_SEASONALITY = { monthly_shares: Array(12).fill(1/12) };
const PEAK_SEASONALITY = { monthly_shares: [0.05, 0.05, 0.06, 0.07, 0.08, 0.08, 0.08, 0.09, 0.10, 0.12, 0.12, 0.10] };

// ── Simple 2-line Y1 model ──
// Each line: 20,800 annual hours = 10 FTE at 2080 operating hours
function twoLineModel() {
  return [
    { id: 'l1', activity_name: 'Receive', annual_hours: 20800, mhe_type: 'reach_truck', it_device: 'rf_scanner', employment_type: 'permanent', hourly_rate: 22, burden_pct: 30 },
    { id: 'l2', activity_name: 'Pick',    annual_hours: 20800, mhe_type: 'order_picker', it_device: 'voice_pick', employment_type: 'permanent', hourly_rate: 20, burden_pct: 30 },
  ];
}

// ─── Direct FTE under flat seasonality — peak = avg = 10 + 10 = 20 ───
{
  const r = computeMonthlyLaborView({
    laborLines: twoLineModel(),
    periods: periods(1),
    annualOpHours: 2080,
    shiftsPerDay: 1,
    calcHeur: { overtimePct: 0, absenceAllowancePct: 0 },
    seasonality: FLAT_SEASONALITY,
  });
  t('flat season: 12 months produced', r.months.length === 12);
  t('flat season: each month total_fte ≈ 20',
    r.months.every(m => near(m.total_fte, 20, 0.01)),
    `first month = ${r.months[0].total_fte}`);
  t('flat season: peak ≈ avg ≈ min', near(r.summary.direct.peakFte, r.summary.direct.avgFte, 0.01) && near(r.summary.direct.avgFte, r.summary.direct.minFte, 0.01));
}

// ─── Peak seasonality: peak month = 12%, min = 5% → ratio 2.4× avg ───
{
  const r = computeMonthlyLaborView({
    laborLines: twoLineModel(),
    periods: periods(1),
    annualOpHours: 2080,
    shiftsPerDay: 1,
    calcHeur: { overtimePct: 0, absenceAllowancePct: 0 },
    seasonality: PEAK_SEASONALITY,
  });
  // peak FTE = 20 × 0.12 × 12 = 28.8
  // avg FTE = 20 (the mean)
  // min FTE = 20 × 0.05 × 12 = 12
  t('peak FTE scales with peak seasonality',  near(r.summary.direct.peakFte, 28.8, 0.1), `got ${r.summary.direct.peakFte}`);
  t('avg FTE ≈ base total 20',                near(r.summary.direct.avgFte, 20, 0.1));
  t('min FTE scales with min seasonality',    near(r.summary.direct.minFte, 12, 0.1), `got ${r.summary.direct.minFte}`);
}

// ─── MHE count: peak-month 28.8 FTE split 14.4 reach_truck + 14.4 order_picker ───
// With 2 shifts: reach_truck peakCount = ceil(14.4/2) = 8; baseline (from min) = ceil(6/2) = 3
{
  const r = computeMonthlyLaborView({
    laborLines: twoLineModel(),
    periods: periods(1),
    annualOpHours: 2080,
    shiftsPerDay: 2,
    calcHeur: { overtimePct: 0, absenceAllowancePct: 0 },
    seasonality: PEAK_SEASONALITY,
  });
  const rt = r.summary.byMhe['reach_truck'];
  t('by_mhe: reach_truck present', !!rt);
  t('by_mhe: reach_truck peakFte ≈ 14.4', near(rt?.peakFte || 0, 14.4, 0.1));
  t('by_mhe: reach_truck peakCount = ceil(14.4/2) = 8', rt?.peakCount === 8, `got ${rt?.peakCount}`);
  t('by_mhe: reach_truck baselineCount = ceil(6/2) = 3', rt?.baselineCount === 3, `got ${rt?.baselineCount}`);
  t('by_mhe: seasonalCount = peak - baseline = 5', rt?.seasonalCount === 5);
  // IT device path
  const rf = r.summary.byIt['rf_scanner'];
  t('by_it: rf_scanner present + count = 8',  rf?.peakCount === 8);
}

// ─── Volume growth across multiple contract years ───
{
  const r = computeMonthlyLaborView({
    laborLines: twoLineModel(),
    periods: periods(3),
    annualOpHours: 2080,
    shiftsPerDay: 1,
    calcHeur: { overtimePct: 0, absenceAllowancePct: 0 },
    seasonality: FLAT_SEASONALITY,
    volGrowthPct: 10,  // +10% vol per year
  });
  t('3 contract years = 36 months', r.months.length === 36);
  // Y1 flat = 20, Y2 × 1.10 = 22, Y3 × 1.21 = 24.2
  t('Y1 mid-month FTE ≈ 20', near(r.months[5].total_fte, 20, 0.1));
  t('Y2 mid-month FTE ≈ 22', near(r.months[17].total_fte, 22, 0.1));
  t('Y3 mid-month FTE ≈ 24.2', near(r.months[29].total_fte, 24.2, 0.1));
  t('peakFte = Y3 month value', near(r.summary.direct.peakFte, 24.2, 0.1));
}

// ─── "Manual" MHE type is excluded from fleet counts (not a physical MHE) ───
{
  const lines = [
    { id: 'l1', activity_name: 'Stage', annual_hours: 20800, mhe_type: 'manual', it_device: 'rf_scanner' },
  ];
  const r = computeMonthlyLaborView({
    laborLines: lines,
    periods: periods(1),
    annualOpHours: 2080,
    shiftsPerDay: 1,
    seasonality: FLAT_SEASONALITY,
  });
  t('manual mhe_type excluded', !r.summary.byMhe['manual']);
  t('rf_scanner still tracked',  !!r.summary.byIt['rf_scanner']);
}

// ─── Shift structure halves MHE count ───
{
  const lines = [
    { id: 'l1', activity_name: 'Forklift op', annual_hours: 20800, mhe_type: 'sit_down_forklift' },  // 10 FTE
  ];
  const r1 = computeMonthlyLaborView({
    laborLines: lines, periods: periods(1),
    annualOpHours: 2080, shiftsPerDay: 1,
    seasonality: FLAT_SEASONALITY,
  });
  const r2 = computeMonthlyLaborView({
    laborLines: lines, periods: periods(1),
    annualOpHours: 2080, shiftsPerDay: 2,
    seasonality: FLAT_SEASONALITY,
  });
  t('1 shift: 10 FTE → 10 forklifts', r1.summary.byMhe['sit_down_forklift'].peakCount === 10);
  t('2 shifts: 10 FTE → 5 forklifts', r2.summary.byMhe['sit_down_forklift'].peakCount === 5);
}

// ─── Indirect summary plugged via indirectGenerator ───
{
  const lines = [
    { id: 'l1', activity_name: 'Pick', annual_hours: 20800, mhe_type: 'order_picker' },  // 10 FTE
    { id: 'l2', activity_name: 'Pack', annual_hours: 41600, mhe_type: 'manual' },         // 20 FTE
  ];
  // Real state shape for autoGenerateIndirectLabor
  const state = {
    laborLines: lines,
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    facility: { totalSqft: 150000 },
    volumeLines: [{ isOutboundPrimary: true, volume: 1000000 }],
  };
  const r = computeMonthlyLaborView({
    laborLines: lines, periods: periods(1),
    annualOpHours: 2080, shiftsPerDay: 1,
    seasonality: PEAK_SEASONALITY,
    indirectGenerator: autoGenerateIndirectLabor,
    state,
  });
  t('indirectSummary produced',             !!r.summary.indirect);
  t('indirect peakHc > 0',                   (r.summary.indirect?.peakHc || 0) > 0);
  t('indirect peakHc >= avgHc',              r.summary.indirect.peakHc >= r.summary.indirect.avgHc);
  t('indirect byRole has entries',           r.summary.indirect.byRole.length > 0);
}

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
