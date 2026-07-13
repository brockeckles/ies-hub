// test-cm-station-price.mjs — M5-Price: rate-card strip (2026-07-13)
//
// Locks the Price-face contract:
//   1. renderPriceStrip — one card per bucket carrying data-tc-section
//      ("pricing") + data-cm-cell="pb:<id>"; derived vs override pills;
//      +N overflow past 6; revenue frame card on the EXISTING 'revenue'
//      cell; empty state routes to the buckets editor; escaping.
//   2. ui.js integration pins — strip prepends for the three Price
//      sections under the D shell only; pb: provenance case reads the
//      seam's pricingSnapshot; pb: bypasses the projections guard.
//
// Pure module. ?v= pin MUST match ui.js's import
// (feedback_test_cache_bust_match).
//
// Run: node test-cm-station-price.mjs

import { readFileSync } from 'node:fs';

const stationPrice = await import('./tools/cost-model/station-price.js?v=20260713-m5g');
const { renderPriceStrip, priceStyles } = stationPrice;

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const BUCKET = (id, name, over = {}) => ({
  id, name, type: 'variable', uom: 'each', rate: 0.42, annualVolume: 1400000,
  recommendedRate: 0.42, overrideRate: null, _rateSource: 'recommended', ...over,
});
const BAG = {
  buckets: [
    BUCKET('each_pick', 'Each Pick'),
    BUCKET('mgmt_fee', 'Management Fee', { type: 'fixed', uom: 'month', rate: 47348.48, annualVolume: 12, recommendedRate: 47348.48 }),
    BUCKET('storage', 'Storage', { rate: 1.5, recommendedRate: 1.2, overrideRate: 1.5, _rateSource: 'override', overrideReason: 'client cap' }),
  ],
  revenue: 11000000, gmPct: 29.2, targetPct: 12,
};

t('strip: bucket cards carry pricing nav + pb: cells; frame card on revenue cell', () => {
  const html = renderPriceStrip(BAG);
  assert(html.includes('data-price-strip'), 'guard hook attribute present');
  assert(/data-tc-section="pricing"[^>]*data-cm-cell="pb:each_pick"[^>]*data-cm-year="1"/.test(html),
    'bucket card navigates + inspects');
  assert(html.includes('data-cm-cell="pb:mgmt_fee"'), 'second bucket cell');
  assert(/data-cm-cell="revenue"[^>]*/.test(html), 'frame card rides the EXISTING revenue cell');
  assert(html.includes('data-tc-section="pricingBuckets"'), 'edit-structure link routes to the buckets editor');
});

t('strip: derived vs override pills; rate + revenue formatting', () => {
  const html = renderPriceStrip(BAG);
  assert(html.includes('>derived<'), 'derived pill');
  assert(html.includes('>override<'), 'override pill (storage)');
  assert(html.includes('recommended was'), 'override tooltip cites the recommended rate');
  assert(html.includes('$0.42/each'), 'variable rate per uom');
  assert(html.includes('/mo'), 'fixed monthly rate unit');
  assert(html.includes('$588K/yr revenue'), 'bucket revenue = rate × volume');
  assert(html.includes('GM 29.2%') && html.includes('meets 12.0% target'), 'frame GM vs target');
});

t('strip: overflow past 6 buckets renders a +N card', () => {
  const many = { ...BAG, buckets: Array.from({ length: 9 }, (_, i) => BUCKET('b' + i, 'B' + i)) };
  const html = renderPriceStrip(many);
  assert((html.match(/data-cm-cell="pb:/g) || []).length === 6, 'six bucket cells max');
  assert(html.includes('+3 more'), 'overflow chip');
});

t('strip: empty state routes to the buckets editor, no cells', () => {
  const html = renderPriceStrip({ buckets: [], revenue: 0, gmPct: NaN, targetPct: 12 });
  assert(html.includes('No buckets yet'), 'guidance');
  assert(!html.includes('data-cm-cell="pb:'), 'no bucket cells');
  assert(/cmpr-card--empty"[^>]*data-tc-section="pricingBuckets"/.test(html), 'routes to structure editor');
});

t('strip: escapes hostile bucket names/ids', () => {
  const hostile = { ...BAG, buckets: [BUCKET('x"><img src=x onerror=alert(1)>', '<script>y</script>')] };
  const html = renderPriceStrip(hostile);
  assert(!html.includes('<img src=x') && !html.includes('<script>y'), 'name + id escaped');
});

t('priceStyles emits scoped .cmpr-* css', () => {
  const css = priceStyles();
  assert(css.startsWith('<style>') && css.includes('.cmpr-card') && css.includes('.cmpr-strip'), 'scoped styles');
});

// ---- ui.js integration pins ----
const uiSrc = readFileSync('./tools/cost-model/ui.js', 'utf8');

t('ui.js: strip prepends for the three Price sections, D shell only', () => {
  assert(/const PRICE_STRIP_SECTIONS = \['pricingBuckets', 'pricing', 'scenarios'\]/.test(uiSrc), 'section list pinned');
  assert(/_useDShell\(\) && PRICE_STRIP_SECTIONS\.includes\(activeSection\)/.test(uiSrc), 'D-shell gate');
  assert(uiSrc.includes('container.innerHTML = eco + price + render()'), 'strip prepends the section body');
  assert(uiSrc.includes('stationPrice.renderPriceStrip({'), 'values bag feeds the pure renderer');
});

t('ui.js: pb: provenance reads the seam snapshot; bypasses the projections guard', () => {
  const anchor = "if (rowKey && rowKey.startsWith('pb:'))";
  assert(uiSrc.includes(anchor), 'pb: branch exists');
  const fn = uiSrc.slice(uiSrc.indexOf(anchor), uiSrc.indexOf(anchor) + 1800);
  assert(fn.includes('c.pricingSnapshot?.buckets'), 'reads enriched buckets from the seam');
  assert(fn.includes('frozen rate-card snapshot'), 'snapshot honesty note present');
  assert(/const isOpKey = [^\n]*'pb:'[^\n]*/.test(uiSrc), 'pb: in the guard bypass');
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-station-price: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
