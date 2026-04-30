// Offline harness — run the production calc engine against Hearthwood Baseline
// (cost_model_projects.id=116) without involving the browser. Mirrors
// `ensureMonthlyBundle` from tools/cost-model/ui.js so the output matches what
// production would produce on a chrome-strip render.

import fs from 'node:fs';
import * as calc from './tools/cost-model/calc.js';
import * as scenarios from './tools/cost-model/calc.scenarios.js';

const STATE_DIR = '/sessions/dazzling-nifty-babbage/mnt/outputs/hearthwood_state';
const OUT = `${STATE_DIR}/calc_output.json`;

const model = JSON.parse(fs.readFileSync(`${STATE_DIR}/project_data.json`, 'utf8'));

// Facility rate (Columbus, OH; Class A Warehouse) - from Supabase
const facilityRate = {
  market_id: '486a100a-e4fd-4e05-8413-070b3e397a07',
  building_type: 'Class A Warehouse',
  lease_rate_psf_yr: 5.60,
  cam_rate_psf_yr: 1.00,
  tax_rate_psf_yr: 1.00,
  insurance_rate_psf_yr: 0.24,
  build_out_psf: 5.50,
  clear_height_ft: 34,
  dock_door_cost: 0,
};

const utilityRate = null;

const marketLaborProfile = {
  market_id: '486a100a-e4fd-4e05-8413-070b3e397a07',
  turnover_pct_annual: 38,
  temp_cost_premium_pct: 25,
  peak_month_overtime_pct: [0.05,0.05,0.05,0.05,0.05,0.07,0.07,0.08,0.10,0.12,0.12,0.08],
  peak_month_absence_pct:  [0.10,0.10,0.10,0.10,0.10,0.11,0.12,0.12,0.10,0.10,0.11,0.12],
  holiday_days_per_year: 11,
};

function seedPeriods(startYear, monthCount) {
  const ps = [];
  for (let i = 0; i < monthCount; i++) {
    const calMonth = ((i) % 12) + 1;
    const calYear  = startYear + Math.floor(i / 12);
    const fyIndex  = Math.floor(i / 12) + 1;
    const fmIndex  = ((i) % 12) + 1;
    ps.push({
      id: 1000 + i,
      period_type: 'month',
      period_index: i,
      calendar_year: calYear,
      calendar_month: calMonth,
      customer_fy_index: fyIndex,
      customer_fm_index: fmIndex,
      label: `Y${fyIndex}M${fmIndex}`,
      is_pre_go_live: false,
    });
  }
  return ps;
}
const periods = seedPeriods(2026, 60);

const fin = model.financial || {};
const lc  = model.laborCosting || {};
const projectCols = {
  taxRate:          25,
  targetMargin:     fin.targetMargin ?? 12,
  volumeGrowth:     fin.volumeGrowth ?? 0,
  discountRate:     fin.discountRate ?? 10,
  reinvestRate:     fin.reinvestRate ?? 8,
  dsoDays:          30,
  dpoDays:          30,
  laborPayableDays: 14,
  preGoLiveMonths:  0,
  benefitLoad:      35,
  bonus:            0,
  overtime:         lc.overtimePct ?? 5,
  absenceAllowance: 12,
  shift2Premium:    10,
  shift3Premium:    15,
  laborEscalation:  fin.laborEscalation ?? 3,
  costEscalation:     fin.annualEscalation ?? 3,
  annualEscalation:   fin.annualEscalation ?? 3,
  facilityEscalation: fin.annualEscalation ?? 3,
  equipmentEscalation: fin.annualEscalation ?? 3,
};

const calcHeur = scenarios.resolveCalcHeuristics(null, null, {}, projectCols, {});
const opHrs = calc.operatingHours(model.shifts || {});
const orderRow = (model.volumeLines || []).find(v => v.isOutboundPrimary);
const orders = orderRow ? Number(orderRow.volume) : 0;
const contractYears = model.projectDetails?.contractTerm || 5;
const marginFrac = (calcHeur.targetMarginPct || 0) / 100;

const summary = calc.computeSummary({
  laborLines:        model.laborLines || [],
  indirectLaborLines: model.indirectLaborLines || [],
  equipmentLines:    model.equipmentLines || [],
  overheadLines:     model.overheadLines || [],
  vasLines:          model.vasLines || [],
  startupLines:      model.startupLines || [],
  facility:          model.facility || {},
  shifts:            model.shifts || {},
  facilityRate,
  utilityRate,
  contractYears,
  targetMarginPct:   calcHeur.targetMarginPct,
  annualOrders:      orders || 1,
});

