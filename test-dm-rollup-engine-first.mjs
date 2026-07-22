// test-dm-rollup-engine-first.mjs — C2 wave (Brock ruling 2026-07-22):
// the Σ★ roll-up is ENGINE-FIRST. modelRevenueEst prefers the CM engine's
// stamped total_annual_revenue when Number(...) > 0 (CM-authoritative,
// mirroring computeSiteFinancials and the bid manifest's engine-priced
// item) and only falls back to the cost/(1−margin) markup heuristic when
// no engine price exists. This DELIBERATELY breaks the S1 zero-diff
// guarantee for engine-priced deals — Overview, Financials, and the score
// basis must agree. computeStarRollup now also reports provenance
// (per-site revenueSource + top-level anyHeuristicStar) so the UI can
// badge heuristic-priced ★ rows honestly.

import { computeStarRollup, modelRevenueEst } from './hub/deal-management/calc.js?v=20260722-s3d';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

/** The OLD heuristic formula, replicated byte-for-byte for fallback pins. */
const oldHeuristic = (m, fallbackMarginPct) => {
  const mMargin = Number(m?.target_margin_pct);
  const pct = (Number.isFinite(mMargin) && mMargin > 0 ? mMargin : (Number(fallbackMarginPct) || 10)) / 100;
  const cost = Number(m?.total_annual_cost) || 0;
  return pct < 1 ? cost / (1 - pct) : cost;
};

// ── 1. modelRevenueEst: engine price wins ──
{
  const engine = { total_annual_revenue: 5_000_000, total_annual_cost: 4_400_000, target_margin_pct: 12 };
  t('engine-stamped model prices at exactly total_annual_revenue',
    modelRevenueEst(engine, 12) === 5_000_000);
  // NB: 4.4M/(1−.12) happens to equal 5M too, so pin precedence with a
  // fixture where engine and heuristic genuinely diverge.
  const diverge = { total_annual_revenue: 5_000_000, total_annual_cost: 4_000_000, target_margin_pct: 12 };
  t('engine price wins where heuristic would differ',
    modelRevenueEst(diverge, 12) === 5_000_000 &&
    !near(5_000_000, 4_000_000 / (1 - 0.12)));
  // String-typed DB numerics count too (Number(...) > 0).
  t('string engine revenue accepted', modelRevenueEst({ total_annual_revenue: '5000000', total_annual_cost: 1 }) === 5_000_000);
}

// ── 2. modelRevenueEst: heuristic fallback byte-identical to the old formula ──
{
  const cases = [
    [{ total_annual_revenue: 0, total_annual_cost: 4_400_000, target_margin_pct: 12 }, 12],
    [{ total_annual_revenue: null, total_annual_cost: 4_400_000, target_margin_pct: 12 }, 12],
    [{ total_annual_cost: 4_400_000, target_margin_pct: 12 }, 12],           // absent
    [{ total_annual_revenue: -5, total_annual_cost: 80, target_margin_pct: 20 }, 10], // negative → fallback
    [{ total_annual_revenue: 'n/a', total_annual_cost: 90 }, 10],            // NaN → fallback, deal margin
    [{ total_annual_cost: 90 }, undefined],                                  // 10% floor
    [{ total_annual_cost: 100, target_margin_pct: 100 }, undefined],         // pct >= 1 clamp
    [null, 15],
  ];
  for (const [m, fb] of cases) {
    t(`fallback byte-identical (rev=${m ? JSON.stringify(m.total_annual_revenue) : 'null model'})`,
      modelRevenueEst(m, fb) === oldHeuristic(m, fb));
  }
}

// ── 3. computeStarRollup: mixed deal → provenance + anyHeuristicStar ──
const M = (id, m) => [String(id), { id, ...m }];
const legacy = { revenue: 1_234, margin: 12 };
{
  const models = new Map([
    M(1, { total_annual_revenue: 5_000_000, total_annual_cost: 4_400_000, target_margin_pct: 12 }),
    M(2, { total_annual_cost: 900_000, target_margin_pct: 10 }), // heuristic-only
  ]);
  const mixed = computeStarRollup(
    [{ id: 'sA', inBidModelId: 1 }, { id: 'sB', inBidModelId: 2 }], models, legacy);
  const heurRev = oldHeuristic(models.get('2'), legacy.margin);
  t('mixed: Σ★ = engine + heuristic', near(mixed.revenue, 5_000_000 + heurRev));
  t('mixed: anyHeuristicStar true', mixed.anyHeuristicStar === true);
  t('mixed: full coverage keeps rollupIsEstimate false', mixed.rollupIsEstimate === false);
  t('mixed: per-site revenueSource correct',
    Array.isArray(mixed.siteSources) && mixed.siteSources.length === 2 &&
    mixed.siteSources.find(x => String(x.siteId) === 'sA')?.revenueSource === 'cm-engine' &&
    mixed.siteSources.find(x => String(x.siteId) === 'sB')?.revenueSource === 'estimate');
  t('mixed: siteSources carry the ★ model id',
    mixed.siteSources.find(x => String(x.siteId) === 'sA')?.modelId === 1);
  // Existing shape untouched (only ADD fields).
  t('mixed: existing fields intact',
    mixed.rollupFromStars === true &&
    mixed.bidCoverage.starred === 2 && mixed.bidCoverage.active === 2);
}

// ── 4. all-engine deal → anyHeuristicStar false, exact engine sum ──
{
  const models = new Map([
    M(1, { total_annual_revenue: 5_000_000, total_annual_cost: 4_400_000, target_margin_pct: 12 }),
    M(2, { total_annual_revenue: 2_000_000, total_annual_cost: 1_700_000, target_margin_pct: 15 }),
  ]);
  const all = computeStarRollup([{ id: 'sA', inBidModelId: 1 }, { id: 'sB', inBidModelId: 2 }], models, legacy);
  t('all-engine: revenue = exact Σ of stamped prices', all.revenue === 7_000_000);
  t('all-engine: anyHeuristicStar false', all.anyHeuristicStar === false);
  t('all-engine: every siteSource cm-engine',
    all.siteSources.length === 2 && all.siteSources.every(x => x.revenueSource === 'cm-engine'));
  // ★-weighted margin from engine gp: (600k + 300k) / 7M.
  t('all-engine: margin from engine gp', all.margin === Number(((900_000 / 7_000_000) * 100).toFixed(1)));
}

// ── 5. legacy no-★ passthrough unchanged (S1 guarantee survives for no-★) ──
{
  const models = new Map([M(1, { total_annual_revenue: 9_999_999, total_annual_cost: 1 })]);
  const none = computeStarRollup([{ inBidModelId: null }, { inBidModelId: null }], models, { revenue: 123, margin: 45 });
  t('no ★ → exact legacy echo', none.revenue === 123 && none.margin === 45 && none.rollupFromStars === false);
  t('no ★ → provenance fields present but empty/false',
    none.anyHeuristicStar === false && Array.isArray(none.siteSources) && none.siteSources.length === 0);
  // Ghost ★ (model not in map) → still legacy passthrough with empty provenance.
  const ghost = computeStarRollup([{ inBidModelId: 999 }], models, { revenue: 123, margin: 45 });
  t('ghost ★ → legacy passthrough + empty provenance',
    ghost.revenue === 123 && ghost.rollupFromStars === false &&
    ghost.anyHeuristicStar === false && ghost.siteSources.length === 0);
}

console.log(`\ntest-dm-rollup-engine-first: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
