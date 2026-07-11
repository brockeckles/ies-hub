/**
 * cost-model/compute-all.js — M2 recompute seam (2026-07-10).
 *
 * THE single place the CM calc pipeline runs. Before M2 the identical
 * heuristics → computeSummary → pricingSnapshot → buildYearlyProjections
 * chain lived in FOUR places (ui.js renderSummary, ui.js
 * ensureMonthlyBundle, header-kpis.js computeHeaderKpis, plus two
 * computeMonthlyLaborView sites) and re-ran on every section render.
 * Drift between those copies was an active bug class (P1-2, F3, I-02 —
 * see git history). Now every consumer calls computeAll(ctx) and reads
 * one result.
 *
 * ENGINES UNTOUCHED: this module only *calls* calc.js / calc.monthly.js /
 * calc.channels.js / calc.scenarios.js. All math stays in the engines.
 * Numbers must be byte-identical to the pre-M2 render path — the pipeline
 * below is a verbatim consolidation of the four call sites (which had
 * already converged expression-by-expression via P1-2/F3/Phase-2a).
 *
 * MEMO: content-fingerprint keyed, NOT invalidation-wired. The fingerprint
 * is JSON.stringify of the mutable inputs (model / overrides / what-if /
 * scenario row / labor profile) plus object identity for the wholesale-
 * replaced bags (refData, scenario snapshots). A missed-invalidation stale
 * bug is therefore impossible by construction — the trade is a stringify
 * (~1ms) per render vs re-running the 60-month engine (~10-100ms) 2-4×
 * per render. If stringify throws (it shouldn't — model is jsonb-persisted)
 * we simply recompute.
 *
 * This seam is what the M3 D-shell's live P&L rail will subscribe to.
 *
 * @module tools/cost-model/compute-all
 */

import * as calc from './calc.js?v=20260704-ebr1';
import * as monthlyCalc from './calc.monthly.js?v=20260704-ebr1';
import * as channelCalc from './calc.channels.js?v=20260429-vol13';
import * as scenarios from './calc.scenarios.js?v=20260704-ebr1';
import { _heurProjectFallbacks, applySplitMonthBilling } from './heuristics-helpers.js?v=20260511-port16';
import { formatUomSingular } from '../../shared/format.js?v=20260511-port16';

/** @type {{ fp: string, refData: any, snaps: any, result: any } | null} */
let _memo = null;

/** Test/diagnostic hook — drops the memo. Content-keying makes routine
 *  invalidation unnecessary; this exists for belt-and-braces callers. */
export function invalidateComputeAll() { _memo = null; }

function _fingerprint(ctx) {
  // Mutable-in-place inputs go in by content; wholesale-replaced bags
  // (refData, currentScenarioSnapshots) are identity-checked by the caller
  // of this fn. currentScenario/currentMarketLaborProfile rows are small —
  // content-key them too so in-place status flips can never go stale.
  return JSON.stringify([
    ctx.model,
    ctx.heuristicOverrides,
    ctx.whatIfTransient,
    ctx.currentScenario,
    ctx.currentMarketLaborProfile,
  ]);
}

/**
 * Run (or reuse) the full CM calc pipeline.
 *
 * @param {Object} ctx
 * @param {Object} ctx.model — full cost-model state
 * @param {Object} ctx.refData — reference data bag (facility/utility rates, periods, …)
 * @param {Object|null} ctx.currentScenario — active cost_model_scenarios row
 * @param {Object|null} ctx.currentScenarioSnapshots — frozen rate-card snapshot bag
 * @param {Object} ctx.heuristicOverrides — per-project heuristic override bag
 * @param {Object|null} ctx.whatIfTransient — What-If Studio preview overlay
 * @param {Object|null} ctx.currentMarketLaborProfile — resolved market labor profile
 * @returns {Object} computed — see shape below. Object identity is stable
 *   until any input changes, so downstream consumers MUST NOT mutate it.
 */