// Mirror production's buildEnrichedPricingBuckets: derive bucket.rate from
// cost-plus margin so the monthly engine's revenue path emits non-zero rows.
function buildEnrichedBuckets(summaryArg) {
  const startupWithAmort = (model.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears || 5),
  }));
  const buckets = model.pricingBuckets || [];
  const bucketCosts = calc.computeBucketCosts({
    buckets,
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost: summaryArg.facilityCost || 0,
    operatingHours: opHrs || 0,
    facilityBucketId: model.financial?.facilityBucketId || null,
  });
  const enriched = calc.enrichBucketsWithDerivedRates({
    buckets,
    bucketCosts,
    marginPct: marginFrac || 0,
    volumeLines: model.volumeLines || [],
    model,
  });
  return { enriched, bucketCosts };
}

const { enriched: enrichedBuckets, bucketCosts } = buildEnrichedBuckets(summary);

const projResult = calc.buildYearlyProjections({
  years: contractYears,
  baseLaborCost:     summary.laborCost,
  baseFacilityCost:  summary.facilityCost,
  baseEquipmentCost: summary.equipmentCost,
  baseOverheadCost:  summary.overheadCost,
  baseVasCost:       summary.vasCost,
  startupAmort:      summary.startupAmort,
  startupCapital:    summary.startupCapital,
  baseOrders:        orders || 1,
  marginPct:         marginFrac,
  volGrowthPct:      calcHeur.volGrowthPct  / 100,
  laborEscPct:       calcHeur.laborEscPct   / 100,
  costEscPct:        calcHeur.costEscPct    / 100,
  facilityEscPct:    calcHeur.facilityEscPct  / 100,
  equipmentEscPct:   calcHeur.equipmentEscPct / 100,
  laborLines:        model.laborLines || [],
  taxRatePct:        calcHeur.taxRatePct,
  useMonthlyEngine:  true,
  periods,
  ramp:              null,
  seasonality:       model.seasonalityProfile || null,
  preGoLiveMonths:   calcHeur.preGoLiveMonths,
  dsoDays:           calcHeur.dsoDays,
  dpoDays:           calcHeur.dpoDays,
  laborPayableDays:  calcHeur.laborPayableDays,
  startupLines:      model.startupLines || [],
  pricingBuckets:    enrichedBuckets,
  project_id:        model.id || 116,
  _calcHeur:         calcHeur,
  marketLaborProfile,
  wageLoadByYear:    null,
  equipmentLines:    model.equipmentLines || [],
});

const projections = projResult.projections;
const monthlyBundle = projResult.monthlyBundle || null;

const totalFtes = calc.totalFtes(model.laborLines || [], model.indirectLaborLines || [], opHrs);
const fixedCost = summary.facilityCost + summary.equipmentCost + summary.overheadCost + summary.startupAmort;
const annualDepreciation = summary.equipmentAmort + summary.startupAmort;

const metrics = calc.computeFinancialMetrics(projections, {
  startupCapital:  summary.startupCapital,
  equipmentCapital: summary.equipmentCapital,
  discountRatePct: calcHeur.discountRatePct,
  reinvestRatePct: calcHeur.reinvestRatePct,
  totalFtes,
  fixedCost,
  taxRatePct:        calcHeur.taxRatePct,
  annualDepreciation,
  dsoDays:           calcHeur.dsoDays,
  dpoDays:           calcHeur.dpoDays,
});

const directLineBreakdown = (model.laborLines || []).map(line => {
  const fte_  = calc.fte(line, opHrs);
  const annual = calc.directLineAnnual(line, { operatingHours: opHrs });
  const rate  = calc.fullyLoadedRate(line, { operatingHours: opHrs });
  return {
    activity: line.activity_name,
    bucket: line.pricing_bucket,
    volume: line.volume,
    base_uph: line.base_uph,
    annual_hours: line.annual_hours,
    hourly_rate: line.hourly_rate,
    burden_pct: line.burden_pct,
    fte: fte_,
    fully_loaded_rate: rate,
    annual_cost: annual,
  };
});

