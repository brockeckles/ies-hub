/**
 * C4 (2026-07-22) — Command Center dead-code purge stays purged.
 *
 * Wave C4 deleted ~617 lines of verified-dead CC code: the never-invoked
 * Chart.js stack (initCharts was never called after the KPI tiles moved to
 * inline SVG sparklines — its ensureChartJs() injected chart.js@3.9.1 via a
 * raw <script> tag while index.html pins the single global Chart.js 4.5.1,
 * a version-skew loader conflict), the Sector Pulse / Market Alerts /
 * platform-health template helpers orphaned when the Signal Stream replaced
 * those widgets, their unreachable bindEvents delegation branches, and the
 * api.js sectors/fetchChartData pipeline nothing consumed.
 *
 * Source scan only — pins the deletions so the dead code doesn't creep back.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const ui = readFileSync('./hub/command-center/ui.js', 'utf8');
const api = readFileSync('./hub/command-center/api.js', 'utf8');
const html = readFileSync('./index.html', 'utf8');

// ── Chart.js stack gone (and with it the 3.9.1 loader conflict) ──────────
t('CC no longer carries its own Chart.js CDN loader (3.9.1 vs index.html 4.5.1)', () =>
  !ui.includes('chart.js@3.9.1') && !ui.includes('ensureChartJs'));
t('never-called chart render stack deleted', () =>
  !/initCharts|renderCharts|renderDieselChart|renderFreightChart|renderLaborChart|renderSteelChart|destroyAllCharts/.test(ui));
t('chart instance vars deleted', () =>
  !/dieselChartInstance|freightChartInstance|laborChartInstance|steelChartInstance/.test(ui));
t('index.html still the single Chart.js pin (4.x)', () =>
  /cdn\.jsdelivr\.net\/npm\/chart\.js@4/.test(html));
t('api.js fetchChartData (only consumer was the dead chart stack) deleted', () =>
  !api.includes('fetchChartData') && !api.includes('DEMO_LABOR_CHART'));

// ── Orphaned pre-Signal-Stream widget helpers gone ───────────────────────
t('Sector Pulse / Market Alerts era helpers deleted', () =>
  !/function kpiCard|function sectorPulseCard|function alertRow|function miniKpi|function toolTile|function statusTile|function matchAlertHeight/.test(ui));
t('unreachable bindEvents branches deleted (no template produces these attrs)', () =>
  !ui.includes('data-alert-link') && !ui.includes('data-alert-url') &&
  !ui.includes("closest('[data-route]')"));
t('unused event-bus import dropped', () => !/import \{ bus \}/.test(ui));
t('api.js sectors pipeline (unread by UI) deleted', () =>
  !api.includes('buildSectorsFromNews') && !api.includes('DEMO_SECTORS'));
t('unread KPI fields (laborTightness / marketSignal) deleted', () =>
  !api.includes('laborTightness') && !api.includes('marketSignal'));

// ── Live surfaces preserved (C2/C3 upgrades must survive the purge) ──────
t('sparkline KPI tiles still live', () =>
  ui.includes('function vitalSignTile') && ui.includes('function renderSparkline'));
t('pipeline snapshot card still live (Sites KPI + grade chips + est pill)', () =>
  ui.includes('function renderPipelineSnapshot') && ui.includes('deals fully covered'));
t('win/loss card still live', () => ui.includes('function renderWinLossCard'));
t('signal stream + RFP feed still live', () =>
  ui.includes('function renderIntelFeed') && ui.includes('function renderRfpFeed'));
t('bind-once guard intact', () =>
  /if \(!rootEl \|\| rootEl\.__ccBound\) return;\s*\n\s*rootEl\.__ccBound = true;/.test(ui));
t('kpi spark builder still live in api.js', () => api.includes('buildKpiSparks'));

console.log(`test-c4-cc-dead-code: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
