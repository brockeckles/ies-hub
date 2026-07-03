/**
 * P2-3 (2026-07-02) — Workflow Composer persistence + NetOpt demand CSV.
 */
import {
  serializeWorkflow, workflowFromAnalysisData, workflowStepsToCmLines,
  convertToCmLaborLines, computeWorkflowStep,
} from './tools/most-standards/calc.js';
import { parseDemandCsv } from './tools/network-opt/calc.js';
import { ZIP3_CENTROIDS } from './tools/center-of-gravity/calc.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── workflow serialize/deserialize round-trip ─────────────────────────────
t('workflow round-trip preserves durable fields, strips derived, recomputes clean', () => {
  const wf = {
    id: 'row-9', name: 'Inbound Flow', target_volume_per_day: 8000, shift_hours: 10,
    pfd_pct: 12, productivity_pct: 95,
    steps: [
      { id: 'x', template_id: 4, step_name: 'Receive', process_area: 'Receiving', labor_category: 'mhe', base_uph: 200, volume_ratio: 1, adjusted_uph: 168, fte: 4.7, hours_per_day: 47 },
      { id: 'y', template_id: 7, step_name: 'Putaway', process_area: 'Putaway', labor_category: 'mhe', base_uph: 90, volume_ratio: 0.6 },
    ],
  };
  const ser = serializeWorkflow(wf);
  if (ser.kind !== 'workflow') throw new Error('missing kind discriminator');
  if ('adjusted_uph' in ser.workflow.steps[0] || 'fte' in ser.workflow.steps[0]) throw new Error('derived fields leaked into payload');
  const back = workflowFromAnalysisData(ser, 'row-9');
  if (back.name !== 'Inbound Flow' || back.steps.length !== 2) throw new Error('round-trip lost data');
  if (!near(back.steps[1].volume_ratio, 0.6) || back.steps[1].base_uph !== 90) throw new Error('step fields lost');
  if (back.productivity_pct !== 95 || back.shift_hours !== 10) throw new Error('params lost');
});

t('workflowFromAnalysisData survives junk/legacy payloads with defaults', () => {
  const back = workflowFromAnalysisData({}, null);
  if (back.steps.length !== 0 || back.pfd_pct !== 14 || back.shift_hours !== 8) throw new Error('defaults wrong');
});

// ── workflow → CM push adapter ────────────────────────────────────────────
t('workflow steps convert to CM labor lines through the canonical converter', () => {
  const derived = computeWorkflowStep({ base_uph: 100, pfd_pct: 0, productivity_pct: 100, target_volume: 1000, volume_ratio: 0.5, shift_hours: 8 });
  const steps = [
    { step_name: 'Pack', process_area: 'Packing', labor_category: 'manual', template_id: 3, base_uph: 100, volume_ratio: 0.5, ...derived },
    { step_name: 'Empty', base_uph: 0, volume_ratio: 1, adjusted_uph: 0, daily_volume: 0, hours_per_day: 0, fte: 0 },
  ];
  const lines = workflowStepsToCmLines(steps);
  if (lines.length !== 1) throw new Error('zero-volume step not filtered');
  const cm = convertToCmLaborLines(lines, { operatingDays: 250, shiftHours: 8, defaultBurdenPct: 30, templateMap: new Map() });
  // daily_volume = 1000×0.5 = 500 → annual 125,000; hours/day = 5 → annual 1,250
  if (!near(cm[0].volume, 125000) || !near(cm[0].annual_hours, 1250)) throw new Error(`CM line math off: ${cm[0].volume}/${cm[0].annual_hours}`);
  if (cm[0].activity_name !== 'Pack') throw new Error('step_name→activity_name mapping lost');
});

