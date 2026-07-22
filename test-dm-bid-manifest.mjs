// test-dm-bid-manifest.mjs — S3-P1 Package manifest station (2026-07-22).
//
// Behavioral lock on the ONE pure readiness formula,
// hub/deal-management/calc.js computeBidManifest(input):
//   1. Null-safety: all-null / empty input never throws; zero non-dropped
//      sites → the three sites/* items are 'missing' with 'No sites yet'.
//   2. Hearthwood-like fixture (3 sites, 2 ★, 1 engine-priced): every item
//      status + hand-computed pct (5.5/7 → 79).
//   3. Dropped sites excluded from every sites/* denominator.
//   4. partial vs done boundaries (star coverage, engine pricing,
//      design basis, win-strategy blank value_prop).
//   5. manual_checks toggles are strict-boolean (=== true).
//   6. Item ORDER + required flags pinned — UI renders in array order.

import { computeBidManifest } from './hub/deal-management/calc.js?v=20260722-s3c';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const item = (out, key) => out.items.find(i => i.key === key);
const status = (out, key) => item(out, key)?.status;

// ── 1. Null-safety + empty deal ──
{
  let threw = false, out = null;
  try {
    out = computeBidManifest(null);
    computeBidManifest(undefined);
    computeBidManifest({});
    computeBidManifest({ sites: null, models: null, designs: null, strategy: null, meta: null });
  } catch (e) { threw = true; }
  t('all-null input never throws', !threw);
  t('empty deal → pct 0', out.pct === 0);
  t('empty deal → requiredDone 0 of 7', out.requiredDone === 0 && out.requiredTotal === 7);
  t('empty deal → dueDate null', out.dueDate === null);
  t('empty deal → 10 items always present', out.items.length === 10);
  t('zero sites → sites/* all missing with No sites yet',
    ['star-coverage', 'engine-priced', 'design-basis'].every(k =>
      status(out, k) === 'missing' && item(out, k).detail === 'No sites yet'));
  t('empty deal → every item missing', out.items.every(i => i.status === 'missing'));
}

// ── 2. Item order + required flags + fixTabs pinned ──
{
  const out = computeBidManifest({});
  t('item order pinned',
    out.items.map(i => i.key).join(',') ===
    'star-coverage,engine-priced,design-basis,financials-ready,network-coverage,win-strategy,exec-summary,commercial-review,ops-review,client-deck');
  t('group order pinned',
    out.items.map(i => i.group).join(',') ===
    'sites,sites,sites,economics,economics,narrative,narrative,reviews,reviews,reviews');
  t('required flags pinned (7 required, 3 optional)',
    out.items.map(i => (i.required ? 1 : 0)).join('') === '1111011100');
  t('fixTabs pinned',
    out.items.map(i => i.fixTab ?? '-').join(',') ===
    'sites,sites,sites,financials,-,strategy,package,package,package,package');
  t('every item carries a label and detail',
    out.items.every(i => typeof i.label === 'string' && i.label.length > 0 && typeof i.detail === 'string'));
}

