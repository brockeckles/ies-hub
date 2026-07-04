// test-most-wc-retire.mjs — decision #10 option C (2026-07-04): the MOST
// Workflow Composer tab is RETIRED. Prod most_analyses held 0 saved rows of
// either shape at retirement, so no data migration was needed.
//
// Pins:
//   1. The 4th tab, its chrome actions, save path, and composer renderer are
//      fully unwired from ui.js; api.saveWorkflow is gone.
//   2. Legacy kind='workflow' rows stay quarantined — excluded from
//      savedScenarios, and a landing open routes to the Library with a
//      notice (never an empty Quick Analysis, never a dead composer).
//   3. The replacement — the catalog Sequence Preview — exists, runs on the
//      shared DEFAULT_ANALYSIS_PARAMS, and its calc spine (computeWorkflowStep
//      + analyzeWorkflow) still identifies bottlenecks correctly.
//
// Run:  node test-most-wc-retire.mjs

import { readFileSync } from 'node:fs';
import * as calc from './tools/most-standards/calc.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const ui = readFileSync('./tools/most-standards/ui.js', 'utf8');
const api = readFileSync('./tools/most-standards/api.js', 'utf8');
const index = readFileSync('./index.html', 'utf8');

// ── 1. composer fully unwired ────────────────────────────────────────────
t('no workflow tab in MOST_GROUPS', () =>
  assert(!ui.includes("key: 'workflow'"), 'workflow tab key survives'));

t('no composer renderer, chrome actions, or save path in ui.js', () => {
  for (const sym of ['renderWorkflowComposer', 'renderWorkflowSummary',
    'saveCurrentWorkflow', 'pushWorkflowToCostModel', 'exportWorkflowToXlsx',
    'createEmptyWorkflow', 'workflowScenarios', 'most-save-workflow',
    'most-run-workflow', 'add-wf-step', 'set-wf-template']) {
    assert(!ui.includes(sym), `${sym} still present in ui.js`);
  }
});

t('api.saveWorkflow retired', () =>
  assert(!api.includes('saveWorkflow') && !api.includes('serializeWorkflow'),
    'api.js still carries the composer save path'));

t('router pin bumped for the retirement commit', () =>
  assert(index.includes('most-standards/ui.js?v=20260704-wcr1'), 'index.html pin not bumped'));

// ── 2. legacy rows quarantined ───────────────────────────────────────────
t('workflow-kind rows still excluded from savedScenarios', () =>
  assert(ui.includes("analysis_data.kind === 'workflow'"), 'kind discriminator gone — legacy rows would hydrate as empty QA'));

t('landing open of a legacy workflow row → library + notice', () =>
  assert(/kind === 'workflow'\)\s*\{\s*\n\s*showToast\([\s\S]{0,220}activeTab = 'library';/.test(ui),
    'legacy-row open must toast and land on the library'));

// ── 3. Sequence Preview replacement ──────────────────────────────────────
t('catalog Sequence Preview exists and is wired', () => {
  for (const sym of ['renderSequenceTray', '_seqSteps', 'data-action="seq-add"',
    'data-action="seq-send"', 'data-action="seq-remove"', 'data-action="seq-clear"',
    'data-seq-vol']) {
    assert(ui.includes(sym), `${sym} missing`);
  }
});

t('preview steps run on shared DEFAULT_ANALYSIS_PARAMS', () =>
  assert(/_seqSteps[\s\S]{0,200}calc\.DEFAULT_ANALYSIS_PARAMS/.test(ui)));

t('seq-send seeds staffing lines with the preview volume', () =>
  assert(/seq-send[\s\S]{0,900}_fillLineFromTemplate\(line, tpl\);\s*\n\s*line\.daily_volume = vol;/.test(ui),
    'send path must reuse _fillLineFromTemplate + stamp daily_volume'));

// calc spine sanity — the tray math end-to-end at shared defaults.
t('computeWorkflowStep + analyzeWorkflow spot the bottleneck', () => {
  const p = calc.DEFAULT_ANALYSIS_PARAMS;
  const mk = (name, uph) => ({
    step_name: name,
    ...calc.computeWorkflowStep({
      base_uph: uph, pfd_pct: p.pfd_pct, productivity_pct: p.productivity_pct,
      target_volume: 5000, volume_ratio: 1, shift_hours: p.shift_hours,
    }),
  });
  const steps = [mk('Receive', 400), mk('Pick', 120), mk('Pack', 300)];
  const res = calc.analyzeWorkflow(steps);
  assert(res.bottleneckStep === 'Pick', `bottleneck ${res.bottleneckStep} ≠ Pick`);
  assert(res.totalFtes > 0, 'no FTEs computed');
  assert(steps[1].adjusted_uph < steps[2].adjusted_uph, 'adjusted UPH ordering wrong');
});

console.log('');
if (failures.length) console.error(failures.join('\n'));
console.log(`test-most-wc-retire: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
