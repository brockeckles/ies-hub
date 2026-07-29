// test-cm-compute-seam.mjs — M2 recompute seam (2026-07-10)
//
// Locks the compute-all.js seam introduced in M2:
//   1. computeAll(ctx) result shape — everything the M3 D-shell's live
//      P&L rail will subscribe to.
//   2. Memo contract — same inputs return the SAME object (render cheaply),
//      any model/override/what-if mutation recomputes (content-fingerprint,
//      no invalidation wiring to miss).
//   3. Single-seam parity — computeHeaderKpis rides the same seam, so its
//      kpiCtx numbers must be identical to computeAll's outputs.
//   4. Source pins — the calc pipeline must not creep back into render
//      fns: ui.js keeps exactly ONE direct computeSummary call (the Excel
//      export handler, deliberately out-of-seam) and ZERO direct
//      buildYearlyProjections / computeMonthlyLaborView calls;
//      header-kpis.js has none of the three.
//
// Run: node test-cm-compute-seam.mjs

import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

// NOTE: the ?v= pin MUST match ui.js/header-kpis.js's import URL — ES modules
// key on the full URL, and a bare import would create a SECOND compute-all
// instance with its own memo (feedback_test_cache_bust_match class).
const { computeAll, invalidateComputeAll } = await import('./tools/cost-model/compute-all.js?v=20260728-s7d');
const { computeHeaderKpis } = await import('./tools/cost-model/header-kpis.js');
const scenarios = await import('./tools/cost-model/calc.scenarios.js');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- Fixture (realistic multi-line model) ----
function makeModel() {
  return {
    projectDetails: { contractTerm: 5, name: 'Seam', market: 'mkt-1', goLiveDate: '2026-03-01' },
    financial: { targetMargin: 14, gaMargin: 5.25, mgmtFeeMargin: 8.75, discountRate: 10, volumeGrowth: 3, annualEscalation: 3 },
    volumeLines: [{ name: 'Orders Packed', uom: 'orders', volume: 800000, isOutboundPrimary: true }],
    laborLines: [
      { activity_name: 'Each Pick', annual_hours: 120000, hourly_rate: 19.5, volume: 800000, base_uph: 60, pricing_bucket: 'each_pick', employment_type: 'direct' },
      { activity_name: 'Pack', annual_hours: 80000, hourly_rate: 18, volume: 800000, base_uph: 45, pricing_bucket: 'pick_pack' },
    ],
    indirectLaborLines: [{ role: 'Supervisor', headcount: 4, annual_salary: 75000 }],
    equipmentLines: [{ equipment_name: 'Forklift', category: 'MHE', line_type: 'owned_mhe', quantity: 6, acquisition_cost: 42000, amort_years: 7, monthly_maintenance: 250 }],
    overheadLines: [{ category: 'Supplies', annual_cost: 120000 }],
    vasLines: [{ name: 'Kitting', annual_units: 50000, unit_cost: 0.8 }],
    startupLines: [{ name: 'Racking install', cost: 500000 }],
    facility: { totalSqft: 300000, clearHeightFt: 32 },
    shifts: { shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52, ptoHoursPerYear: 80, holidayHoursPerYear: 64, directUtilization: 85 },
    laborCosting: { defaultBurdenPct: 32, overtimePct: 5, turnoverPct: 45 },
    pricingBuckets: [
      { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed', uom: 'month' },
      { id: 'each_pick', name: 'Each Pick', type: 'variable', uom: 'each', rate: 0.42 },
      { id: 'pick_pack', name: 'Pick & Pack', type: 'variable', uom: 'order' },
    ],
    seasonalityProfile: { preset: 'retail_q4', monthly_shares: [0.06, 0.06, 0.07, 0.07, 0.08, 0.08, 0.08, 0.09, 0.09, 0.10, 0.11, 0.11] },
    channels: [],
  };
}
const refData = {
  facilityRates: [{ market_id: 'mkt-1', lease_rate_sqft_yr: 8.5, utilities_sqft_yr: 1.2 }],
  utilityRates: [{ market_id: 'mkt-1', rate: 1.1 }],
  periods: [],
};
function makeCtx(model) {
  return {
    model, refData,
    currentScenario: null, currentScenarioSnapshots: null,
    heuristicOverrides: {}, whatIfTransient: null, currentMarketLaborProfile: null,
  };
}

// ---- 1. Result shape ----
invalidateComputeAll();
const model = makeModel();
const ctx = makeCtx(model);
const c = computeAll(ctx);

t('computeAll returns the full seam shape', () => {
  for (const k of ['summary', 'pricingSnapshot', 'projections', 'monthlyBundle', 'metrics',
    'calcHeur', 'laborOpts', 'marginFrac', 'channelLineage', 'opHrs', 'orders',
    'outboundUomLabel', 'contractYears', 'fin', 'getMlv']) {
    assert(k in c || typeof c[k] === 'function', `missing key: ${k}`);
  }
  assert(c.summary.totalCost > 0, 'summary.totalCost > 0');
  assert(Array.isArray(c.projections) && c.projections.length === 5, '5-year projections');
  assert(Array.isArray(c.pricingSnapshot.buckets) && c.pricingSnapshot.buckets.length > 0, 'enriched buckets');
  assert(c.metrics && typeof c.metrics.npv === 'number', 'metrics.npv');
  assert(c.orders === 800000, 'orders resolved from outbound-primary line');
});

t('getMlv is lazy, memoized per variant, and builds 60 months', () => {
  const mlv = c.getMlv(true);
  assert(mlv && mlv.months.length === 60, '60-month MLV');
  assert(c.getMlv(true) === mlv, 'with-indirect variant memoized');
  const plain = c.getMlv(false);
  assert(plain && plain !== mlv, 'no-indirect variant is a distinct result');
  assert(c.getMlv(false) === plain, 'no-indirect variant memoized');
});

// ---- 2. Memo contract ----
t('same inputs → same object identity (render is cheap)', () => {
  assert(computeAll(ctx) === c, 'memo hit expected');
});

t('model mutation → recompute with moved numbers', () => {
  model.laborLines[0].hourly_rate = 25;
  const c2 = computeAll(ctx);
  assert(c2 !== c, 'memo must miss after mutation');
  assert(c2.summary.laborCost > c.summary.laborCost, 'labor cost moved with the rate');
  model.laborLines[0].hourly_rate = 19.5;
});

t('what-if transient participates in the fingerprint', () => {
  const base = computeAll(ctx);
  // transient keys are heuristic-catalog snake_case (resolveCalcHeuristics
  // pick('target_margin_pct', …))
  const ctx2 = { ...ctx, whatIfTransient: { target_margin_pct: 22 } };
  const cWhatIf = computeAll(ctx2);
  assert(cWhatIf !== base, 'what-if overlay must recompute');
  assert(cWhatIf.marginFrac !== base.marginFrac, 'marginFrac follows the overlay');
});

t('refData is identity-keyed: replacing the bag recomputes', () => {
  const base = computeAll(ctx);
  const ctx3 = { ...ctx, refData: { ...refData } };
  assert(computeAll(ctx3) !== base, 'new refData object must recompute');
});

// M5-Operation (2026-07-13) — the transient dl-productivity lever now
// feeds the MAIN pipeline (closes the M4 "chip moves, rail doesn't" wart).
// Transient-only by design: persisted overrides don't move saved numbers.
t('M5 — transient dl-productivity scales pipeline labor; idle lever is a zero-diff no-op', () => {
  invalidateComputeAll();
  const base = computeAll(makeCtx(makeModel()));
  const worse = computeAll({ ...makeCtx(makeModel()), whatIfTransient: { direct_labor_productivity_pct: 90 } });
  assert(worse.summary.laborCost > base.summary.laborCost * 1.02,
    `90% productivity must raise labor cost (${worse.summary.laborCost} vs ${base.summary.laborCost})`);
  const at100 = computeAll({ ...makeCtx(makeModel()), whatIfTransient: { direct_labor_productivity_pct: 100 } });
  assert(Math.abs(at100.summary.laborCost - base.summary.laborCost) < 1, '100% = no scaling');
  // Persisted override must NOT move the pipeline (saved numbers pinned).
  const ovr = computeAll({ ...makeCtx(makeModel()), heuristicOverrides: { direct_labor_productivity_pct: 90 } });
  assert(Math.abs(ovr.summary.laborCost - base.summary.laborCost) < 1,
    'persisted override stays preview-only — pipeline labor unchanged');
  // The input model object is never mutated (zero writes, engines frozen).
  const m = makeModel();
  const before = JSON.stringify(m.laborLines);
  computeAll({ ...makeCtx(m), whatIfTransient: { direct_labor_productivity_pct: 85 } });
  assert(JSON.stringify(m.laborLines) === before, 'ctx.model.laborLines untouched by the scaling');
});

// ---- 3. Header KPIs ride the same seam ----
t('computeHeaderKpis numbers are identical to computeAll outputs', () => {
  invalidateComputeAll();
  const m = makeModel();
  const kpis = computeHeaderKpis({
    model: m, refData, userHasInteracted: true,
    whatIfTransient: null, currentScenario: null, currentScenarioSnapshots: null,
    heuristicOverrides: {}, currentMarketLaborProfile: null, scenarios,
  });
  assert(kpis.ready, 'ready with populated model');
  const cc = computeAll(makeCtx(m));
  assert(kpis.kpiCtx.summary === cc.summary, 'summary is the SAME object (single seam, memo shared)');
  assert(kpis.kpiCtx.projections === cc.projections, 'projections same object');
  assert(kpis.kpiCtx.kpi.npv === cc.metrics.npv, 'npv identical');
  assert(kpis.kpiCtx.kpi.totalFtes === (cc.summary.totalFtes || 0), 'FTEs identical');
});

// ---- 4. Source pins — pipeline can't creep back into render fns ----
const uiSrc = readFileSync('./tools/cost-model/ui.js', 'utf8');
const hkSrc = readFileSync('./tools/cost-model/header-kpis.js', 'utf8');

t('ui.js: exactly one direct computeSummary call left (Excel export, out-of-seam by design)', () => {
  const n = (uiSrc.match(/calc\.computeSummary\(/g) || []).length;
  assert(n === 1, `expected 1, found ${n} — new call sites must consume computeAll instead`);
});

t('ui.js: zero direct buildYearlyProjections / computeMonthlyLaborView calls', () => {
  assert((uiSrc.match(/calc\.buildYearlyProjections\(/g) || []).length === 0, 'buildYearlyProjections crept back');
  assert((uiSrc.match(/monthlyCalc\.computeMonthlyLaborView\(/g) || []).length === 0, 'computeMonthlyLaborView crept back');
});

t('ui.js: seam consumers call computeAll(_computeCtx()) — core four present', () => {
  // Core four from M2: renderSummary, ensureMonthlyBundle, MLV card,
  // equipment probe. Chrome-level consumers (M3 D-shell rail/subs, later
  // rail inspector) may add more — that is the seam working as designed,
  // so this is a floor, not an exact count. Engine creep-back is caught
  // by the zero-direct-call asserts above.
  const n = (uiSrc.match(/computeAll\(_computeCtx\(\)\)/g) || []).length;
  assert(n >= 4, `expected >=4 seam call sites, found ${n}`);
});

t('header-kpis.js: no direct pipeline calls; consumes computeAll', () => {
  for (const bad of ['calc.computeSummary(', 'calc.buildYearlyProjections(', 'calc.computePricingSnapshot(', 'resolveCalcHeuristics(']) {
    assert(!hkSrc.includes(bad), `${bad} crept back into header-kpis`);
  }
  assert(hkSrc.includes('computeAll({'), 'computeAll consumption missing');
});

t('compute-all.js: engines-frozen guard — seam imports engines, never redefines math', () => {
  const caSrc = readFileSync('./tools/cost-model/compute-all.js', 'utf8');
  assert(caSrc.includes("from './calc.js?v="), 'imports calc engine');
  assert(caSrc.includes('calc.computeSummary({'), 'delegates summary to engine');
  assert(caSrc.includes('scenarios.buildProjectionParams({'), 'uses the Phase-2a shared params builder');
  assert(!/function\s+(computeSummary|buildYearlyProjections|computeMonthlyLaborView)\b/.test(caSrc),
    'seam must not re-implement engine functions');
});

t('W2: channel aggregate is authoritative for orders when channels exist', () => {
  // Brock ruling 2026-07-13 — Σ non-reverse channels' derived orders wins;
  // the starred line only anchors channel-less models (case above).
  const m2 = makeModel();
  m2.channels = [
    { key: 'outbound', name: 'DTC', primary: { uom: 'orders', value: 1400000, activity: 'outbound' } },
    { key: 'b2b-retail', name: 'B2B', primary: { uom: 'orders', value: 600000, activity: 'outbound' } },
    { key: 'reverse', name: 'Returns', primary: { uom: 'orders', value: 250000, activity: 'returns' } },
  ];
  invalidateComputeAll();
  const c2 = computeAll(makeCtx(m2));
  assert(c2.orders === 2000000, `orders = DTC + B2B, reverse excluded (got ${c2.orders})`);
  assert(c2.outboundUomLabel === 'Order', `uom label re-bases to orders (got ${c2.outboundUomLabel})`);
  assert(c2.projections[0].orders === 2000000, 'Y1 projections ride the aggregate');
  assert(Math.abs(c2.summary.costPerOrder - c2.summary.totalCost / 2000000) < 1e-9, 'costPerOrder denominators re-base');
  // Channels present but zero-valued → starred-line fallback.
  const m3 = makeModel();
  m3.channels = [{ key: 'outbound', name: 'DTC', primary: { uom: 'orders', value: 0, activity: 'outbound' } }];
  invalidateComputeAll();
  const c3 = computeAll(makeCtx(m3));
  assert(c3.orders === 800000, 'zero-valued channels fall back to the starred line');
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-compute-seam: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
