/**
 * cost-model/what-if-preview.js — single-overlay scenario preview.
 *
 * Extracted from `cost-model/ui.js` 2026-05-11 (S18). The function
 * used to read 7+ closure-state bindings directly. New signature
 * accepts them as an explicit opts bag — same param-injection
 * pattern S15/S18 established for computePricingSnapshot +
 * computeHeaderKpis.
 *
 * Returns a preview bundle the What-If Studio renders for
 * baseline-vs-scenario comparison: totalRev / totalOpex /
 * totalEbitda / totalNI / ebitdaMargin / cumFcf / npv plus the
 * raw `projections` array and the resolved `calcHeur` bag. Never
 * throws — bad input or compute failure returns `null` with a
 * console.warn diagnostic.
 *
 * Pure compute. Mutates nothing. The `overlay` param is the
 * single what-if slider value (or full whatIfTransient when called
 * without an arg).
 */
import * as calc from './calc.js?v=20260611-tia3';
import { _heurProjectFallbacks, applySplitMonthBilling } from './heuristics-helpers.js?v=20260511-port16';

/**
 * @param {Object|undefined} overlay — what-if slider overlay (defaults to opts.whatIfTransient)
 * @param {Object} opts
 * @param {Object} opts.model
 * @param {Object} opts.refData
 * @param {Object} opts.whatIfTransient
 * @param {Object} opts.heuristicOverrides
 * @param {Object} opts.currentScenario
 * @param {Object} opts.currentScenarioSnapshots
 * @param {Object|null} opts.currentMarketLaborProfile
 * @param {Object} opts.scenarios — the calc.scenarios module
 * @returns {Object|null}
 */
