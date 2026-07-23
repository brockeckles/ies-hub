// test-p2b-binder-engine.mjs — pins the S3-P2-b "bid binder" engine
// (2026-07-23): tools/deal-manager/bid-binder.js is a PURE print-doc
// builder (review-doc.js pattern) consuming buildBidSnapshotPayload's
// payload (schema_version 1) and producing two faces from one payload:
//
//   customer — client-safe: NO internal costs/margins/grade/score and
//              NO manifest checklist; estimates honestly marked.
//   elt      — full internal economics: Σ★ totals, per-site Y1 rev/cost/
//              margin, grade + score, coverage, manifest checklist,
//              manual checks.
//
// Draft rule: manifest.pct < 100 → DRAFT watermark (screen AND @media
// print) + missing-required-items page, in BOTH variants (a draft binder
// is an internal review copy by definition). At pct 100 both vanish.
//
// Pins:
//   1. Imports in bare node; export surface is EXACTLY the two builders.
//   2. Source parses (node --input-type=module --check) and performs no
//      browser side effects / clock reads (string scan, comments stripped).
//   3. Both faces render complete self-contained '<!doctype html>' docs:
//      print toolbar, @page, printFontCss inlined, no var(--…) leaks.
//   4. Client-safe wall: customer html carries no cost figures, no
//      'Score', no checklist labels (done items never render; at 100%
//      no manifest strings at all).
//   5. Draft watermark + missing-items page behavior at 64% vs 100%.
//   6. esc() everywhere: hostile deal name renders escaped.
//   7. Deterministic: same inputs → identical html; generatedAt is
//      caller-supplied or omitted.
//
// Run:  node test-p2b-binder-engine.mjs

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
function t(name, fn) {
  Promise.resolve().then(fn).then(
    () => { pass++; },
    (e) => { fail++; console.error(`✗ ${name}\n  ${e.message}`); },
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const src = readFileSync(new URL('./tools/deal-manager/bid-binder.js', import.meta.url), 'utf8');

// ------------------------------------------------------------------
// Fixture — real buildBidSnapshotPayload payload shape (schema_version 1):
// one engine-priced site + one estimated site, a manual check, and a
// 64%-complete manifest with exactly 2 incomplete REQUIRED items
// (engine-priced: partial, commercial-review: missing).
// ------------------------------------------------------------------
const ITEMS_64 = [
  { key: 'star-coverage', label: 'Every site has a ★ scenario', group: 'sites', status: 'done', required: true, detail: '2/2 sites have a ★ scenario' },
  { key: 'engine-priced', label: '★ scenarios engine-priced', group: 'sites', status: 'partial', required: true, detail: 'Reno DC ★ not engine-priced' },
  { key: 'design-basis', label: 'Design basis per site', group: 'sites', status: 'done', required: true, detail: '2/2 sites have a design basis' },
  { key: 'financials-ready', label: 'Deal financials ready (Σ★)', group: 'economics', status: 'done', required: true, detail: 'Σ★ over 2 ★ scenarios' },
  { key: 'network-coverage', label: 'Network design coverage', group: 'economics', status: 'missing', required: false, detail: 'No COG / NetOpt / Fleet scenarios' },
  { key: 'win-strategy', label: 'Win strategy drafted', group: 'narrative', status: 'done', required: true, detail: 'Value prop drafted' },
  { key: 'exec-summary', label: 'Executive summary written', group: 'narrative', status: 'done', required: true, detail: 'Summary drafted' },
  { key: 'commercial-review', label: 'Commercial review signed off', group: 'reviews', status: 'missing', required: true, detail: 'Not checked' },
  { key: 'ops-review', label: 'Ops review signed off', group: 'reviews', status: 'done', required: false, detail: 'Checked off' },
  { key: 'client-deck', label: 'Client deck prepared', group: 'reviews', status: 'missing', required: false, detail: 'Not checked' },
];

function makePayload({ pct = 64, dealName = 'Project Atlas' } = {}) {
  return {
    schema_version: 1,
    deal: { id: 'd-1', name: dealName, client: 'Acme & Sons' },
    manifest: {
      pct,
      required_done: pct >= 100 ? 7 : 5,
      required_total: 7,
      due_date: '2026-08-15',
      items: pct >= 100
        ? ITEMS_64.map(it => ({ ...it, status: 'done', detail: 'Complete' }))
        : ITEMS_64,
    },
    sites: [
      { site_id: 's1', name: 'Columbus DC', status: 'proposed', star_model_id: 'm1',
        star_model_name: 'Columbus base', star_scenario_label: 'Base', y1_revenue: 3500000,
        y1_cost: 2370000, y1_margin_pct: 32.3, sqft: 120000, revenue_source: 'cm-engine' },
      { site_id: 's2', name: 'Reno DC', status: 'proposed', star_model_id: 'm2',
        star_model_name: 'Reno concept', star_scenario_label: 'Concept A', y1_revenue: 2500000,
        y1_cost: 1830000, y1_margin_pct: 26.8, sqft: null, revenue_source: 'estimate' },
    ],
    totals: {
      y1_revenue: 6000000, y1_cost: 4200000, y1_margin_pct: 30.0,
      rollup_from_stars: true, rollup_is_estimate: true, any_heuristic_star: true,
      bid_coverage: { starred: 2, active: 2 },
      grade: 'B', score: 78,
    },
    exec_summary: 'Two-site network for Acme & Sons covering east and west.',
    manual_checks: { 'commercial-review': false, 'ops-review': true, 'client-deck': false },
    strategy: { value_prop: 'Engineered standards + shared transportation network.' },
  };
}

// Rendered fixture cost strings (money() convention: $X.XXM under $10M).
const TOTAL_COST_STR = '$4.20M';   // 4,200,000
const SITE_COST_STR = '$1.83M';    // 1,830,000 (Reno)

// ------------------------------------------------------------------
// 1. Import + surface + source hygiene
// ------------------------------------------------------------------
const mod = await import('./tools/deal-manager/bid-binder.js');

t('bid-binder.js imports in bare node and exposes exactly the 2 builders', () => {
  const keys = Object.keys(mod).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['buildBinderModel', 'renderBinderHtml']),
    `unexpected export surface: ${keys.join(', ')}`);
  for (const k of keys) assert(typeof mod[k] === 'function', `${k} is not a function`);
});

