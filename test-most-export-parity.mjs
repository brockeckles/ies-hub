// test-most-export-parity.mjs — P1-3 guard (2026-07-02 assessment).
// The XLSX export must agree with the screen: one canonical line-derivation
// path (calc.computeAnalysisLines) shared by render, export, push-to-CM,
// and scenario summaries. Pre-fix, export skipped learning curve +
// per-category rates, summed `ftes` into a summary that reads `fte`
// (Total FTEs always 0), and never populated annual_cost.
// Run:  node test-most-export-parity.mjs

import { readFileSync } from 'node:fs';
import {
  computeAnalysisLines,
  computeAnalysisSummary,
  computeAnalysisLine,
  applyLearningCurve,
  DEFAULT_OPERATING_DAYS,
} from './tools/most-standards/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, eps, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`); }

console.log('MOST export/screen parity');

const ANALYSIS = {
  pfd_pct: 14,
  productivity_pct: 90,
  learning_curve_pct: 80,          // ramp scenario — the drift trigger
  shift_hours: 8,
  hourly_rate: 20,
  operating_days: 250,
  rates_by_category: { manual: 18.5, mhe: 24, hybrid: 21 },
  lines: [
    { activity_name: 'Case Pick', labor_category: 'manual', base_uph: 120, daily_volume: 9600 },
    { activity_name: 'Putaway (MHE)', labor_category: 'mhe', base_uph: 45, daily_volume: 1800 },
    { activity_name: 'Pack Out', labor_category: 'hybrid', base_uph: 80, daily_volume: 4000, hourly_rate: 22.75 },
  ],
};

t('learning curve is applied (adjusted UPH < no-LC derivation)', () => {
  const [line] = computeAnalysisLines({ ...ANALYSIS, lines: [ANALYSIS.lines[0]] });
  const noLc = computeAnalysisLine({
    base_uph: 120, pfd_pct: 14, productivity_pct: 90,
    daily_volume: 9600, shift_hours: 8, hourly_rate: 18.5,
  });
  assert(line.adjusted_uph < noLc.adjusted_uph, `LC not applied: ${line.adjusted_uph} !< ${noLc.adjusted_uph}`);
  near(line.adjusted_uph, applyLearningCurve(noLc.adjusted_uph, 80), 0.01, 'LC math');
});

t('per-category rates resolve (mhe line priced at 24, not the 20 default)', () => {
  const lines = computeAnalysisLines(ANALYSIS);
  near(lines[1].effective_rate, 24, 0.001, 'mhe rate');
  near(lines[1].daily_cost, lines[1].hours_per_day * 24, 0.01, 'mhe daily cost');
});

t('per-line rate override beats category rate', () => {
  const lines = computeAnalysisLines(ANALYSIS);
  near(lines[2].effective_rate, 22.75, 0.001, 'hybrid line override');
});

t('summary totals are non-zero and keyed off fte (the ftes/fte bug)', () => {
  const lines = computeAnalysisLines(ANALYSIS);
  const summary = computeAnalysisSummary(lines, 250);
  assert(summary.totalFtes > 0, 'totalFtes is 0 — fte key mismatch regressed');
  near(summary.totalFtes, lines.reduce((s, l) => s + l.fte, 0), 0.001, 'totalFtes');
  near(summary.annualCost, summary.dailyCost * 250, 0.01, 'annualCost');
});

t('annual_cost is populated per line = daily_cost × operating_days', () => {
  const lines = computeAnalysisLines(ANALYSIS);
  for (const l of lines) near(l.annual_cost, l.daily_cost * 250, 0.01, l.activity_name);
});

t('operating_days defaults to DEFAULT_OPERATING_DAYS when absent', () => {
  const { operating_days, ...rest } = ANALYSIS;
  const [line] = computeAnalysisLines({ ...rest, lines: [ANALYSIS.lines[0]] });
  near(line.annual_cost, line.daily_cost * DEFAULT_OPERATING_DAYS, 0.01, 'default days');
});

t('LC=100 / no categories degenerates to the plain derivation (back-compat)', () => {
  const plain = { pfd_pct: 14, productivity_pct: 90, shift_hours: 8, hourly_rate: 20,
    lines: [{ base_uph: 100, daily_volume: 4000 }] };
  const [line] = computeAnalysisLines(plain);
  const direct = computeAnalysisLine({ base_uph: 100, pfd_pct: 14, productivity_pct: 90,
    daily_volume: 4000, shift_hours: 8, hourly_rate: 20 });
  near(line.adjusted_uph, direct.adjusted_uph, 0.001, 'uph');
  near(line.fte, direct.fte, 0.001, 'fte');
  near(line.daily_cost, direct.daily_cost, 0.001, 'cost');
});

// Static: all five ui.js consumers go through the canonical helper.
t('ui.js render/export/push/scenario/save-fallback all use computeAnalysisLines', () => {
  const src = readFileSync(new URL('./tools/most-standards/ui.js', import.meta.url), 'utf8');
  const calls = (src.match(/calc\.computeAnalysisLines\(/g) || []).length;
  assert(calls >= 5, `expected ≥5 canonical call sites, found ${calls}`);
  assert(!/computed\.fte \|\| 0/.test(src) || true, 'n/a');
  // the old drift pattern: computeAnalysisLine called directly inside ui.js
  const directs = (src.match(/calc\.computeAnalysisLine\(/g) || []).length;
  assert(directs === 0, `ui.js still calls computeAnalysisLine directly ${directs}× — drift risk`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
