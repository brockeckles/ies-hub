// test-cm-station-operation.mjs — M5-Operation: flow-as-face (2026-07-13)
//
// Locks the Operation-face contract:
//   1. aggregateAreas — binning, flow order (main by sortOrder then wide),
//      empty areas dropped, cost-weighted MOST-backed %, indirect flag.
//   2. renderFlowStrip — data-op-area cards, selection, connectors only
//      between adjacent main areas, std dots, MOST pill, empty state.
//   3. renderLinesTable — data-labor-select rows, UPH input on the
//      data-array commit machinery (laborLines/base_uph), MOST vs manual
//      pills, totals row, XSS escaping.
//
// Pure module — no DOM, no cmState. ?v= pin MUST match ui.js's import
// (feedback_test_cache_bust_match).
//
// Run: node test-cm-station-operation.mjs

const stationOp = await import('./tools/cost-model/station-operation.js?v=20260713-m5b');
const { aggregateAreas, renderFlowStrip, renderLinesTable, operationStyles } = stationOp;

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- Fixtures (mirror the OFP default registry shape) ----
const REGISTRY = [
  { key: 'inbound',      label: 'Inbound',            color: '#0EA5E9', displayMode: 'main', sortOrder: 0 },
  { key: 'storage',      label: 'Storage',            color: '#8B5CF6', displayMode: 'main', sortOrder: 1 },
  { key: 'outbound',     label: 'Outbound',           color: '#16A34A', displayMode: 'main', sortOrder: 2 },
  { key: 'returnsVas',   label: 'Returns / VAS',      color: '#F59E0B', displayMode: 'wide', sortOrder: 3 },
  { key: 'support',      label: 'Support / Indirect', color: '#64748B', displayMode: 'wide', sortOrder: 4 },
  { key: 'unclassified', label: 'Unclassified',       color: '#DC2626', displayMode: 'wide', sortOrder: 5 },
];
const ENTRIES = [
  { idx: 0, areaKey: 'inbound',  isIndirect: false, name: 'Receiving — pallets', mostLabel: 'MOST · RC-201', hasStandard: true,  uph: 42,  volume: 190000,  fte: 38,  cost: 2600000 },
  { idx: 1, areaKey: 'outbound', isIndirect: false, name: 'Discrete pick — D2C', mostLabel: 'MOST · EP-104', hasStandard: true,  uph: 94,  volume: 8800000, fte: 67.2, cost: 4710000 },
  { idx: 2, areaKey: 'outbound', isIndirect: false, name: 'Pick-to-clean / replen', mostLabel: null,         hasStandard: false, uph: 120, volume: 1400000, fte: 13.6, cost: 940000 },
  { idx: 3, areaKey: 'support',  isIndirect: true,  name: 'Supervisor',          mostLabel: null,            hasStandard: false, uph: 0,   volume: 0,       fte: 4,   cost: 380000 },
];

// ---- 1. aggregateAreas ----
t('bins entries into areas, drops empty areas, keeps flow order', () => {
  const agg = aggregateAreas(ENTRIES, REGISTRY);
  assert(agg.areas.map(a => a.key).join(',') === 'inbound,outbound,support',
    `order/emptiness wrong: ${agg.areas.map(a => a.key).join(',')}`);
  const ob = agg.areas.find(a => a.key === 'outbound');
  assert(ob.count === 2 && ob.mostCount === 1 && ob.manualCount === 1, 'outbound line accounting');
  assert(Math.abs(ob.fte - 80.8) < 0.01 && ob.cost === 5650000, 'outbound rollup sums');
  assert(agg.areas.find(a => a.key === 'support').isIndirect === true, 'support flagged indirect');
});

t('MOST-backed % is cost-weighted over DIRECT lines only', () => {
  const agg = aggregateAreas(ENTRIES, REGISTRY);
  // MOST cost = 2.6M + 4.71M of 8.25M direct → 88.6%
  const expected = ((2600000 + 4710000) / 8250000) * 100;
  assert(Math.abs(agg.mostBackedPct - expected) < 0.1, `got ${agg.mostBackedPct}`);
  assert(agg.directCount === 3, 'direct count excludes indirect');
  const none = aggregateAreas([], REGISTRY);
  assert(none.mostBackedPct === null, 'null when no direct cost (no fake 0%)');
});