t('bid-binder.js passes node --input-type=module --check', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' });
  assert(r.status === 0, `--check failed: ${r.stderr}`);
});

t('bid-binder.js source performs no browser side effects or clock reads', () => {
  // Popup plumbing (window.open + document.write), downloads, and toasts
  // stay in the concurrent ui.js seam — generation must run headless.
  // Strip comments first so prose mentioning an API can't false-positive.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['document.createElement', 'document.body', 'document.head',
                     'window.open(', 'URL.createObjectURL', 'writeFile(',
                     'showToast(', 'alert(', 'Date.now(']) {
    assert(!code.includes(bad), `bid-binder.js contains forbidden call: ${bad}`);
  }
});

// ------------------------------------------------------------------
// 2. Both faces render complete self-contained print docs
// ------------------------------------------------------------------
const draftPayload = makePayload({ pct: 64 });
const custDraft = mod.renderBinderHtml(mod.buildBinderModel({ payload: draftPayload, variant: 'customer' }));
const eltDraft = mod.renderBinderHtml(mod.buildBinderModel({ payload: draftPayload, variant: 'elt' }));
const fullPayload = makePayload({ pct: 100 });
const custFull = mod.renderBinderHtml(mod.buildBinderModel({ payload: fullPayload, variant: 'customer' }));
const eltFull = mod.renderBinderHtml(mod.buildBinderModel({ payload: fullPayload, variant: 'elt' }));

