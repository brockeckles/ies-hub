// test-cm-projection-params.mjs — locks the Phase 2a single-source-of-truth
// contract for projection/metrics param assembly (2026-06-10 assessment).
//
// History: Summary, ensureMonthlyBundle, header KPIs, and What-If each
// hand-assembled a ~40-key buildYearlyProjections bag. Finding #10 (discount
// rate honored by 1 of 3 NPV surfaces) and #11 (What-If missing SG&A
// overlay) were both one-site-missing-one-key bugs. buildProjectionParams /
// buildMetricsOpts are now the only assembly points; this test pins the
// keys whose absence caused those bugs, so a future hand-rolled bag (or a
// builder regression) fails loudly.
//
// Run:  node test-cm-projection-params.mjs

import { buildProjectionParams, buildMetricsOpts } from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, eps = 1e-9, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ${b}, got ${a}`); }

const MODEL = {
  id: 42,
  laborLines: [{ hourly_rate: 18, annual_hours: 2080 }],
  startupLines: [],
  seasonalityProfile: null,
  financial: { sgaOverlayPct: 4.5, sgaAppliesTo: 'gross_revenue' },
};
const SUMMARY = {
  laborCost: 1_000_000, facilityCost: 500_000,
  equipmentCost: 80_000, equipmentAmort: 27_360,
  overheadCost: 60_000, vasCost: 0,
  startupAmort: 20_000, startupCapital: 100_000,
  equipmentCapital: 136_800, totalFtes: 25,
};
const HEUR = {
  targetMarginPct: 12, volGrowthPct: 2, laborEscPct: 3, costEscPct: 2.5,
  facilityEscPct: 2, equipmentEscPct: 1.5, taxRatePct: 25,
  preGoLiveMonths: 2, dsoDays: 45, dpoDays: 30, laborPayableDays: 14,
  discountRatePct: 7.5, reinvestRatePct: 6, used: { taxRatePct: 'override' },
};

function ctx(overrides) {
  return { model: MODEL, summary: SUMMARY, calcHeur: HEUR, contractYears: 5, orders: 1_000_000, pricingBuckets: [], ...(overrides || {}) };
}

t('SG&A overlay rides on every surface (finding #11 lock)', () => {
  const p = buildProjectionParams(ctx());
  near(p.sgaOverlayPct, 4.5, 1e-9, 'sgaOverlayPct');
  assert(p.sgaAppliesTo === 'gross_revenue', 'sgaAppliesTo from model.financial');
});

t('EBITDA reclass 2026-07-04: amort rides equipmentAmort, NOT baseEquipmentCost', () => {
  // Supersedes the Critical #3 lock (amort baked into baseEquipmentCost).
  // Amort must still be present — just on its own param, where the engines
  // book it to EQUIP_DEPR (D&A). Losing it from BOTH keys would regress
  // Critical #3 (acquisition cost silently dropped); folding it back into
  // baseEquipmentCost would regress the EBITDA reclass.
  const p = buildProjectionParams(ctx());
  near(p.baseEquipmentCost, 80_000, 1e-6, 'baseEquipmentCost excludes amort');
  near(p.equipmentAmort, 27_360, 1e-6, 'equipmentAmort carries it separately');
});

t('deterministic: same inputs => identical bags (the no-drift property)', () => {
  const a = buildProjectionParams(ctx());
  const b = buildProjectionParams(ctx());
  assert(JSON.stringify(a) === JSON.stringify(b), 'two calls must be byte-identical');
});

t('overrides win, and only the overridden keys differ', () => {
  const base = buildProjectionParams(ctx());
  const wif = buildProjectionParams(ctx({ overrides: { marginPct: 0.18, baseLaborCost: 900_000 } }));
  near(wif.marginPct, 0.18); near(wif.baseLaborCost, 900_000);
  const diffs = Object.keys(base).filter(k => JSON.stringify(base[k]) !== JSON.stringify(wif[k]));
  assert(diffs.sort().join(',') === 'baseLaborCost,marginPct',
    `only overridden keys may differ; got [${diffs.join(', ')}]`);
});

t('metrics opts read calcHeur.discountRatePct/reinvestRatePct (finding #10 lock)', () => {
  const m = buildMetricsOpts({ summary: SUMMARY, calcHeur: HEUR });
  near(m.discountRatePct, 7.5, 1e-9, 'heuristic discount rate must flow');
  near(m.reinvestRatePct, 6, 1e-9, 'heuristic reinvest rate must flow');
  near(m.annualDepreciation, 27_360 + 20_000, 1e-6, 'D&A = equip amort + startup amort');
  near(m.fixedCost, 500_000 + 60_000 + 20_000, 1e-6);
});

t('escalations are fractions of the pct heuristics', () => {
  const p = buildProjectionParams(ctx());
  near(p.volGrowthPct, 0.02); near(p.laborEscPct, 0.03);
  near(p.costEscPct, 0.025); near(p.facilityEscPct, 0.02);
  near(p.equipmentEscPct, 0.015); near(p.marginPct, 0.12);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