const indirectLineBreakdown = (model.indirectLaborLines || []).map(line => {
  const annual = calc.indirectLineAnnual(line, { operatingHours: opHrs });
  return {
    role: line.role_name,
    headcount: line.headcount,
    hourly_rate: line.hourly_rate,
    burden_pct: line.burden_pct,
    annual_cost: annual,
  };
});

const equipmentLineBreakdown = (model.equipmentLines || []).map(line => {
  const annual = calc.equipLineAnnual(line);
  return {
    name: line.equipment_name,
    category: line.category,
    line_type: line.line_type,
    quantity: line.quantity,
    monthly_cost: line.monthly_cost,
    monthly_maintenance: line.monthly_maintenance,
    acquisition_cost: line.acquisition_cost,
    acquisition_type: line.acquisition_type,
    seasonal_months: line.seasonal_months || null,
    annual_cost: annual,
  };
});

const facilitySqft = model.facility?.totalSqft || 0;
const tiUpfront = summary.tiUpfront;
const tiAmort = summary.tiAmortAnnual;
const facilityBreakdown = {
  total_sqft: facilitySqft,
  lease_psf_yr: facilityRate.lease_rate_psf_yr,
  cam_psf_yr: facilityRate.cam_rate_psf_yr,
  tax_psf_yr: facilityRate.tax_rate_psf_yr,
  insurance_psf_yr: facilityRate.insurance_rate_psf_yr,
  total_psf_yr: facilityRate.lease_rate_psf_yr + facilityRate.cam_rate_psf_yr +
                facilityRate.tax_rate_psf_yr + facilityRate.insurance_rate_psf_yr,
  rent_annual: facilitySqft * (facilityRate.lease_rate_psf_yr + facilityRate.cam_rate_psf_yr +
                facilityRate.tax_rate_psf_yr + facilityRate.insurance_rate_psf_yr),
  ti_upfront: tiUpfront,
  ti_amort_annual: tiAmort,
  total_facility_cost_annual: summary.facilityCost,
};

const out = {
  generated_at: new Date().toISOString(),
  source: 'offline harness mirroring ensureMonthlyBundle',
  model_id: model.id,
  scenario: 'Baseline',
  contract_years: contractYears,
  market: 'Columbus, OH',
  facility_rate: facilityRate,
  market_labor_profile: marketLaborProfile,
  resolved_heuristics: calcHeur,
  primary_outbound_orders_legacy: orders,
  total_ftes: totalFtes,
  bucket_costs: bucketCosts,
  enriched_buckets: enrichedBuckets,
  summary,
  projections,
  metrics,
  direct_line_breakdown: directLineBreakdown,
  indirect_line_breakdown: indirectLineBreakdown,
  equipment_line_breakdown: equipmentLineBreakdown,
  facility_breakdown: facilityBreakdown,
  monthly_engine_used: !!monthlyBundle,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('Wrote', OUT);
const y1 = projections[0];
console.log('Y1 Revenue:', y1?.revenue?.toFixed(0));
console.log('Y1 Cost:', y1?.totalCost?.toFixed(0));
console.log('Y1 GP:', y1?.grossProfit?.toFixed(0));
console.log('Y1 EBITDA:', y1?.ebitda?.toFixed(0));
console.log('Y1 EBIT:', y1?.ebit?.toFixed(0));
console.log('Y1 Tax:', y1?.taxes?.toFixed(0));
console.log('Y1 Net Income:', y1?.netIncome?.toFixed(0));
console.log('Y1 ΔWC:', y1?.workingCapitalChange?.toFixed(0));
console.log('Y1 OpCF:', y1?.operatingCashFlow?.toFixed(0));
console.log('Y1 FCF:', y1?.freeCashFlow?.toFixed(0));
console.log('Total FTEs:', totalFtes.toFixed(1));
console.log('Y1 GP Margin:', y1?.revenue > 0 ? ((y1.grossProfit/y1.revenue)*100).toFixed(2)+'%' : 'n/a');
console.log('NPV(5yr) @' + calcHeur.discountRatePct + '%:', metrics.npv?.toFixed(0));
console.log('ROIC:', metrics.roicPct?.toFixed(2) + '%');
console.log('Payback (months):', metrics.paybackMonths);
console.log('Contract value (5yr revenue):', metrics.contractValue?.toFixed(0));