t('wide areas sort after main areas regardless of sortOrder; unknown keys fall to unclassified', () => {
  // Registry where a WIDE area numerically precedes a MAIN area — users can
  // reorder areas, so the face's main-then-wide rule must not rely on the
  // seed's convenient numbering.
  const registry = [
    { key: 'returnsVas', label: 'Returns / VAS', displayMode: 'wide', sortOrder: 0 },
    { key: 'storage', label: 'Storage', displayMode: 'main', sortOrder: 1 },
    { key: 'unclassified', label: 'Unclassified', displayMode: 'wide', sortOrder: 5 },
  ];
  const entries = [
    { idx: 0, areaKey: 'returnsVas', fte: 1, cost: 100, hasStandard: false },
    { idx: 1, areaKey: 'storage', fte: 2, cost: 200, hasStandard: true },
    { idx: 2, areaKey: 'ghost-area', fte: 3, cost: 300, hasStandard: false },
  ];
  const agg = aggregateAreas(entries, registry);
  assert(agg.areas.map(a => a.key).join(',') === 'storage,returnsVas,unclassified',
    `got ${agg.areas.map(a => a.key).join(',')}`);
});

// ---- 2. renderFlowStrip ----
t('flow strip: cards carry data-op-area, selection class, MOST pill, std dots', () => {
  const agg = aggregateAreas(ENTRIES, REGISTRY);
  const html = renderFlowStrip(agg, 'outbound');
  assert(html.includes('data-op-area="inbound"') && html.includes('data-op-area="outbound"')
    && html.includes('data-op-area="support"'), 'all three cards present');
  assert(/cmop-area--sel"[^>]*data-op-area="outbound"/.test(html), 'outbound card selected');
  assert(html.includes('MOST-backed 89%'), 'cost-weighted pill rendered');
  assert(html.includes('cmop-std--g'), 'green std dot (inbound all MOST)');
  assert(html.includes('cmop-std--w'), 'warn std dot (outbound has a manual line)');
  assert((html.match(/cmop-conn/g) || []).length === 1,
    'exactly one connector (inbound→outbound); none into the wide support card');
});

t('flow strip: empty state renders guidance, no cards', () => {
  const html = renderFlowStrip(aggregateAreas([], REGISTRY), null);
  assert(html.includes('No labor lines yet'), 'empty guidance');
  assert(!html.includes('data-op-area='), 'no cards');
});

// ---- 3. renderLinesTable ----
t('lines table: rows on data-labor-select, UPH input rides the data-array machinery', () => {
  const rows = ENTRIES.filter(e => e.areaKey === 'outbound');
  const html = renderLinesTable(rows, 1, { areaLabel: 'Outbound' });
  assert(html.includes('data-labor-select="1"') && html.includes('data-labor-select="2"'), 'row selectors');
  assert(/cmop-row--sel"[^>]*data-labor-select="1"/.test(html), 'selected row highlighted');
  assert(html.includes('data-array="laborLines"') && html.includes('data-field="base_uph"')
    && html.includes('data-type="number"'), 'UPH input commits via the existing machinery');
  assert(html.includes('MOST · EP-104'), 'MOST pill');
  assert(html.includes('Manual est.'), 'manual pill');
  assert(html.includes('8.8M'), 'volume formatted');
  assert(html.includes('$5.65M'), 'totals row cost');
});

t('lines table: escapes hostile names and area labels', () => {
  const hostile = [{ idx: 0, areaKey: 'outbound', name: '<img src=x onerror=alert(1)>',
    mostLabel: null, hasStandard: false, uph: 10, volume: 100, fte: 1, cost: 1000 }];
  const html = renderLinesTable(hostile, 0, { areaLabel: '<script>x</script>' });
  assert(!html.includes('<img src=x'), 'name escaped');
  assert(!html.includes('<script>x'), 'area label escaped');
});

t('lines table: empty area renders add-a-line guidance', () => {
  const html = renderLinesTable([], null, { areaLabel: 'Storage' });
  assert(html.includes('No lines in this area yet'), 'empty guidance');
  assert(!html.includes('<tfoot>'), 'no totals row when empty');
});

t('operationStyles emits scoped .cmop-* css', () => {
  const css = operationStyles();
  assert(css.startsWith('<style>') && css.includes('.cmop-area') && css.includes('.cmop-lines'), 'scoped styles');
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-station-operation: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