// ── 3. Hearthwood-like fixture: 3 sites, 2 ★, one engine-priced ──
const hearthwood = () => ({
  sites: [
    { id: 's1', name: 'Hearthwood DC', status: 'committed', inBidModelId: 11 },
    { id: 's2', name: 'Memphis', status: 'evaluating', inBidModelId: 12 },
    { id: 's3', name: 'Tulsa', status: 'proposed', inBidModelId: null },
  ],
  models: [
    { id: 11, site_id: 's1', total_annual_revenue: 8_400_000, revenueSource: 'cm-engine' },
    { id: 12, site_id: 's2', total_annual_revenue: 4_600_000, revenueSource: 'estimate' },
  ],
  designs: {
    wsc: [{ id: 1, site_id: 's1' }],
    most: [{ id: 2, site_id: 's2' }],
    cog: [{ id: 3 }], netopt: [], fleet: [],
  },
  strategy: { value_prop: 'Shared-campus density beats 3PL field', risks: '', asks: '', differentiators: '' },
  meta: {
    exec_summary: 'Two-node network anchored on Hearthwood.',
    submission_due: '2026-08-15',
    manual_checks: { 'commercial-review': true, 'ops-review': false },
  },
});
{
  const out = computeBidManifest(hearthwood());
  t('HW star-coverage partial 2/3', status(out, 'star-coverage') === 'partial' &&
    item(out, 'star-coverage').detail === '2/3 sites have a ★ scenario');
  t('HW engine-priced partial (revenueSource estimate ≠ engine)',
    status(out, 'engine-priced') === 'partial');
  t('HW engine-priced detail names Memphis',
    item(out, 'engine-priced').detail.includes('Memphis') &&
    !item(out, 'engine-priced').detail.includes('Hearthwood'));
  t('HW design-basis partial 2/3', status(out, 'design-basis') === 'partial' &&
    item(out, 'design-basis').detail === '2/3 sites have a design basis');
  t('HW financials-ready done (★ exists)', status(out, 'financials-ready') === 'done');
  t('HW network-coverage done (1 cog row)', status(out, 'network-coverage') === 'done');
  t('HW win-strategy done', status(out, 'win-strategy') === 'done');
  t('HW exec-summary done', status(out, 'exec-summary') === 'done');
  t('HW commercial-review done', status(out, 'commercial-review') === 'done');
  t('HW ops-review missing (false)', status(out, 'ops-review') === 'missing');
  t('HW client-deck missing (absent)', status(out, 'client-deck') === 'missing');
  // Hand-computed pct: 7 required = 3×partial (0.5) + 4×done (financials,
  // win-strategy, exec-summary, commercial-review) = 5.5 / 7 → 78.57 → 79.
  t('HW pct hand-computed 79', out.pct === 79, `got ${out.pct}`);
  t('HW requiredDone 4/7', out.requiredDone === 4 && out.requiredTotal === 7);
  t('HW dueDate passthrough', out.dueDate === '2026-08-15');
}

// ── 4. Dropped sites excluded ──
{
  const inp = hearthwood();
  inp.sites[2].status = 'dropped'; // Tulsa (no ★, no design) drops out
  const out = computeBidManifest(inp);
  t('dropped: star-coverage → done 2/2', status(out, 'star-coverage') === 'done' &&
    item(out, 'star-coverage').detail === '2/2 sites have a ★ scenario');
  t('dropped: design-basis → done 2/2', status(out, 'design-basis') === 'done');
  // Only-dropped-sites deal behaves like no sites at all.
  const ghost = computeBidManifest({ sites: [{ id: 'x', status: 'dropped', inBidModelId: 9 }] });
  t('all sites dropped → No sites yet on sites/*',
    ['star-coverage', 'engine-priced', 'design-basis'].every(k =>
      status(ghost, k) === 'missing' && item(ghost, k).detail === 'No sites yet'));
  t('all sites dropped → financials-ready missing (dropped ★ ignored)',
    status(ghost, 'financials-ready') === 'missing');
}

