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

// ── S3-P1: bid package manifest ─────────────────────────────────────────────

/** Non-blank string check (trim-aware, null-safe). */
const nonBlank = (s) => typeof s === 'string' && s.trim().length > 0;

/**
 * One manifest checklist row.
 * @typedef {object} ManifestItem
 * @property {string} key       — stable id, e.g. 'star-coverage'
 * @property {string} label     — human checklist label
 * @property {'sites'|'economics'|'narrative'|'reviews'} group
 * @property {'done'|'partial'|'missing'} status
 * @property {boolean} required — required items drive pct; optional ones don't
 * @property {string} detail    — short concrete note ('2/3 sites have a ★ scenario')
 * @property {string|null} fixTab — deal-tab id the user can jump to, or null
 */

/**
 * S3-P1 bid-package manifest: the ONE pure readiness formula for a deal's
 * bid submission. api.js/ui.js feed it deal-shaped rows; it never fetches.
 *
 * @param {{
 *   sites?:    Array<{id: string|number, name?: string, status?: string, inBidModelId?: string|number|null}>|null,
 *   models?:   Array<{id: string|number, site_id?: string|number|null, total_annual_revenue?: number|string|null, revenueSource?: string|null}>|null,
 *   designs?:  {wsc?: Array<{site_id?: string|number|null}>, most?: Array<{site_id?: string|number|null}>, cog?: any[], netopt?: any[], fleet?: any[]}|null,
 *   strategy?: {value_prop?: string|null}|null,
 *   meta?:     {exec_summary?: string|null, submission_due?: string|null, manual_checks?: Record<string, boolean>|null}|null,
 * }|null|undefined} input — null/undefined anywhere is treated as empty, never throws
 * @returns {{
 *   pct: number,                 // 0-100 integer over REQUIRED items (done=1, partial=0.5)
 *   requiredDone: number, requiredTotal: number,
 *   dueDate: string|null,        // meta.submission_due passthrough
 *   items: ManifestItem[],       // fixed set, fixed order
 * }}
 */