t('both variants: complete self-contained doc (doctype, toolbar, @page, fonts)', () => {
  for (const [name, html] of [['customer', custDraft], ['elt', eltDraft]]) {
    assert(html.startsWith('<!doctype html>'), `${name}: not a full document`);
    assert(html.includes('Project Atlas'), `${name}: deal name missing`);
    assert(html.includes('Acme &amp; Sons'), `${name}: client not escaped/present`);
    assert(html.includes('window.print()') && html.includes('print-btn'), `${name}: print toolbar missing`);
    assert(html.includes('@page { size: letter portrait; margin: 0.5in; }'), `${name}: @page rule missing`);
    assert(html.includes('@font-face'), `${name}: printFontCss not inlined`);
    // Popup docs never load css/hub.css — a var(--…) would render broken.
    assert(!/var\(--/.test(html), `${name}: leaks design-token var() refs`);
    assert(/@media print\s*{[^}]*\.print-btn\s*{\s*display:\s*none/.test(html.replace(/\n/g, ' ')),
      `${name}: print-btn not hidden in @media print`);
  }
});

// ------------------------------------------------------------------
// 3. Draft rule: watermark + missing-items page at 64%, gone at 100%
// ------------------------------------------------------------------
t('draft (pct 64): DRAFT watermark on screen AND in @media print — both variants', () => {
  for (const [name, html] of [['customer', custDraft], ['elt', eltDraft]]) {
    assert(html.includes('class="wm"') && html.includes('>DRAFT<'), `${name}: watermark band missing`);
    // Fixed-position band styled in base CSS (screen) and explicitly kept
    // in the @media print block so Print/Save-as-PDF carries it.
    assert(/\.wm\s*{\s*position:\s*fixed/.test(html), `${name}: watermark not a fixed band`);
    const printBlock = (html.match(/@media print\s*{[\s\S]*?}\s*<\/style>/) || [''])[0];
    assert(printBlock.includes('.wm'), `${name}: watermark not pinned in @media print`);
  }
});

t('draft (pct 64): missing-items page lists the 2 incomplete REQUIRED items — both variants', () => {
  for (const [name, html] of [['customer', custDraft], ['elt', eltDraft]]) {
    assert(html.includes('class="missing-page"'), `${name}: missing-items page absent`);
    assert(html.includes('DRAFT — missing items (64% complete)'), `${name}: draft header missing`);
    assert(html.includes('★ scenarios engine-priced'), `${name}: partial required item not listed`);
    assert(html.includes('Commercial review signed off'), `${name}: missing required item not listed`);
    // Optional incomplete items do NOT go on the missing page.
    assert(!html.includes('Client deck prepared') || name === 'elt',
      `${name}: optional missing item leaked onto missing page`);
  }
  // Customer face: optional-missing 'Network design coverage' never renders.
  assert(!custDraft.includes('Network design coverage'), 'customer: optional item leaked');
});

t('complete (pct 100): no watermark, no missing-items page — both variants', () => {
  for (const [name, html] of [['customer', custFull], ['elt', eltFull]]) {
    assert(!html.includes('class="wm"') && !html.includes('>DRAFT<'), `${name}: watermark rendered at 100%`);
    assert(!html.includes('class="missing-page"') && !html.includes('DRAFT — missing items'),
      `${name}: missing-items page rendered at 100%`);
  }
});

// ------------------------------------------------------------------
// 4. Client-safe wall (customer) vs full internal economics (elt)
// ------------------------------------------------------------------
t('customer: no internal costs, margins, score, or manifest checklist', () => {
  for (const html of [custDraft, custFull]) {
    assert(!html.includes(TOTAL_COST_STR), 'customer leaks Σ★ Y1 cost');
    assert(!html.includes(SITE_COST_STR), 'customer leaks per-site Y1 cost');
    assert(!html.includes('$6.00M'), 'customer leaks Σ★ Y1 revenue');
    assert(!html.includes('$3.50M') && !html.includes('$2.50M'), 'customer leaks site revenue');
    assert(!html.includes('32.3%') && !html.includes('30.0%'), 'customer leaks margin');
    assert(!html.includes('Score'), 'customer leaks Score');
    assert(!html.includes('Grade'), 'customer leaks Grade');
    assert(!html.includes('Manual checks'), 'customer leaks manual checks section');
    assert(!html.includes('Bid manifest checklist'), 'customer leaks checklist section');
    // Done checklist items never render on the customer face.
    for (const label of ['Every site has a ★ scenario', 'Win strategy drafted',
                         'Deal financials ready', 'Executive summary written',
                         'Ops review signed off']) {
      assert(!html.includes(label), `customer leaks checklist label: ${label}`);
    }
  }
  // At 100% the customer face carries NO manifest strings at all.
  for (const it of ITEMS_64) assert(!custFull.includes(it.label), `customer@100 leaks: ${it.label}`);
  // But it still presents the client-facing content.
  assert(custDraft.includes('Columbus DC') && custDraft.includes('Reno DC'), 'customer site rows missing');
  assert(custDraft.includes('120,000 SF'), 'customer total footprint missing');
  assert(custDraft.includes('Two-site network for Acme &amp; Sons'), 'customer exec summary missing');
  assert(custDraft.includes('Engineered standards + shared transportation network.'), 'customer value prop missing');
  assert(custDraft.includes('est.') && custDraft.includes('planning estimates'), 'customer estimate honesty missing');
});

t('elt: full internal economics + checklist + manual checks', () => {
  assert(eltDraft.includes(TOTAL_COST_STR), 'elt Σ★ Y1 cost missing');
  assert(eltDraft.includes('$6.00M'), 'elt Σ★ Y1 revenue missing');
  assert(eltDraft.includes(SITE_COST_STR) && eltDraft.includes('$2.37M'), 'elt per-site costs missing');
  assert(eltDraft.includes('30.0%') && eltDraft.includes('32.3%') && eltDraft.includes('26.8%'), 'elt margins missing');
  assert(eltDraft.includes('Score') && eltDraft.includes('78 / 100'), 'elt score missing');
  assert(eltDraft.includes('Grade') && /<div class="v">B<\/div>/.test(eltDraft), 'elt grade missing');
  assert(eltDraft.includes('2 of 2 active sites ★'), 'elt bid coverage missing');
  assert(eltDraft.includes('heuristic estimates'), 'elt heuristic-star flag missing');
  assert(eltDraft.includes('Bid manifest checklist'), 'elt checklist section missing');
  for (const it of ITEMS_64) assert(eltDraft.includes(it.label), `elt checklist missing: ${it.label}`);
  assert(eltDraft.includes('Manual checks'), 'elt manual checks section missing');
  assert(eltDraft.includes('Ops review signed off'), 'elt manual check row missing');
  assert(eltDraft.includes('cm-engine') || eltDraft.includes('CM engine'), 'elt revenue source missing');
});

// ------------------------------------------------------------------
// 5. Escaping + fail-soft + determinism
// ------------------------------------------------------------------
t('hostile deal name renders escaped (no raw <script> in output)', () => {
  const evil = makePayload({ pct: 100, dealName: '<script>alert(1)</script> Deal' });
  for (const variant of ['customer', 'elt']) {
    const html = mod.renderBinderHtml(mod.buildBinderModel({ payload: evil, variant }));
    assert(!html.includes('<script>'), `${variant}: raw <script> leaked`);
    assert(html.includes('&lt;script&gt;'), `${variant}: escaped deal name missing`);
  }
});

t('fail-soft: null payload / empty sites / missing strategy render without throwing', () => {
  for (const payload of [null, {}, { deal: {}, manifest: {}, sites: [], totals: {} }]) {
    for (const variant of ['customer', 'elt']) {
      const html = mod.renderBinderHtml(mod.buildBinderModel({ payload, variant }));
      assert(html.startsWith('<!doctype html>'), 'degenerate payload broke the doc');
      assert(html.includes('Untitled deal'), 'degenerate payload lost fallback deal name');
      assert(html.includes('No sites on record'), 'empty-sites row missing');
      // pct defaults to 0 → an empty payload is still an honest DRAFT.
      assert(html.includes('>DRAFT<'), 'degenerate payload lost draft marking');
    }
  }
  // Null sqft renders as an em-dash, not NaN/null.
  assert(!custDraft.includes('NaN') && !custDraft.includes('null SF'), 'null sqft mishandled');
});

t('deterministic: same inputs → identical html; generatedAt caller-supplied or omitted', () => {
  const a = mod.renderBinderHtml(mod.buildBinderModel({ payload: makePayload(), variant: 'elt' }));
  const b = mod.renderBinderHtml(mod.buildBinderModel({ payload: makePayload(), variant: 'elt' }));
  assert(a === b, 'output not deterministic across calls');
  assert(!a.includes('Generated '), 'generatedAt line rendered without a caller value');
  const c = mod.renderBinderHtml(mod.buildBinderModel({
    payload: makePayload(), variant: 'elt', generatedAt: '2026-07-23 14:00',
  }));
  assert(c.includes('Generated 2026-07-23 14:00'), 'caller-supplied generatedAt not rendered');
});

// ------------------------------------------------------------------
setTimeout(() => {
  console.log(`test-p2b-binder-engine: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}, 50);
