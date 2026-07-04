// test-ux2-most-split.mjs — UX-2 / D3: MOST catalog/editor split + one defaults set
//
//   1. calc.DEFAULT_ANALYSIS_PARAMS — the single defaults source for Quick
//      Analysis AND Workflow Composer (X11 split-brain fix).
//   2. Source scans on tools/most-standards/ui.js: quick chrome groups,
//      tier-aware card click (quick → read-only detail, engineering →
//      sequence editor), use-in-staffing send path, both creators seeded
//      from DEFAULT_ANALYSIS_PARAMS, tier toggle remaps hidden tabs.
//
// Run:  node test-ux2-most-split.mjs

import { readFileSync } from 'node:fs';
import * as calc from './tools/most-standards/calc.js';
import * as tier from './shared/tier.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- 1. one defaults set ----

t('DEFAULT_ANALYSIS_PARAMS exists with the unified values', () => {
  const d = calc.DEFAULT_ANALYSIS_PARAMS;
  assert(d, 'missing');
  assert(d.operating_days === calc.DEFAULT_OPERATING_DAYS, 'days must reuse DEFAULT_OPERATING_DAYS');
  assert(d.operating_days === 260, 'unified days = 260');
  assert(d.pfd_pct === 14 && d.shift_hours === 8, 'pfd/shift');
  assert(d.productivity_pct === 90, 'productivity must be EXPLICIT 90 (display/engine agreement)');
  assert(d.rates_by_category.manual === 18 && d.rates_by_category.mhe === 22 && d.rates_by_category.hybrid === 20, 'rates');
});

t('explicit productivity flows through the engine (90 ≠ silent 100)', () => {
  // effectiveUph honors the explicit param — the old fresh-analysis state
  // omitted productivity_pct so the engine ran at 100 while the UI said 90.
  const at90 = calc.effectiveUph(100, 0, calc.DEFAULT_ANALYSIS_PARAMS.productivity_pct);
  const at100 = calc.effectiveUph(100, 0);
  assert(Math.abs(at90 - 90) < 1e-9, `expected 90, got ${at90}`);
  assert(Math.abs(at100 - 100) < 1e-9, 'default engine path unchanged for legacy rows');
});

t('most tier entry independent + defaults quick', () => {
  assert(tier.getTier('most') === 'quick');
  tier.setTier('most', 'engineering');
  assert(tier.getTier('cog') === 'quick' && tier.getTier('cm') === 'quick', 'other tools unaffected');
  tier.setTier('most', 'quick');
});

// ---- 2. ui wiring scans ----

const ui = readFileSync(new URL('./tools/most-standards/ui.js', import.meta.url), 'utf8');

t('MOST imports shared/tier.js with a cache-bust', () => {
  assert(/from '\.\.\/\.\.\/shared\/tier\.js\?v=[\w.-]+'/.test(ui), 'tier import missing/unpinned');
});

t('quick chrome = catalog + staffing; tier action wired', () => {
  assert(ui.includes('MOST_QUICK_GROUPS'), 'quick groups missing');
  assert(/key:\s*'library',\s*label:\s*'Template Catalog'/.test(ui), 'catalog group missing');
  assert(/key:\s*'analysis',\s*label:\s*'Staffing Analysis'/.test(ui), 'staffing group missing');
  assert(ui.includes(`id: 'most-tier'`), 'most-tier action missing');
  assert(ui.includes("if (actionId === 'most-tier')"), 'dispatch missing');
  assert(ui.includes('function handleMostTierToggle()'), 'toggle handler missing');
  assert(ui.includes("groups: _quick ? MOST_QUICK_GROUPS : MOST_GROUPS"), 'groups swap missing');
});

t('card click is tier-aware: quick → detail, engineering → editor', () => {
  assert(ui.includes('function _openTemplateFromCard(id)'), 'router fn missing');
  assert(ui.includes('function openTemplateDetail(id)') || ui.includes('async function openTemplateDetail(id)'), 'detail loader missing');
  // both click sites route through the tier-aware helper — no direct
  // openTemplateInEditor from card handlers.
  const cardSites = [...ui.matchAll(/most-tpl-card\[data-action="select-template"\]/g)];
  assert(cardSites.length >= 2, 'expected both card click sites');
  assert(!/tileCard[\s\S]{0,120}openTemplateInEditor/.test(ui), 'delegated site bypasses tier router');
  assert(ui.split('_openTemplateFromCard(id)').length >= 3, 'both sites must call the router');
});

t('detail panel: quick de-emphasizes TMU + has use-in-staffing', () => {
  assert(ui.includes('use-in-staffing'), 'send button missing');
  assert(ui.includes('_quickDetail'), 'quick detail variant missing');
  assert(ui.includes('function _fillLineFromTemplate(line, tpl)'), 'shared line-fill helper missing');
});

t('tier toggle remaps hidden tabs (editor→library, workflow→analysis)', () => {
  assert(/if \(activeTab === 'editor'\) activeTab = 'library';/.test(ui), 'editor remap');
  assert(/else if \(activeTab === 'workflow'\) activeTab = 'analysis';/.test(ui), 'workflow remap');
});

t('both creators seed from calc.DEFAULT_ANALYSIS_PARAMS', () => {
  const an = ui.slice(ui.indexOf('function createEmptyAnalysis()'), ui.indexOf('function createEmptyAnalysisLine()'));
  const wf = ui.slice(ui.indexOf('function createEmptyWorkflow()'), ui.indexOf('function createEmptyWorkflowStep()'));
  for (const [name, block] of [['analysis', an], ['workflow', wf]]) {
    for (const k of ['pfd_pct', 'shift_hours', 'operating_days', 'productivity_pct', 'rates_by_category']) {
      assert(block.includes(`calc.DEFAULT_ANALYSIS_PARAMS.${k}`), `${name} creator misses shared ${k}`);
    }
  }
  assert(!wf.includes('operating_days: 250'), 'workflow 250-day literal must be gone');
  assert(!wf.includes('{ manual: 0, mhe: 0, hybrid: 0 }'), 'workflow zero-rates seed must be gone');
});

console.log('');
if (failures.length) console.error(failures.join('\n'));
console.log(`test-ux2-most-split: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
