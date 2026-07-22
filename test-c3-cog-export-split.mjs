// test-c3-cog-export-split.mjs — pins the C3 "COG client-safe export split"
// (2026-07-22): all export/document GENERATION (analysis CSV, per-shipment
// CSV, GeoJSON, PPTX deck, print HTML) lives in a pure, side-effect-free
// module at tools/center-of-gravity/export.js (WSC basis-doc.js pattern),
// while ui.js keeps only the thin triggers (guard toasts, downloads, popup
// plumbing, PptxGenJS CDN loader).
//
// Pins:
//   1. export.js imports cleanly in bare node — no DOM globals touched at
//      import time — and exposes exactly the five builders.
//   2. export.js source contains no document./window. references at all
//      (the CDN loader + blob/anchor/popup side effects stayed in ui.js).
//   3. ui.js no longer contains the moved generation bodies (source scan
//      for generation-only markers), but still defines the thin triggers.
//   4. Builders actually build: CSV sections, GeoJSON FeatureCollection,
//      print HTML doc, and a PPTX deck driven through a stub constructor.
//
// Run:  node test-c3-cog-export-split.mjs

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

const uiSrc = readFileSync(new URL('./tools/center-of-gravity/ui.js', import.meta.url), 'utf8');
const exSrc = readFileSync(new URL('./tools/center-of-gravity/export.js', import.meta.url), 'utf8');

// ------------------------------------------------------------------
// Shared fixture — minimal but full-shaped COG state
// ------------------------------------------------------------------
const POINTS = [
  { id: 'p1', name: 'Chicago Metro', lat: 41.88, lng: -87.63, weight: 60000 },
  { id: 'p2', name: 'Dallas Metro', lat: 32.78, lng: -96.80, weight: 40000 },
];
const COG_RESULT = {
  centers: [{ lat: 39.5, lng: -90.1, nearestCity: 'Springfield, IL', totalWeight: 100000, avgWeightedDistance: 310.5, maxDistance: 612.2 }],
  assignments: [
    { pointId: 'p1', clusterId: 0, distanceToCenter: 180.4 },
    { pointId: 'p2', clusterId: 0, distanceToCenter: 420.9 },
  ],
  costByAssignment: [
    { pointId: 'p1', totalCost: 52000, truckCost: 52000, parcelCost: 0, zone: 3, pkgCount: 0 },
    { pointId: 'p2', totalCost: 98000, truckCost: 98000, parcelCost: 0, zone: 5, pkgCount: 0 },
  ],
  costByCluster: [150000],
  iterations: 12,
  totalCost: 150000,
  avgCostPerUnit: 1.5,
  totalTruckloads: 4,
  totalTruckMiles: 52000,
  co2Tons: 84,
};
const CONFIG = {
  transportCostPerMile: 2.85, roundTripFactor: 2.0, roadFactor: 1.22,
  unitsPerTruck: 25000, weightUnit: 'lb', fixedCostPerDC: 0,
  co2KgPerTruckMile: 1.62, maxServiceMiles: 0, analysisHorizonYears: 1,
  customerName: 'Acme Industries',
};

// ------------------------------------------------------------------
// 1. Importable side-effect-free in bare node (no DOM globals)
// ------------------------------------------------------------------
const mod = await import('./tools/center-of-gravity/export.js');

t('export.js imports in bare node and exposes exactly the 5 builders', () => {
  const keys = Object.keys(mod).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ['buildAnalysisCsv', 'buildGeoJson', 'buildPerShipmentCsv', 'buildPptxDeck', 'buildPrintHtml'],
  ), `unexpected export surface: ${keys.join(', ')}`);
  for (const k of keys) assert(typeof mod[k] === 'function', `${k} is not a function`);
});

t('export.js passes node --input-type=module --check', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: exSrc, encoding: 'utf8' });
  assert(r.status === 0, `--check failed: ${r.stderr}`);
});

t('export.js source performs no browser side effects', () => {
  // The blob/anchor download, popup open/write, and PptxGenJS CDN <script>
  // loader all stayed in ui.js. Generation must be runnable headless.
  // (window.print()/window.close() strings inside the generated popup HTML
  // are output, not module behavior — so scan for the side-effect APIs.)
  for (const bad of ['document.createElement', 'document.body', 'document.head',
                     'URL.createObjectURL', 'window.open(', 'sessionStorage',
                     'writeFile(', 'downloadCSV(', 'showToast(']) {
    assert(!exSrc.includes(bad), `export.js contains browser side effect: ${bad}`);
  }
});

// ------------------------------------------------------------------
// 2. ui.js: thin triggers remain, generation bodies are gone
// ------------------------------------------------------------------
t('ui.js keeps the thin triggers (names still bound + imported builders)', () => {
  for (const fn of ['function exportCogAnalysis()', 'function exportCogPerShipment()',
                    'function exportCogGeoJSON()', 'async function openPptxExport()',
                    'function openPrintView()', 'function _ensurePptxLoaded()']) {
    assert(uiSrc.includes(fn), `ui.js lost trigger: ${fn}`);
  }
  assert(/import \{[^}]*buildAnalysisCsv[^}]*\} from '\.\/export\.js\?v=/.test(uiSrc),
    'ui.js does not import the builders from ./export.js with a ?v= pin');
});

