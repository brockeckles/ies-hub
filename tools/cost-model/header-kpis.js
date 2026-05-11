/**
 * cost-model/header-kpis.js — pure computation of the 5 sticky header KPIs.
 *
 * Extracted from `cost-model/ui.js` 2026-05-11 (S18). The function used
 * to read 7 closure-state bindings directly (model / refData /
 * userHasInteracted / whatIfTransient / currentScenario /
 * currentScenarioSnapshots / heuristicOverrides). New signature accepts
 * them as an explicit opts bag — same param-injection pattern S15
 * introduced for computePricingSnapshot.
 *
 * Side effects: none. Returns `{ ready: boolean, items: Array }`.
 * `items` is the KPI strip's display payload (label / value / hint /
 * key). When `ready === false`, items are placeholder rows that show
 * em-dashes — keeps the strip layout-stable on empty Setup pages and
 * before the user has interacted with a freshly-seeded model.
 *
 * The function never throws; any failure inside the try block returns
 * `{ ready: false, items: [] }` with a console.warn diagnostic.
 */
import * as calc from './calc.js?v=20260511-port15';
import * as channelCalc from './calc.channels.js?v=20260429-vol13';
import { _heurProjectFallbacks, applySplitMonthBilling } from './heuristics-helpers.js?v=20260511-port15';
import { formatUomSingular } from '../../shared/format.js?v=20260511-port15';

/**
 * @param {Object} opts
 * @param {Object} opts.model — full cost-model state
 * @param {Object} opts.refData — reference data (facility rates, utility rates, etc.)
 * @param {boolean} opts.userHasInteracted — true after first user input
 * @param {Object} opts.whatIfTransient — current what-if slider overlay
 * @param {Object} opts.currentScenario — active scenario record
 * @param {Object} opts.currentScenarioSnapshots — scenario snapshot bag
 * @param {Object} opts.heuristicOverrides — heuristic override bag
 * @param {Object|null} opts.currentMarketLaborProfile — resolved market labor profile
 * @param {Object} opts.scenarios — the calc.scenarios module (resolveCalcHeuristics)
 * @returns {{ ready: boolean, items: Array }}
 */
