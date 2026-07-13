// test-cm-station-economics.mjs — M5-Economics: cost-stack strip (2026-07-13)
//
// Locks the Economics-face contract:
//   1. renderEcoStrip — one card per cost block + financial frame, each
//      carrying data-tc-section (nav rides tool-chrome delegation) and,
//      for rail-cell blocks, data-cm-cell/data-cm-year (inspector rides
//      the CM-PROV-1 delegation). Financial frame has NO cell.
//   2. Active card highlighting, [data-eco-strip] guard hook, formatting,
//      empty/missing-value resilience, XSS escaping.
//   3. ui.js integration pins — strip prepends in renderSection for the
//      four block sections under the D shell ONLY; prov guard admits
//      [data-eco-strip] cells; orderProfile orphan stays deleted.
//
// Pure module. ?v= pin MUST match ui.js's import
// (feedback_test_cache_bust_match).
//
// Run: node test-cm-station-economics.mjs

import { readFileSync } from 'node:fs';

const stationEco = await import('./tools/cost-model/station-economics.js?v=20260713-m5d');
const { renderEcoStrip, ecoStyles } = stationEco;

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const BAG = {
  active: 'overhead',
  facility: { cost: 1370000, sqft: 150000 },
  overhead: { cost: 732000, lines: 12 },
  startup: { amort: 44000, items: 3, total: 220000 },
  financial: { marginPct: 12, volGrowthPct: 3, costEscPct: 3, years: 5 },
};

t('strip: four cards, nav + cell pairing, financial frame is nav-only', () => {
  const html = renderEcoStrip(BAG);
  assert(html.includes('data-eco-strip'), 'guard hook attribute present');
  for (const k of ['facility', 'overhead', 'startup', 'financial']) {
    assert(html.includes(`data-tc-section="${k}"`), `${k} card navigates via tool-chrome`);
  }
  for (const k of ['facility', 'overhead', 'startup']) {
    assert(new RegExp(`data-tc-section="${k}"[^>]*data-cm-cell="${k}"[^>]*data-cm-year="1"`).test(html),
      `${k} card carries its rail cell for the inspector`);
  }
  assert(!/data-tc-section="financial"[^>]*data-cm-cell/.test(html),
    'financial frame has no rail cell (no single P&L row)');
  assert(html.includes('data-tc-section="summary"'), 'Multi-year P&L link navigates to summary');
});

t('strip: active card highlighted; values formatted', () => {
  const html = renderEcoStrip(BAG);
  assert(/cmeco-card--on"[^>]*data-tc-section="overhead"/.test(html), 'active section card highlighted');
  assert(html.includes('$1.37M/yr'), 'facility Y1 formatted');
  assert(html.includes('150K SF'), 'sqft sub-line');
  assert(html.includes('12 lines'), 'overhead line count');
  assert(html.includes('$44K/yr amort') && html.includes('$220K total'), 'startup amort + total');
  assert(html.includes('12.0% target margin'), 'financial frame margin');
  assert(html.includes('vol +3.0%/yr') && html.includes('5 yr'), 'frame bits');
});

t('strip: resilient to empty model (no NaN, no undefined)', () => {
  const html = renderEcoStrip({ active: 'facility', facility: {}, overhead: {}, startup: {}, financial: {} });
  assert(!html.includes('NaN') && !html.includes('undefined'), 'no NaN/undefined leakage');
  assert(html.includes('no footprint yet'), 'facility empty sub');
  assert(html.includes('0 lines'), 'overhead zero-count pluralized');
  assert(html.includes('— target margin'), 'margin placeholder');
});

t('strip: escapes hostile active-section values in attrs', () => {
  // active only matches known keys, but the renderer must not trust it
  const html = renderEcoStrip({ ...BAG, active: '"><img src=x onerror=alert(1)>' });
  assert(!html.includes('<img src=x'), 'no injection through active');
});

t('ecoStyles emits scoped .cmeco-* css', () => {
  const css = ecoStyles();
  assert(css.startsWith('<style>') && css.includes('.cmeco-card') && css.includes('.cmeco-strip'), 'scoped styles');
});

// ---- ui.js integration pins ----
const uiSrc = readFileSync('./tools/cost-model/ui.js', 'utf8');

t('ui.js: strip prepends in renderSection for the four block sections, D shell only', () => {
  assert(/const ECO_STRIP_SECTIONS = \['facility', 'financial', 'overhead', 'startup'\]/.test(uiSrc),
    'strip section list pinned');
  assert(/_useDShell\(\) && ECO_STRIP_SECTIONS\.includes\(activeSection\)/.test(uiSrc),
    'strip renders under the D shell only');
  assert(uiSrc.includes('container.innerHTML = eco + price + render()'), 'strips PREPEND the section body (eco + price, M5-Price extended)');
  assert(uiSrc.includes('stationEco.renderEcoStrip({'), 'values bag feeds the pure renderer');
});

t('ui.js: prov delegation admits strip cells; strip bag rides the seam', () => {
  assert(uiSrc.includes("cell.closest('[data-eco-strip], [data-price-strip]')"), 'guard admits eco + price strip cells');
  // Mutation probe found the weak version of this pin: the closest() call
  // existing is NOT enough — it must gate the actual bail condition.
  assert(uiSrc.includes('!isKpi && !isGen && !isDRail && !isEcoStrip'),
    'isEcoStrip participates in the guard condition itself');
  const fn = uiSrc.slice(uiSrc.indexOf('function _ecoStripHtml'), uiSrc.indexOf('function _ecoStripHtml') + 1400);
  assert(fn.includes('computeAll(_computeCtx())'), 'strip values come from the memoized seam');
});

t('ui.js: startup rail/strip cell has a provenance case (m5f walk find)', () => {
  // The rail carried a startup row since M3 with NO case in
  // getCellProvenance — inspector said "No provenance available".
  assert(/case 'startup': \{\n      const lines = model\?\.startupLines/.test(uiSrc),
    'startup provenance case exists and reads startupLines');
  assert(uiSrc.includes("l.billing_type === 'as_incurred' ? 0 : (Number(l.one_time_cost) || 0)"),
    'strip startup total uses one_time_cost on the capitalized basis (not the nonexistent .cost field)');
});

t('ui.js: overhead vs sga provenance resolves by rowKey (m5e walk find)', () => {
  // p.sga can be a legitimate 0 post-EBITDA-reclass; `p.sga ?? p.overhead`
  // masked the overhead cell behind it (rail + strip showed $0.00).
  assert(uiSrc.includes("rowKey === 'sga' ? (p.sga ?? p.overhead) : (p.overhead ?? p.sga)"),
    'overhead cell reads p.overhead first; sga cell reads p.sga first');
});

t('ui.js: orderProfile orphan renderer stays deleted (nav key aliases Volumes)', () => {
  assert(!/function renderOrderProfile/.test(uiSrc), 'renderOrderProfile deleted');
  assert(/orderProfile: renderVolumes/.test(uiSrc), 'legacy nav key aliases straight to Volumes');
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-station-economics: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