export function computeBidManifest(input) {
  const inp = input || {};
  const sites = Array.isArray(inp.sites) ? inp.sites : [];
  const models = Array.isArray(inp.models) ? inp.models : [];
  const designs = inp.designs || {};
  const wsc = Array.isArray(designs.wsc) ? designs.wsc : [];
  const most = Array.isArray(designs.most) ? designs.most : [];
  const cog = Array.isArray(designs.cog) ? designs.cog : [];
  const netopt = Array.isArray(designs.netopt) ? designs.netopt : [];
  const fleet = Array.isArray(designs.fleet) ? designs.fleet : [];
  const strategy = inp.strategy || null;
  const meta = inp.meta || null;
  const checks = (meta && meta.manual_checks && typeof meta.manual_checks === 'object')
    ? meta.manual_checks : {};

  const active = sites.filter(s => s && s.status !== 'dropped');
  const starred = active.filter(s => s.inBidModelId != null);
  const modelById = new Map(models.filter(Boolean).map(m => [String(m.id), m]));
  // Engine-priced: explicit revenueSource wins; else infer from revenue > 0.
  const isEnginePriced = (m) => !m ? false
    : (m.revenueSource != null ? m.revenueSource === 'cm-engine'
      : (Number(m.total_annual_revenue) || 0) > 0);
  const siteName = (s, i) => nonBlank(s?.name) ? s.name.trim() : `Site ${i + 1}`;

  const items = [];

  // sites/star-coverage — every active site carries a ★ scenario.
  if (!active.length) {
    items.push({ key: 'star-coverage', label: 'Every site has a ★ scenario', group: 'sites',
      status: 'missing', required: true, detail: 'No sites yet', fixTab: 'sites' });
  } else {
    const n = starred.length, d = active.length;
    items.push({ key: 'star-coverage', label: 'Every site has a ★ scenario', group: 'sites',
      status: n === d ? 'done' : n > 0 ? 'partial' : 'missing', required: true,
      detail: `${n}/${d} sites have a ★ scenario`, fixTab: 'sites' });
  }

  // sites/engine-priced — every ★ model is engine-priced.
  if (!active.length) {
    items.push({ key: 'engine-priced', label: '★ scenarios engine-priced', group: 'sites',
      status: 'missing', required: true, detail: 'No sites yet', fixTab: 'sites' });
  } else if (!starred.length) {
    items.push({ key: 'engine-priced', label: '★ scenarios engine-priced', group: 'sites',
      status: 'missing', required: true, detail: 'No ★ scenarios yet', fixTab: 'sites' });
  } else {
    const unpriced = starred.filter(s => !isEnginePriced(modelById.get(String(s.inBidModelId))));
    const n = starred.length - unpriced.length;
    const names = unpriced.map(s => siteName(s, active.indexOf(s))).join(', ');
    items.push({ key: 'engine-priced', label: '★ scenarios engine-priced', group: 'sites',
      status: !unpriced.length ? 'done' : n > 0 ? 'partial' : 'missing', required: true,
      detail: !unpriced.length ? `${n}/${starred.length} ★ engine-priced` : `${names} ★ not engine-priced`,
      fixTab: 'sites' });
  }

  // sites/design-basis — every active site has ≥1 site-attached wsc/most scenario.
  if (!active.length) {
    items.push({ key: 'design-basis', label: 'Design basis per site', group: 'sites',
      status: 'missing', required: true, detail: 'No sites yet', fixTab: 'sites' });
  } else {
    const designedIds = new Set([...wsc, ...most]
      .filter(r => r && r.site_id != null).map(r => String(r.site_id)));
    const n = active.filter(s => designedIds.has(String(s.id))).length, d = active.length;
    items.push({ key: 'design-basis', label: 'Design basis per site', group: 'sites',
      status: n === d ? 'done' : n > 0 ? 'partial' : 'missing', required: true,
      detail: `${n}/${d} sites have a design basis`, fixTab: 'sites' });
  }

  // economics/financials-ready — ≥1 ★ makes Σ★/score computable.
  items.push({ key: 'financials-ready', label: 'Deal financials ready (Σ★)', group: 'economics',
    status: starred.length ? 'done' : 'missing', required: true,
    detail: starred.length ? `Σ★ over ${starred.length} ★ scenario${starred.length === 1 ? '' : 's'}` : 'No ★ scenario yet',
    fixTab: 'financials' });

  // economics/network-coverage (optional) — any COG / NetOpt / Fleet scenario.
  const netCount = cog.length + netopt.length + fleet.length;
  items.push({ key: 'network-coverage', label: 'Network design coverage', group: 'economics',
    status: netCount ? 'done' : 'missing', required: false,
    detail: netCount ? `${netCount} network scenario${netCount === 1 ? '' : 's'}` : 'No COG / NetOpt / Fleet scenarios',
    fixTab: null });

  // narrative/win-strategy — strategy row with a non-blank value prop.
  items.push({ key: 'win-strategy', label: 'Win strategy drafted', group: 'narrative',
    status: strategy ? (nonBlank(strategy.value_prop) ? 'done' : 'partial') : 'missing', required: true,
    detail: strategy ? (nonBlank(strategy.value_prop) ? 'Value prop drafted' : 'Strategy started — value prop blank') : 'No strategy yet',
    fixTab: 'strategy' });

  // narrative/exec-summary — non-blank meta.exec_summary.
  const hasExec = nonBlank(meta?.exec_summary);
  items.push({ key: 'exec-summary', label: 'Executive summary written', group: 'narrative',
    status: hasExec ? 'done' : 'missing', required: true,
    detail: hasExec ? 'Summary drafted' : 'No exec summary yet', fixTab: 'package' });

  // reviews — manual checkboxes on deal_bid_meta.manual_checks.
  const review = (key, label, required) => items.push({
    key, label, group: 'reviews',
    status: checks[key] === true ? 'done' : 'missing', required,
    detail: checks[key] === true ? 'Checked off' : 'Not checked', fixTab: 'package' });
  review('commercial-review', 'Commercial review signed off', true);
  review('ops-review', 'Ops review signed off', false);
  review('client-deck', 'Client deck prepared', false);

  const req = items.filter(i => i.required);
  const score = req.reduce((s, i) => s + (i.status === 'done' ? 1 : i.status === 'partial' ? 0.5 : 0), 0);
  return {
    pct: req.length ? Math.round((100 * score) / req.length) : 0,
    requiredDone: req.filter(i => i.status === 'done').length,
    requiredTotal: req.length,
    dueDate: meta?.submission_due ?? null,
    items,
  };
}

export default { modelRevenueEst, computeStarRollup, computeBidManifest };
