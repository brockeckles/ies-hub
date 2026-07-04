/**
 * UX0-1 (2026-07-03) — MOST workflow push must not send $0 hourly rates.
 * The workflow-step → CM-line adapter now resolves category rates the same
 * way Quick Analysis does, and operating days ride the workflow instead of
 * a hardcoded 250. Guards the wiring in ui.js with source scans.
 */
import {
  workflowStepsToCmLines, serializeWorkflow, workflowFromAnalysisData,
  convertToCmLaborLines,
} from './tools/most-standards/calc.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const steps = [
  { step_name: 'Pick', labor_category: 'manual', base_uph: 100, adjusted_uph: 88, daily_volume: 5000, hours_per_day: 56.8 },
  { step_name: 'Load', labor_category: 'mhe', base_uph: 200, adjusted_uph: 176, daily_volume: 5000, hours_per_day: 28.4 },
  { step_name: 'Audit', labor_category: 'hybrid', base_uph: 300, adjusted_uph: 264, daily_volume: 5000, hours_per_day: 18.9, hourly_rate: 31.5 },
];
const rates = { manual: 18, mhe: 22.5, hybrid: 20 };

t('category rates resolve per step (manual/mhe)', () => {
  const lines = workflowStepsToCmLines(steps, { ratesByCategory: rates });
  if (lines[0].hourly_rate !== 18) throw new Error(`manual got ${lines[0].hourly_rate}`);
  if (lines[1].hourly_rate !== 22.5) throw new Error(`mhe got ${lines[1].hourly_rate}`);
});

t('explicit per-step rate beats category rate', () => {
  const lines = workflowStepsToCmLines(steps, { ratesByCategory: rates });
  if (lines[2].hourly_rate !== 31.5) throw new Error(`got ${lines[2].hourly_rate}`);
});

t('no rates provided → 0 (never invents a number)', () => {
  const lines = workflowStepsToCmLines(steps.slice(0, 1));
  if (lines[0].hourly_rate !== 0) throw new Error(`got ${lines[0].hourly_rate}`);
});

t('defaultRate fallback applies when category missing', () => {
  const lines = workflowStepsToCmLines(steps.slice(0, 1), { ratesByCategory: { mhe: 22 }, defaultRate: 17 });
  if (lines[0].hourly_rate !== 17) throw new Error(`got ${lines[0].hourly_rate}`);
});

t('rates flow through convertToCmLaborLines into the CM payload', () => {
  const lines = workflowStepsToCmLines(steps, { ratesByCategory: rates });
  const cm = convertToCmLaborLines(lines, { operatingDays: 250, shiftHours: 8, defaultBurdenPct: 30, templateMap: new Map() });
  if (!(cm[0].hourly_rate > 0 && cm[1].hourly_rate > 0)) throw new Error('CM lines lost the rate');
});

t('workflow round-trip preserves operating_days + rates_by_category', () => {
  const ser = serializeWorkflow({ name: 'W', operating_days: 260, rates_by_category: rates, steps: [] });
  if (ser.workflow.operating_days !== 260) throw new Error('operating_days dropped in serialize');
  const back = workflowFromAnalysisData(ser, 'r1');
  if (back.operating_days !== 260) throw new Error('operating_days dropped in deserialize');
  if (!back.rates_by_category || back.rates_by_category.mhe !== 22.5) throw new Error('rates dropped');
});

t('legacy payloads (no new fields) default sanely', () => {
  const back = workflowFromAnalysisData({ kind: 'workflow', workflow: { name: 'Old' } });
  if (back.operating_days !== 250) throw new Error(`got ${back.operating_days}`);
  if (back.rates_by_category !== null) throw new Error('expected null rates');
});

// ── source wiring scans ────────────────────────────────────────────────────
const ui = readFileSync('./tools/most-standards/ui.js', 'utf8');

// Decision #10 C (2026-07-04): the composer UI is retired — its push /
// rate-input wiring must be GONE from ui.js. The calc helpers above stay:
// they are the engine contract (and the catalog Sequence Preview's math).
t('composer push wiring fully removed from ui.js', () =>
  !ui.includes('workflowStepsToCmLines') && !ui.includes('would receive $0 labor rates'));

t('ui.js still never hardcodes operatingDays 250 in a push payload', () => {
  if (/operatingDays:\s*250\s*,/.test(ui)) throw new Error('hardcoded 250 present');
  return true;
});

t('composer rate/param inputs removed', () =>
  !ui.includes('data-wf-rate-cat=') && !ui.includes('data-wf="operating_days"'));

console.log(`test-ux0-most-workflow-rates: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