export function computeHeaderKpis({
  model,
  refData,
  userHasInteracted,
  whatIfTransient,
  currentScenario,
  currentScenarioSnapshots,
  heuristicOverrides,
  currentMarketLaborProfile,
  scenarios,
}) {
  try {
    const market = model?.projectDetails?.market;
    const fr = (refData?.facilityRates || []).find(r => r.market_id === market);
    const ur = (refData?.utilityRates  || []).find(r => r.market_id === market);
    const outboundStar = (model?.volumeLines || []).find(v => v.isOutboundPrimary);
    const orders = outboundStar?.volume || 0;
    const outboundUomLabel = formatUomSingular(outboundStar?.uom);
    const contractYears = model?.projectDetails?.contractTerm || 5;
    const fin = model?.financial || {};

    // Bail out cheaply when there's effectively no model yet — keeps the
    // strip blank on empty Setup pages instead of flashing $0.
    // 2026-04-29 (#14): also bail when the user hasn't touched anything yet
    // so the seeded defaults (80K orders + sample equipment) don't surface
    // a misleading "Cost/Order $5.94" / "NPV -$2.2M" before the user has
    // entered a single value.
    // 2026-04-30 (F2): loaded-from-DB models DO have meaningful data even
    // before the user types, so distinguish loaded-with-data from
    // fresh-empty-seed. Mirrors the hasData check in updateValidation().
    const hasLoadedData = !!(model && (
      (model.projectDetails?.name) ||
      (Array.isArray(model.laborLines) && model.laborLines.length) ||
      (Array.isArray(model.pricingBuckets) && model.pricingBuckets.length)
    ));
    if (!orders || (!userHasInteracted && !hasLoadedData)) {
      return {
        ready: false,
        items: [
          { label: `Cost / Unit`,   value: '—', hint: 'Set outbound volume on the Volumes section to populate.' },
          { label: 'Y1 Revenue',    value: '—' },
          { label: 'GP Margin (Y1)', value: '—' },
          { label: 'Total FTEs',    value: '—' },
          { label: `NPV (${contractYears}yr)`, value: '—' },
          // 2026-04-30 (F4): 6th tile on bail-out so the strip is stable
          // (prior version showed 5 chips on bail, 6 after first input).
          { label: 'Contract',
            value: contractYears > 0 ? `${contractYears} yr` : '—',
            hint: 'Contract term — sets the multi-year P&L horizon, NPV window, and ramp tail.' },
        ],
      };
    }

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
      annualOrders: orders,
    });

    // 2026-04-30 (F3) — align with renderSummary's projection inputs so the
    // chrome KPI strip's NPV/Revenue tie to the Summary section's tiles.
    // Prior version called buildYearlyProjections with raw model.financial
    // and unenriched pricingBuckets; the I-02 fix that derives missing
    // bucket rates from assigned costs only ran inside renderSummary, so
    // chrome strip Y1 Revenue read $0 on every saved model.
    const opHrs = calc.operatingHours(model.shifts || {});
    const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
      currentScenario,
      currentScenarioSnapshots,
      heuristicOverrides,
      _heurProjectFallbacks(model),
      whatIfTransient,
    ), model);
    const marginFrac = (calcHeur.targetMarginPct || 0) / 100;
    const pricingSnapshot = calc.computePricingSnapshot({ model, summary, marginFrac, opHrs, contractYears });
    const enrichedPricingBuckets = pricingSnapshot.buckets;

    const projResult = calc.buildYearlyProjections({
      years: contractYears,
      baseLaborCost:     summary.laborCost,
      baseFacilityCost:  summary.facilityCost,
      baseEquipmentCost: summary.equipmentCost,
      baseOverheadCost:  summary.overheadCost,
      baseVasCost:       summary.vasCost,
      startupAmort:      summary.startupAmort,
      startupCapital:    summary.startupCapital,
      baseOrders:        orders,
      marginPct:         marginFrac,
      volGrowthPct:      calcHeur.volGrowthPct      / 100,
      laborEscPct:       calcHeur.laborEscPct       / 100,
      costEscPct:        calcHeur.costEscPct        / 100,
      facilityEscPct:    calcHeur.facilityEscPct    / 100,
      equipmentEscPct:   calcHeur.equipmentEscPct   / 100,
      laborLines: model.laborLines || [],
      taxRatePct: calcHeur.taxRatePct,
      useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
      periods: (refData && refData.periods) || [],
      ramp: null,
      seasonality: model.seasonalityProfile || null,
      preGoLiveMonths:  calcHeur.preGoLiveMonths,
      dsoDays:          calcHeur.dsoDays,
      dpoDays:          calcHeur.dpoDays,
      laborPayableDays: calcHeur.laborPayableDays,
      startupLines: model.startupLines || [],
      pricingBuckets: enrichedPricingBuckets,
      project_id: model.id || 0,
      sgaOverlayPct: Number(model.financial?.sgaOverlayPct) || 0,
      sgaAppliesTo:  model.financial?.sgaAppliesTo || 'net_revenue',
      _calcHeur: calcHeur,
      marketLaborProfile: currentMarketLaborProfile,
      wageLoadByYear: null,
    });
    const projections = (projResult && projResult.projections) || [];
    const y1 = projections[0] || null;
    const metrics = calc.computeFinancialMetrics(projections, {
      startupCapital:      summary.startupCapital,
      equipmentCapital:    summary.equipmentCapital,
      annualDepreciation:  (summary.equipmentAmort || 0) + (summary.startupAmort || 0),
      discountRatePct:     calcHeur.discountRate ?? (fin.discountRate ?? 10),
      reinvestRatePct:     calcHeur.reinvestRate ?? (fin.reinvestRate ?? 8),
      taxRatePct:          calcHeur.taxRatePct,
      dsoDays:             calcHeur.dsoDays || 0,
      dpoDays:             calcHeur.dpoDays || 0,
      totalFtes:           summary.totalFtes,
      fixedCost:           summary.facilityCost + summary.overheadCost + summary.startupAmort,
    });

    const costPerUnit = summary.costPerOrder || 0;
    // 2026-04-30 (F3) — fall back to summary.totalRevenue when the projection
    // didn't emit a Y1 revenue (matches renderSummary's `?? summary.totalRevenue`).
    const y1Revenue   = (y1 && y1.revenue) ? y1.revenue : (summary.totalRevenue || 0);
    const y1Margin    = (y1Revenue > 0)
      ? ((y1?.grossProfit || (y1Revenue - (y1?.totalCost || summary.totalCost || 0))) / y1Revenue) * 100
      : 0;
    const totalFtes   = summary.totalFtes || 0;
    const npv         = (metrics && metrics.npv) || 0;

    // Phase 5.2 — bundle the underlying numbers + lineage into a ctx the
    // inspector panel can read when a KPI tile is clicked from any section.
    // Mirrors _lastProvenanceContext but adds payback + costPerUnit so the
    // KPI-specific row keys can render inputs even when the user has never
    // navigated to Summary yet. Stashed onto _lastProvenanceContext so
    // getCellProvenance has a single source of truth.
    const kpiCtx = {
      projections,
      summary,
      calcHeur: {
        volGrowthPct: (fin.volGrowth || 0) * 1,
        laborEscPct:  (fin.laborEsc  || 0) * 1,
        costEscPct:   (fin.costEsc   || 0) * 1,
        facilityEscPct:  fin.facilityEsc != null ? fin.facilityEsc : (fin.costEsc || 0),
        equipmentEscPct: fin.equipmentEsc != null ? fin.equipmentEsc : (fin.costEsc || 0),
        taxRatePct:   fin.taxRate != null ? fin.taxRate : 25,
      },
      marginFrac,
      contractYears,
      baseOrders: orders || 1,
      computedAt: new Date().toISOString(),
      channelLineage: channelCalc.buildChannelLineage(model),
      // KPI-specific extras
      kpi: {
        costPerUnit,
        y1Revenue,
        y1Margin,
        totalFtes,
        npv,
        payback: (metrics && metrics.payback) || null,
        outboundUomLabel: outboundUomLabel || 'Unit',
        discountRate: fin.discountRate || 10,
      },
    };

    // If renderSummary hasn't run yet (user opened a non-Summary section
    // first), seed _lastProvenanceContext so the inspector still works.
    // renderSummary will overwrite with its richer ctx when the user
    // navigates there. From-Summary loads always win because they pass
    // through renderSummary AFTER refreshHeaderKpis.
    if (!_lastProvenanceContext || _lastProvenanceContext._source !== 'summary') {
      _lastProvenanceContext = { ...kpiCtx, _source: 'kpi' };
    } else {
      // Already on Summary — graft the kpi-specific extras onto it so
      // KPI clicks read fresh costPerUnit/npv even mid-session.
      _lastProvenanceContext.kpi = kpiCtx.kpi;
    }

    return {
      ready: true,
      items: [
        {
          key: 'kpi:costPerUnit',
          label: `Cost / ${outboundUomLabel || 'Unit'}`,
          value: costPerUnit > 0
            ? calc.formatCurrency(costPerUnit, { decimals: costPerUnit < 10 ? 2 : 0 })
            : '—',
          hint: 'Total operating cost ÷ outbound primary volume. Drives the headline pricing rate.',
        },
        {
          key: 'kpi:y1Revenue',
          label: 'Y1 Revenue',
          value: y1Revenue > 0 ? calc.formatCurrency(y1Revenue, { compact: true }) : '—',
          hint: 'Year-1 revenue from the multi-year P&L (ramped, escalation-aware).',
        },
        {
          key: 'kpi:y1Margin',
          label: 'GP Margin (Y1)',
          value: y1Revenue > 0 ? calc.formatPct(y1Margin, 1) : '—',
          hint: 'Y1 gross profit ÷ revenue. Often lower than your target margin in early years until the ramp completes.',
        },
        {
          key: 'kpi:totalFtes',
          label: 'Total FTEs',
          value: totalFtes > 0 ? totalFtes.toFixed(1) : '—',
          hint: 'Direct + indirect headcount at steady-state operating hours.',
        },
        {
          key: 'kpi:npv',
          label: `NPV (${contractYears}yr)`,
          value: npv !== 0 ? calc.formatCurrency(npv, { compact: true }) : '—',
          hint: `Net present value over the ${contractYears}-year contract at ${fin.discountRate || 10}% discount rate.`,
        },
        {
          key: 'kpi:contract',
          // 2026-04-29 (Brock): contract term as framing context for the other
          // chips. Sets the horizon for the multi-year P&L, NPV, and ramp.
          label: 'Contract',
          value: contractYears > 0
            ? `${contractYears} yr${(contractYears * 12) % 12 === 0 ? '' : ` (${Math.round(contractYears * 12)} mo)`}`
            : '—',
          hint: `${Math.round(contractYears * 12)}-month contract term — sets the multi-year P&L horizon, NPV window, and ramp tail.`,
        },
      ],
    };
  } catch (err) {
    console.warn('[CM] header KPI compute failed:', err);
    return { ready: false, items: [] };
  }
}