// ── 5. partial vs done / missing boundaries ──
{
  // Sites present, zero ★ → star-coverage missing (not 'No sites yet').
  const none = computeBidManifest({ sites: [{ id: 'a' }, { id: 'b' }] });
  t('0/2 ★ → star-coverage missing with count detail',
    status(none, 'star-coverage') === 'missing' &&
    item(none, 'star-coverage').detail === '0/2 sites have a ★ scenario');
  t('no ★ → engine-priced missing "No ★ scenarios yet"',
    status(none, 'engine-priced') === 'missing' &&
    item(none, 'engine-priced').detail === 'No ★ scenarios yet');
  t('no designs → design-basis missing 0/2',
    status(none, 'design-basis') === 'missing' &&
    item(none, 'design-basis').detail === '0/2 sites have a design basis');

  // Full coverage → all three sites items done.
  const full = computeBidManifest({
    sites: [{ id: 'a', name: 'A', inBidModelId: 1 }],
    models: [{ id: 1, site_id: 'a', total_annual_revenue: 1_000_000 }], // no revenueSource → infer from > 0
    designs: { wsc: [{ site_id: 'a' }], most: [], cog: [], netopt: [], fleet: [] },
  });
  t('1/1 ★ → star-coverage done', status(full, 'star-coverage') === 'done');
  t('inferred engine-priced (revenue > 0, no revenueSource) → done',
    status(full, 'engine-priced') === 'done');
  t('1/1 design basis → done', status(full, 'design-basis') === 'done');

  // Zero-revenue ★ without revenueSource → not engine-priced (all unpriced → missing).
  const zero = computeBidManifest({
    sites: [{ id: 'a', name: 'A', inBidModelId: 1 }],
    models: [{ id: 1, site_id: 'a', total_annual_revenue: 0 }],
  });
  t('★ with $0 revenue → engine-priced missing, detail names site',
    status(zero, 'engine-priced') === 'missing' &&
    item(zero, 'engine-priced').detail.includes('A'));
  // ★ pointing at a model row we never loaded counts as unpriced too.
  const orphan = computeBidManifest({ sites: [{ id: 'a', name: 'A', inBidModelId: 99 }], models: [] });
  t('★ with no model row → engine-priced missing', status(orphan, 'engine-priced') === 'missing');

  // Everything green → pct 100.
  const done = computeBidManifest({
    sites: [{ id: 'a', name: 'A', inBidModelId: 1 }],
    models: [{ id: 1, site_id: 'a', total_annual_revenue: 2_000_000, revenueSource: 'cm-engine' }],
    designs: { wsc: [{ site_id: 'a' }], most: [], cog: [], netopt: [], fleet: [{ id: 9 }] },
    strategy: { value_prop: 'x' },
    meta: { exec_summary: 'y', submission_due: null,
      manual_checks: { 'commercial-review': true, 'ops-review': true, 'client-deck': true } },
  });
  t('all green → pct 100, 7/7 required done',
    done.pct === 100 && done.requiredDone === 7 && done.items.every(i => i.status === 'done'));
}

// ── 6. Strategy row present but blank → partial ──
{
  const out = computeBidManifest({ strategy: { value_prop: '   ', risks: 'r' } });
  t('strategy row, blank value_prop → win-strategy partial', status(out, 'win-strategy') === 'partial');
  const missing = computeBidManifest({ strategy: null });
  t('no strategy row → win-strategy missing', status(missing, 'win-strategy') === 'missing');
  // Blank-after-trim exec summary stays missing.
  const blankExec = computeBidManifest({ meta: { exec_summary: '  \n ' } });
  t('whitespace exec_summary → exec-summary missing', status(blankExec, 'exec-summary') === 'missing');
}

// ── 7. manual_checks toggles (strict boolean) ──
{
  const on = computeBidManifest({ meta: { manual_checks: { 'commercial-review': true, 'ops-review': true, 'client-deck': true } } });
  t('all checks true → all three reviews done',
    ['commercial-review', 'ops-review', 'client-deck'].every(k => status(on, k) === 'done'));
  const truthy = computeBidManifest({ meta: { manual_checks: { 'commercial-review': 'true', 'ops-review': 1 } } });
  t('truthy-but-not-true stays missing (=== true)',
    status(truthy, 'commercial-review') === 'missing' && status(truthy, 'ops-review') === 'missing');
  // Required commercial-review moves pct by a full 1/7 step; optional ones don't.
  const base = computeBidManifest({ meta: { manual_checks: {} } });
  const cr = computeBidManifest({ meta: { manual_checks: { 'commercial-review': true } } });
  const opt = computeBidManifest({ meta: { manual_checks: { 'ops-review': true, 'client-deck': true } } });
  t('commercial-review toggle moves pct +14', base.pct === 0 && cr.pct === Math.round(100 / 7));
  t('optional toggles leave pct untouched', opt.pct === base.pct);
}

console.log(`\ntest-dm-bid-manifest: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