export function computeWhatIfPreview(overlay, {
  model,
  refData,
  whatIfTransient,
  heuristicOverrides,
  currentScenario,
  currentScenarioSnapshots,
  currentMarketLaborProfile,
  scenarios,
}) {
  try {
    const ov = overlay === undefined ? whatIfTransient : (overlay || {});
    const market = model.projectDetails?.market;
    const fr = (refData.facilityRates || []).find(r => r.market_id === market);
    const ur = (refData.utilityRates || []).find(r => r.market_id === market);
    const opHrs = calc.operatingHours(model.shifts || {});
    const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
    const contractYears = model.projectDetails?.contractTerm || 5;
    const fin = model.financial || {};
    const summary = calc.computeSummary({
      laborLines: model.laborLines || [],
      indirectLaborLines: model.indirectLaborLines || [],
      equipmentLines: model.equipmentLines || [],
      overheadLines: model.overheadLines || [],
      vasLines: model.vasLines || [],
      startupLines: model.startupLines || [],
      facility: model.facility || {},
      shifts: model.shifts || {},
      facilityRate: fr,
      utilityRate: ur,
      contractYears,
      targetMarginPct: fin.targetMargin || 0,
      annualOrders: orders || 1,
    });
    const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
      currentScenario, currentScenarioSnapshots, heuristicOverrides, _heurProjectFallbacks(model), ov,
    ), model);
    const whatIfMarginFrac = (calcHeur.targetMarginPct || 0) / 100;

    // Direct Labor Productivity scaling. Pull from the overlay first, then
    // from heuristicOverrides, else default to 100 (no drag). Scale is
    // 100/prod: 90% prod → 1.111× hours → 1.111× labor cost.
    const dlProd = ov.direct_labor_productivity_pct != null && ov.direct_labor_productivity_pct !== ''
      ? Number(ov.direct_labor_productivity_pct)
      : (heuristicOverrides.direct_labor_productivity_pct != null && heuristicOverrides.direct_labor_productivity_pct !== ''
          ? Number(heuristicOverrides.direct_labor_productivity_pct)
          : 100);
    const dlProdClamped = Math.max(1, Math.min(150, Number.isFinite(dlProd) ? dlProd : 100));
    const laborHoursScale = 100 / dlProdClamped;  // 90 → 1.111, 100 → 1.0, 110 → 0.909

    // 2026-04-21 PM (Brock live feedback): Direct Labor Productivity was
    // scaling base_uph only, but the monthly engine reads `annual_hours`
    // directly via monthlyEffectiveHours — so the slider was silently dead
    // when the monthly engine was on (default). Fix: scale annual_hours
    // alongside base_uph so BOTH paths (per-line monthly and aggregate
    // yearly fallback) reflect productivity. 90% prod → 1.111× annual_hours
    // → 1.111× labor cost; 110% prod → 0.909× hours → 0.909× cost.
    // 2026-04-21 audit (Brock): Absence % slider was silently dead on
    // projects where labor lines carry a `monthly_absence_profile` (market
    // profile resolution). `monthlyAbsencePct` prefers the per-line profile
    // → market profile → calcHeur fallback, so the slider's calcHeur value
    // never reached the engine when profiles were set. Fix: when absence is
    // in the overlay, strip per-line profiles so calcHeur.absenceAllowancePct
    // becomes authoritative. Below we also clone the market profile with
    // absence_pct nulled to close the last hop.
    const absenceOverlayActive = ov.absence_allowance_pct != null && ov.absence_allowance_pct !== '';
    const scaledLaborLines = (model.laborLines || []).map(l => ({
      ...l,
      annual_hours: (l.annual_hours || 0) * laborHoursScale,  // THE one the monthly engine consumes
      base_uph: (l.base_uph || 0) / laborHoursScale,          // kept in sync for any UPH-reading downstream
      // If absence overlay active, strip per-line profile so calcHeur wins.
      ...(absenceOverlayActive ? { monthly_absence_profile: null } : {}),
    }));
    const scaledBaseLaborCost = summary.laborCost * laborHoursScale;
    // Clone market profile without absence array when the overlay is driving
    // absence. Same rationale as above — ensures calcHeur.absenceAllowancePct
    // is the effective monthly absence for every month in the preview.
    const whatIfMarketProfile = absenceOverlayActive && currentMarketLaborProfile
      ? { ...currentMarketLaborProfile, peak_month_absence_pct: null }
      : currentMarketLaborProfile;

    // When margin or volume sliders are active, re-derive bucket rates
    // from the overlay values — otherwise explicit rates on Wayfair-style
    // buckets pin revenue at baseline and the margin slider reads as dead.
    // For other sliders (DSO, tax rate, labor rate) the explicit rates
    // remain the defensible pricing and we leave them alone.
    const marginOverlayActive = ov.target_margin_pct != null && ov.target_margin_pct !== '';
    const volOverlayActive    = ov.annual_volume_growth_pct != null && ov.annual_volume_growth_pct !== '';
    // M4 (2026-04-21): pricing-discount slider — uniform multiplier on every
    // bucket's effective rate. Same machinery as per-bucket overrides.
    const pricingDiscountPct = ov.pricing_discount_pct != null && ov.pricing_discount_pct !== ''
      ? Number(ov.pricing_discount_pct) : 0;
    const pricingMult = 1 + pricingDiscountPct / 100;
    const whatIfBuckets = (marginOverlayActive || volOverlayActive)
      ? (() => {
          const cleared = (model.pricingBuckets || []).map(b => ({ ...b, rate: 0 }));
          const bucketCosts = calc.computeBucketCosts({
            buckets: cleared,
            laborLines: model.laborLines || [],
            indirectLaborLines: model.indirectLaborLines || [],
            equipmentLines: model.equipmentLines || [],
            overheadLines: model.overheadLines || [],
            vasLines: model.vasLines || [],
            startupLines: (model.startupLines || []).map(l => ({
              ...l,
              annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears),
            })),
            facilityCost: summary.facilityCost || 0,
            operatingHours: opHrs || 0,
            facilityBucketId: model.financial?.facilityBucketId || null,
          });
          return calc.enrichBucketsWithDerivedRates({
            buckets: cleared,
            bucketCosts,
            marginPct: whatIfMarginFrac || 0,
            volumeLines: model.volumeLines || [],
            model,
          });
        })()
      : calc.computePricingSnapshot({ model, summary, marginFrac: whatIfMarginFrac, opHrs, contractYears }).buckets;
    // Apply M4 pricing-discount multiplier AFTER enrichment so it layers on
    // both explicit and derived rates uniformly.
    const whatIfBucketsAfterDiscount = pricingMult === 1 ? whatIfBuckets
      : whatIfBuckets.map(b => ({ ...b, rate: (Number(b.rate) || 0) * pricingMult }));

    // Phase 2a (2026-06-10): shared builder. The What-If's genuine deltas
    // (scaled labor, what-if margin, discounted buckets, what-if market
    // profile) ride in overrides; everything else — INCLUDING the SG&A
    // overlay this site previously dropped (assessment #11) — comes from
    // the same bag Summary uses, so the unchanged-baseline preview now
    // matches the Summary P&L by construction.
    const projResult = calc.buildYearlyProjections(scenarios.buildProjectionParams({
      model, summary, calcHeur, contractYears, orders, refData,
      pricingBuckets: whatIfBucketsAfterDiscount,
      marketLaborProfile: whatIfMarketProfile,
      overrides: {
        baseLaborCost: scaledBaseLaborCost,
        laborLines: scaledLaborLines,
        marginPct: whatIfMarginFrac,
      },
    }));

    // Aggregate over the projection horizon
    const projections = projResult.projections || [];
    const totalRev = projections.reduce((s, y) => s + (y.revenue || 0), 0);
    const totalOpex = projections.reduce((s, y) => s + (y.totalCost || 0), 0);
    const totalEbitda = projections.reduce((s, y) => s + (y.ebitda || 0), 0);
    const totalNI = projections.reduce((s, y) => s + (y.netIncome || 0), 0);
    // Cum FCF — groupMonthlyToYearly now attaches a running `cumFcf` per year
    // (post 2026-04-20 PM audit). Previously this field was absent and the
    // KPI always read $0.
    const lastCumFcf = projections.length
      ? (projections[projections.length - 1].cumFcf ?? projections.reduce((s, y) => s + (y.freeCashFlow || 0), 0))
      : 0;

    // NPV — so the discount_rate_pct slider has a visible preview effect.
    // Uses the built-in computeFinancialMetrics (same path Summary uses).
    // Parity fix (2026-04-20 PM): pass equipmentCapital + annualDepreciation
    // + taxRatePct + dso/dpo so the What-If baseline NPV matches the Summary
    // NPV on the same project. Previously omitted, so the two screens read
    // different NPVs for the unchanged baseline scenario.
    const totalFtes = (model.laborLines || []).reduce((s, l) => {
      if (!opHrs || opHrs <= 0) return s;
      return s + ((l.annual_hours || 0) / opHrs);
    }, 0);
    let npv = 0;
    try {
      const metrics = calc.computeFinancialMetrics(projections,
        scenarios.buildMetricsOpts({ summary, calcHeur, overrides: { totalFtes } }));
      npv = metrics.npv || 0;
    } catch (metricsErr) {
      // Metrics are defensive; a failure here shouldn't break the preview.
      console.warn('[CM] preview metrics computation failed:', metricsErr);
    }

    return {
      totalRev, totalOpex, totalEbitda, totalNI,
      ebitdaMargin: totalRev > 0 ? (totalEbitda / totalRev * 100) : 0,
      cumFcf: lastCumFcf,
      npv,
      // Expose per-year projections so the trajectory chart can render
      // baseline vs scenario lines without a second compute pass.
      projections,
      calcHeur,
    };
  } catch (err) {
    console.warn('[CM] what-if preview failed:', err);
    return null;
  }
}
