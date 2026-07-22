/**
 * IES Hub v3 — Deal Management pure calc
 *
 * S1 (2026-07-22, rulings #6/#7): the Σ★ deal roll-up. Kept pure and
 * node-safe so the suite can exercise it directly; api.js (fetch-side) and
 * ui.js (optimistic local updates after a ★ change) both call it — one
 * formula, no drift.
 *
 * @module hub/deal-management/calc
 */

/**
 * Revenue estimate for one cost-model scenario: cost grossed up by its own
 * target margin, falling back to the deal margin, then 10%. Mirrors the
 * legacy deal-level fallback formula so the no-★ path stays byte-identical.
 *
 * @param {{target_margin_pct?: number|string|null, total_annual_cost?: number|string|null}|null} m
 * @param {number} [fallbackMarginPct]
 * @returns {number} annual revenue in dollars (0 when the model has no cost)
 */
export function modelRevenueEst(m, fallbackMarginPct) {
  const mMargin = Number(m?.target_margin_pct);
  const pct = (Number.isFinite(mMargin) && mMargin > 0 ? mMargin : (Number(fallbackMarginPct) || 10)) / 100;
  const cost = Number(m?.total_annual_cost) || 0;
  return pct < 1 ? cost / (1 - pct) : cost;
}

/**
 * S1 deal roll-up (ruling #6): deal totals = Σ of each site's ★ scenario.
 * Applies ONLY when at least one site has a ★ — otherwise the legacy
 * heuristic numbers pass through untouched (zero-diff for existing deals).
 *
 * @param {Array<{inBidModelId?: number|string|null, status?: string}>} sites
 * @param {Map<string, object>} modelById — String(model id) → model summary
 *        with target_margin_pct + total_annual_cost
 * @param {{revenue: number, margin: number}} legacy — the pre-S1 heuristic
 *        values (deal column → model averages)
 * @returns {{revenue: number, margin: number, rollupFromStars: boolean,
 *           rollupIsEstimate: boolean, bidCoverage: {starred: number, active: number}}}
 */
export function computeStarRollup(sites, modelById, legacy) {
  const list = Array.isArray(sites) ? sites : [];
  const active = list.filter(s => s.status !== 'dropped');
  const starred = list.filter(s => s.inBidModelId != null);
  const bidCoverage = { starred: starred.length, active: active.length };
  const starModels = starred
    .map(s => modelById.get(String(s.inBidModelId)))
    .filter(Boolean);
  const out = {
    revenue: Number(legacy?.revenue) || 0,
    margin: Number(legacy?.margin) || 0,
    rollupFromStars: false,
    rollupIsEstimate: false,
    bidCoverage,
  };
  if (!starModels.length) return out;
  let rev = 0, gp = 0;
  for (const m of starModels) {
    const r = modelRevenueEst(m, out.margin);
    rev += r;
    gp += r - (Number(m.total_annual_cost) || 0);
  }
  if (rev > 0) {
    out.revenue = rev;
    out.margin = Number(((gp / rev) * 100).toFixed(1));
  }
  out.rollupFromStars = true;
  // Coverage gap → totals carry an estimate badge (the mockup's est chip).
  out.rollupIsEstimate = active.some(s => s.inBidModelId == null);
  return out;
}

export default { modelRevenueEst, computeStarRollup };