// ── demand CSV parser ─────────────────────────────────────────────────────
t('demand CSV: lat/lng, ZIP5→ZIP3 centroid, city/state, and error rows', () => {
  const csv = [
    'name,zip,city,state,lat,lng,annual volume,avg weight,channel,max days',
    '"Dallas, TX",75201,,,,,120000,32,dtc,2',        // ZIP5 → 752 centroid
    'ChiTown,,Chicago,IL,,,80000,,b2b,',              // city/state gazetteer
    'Explicit,,,,33.45,-112.07,50000,18,dtc,3',       // raw coords
    'NoWhere,00000,,,,,500,,,',                       // bad ZIP → error
    'NoDemand,30301,,,,,,,,',                         // no demand → error
  ].join('\n');
  const r = parseDemandCsv(csv, { zip3Lookup: ZIP3_CENTROIDS });
  if (r.demands.length !== 3) throw new Error(`want 3 demands, got ${r.demands.length}`);
  if (r.errors.length !== 2) throw new Error(`want 2 errors, got ${r.errors.length}`);
  const [dallas, chi, exp] = r.demands;
  if (dallas.zip3 !== '752' || !Number.isFinite(dallas.lat)) throw new Error('ZIP5→ZIP3 resolution failed');
  if (dallas.name !== 'Dallas, TX') throw new Error('quoted comma field corrupted');
  if (dallas.maxDays !== 2 || dallas.avgWeight !== 32 || dallas.channelKey !== 'dtc') throw new Error('optional fields lost');
  if (!Number.isFinite(chi.lat) || Math.abs(chi.lat - 41.88) > 1) throw new Error('city/state resolution failed');
  if (!near(exp.lat, 33.45) || !near(exp.lng, -112.07)) throw new Error('explicit coords not honored');
  if (chi.avgWeight !== 25 || chi.nmfcClass !== 100 || chi.maxDays !== 3) throw new Error('defaults wrong');
});

t('demand CSV: header-only / no-demand-column / no-location-column all error cleanly', () => {
  if (parseDemandCsv('name,zip\n', {}).errors.length === 0) throw new Error('header-only accepted');
  const noDemand = parseDemandCsv('zip,city\n75201,Dallas', {});
  if (!/demand\/volume column/.test(noDemand.errors[0].reason)) throw new Error('missing-demand-column not flagged');
  const noLoc = parseDemandCsv('volume,notes\n100,x', {});
  if (!/location columns/.test(noLoc.errors[0].reason)) throw new Error('missing-location not flagged');
});

// ── source wiring scans ───────────────────────────────────────────────────
{
  const mostUi = readFileSync('./tools/most-standards/ui.js', 'utf8');
  const mostApi = readFileSync('./tools/most-standards/api.js', 'utf8');
  const netUi = readFileSync('./tools/network-opt/ui.js', 'utf8');
  t('MOST ui partitions most_analyses rows on the workflow kind discriminator', () =>
    mostUi.includes("analysis_data.kind === 'workflow'") && mostUi.includes('workflowScenarios'));
  t('MOST api.saveWorkflow persists via serializeWorkflow', () =>
    mostApi.includes('export async function saveWorkflow') && mostApi.includes('serializeWorkflow(workflow)'));
  t('workflow chrome Save routes to saveCurrentWorkflow', () =>
    /actionId === 'most-save-workflow'.\s*\{\s*saveCurrentWorkflow\(false\);/s.test(mostUi));
  t('workflow composer offers save/export/push actions', () =>
    mostUi.includes("data-action=\"save-workflow\"") && mostUi.includes("data-action=\"most-wf-export-xlsx\"") && mostUi.includes("data-action=\"push-wf-to-cm\""));
  t('NetOpt demand tab has the CSV upload wired to parseDemandCsv', () =>
    netUi.includes('no-upload-demand-csv') && netUi.includes('calc.parseDemandCsv'));
  t('NetOpt surfaces skipped rows instead of silently dropping', () =>
    netUi.includes('Demand CSV skipped rows'));
}

console.log(`test-p23-workflow-demand: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
