// test-dm-s2-opener.mjs — S2 opening arc (Brock rulings 2026-07-22 s2 r2):
// score wired · DM esc adopts ★ models' CM knobs · rail Network = COG+NetOpt
// · DOS single definition · S1 residue (deleteSite, sqft estimate, site chip).
//
// Locks:
//   1. siteEscalationFromRow: resting precedence (heuristic_overrides snake
//      → project_data.financial camel legacy → 3), ESC_BLEND_WEIGHTS blend,
//      null when the row carries no signal.
//   2. computeDealFinancials per-site escalation: ZERO-DIFF when no site
//      carries a pair (exact old-math equivalence); a site's own pair moves
//      NPV; perSiteEscalation flag reports the basis.
//   3. DOS stages: ONE in-code definition (calc.js, id+number+color); hub
//      ui aliases it — no local array.
//   4. Wiring pins: score (api computes grade+num, select carries revenue/
//      startup/financial), rail netopt grab + Network count, deleteSite
//      (mirror-clear), sqft_estimate plumbing, site chip in both landings.

import { readFileSync } from 'node:fs';
import {
  siteEscalationFromRow, ESC_BLEND_WEIGHTS, computeDealFinancials,
  computeDealScore, computeNpvFromSeries, DOS_STAGES,
} from './tools/deal-manager/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ── 1. siteEscalationFromRow ──
{
  t('no signal → null', siteEscalationFromRow({}) === null && siteEscalationFromRow(null) === null);
  const wSum = Object.values(ESC_BLEND_WEIGHTS).reduce((a, b) => a + b, 0);
  t('blend weights sum to 1', near(wSum, 1));
  // Uniform 4% everywhere → blended 4 exactly, applied to both rev & cost.
  const uni = siteEscalationFromRow({ heuristic_overrides: {
    labor_escalation_pct: 4, cost_escalation_pct: 4, facility_escalation_pct: 4, equipment_escalation_pct: 4 } });
  t('uniform knobs → blended pair at that rate', uni && near(uni.revenue, 4) && near(uni.cost, 4));
  // Override wins over legacy financial value.
  const prec = siteEscalationFromRow({
    heuristic_overrides: { labor_escalation_pct: 6 },
    project_data: { financial: { laborEscalation: 2, costEscalation: 2, facilityEscalation: 2, equipmentEscalation: 2 } },
  });
  const expect = +(6 * ESC_BLEND_WEIGHTS.labor + 2 * (1 - ESC_BLEND_WEIGHTS.labor)).toFixed(2);
  t('override outranks financial legacy', prec && near(prec.cost, expect));
  // annualEscalation legacy fallback feeds the cost knob; others default 3.
  const legacy = siteEscalationFromRow({ project_data: { financial: { annualEscalation: 5 } } });
  const expLegacy = +(3 * (1 - ESC_BLEND_WEIGHTS.cost) + 5 * ESC_BLEND_WEIGHTS.cost).toFixed(2);
  t('annualEscalation legacy fallback', legacy && near(legacy.cost, expLegacy));
}

// ── 2. per-site escalation in computeDealFinancials ──
const SITE = (id, cost, margin, startup, esc) => ({
  id, name: 'S' + id, sqft: 100000, annualCost: cost, targetMarginPct: margin,
  startupCost: startup, pricingModel: 'cost-plus', annualVolume: 0, annualRevenue: 0,
  ...(esc ? { escalation: esc } : {}),
});
{
  const A = SITE('a', 1_000_000, 20, 250_000);
  const B = SITE('b', 2_000_000, 15, 250_000);
  const base = computeDealFinancials([A, B], 5);
  // PROBE — zero-diff: replicate the OLD aggregate math by hand and compare.
  const rev0 = base.totalAnnualRevenue, cost0 = base.totalAnnualCost;
  const oldSeries = [];
  for (let yr = 1; yr <= 5; yr++) {
    const rev = rev0 * Math.pow(1.03, yr - 1);
    const cost = cost0 * Math.pow(1.03, yr - 1);
    const gm = rev > 0 ? ((rev - cost) / rev) * 100 : 0;
    oldSeries.push(rev * ((gm - base.ebitdaOverheadPct) / 100));
  }
  const oldNpv = computeNpvFromSeries(base.totalStartupCost, oldSeries, base.discountRate);
  t('PROBE zero-diff: no pairs → NPV identical to old aggregate math', near(base.npv, oldNpv));
  t('no pairs → perSiteEscalation false', base.perSiteEscalation === false);

  // Site-carried pair == default 3/3 → still byte-identical + flag stays off.
  const same = computeDealFinancials([{ ...A, escalation: { revenue: 3, cost: 3 } }, B], 5);
  t('pair equal to default → NPV unchanged, flag off', near(same.npv, base.npv) && same.perSiteEscalation === false);

  // A site with faster cost esc than revenue esc compresses margin → NPV drops.
  const hot = computeDealFinancials([{ ...A, escalation: { revenue: 2, cost: 6 } }, B], 5);
  t('per-site pair moves NPV', hot.npv < base.npv);
  t('flag reports per-site basis', hot.perSiteEscalation === true);
  // Y1 aggregates never move (escalation is out-year only).
  t('Y1 revenue/cost unaffected by pairs', near(hot.totalAnnualRevenue, base.totalAnnualRevenue) && near(hot.totalAnnualCost, base.totalAnnualCost));
  // opts.escalationBySite keyed variant behaves like site-carried.
  const keyed = computeDealFinancials([A, B], 5, { escalationBySite: { a: { revenue: 2, cost: 6 } } });
  t('escalationBySite ≡ site-carried pair', near(keyed.npv, hot.npv));

  // Score consumes the fin — smoke the wired path end-to-end.
  const sc = computeDealScore(base);
  t('score returns 0-100 + grade', sc.score >= 0 && sc.score <= 100 && /^[ABCDF]$/.test(sc.grade));

  // Payback disambiguation (S2 live-walk find): zero-startup deals must not
  // be punished as "never pays back" — no capital at risk = full marks.
  const noCap = computeDealFinancials([SITE('z', 1_000_000, 12, 0)], 5);
  t('fixture: zero startup → paybackMonths 0', noCap.totalStartupCost === 0 && noCap.paybackMonths === 0);
  const scNoCap = computeDealScore(noCap);
  t('zero-startup payback scores 100', scNoCap.components.paybackScore === 100);
  // A startup the series never recovers still scores 0 (negative EBITDA).
  const sunk = computeDealFinancials([{ ...SITE('y', 1_000_000, 2, 5_000_000), annualRevenue: 900_000 }], 5);
  const scSunk = computeDealScore(sunk);
  t('unrecovered startup still scores 0', sunk.paybackMonths === 0 ? scSunk.components.paybackScore === 0 : sunk.paybackMonths > 0);
}