export function computeAll(ctx) {
  const { model, refData } = ctx;

  let fp = null;
  try { fp = _fingerprint(ctx); } catch (_) { /* recompute-always fallback */ }
  if (fp && _memo && _memo.fp === fp &&
      _memo.refData === refData && _memo.snaps === ctx.currentScenarioSnapshots) {
    return _memo.result;
  }

  // ── Shared input resolution (verbatim from renderSummary) ──────────────
  const market = model?.projectDetails?.market;
  const fr = (refData?.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData?.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model?.shifts || {});
  const outboundStar = (model?.volumeLines || []).find(v => v.isOutboundPrimary);
  const orders = outboundStar?.volume || 0;
  const outboundUomLabel = formatUomSingular(outboundStar?.uom);
  const contractYears = model?.projectDetails?.contractTerm || 5;
  const fin = model?.financial || {};

  // P1-2 (2026-07-02): calcHeur resolved BEFORE computeSummary — the annual
  // pricing path prices labor on the monthly engine's basis (market temp
  // premium / OT / absence / temp-share What-If).
  const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
    ctx.currentScenario,
    ctx.currentScenarioSnapshots,
    ctx.heuristicOverrides,
    _heurProjectFallbacks(model),
    ctx.whatIfTransient,
  ), model);
  const laborOpts = scenarios.resolveSummaryLaborOpts({
    calcHeur, marketLaborProfile: ctx.currentMarketLaborProfile,
  });

  const summary = calc.computeSummary({
    laborLines: model?.laborLines || [],
    indirectLaborLines: model?.indirectLaborLines || [],
    equipmentLines: model?.equipmentLines || [],
    overheadLines: model?.overheadLines || [],
    vasLines: model?.vasLines || [],
    startupLines: model?.startupLines || [],
    facility: model?.facility || {},
    shifts: model?.shifts || {},
    facilityRate: fr,
    utilityRate: ur,
    contractYears,
    targetMarginPct: fin.targetMargin || 0,
    annualOrders: orders || 1,
    laborOpts,
  });

  const marginFrac = (calcHeur.targetMarginPct || 0) / 100;

  // I-02: derive missing bucket rates from assigned costs so new models
  // don't render $0 revenue. I-01: '_unassigned' rollup for banners.
  const pricingSnapshot = calc.computePricingSnapshot({
    model, summary, marginFrac, opHrs, contractYears, laborOpts,
  });

  // Phase 2a (2026-06-10): single shared params builder — the four
  // hand-rolled ~40-key bags were the active drift mechanism.
  const projResult = calc.buildYearlyProjections(scenarios.buildProjectionParams({
    model, summary, calcHeur, contractYears, orders, refData,
    pricingBuckets: pricingSnapshot.buckets,
    marketLaborProfile: ctx.currentMarketLaborProfile,
  }));
  const projections = (projResult && projResult.projections) || [];

  const metrics = calc.computeFinancialMetrics(
    projections, scenarios.buildMetricsOpts({ summary, calcHeur }));

  const channelLineage = channelCalc.buildChannelLineage(model);

  // ── Monthly Labor View (lazy — only Labor/Equipment sections need it) ──
  const _mlvCache = {};
  /**
   * @param {boolean} withIndirect — true = Labor-section card variant
   *   (runs the indirect auto-generator); false = equipment overflow probe.
   * @returns {Object|null} computeMonthlyLaborView result, or null when
   *   there are no labor lines / the engine throws (equipment probe parity).
   */
  const getMlv = (withIndirect) => {
    const slot = withIndirect ? 'with' : 'without';
    if (slot in _mlvCache) return _mlvCache[slot];
    let view = null;
    try {
      const lines = model?.laborLines || [];
      if (lines.length) {
        const shifts = model?.shifts || {};
        const shiftsPerDay = Math.max(1, Math.floor(shifts.shiftsPerDay || 1));
        let periods = (refData?.periods || []).filter(p =>
          p.period_type === 'month' && p.period_index >= 0 && p.period_index < contractYears * 12
        );
        if (periods.length === 0) {
          // Synthesize a simple axis if ref_periods hasn't loaded.
          const go = new Date(model?.projectDetails?.goLiveDate || '2026-01-01');
          periods = [];
          for (let i = 0; i < contractYears * 12; i++) {
            const d = new Date(go.getFullYear(), go.getMonth() + i, 1);
            periods.push({
              id: i, period_type: 'month', period_index: i,
              calendar_year: d.getFullYear(), calendar_month: d.getMonth() + 1,
              label: `M${i + 1}`, is_pre_go_live: false,
            });
          }
        }
        view = monthlyCalc.computeMonthlyLaborView({
          laborLines: lines,
          periods,
          annualOpHours: opHrs,
          shiftsPerDay,
          calcHeur,
          marketLaborProfile: ctx.currentMarketLaborProfile || null,
          ramp: null,
          seasonality: model?.seasonalityProfile || null,
          volGrowthPct: calcHeur?.volGrowthPct || 0,
          ...(withIndirect ? {
            indirectGenerator: calc.autoGenerateIndirectLabor,
            state: model,
          } : {}),
        });
      }
    } catch (e) {
      console.warn('[CM] computeAll.getMlv failed:', e);
      view = null;
    }
    _mlvCache[slot] = view;
    return view;
  };

  const result = {
    // Resolved inputs
    market, fr, ur, opHrs, outboundStar, orders, outboundUomLabel,
    contractYears, fin,
    // Heuristics chain
    calcHeur, laborOpts, marginFrac,
    // Engine outputs
    summary,
    pricingSnapshot,
    projResult,
    projections,
    monthlyBundle: (projResult && projResult.monthlyBundle) || null,
    metrics,
    channelLineage,
    getMlv,
  };

  if (fp) _memo = { fp, refData, snaps: ctx.currentScenarioSnapshots, result };
  return result;
}