t('ui.js no longer contains the moved generation bodies', () => {
  // Markers that exist ONLY inside the generation logic, not the triggers.
  const movedMarkers = [
    "'OPTIMAL CENTERS'",                       // analysis CSV section header
    'DEMAND POINTS & ASSIGNMENTS',             // analysis CSV section header
    'Per-shipment audit CSV — generated',      // per-shipment CSV comment row
    "'FeatureCollection'",                     // GeoJSON builder
    'assignment_line',                         // GeoJSON line features
    'LAYOUT_WIDE',                             // PPTX deck build
    'pres.addSlide()',                         // PPTX slide creation
    'kpi-strip',                               // print HTML CSS
    'Print preview — use your browser',        // print HTML toolbar
  ];
  for (const m of movedMarkers) {
    assert(!uiSrc.includes(m), `ui.js still contains moved generation marker: ${m}`);
    assert(exSrc.includes(m), `export.js is missing generation marker: ${m}`);
  }
});

// ------------------------------------------------------------------
// 3. Builders build (headless)
// ------------------------------------------------------------------
t('buildAnalysisCsv: 3 sections, engine source of truth, dated filename', () => {
  const { filename, csv } = mod.buildAnalysisCsv({ cogResult: COG_RESULT, points: POINTS, config: CONFIG });
  assert(/^cog-analysis-\d{4}-\d{2}-\d{2}\.csv$/.test(filename), `bad filename: ${filename}`);
  assert(csv.startsWith('SUMMARY'), 'missing SUMMARY section');
  assert(csv.includes('OPTIMAL CENTERS'), 'missing OPTIMAL CENTERS section');
  assert(csv.includes('DEMAND POINTS & ASSIGNMENTS'), 'missing assignments section');
  assert(csv.includes('Springfield, IL'), 'center city not in CSV');
  assert(csv.includes('"Chicago Metro"'), 'point row not in CSV');
});

t('buildPerShipmentCsv: header comments + one row per assignment', () => {
  const { filename, csv } = mod.buildPerShipmentCsv({ cogResult: COG_RESULT, points: POINTS, config: CONFIG, scenarioName: 'Acme Q3' });
  assert(/^cog-per-shipment-\d{4}-\d{2}-\d{2}\.csv$/.test(filename), `bad filename: ${filename}`);
  assert(csv.includes('# Scenario: Acme Q3'), 'scenario comment missing');
  assert(csv.includes('point_id,name,lat,lng,cluster'), 'column header missing');
  const dataRows = csv.split('\n').filter(l => l.startsWith('"p'));
  assert(dataRows.length === 2, `expected 2 data rows, got ${dataRows.length}`);
});

t('buildGeoJson: valid FeatureCollection with centers, points, lines', () => {
  const { filename, text } = mod.buildGeoJson({ cogResult: COG_RESULT, points: POINTS, config: CONFIG });
  assert(/^cog-analysis-\d{4}-\d{2}-\d{2}\.geojson$/.test(filename), `bad filename: ${filename}`);
  const fc = JSON.parse(text);
  assert(fc.type === 'FeatureCollection', 'not a FeatureCollection');
  const kinds = fc.features.map(f => f.properties.kind);
  assert(kinds.filter(k => k === 'center').length === 1, 'center feature missing');
  assert(kinds.filter(k => k === 'demand_point').length === 2, 'demand point features missing');
  assert(kinds.filter(k => k === 'assignment_line').length === 2, 'assignment lines missing');
});

t('buildPrintHtml: self-contained doc, no unresolvable CSS var() tokens', () => {
  const html = mod.buildPrintHtml({
    cogResult: COG_RESULT, points: POINTS, solvePoints: POINTS,
    config: CONFIG, scenarioName: 'Acme Q3', cpm: 2.85,
  });
  assert(html.startsWith('<!doctype html>'), 'not a full document');
  assert(html.includes('Acme Q3'), 'scenario name missing');
  assert(html.includes('Springfield, IL'), 'center card missing');
  // Popup docs never load css/hub.css — a var(--…) here would render broken.
  const styleAndBody = html.replace(/@page[^}]*}/, '');
  assert(!/var\(--(ies|c)-/.test(styleAndBody), 'print HTML leaks design-token var() refs');
});

t('buildPptxDeck: drives an injected constructor, returns { pres, fname }', () => {
  // Stub PptxGenJS: record calls, no I/O.
  const calls = { slides: 0, texts: 0, shapes: 0, tables: 0, charts: 0 };
  function StubPptx() {
    this.shapes = new Proxy({}, { get: (_, p) => String(p) });
    this.charts = new Proxy({}, { get: (_, p) => String(p) });
    this.addSlide = () => { calls.slides++; return {
      addText: () => { calls.texts++; },
      addShape: () => { calls.shapes++; },
      addTable: () => { calls.tables++; },
      addChart: () => { calls.charts++; },
    }; };
    this.writeFile = async () => { throw new Error('writeFile must stay in ui.js'); };
  }
  const { pres, fname } = mod.buildPptxDeck({
    PptxGenJSCtor: StubPptx, cogResult: COG_RESULT, points: POINTS,
    solvePoints: POINTS, sensitivityData: [{ k: 1, totalCost: 150000, isRecommended: true }],
    config: CONFIG, scenarioName: 'Acme Q3',
  });
  assert(pres instanceof StubPptx, 'did not return the built presentation');
  assert(/^cog-Acme-Industries-\d{4}-\d{2}-\d{2}\.pptx$/.test(fname), `bad fname: ${fname}`);
  assert(calls.slides === 6, `expected 6 slides, got ${calls.slides}`);
  assert(calls.texts > 20 && calls.shapes > 10, 'deck content not built');
});

// ------------------------------------------------------------------
setTimeout(() => {
  console.log(`test-c3-cog-export-split: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}, 50);