// ── 3. DOS single definition ──
{
  t('canonical DOS_STAGES: 6 rows w/ id+number+color', DOS_STAGES.length === 6 &&
    DOS_STAGES.every(s => s.id === s.number && typeof s.color === 'string' && s.name));
  const hubUi = readFileSync(new URL('./hub/deal-management/ui.js', import.meta.url), 'utf8');
  t('hub ui aliases msaCalc.DOS_STAGES', hubUi.includes('const DOS_STAGES = msaCalc.DOS_STAGES;'));
  t('hub ui has NO local stage array', !/DOS_STAGES = \[\s*\{ id: 1/.test(hubUi));
}

// ── 4. wiring pins ──
{
  const apiSrc = readFileSync(new URL('./hub/deal-management/api.js', import.meta.url), 'utf8');
  t('score: api computes grade via computeDealScore', apiSrc.includes('computeDealScore(fin)') && apiSrc.includes('score = sc.grade'));
  t('score: select carries revenue/startup/financial for the basis',
    apiSrc.includes('total_annual_revenue, startup_cost, pricing_model, heuristic_overrides, financial:project_data->financial'));
  t('score: basis is ★-preferred', /starIds2\.size \? attached\.filter/.test(apiSrc));
  t('rail: netopt_configs grabbed by deal', apiSrc.includes("from('netopt_configs')") && apiSrc.includes('netopt'));
  t('deleteSite exported + clears ★ mirror', apiSrc.includes('export async function deleteSite') &&
    /deleteSite[\s\S]{0,600}in_bid: false/.test(apiSrc.slice(apiSrc.indexOf('export async function deleteSite'))));
  t('sqft_estimate: selected + created + updatable',
    apiSrc.includes('sort_order, sqft_estimate, updated_at') &&
    apiSrc.includes('sqft_estimate: Number(payload.sqft_estimate)') &&
    apiSrc.includes("'sort_order', 'sqft_estimate'"));

  const uiSrc = readFileSync(new URL('./hub/deal-management/ui.js', import.meta.url), 'utf8');
  t('rail Network counts cog + netopt', uiSrc.includes('ds.cog.length + (ds.netopt || []).length'));
  t('financials caption badges the esc basis', uiSrc.includes('per-★-model CM knobs'));
  t('site modal: sqft field + two-step delete', uiSrc.includes("id=\"site-sqft\"") && uiSrc.includes('Confirm delete?'));
  t('detail circle tooltip carries scoreNum', uiSrc.includes('Deal health ${d.scoreNum'));

  const msaApiSrc = readFileSync(new URL('./tools/deal-manager/api.js', import.meta.url), 'utf8');
  t('mapCmProjectToSite attaches escalation + siteRecordId',
    msaApiSrc.includes('escalation: siteEscalationFromRow(row)') && msaApiSrc.includes('siteRecordId: row.site_id'));

  const landing = readFileSync(new URL('./shared/scenario-landing.js', import.meta.url), 'utf8');
  const cmUi = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');
  t('site chip: scenario-landing shows siteName when bound', landing.includes('dealCtx.siteId && dealCtx.siteName'));
  t('site chip: CM landing shows siteName when bound', cmUi.includes('_dcCtx.siteId && _dcCtx.siteName'));
}

console.log(`\ntest-dm-s2-opener: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
