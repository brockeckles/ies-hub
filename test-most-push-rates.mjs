/**
 * Hotfix (2026-07-22) — MOST Quick Analysis push-to-CM must not send $0
 * hourly rates for category-priced lines.
 *
 * convertToCmLaborLines mapped `hourly_rate: line.hourly_rate || 0`. The
 * per-line override hourly_rate is seeded to 0 by createEmptyAnalysisLine
 * and never set by _fillLineFromTemplate, so every line priced via
 * rates_by_category (the default: manual 18 / mhe 22 / hybrid 20) pushed a
 * $0 rate to the Cost Model — while the screen and XLSX export (which
 * resolve category rates) showed the correct cost. Pin: the converter
 * prefers line.effective_rate (computeAnalysisLines output), else resolves
 * via resolveCategoryRate like computeAnalysisLines / workflowStepsToCmLines
 * do, and an explicit per-line override always wins.
 */
import {
  computeAnalysisLines,
  convertToCmLaborLines,
  DEFAULT_ANALYSIS_PARAMS,
} from './tools/most-standards/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// Mirror createEmptyAnalysisLine's seed: hourly_rate 0 = "no per-line
// override", exactly what a template-picked line looks like at push time.
function seedLine(over = {}) {
  return {
    id: 'l1',
    template_id: 't1',
    activity_name: 'Each Pick',
    process_area: 'Outbound',
    labor_category: 'manual',
    uom: 'each',
    base_uph: 120,
    adjusted_uph: 0,
    daily_volume: 5000,
    hours_per_day: 0,
    fte: 0,
    headcount: 0,
    hourly_rate: 0,
    daily_cost: 0,
    ...over,
  };
}

const analysis = {
  ...DEFAULT_ANALYSIS_PARAMS, // rates_by_category: manual 18 / mhe 22 / hybrid 20
  lines: [
    seedLine(),
    seedLine({ id: 'l2', activity_name: 'Putaway', labor_category: 'mhe', base_uph: 60, daily_volume: 2000 }),
    seedLine({ id: 'l3', activity_name: 'Supervisor Audit', labor_category: 'hybrid', base_uph: 30, daily_volume: 300, hourly_rate: 27.5 }),
  ],
};
const cmOpts = { operatingDays: analysis.operating_days, shiftHours: analysis.shift_hours, defaultBurdenPct: 30, templateMap: new Map() };

// ── the real push pipeline: computeAnalysisLines → convertToCmLaborLines ──
const computed = computeAnalysisLines(analysis);
const cm = convertToCmLaborLines(computed, cmOpts);

t('category-rate line (no per-line override) pushes the category effective rate, not 0', () => {
  if (cm[0].hourly_rate !== 18) throw new Error(`manual pushed ${cm[0].hourly_rate}, expected 18`);
  if (cm[1].hourly_rate !== 22) throw new Error(`mhe pushed ${cm[1].hourly_rate}, expected 22`);
});

t('pushed rate matches the effective_rate the screen/XLSX show', () => {
  for (let i = 0; i < cm.length; i++) {
    if (cm[i].hourly_rate !== computed[i].effective_rate) {
      throw new Error(`line ${i}: pushed ${cm[i].hourly_rate} vs on-screen ${computed[i].effective_rate}`);
    }
  }
});

t('line WITH an explicit per-line override keeps the override', () => {
  if (cm[2].hourly_rate !== 27.5) throw new Error(`got ${cm[2].hourly_rate}, expected 27.5`);
});

t('pushed labor cost is non-zero for category-priced lines (the corruption this pins)', () => {
  const annualCost = cm[0].annual_hours * cm[0].hourly_rate;
  if (!(annualCost > 0)) throw new Error(`annual cost ${annualCost} — $0 push regressed`);
});

// ── raw lines (no effective_rate): converter resolves rates itself ─────────
t('raw line without effective_rate resolves via opts.ratesByCategory', () => {
  const lines = convertToCmLaborLines([seedLine({ hours_per_day: 40 })], {
    ...cmOpts, ratesByCategory: analysis.rates_by_category,
  });
  if (lines[0].hourly_rate !== 18) throw new Error(`got ${lines[0].hourly_rate}, expected 18`);
});

t('raw line override beats opts.ratesByCategory', () => {
  const lines = convertToCmLaborLines([seedLine({ hourly_rate: 31.25 })], {
    ...cmOpts, ratesByCategory: analysis.rates_by_category,
  });
  if (lines[0].hourly_rate !== 31.25) throw new Error(`got ${lines[0].hourly_rate}`);
});

t('opts.defaultRate applies when the category has no rate', () => {
  const lines = convertToCmLaborLines([seedLine()], {
    ...cmOpts, ratesByCategory: { mhe: 22 }, defaultRate: 17,
  });
  if (lines[0].hourly_rate !== 17) throw new Error(`got ${lines[0].hourly_rate}`);
});

t('no rates anywhere → 0 (never invents a number)', () => {
  const lines = convertToCmLaborLines([seedLine()], cmOpts);
  if (lines[0].hourly_rate !== 0) throw new Error(`got ${lines[0].hourly_rate}`);
});

t('effective_rate 0 is respected as a resolved answer (?? semantics, not ||)', () => {
  // A computed line whose analysis had NO rates anywhere: effective_rate is a
  // real 0 — the converter must not "fall back" past it to something else.
  const lines = convertToCmLaborLines([seedLine({ effective_rate: 0 })], {
    ...cmOpts, defaultRate: 99, // must NOT leak in when effective_rate is present
  });
  if (lines[0].hourly_rate !== 0) throw new Error(`got ${lines[0].hourly_rate}`);
});

console.log(`test-most-push-rates: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
