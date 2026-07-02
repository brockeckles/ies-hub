/**
 * P1 Medium tier (2026-07-02 ground-up assessment) — regression pins.
 *  1. CM ROIC invested capital includes equipment capital
 *  2. CM Monte Carlo prices OT at the engine's half-premium
 *  3. Fleet Dedicated base includes tires/tolls/permits
 *  4. Fleet CSV round-trip survives "City, ST" fields (splitCsvLine)
 *  5. MOST bottleneck selection is volume-ratio-aware
 */
import { computeFinancialMetrics } from './tools/cost-model/calc.js';
import { simulateLaborVariance, mulberry32 } from './tools/cost-model/calc.scenarios.js';
import { calcDedicatedFleet, DEMO_LANES } from './tools/fleet-modeler/calc.js';
import { splitCsvLine } from './shared/export.js';
import { analyzeWorkflow, calcWorkflowBottleneck } from './tools/most-standards/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 1. ROIC includes equipment capital ────────────────────────────────────
t('ROIC denominator = startup + equipment (+NWC), not startup alone', () => {
  const proj = [{ year: 1, revenue: 1000000, totalCost: 900000, ebit: 100000, ebitda: 120000,
    grossProfit: 300000, cogs: 700000, freeCashFlow: 50000, netIncome: 75000, depreciation: 20000 }];
  const opts = { startupCapital: 200000, equipmentCapital: 300000, taxRatePct: 25,
    discountRatePct: 10, reinvestRatePct: 8, totalFtes: 10, dsoDays: 0, dpoDays: 0 };
  const m = computeFinancialMetrics(proj, opts);
  // NOPAT = 100000 × 0.75 = 75000; IC = 200000 + 300000 + 0 NWC = 500000 → 15%
  if (!near(m.roicPct, 15, 0.01)) throw new Error(`roicPct=${m.roicPct}, want 15 (old startup-only math gave 37.5)`);
});

// ── 2. Monte Carlo OT half-premium ────────────────────────────────────────
t('MC with zero variance prices OT at half premium (engine parity)', () => {
  const lines = [{ hourly_rate: 20, annual_hours: 1000, performance_variance_pct: 0,
    employment_type: 'permanent', burden_pct: 0, permanent_share_pct: 100 }];
  const calcHeur = { overtimePct: 10, absenceAllowancePct: 0, benefitLoadPct: 0, tempMarkupPct: 0 };
  const r = simulateLaborVariance(lines, calcHeur, null, 10, mulberry32(7));
  // 1000h × $20 × (1 + 10% × 0.5) = 21,000. Old full-rate math: 22,000.
  if (!near(r.mean, 21000, 1)) throw new Error(`mean=${r.mean}, want 21000`);
});

// ── 3. Fleet Dedicated base costs ─────────────────────────────────────────
t('Dedicated rollup includes tires/tolls/permits and self-reconciles', () => {
  const r = calcDedicatedFleet(DEMO_LANES);
  const b = r.breakdown;
  if (!(b.tires > 0 && b.tolls > 0 && b.permits > 0)) throw new Error('tires/tolls/permits missing from breakdown');
  const base = b.fuel + b.maintenance + b.tires + b.tolls + b.permits
    + b.vehicle + b.insurance + b.driver * 1.25 + b.admin;
  if (!near(r.totalAnnual, base * 1.12, 0.01)) throw new Error('totalAnnual does not tie to breakdown × margin');
});

// ── 4. CSV round-trip ─────────────────────────────────────────────────────
t('splitCsvLine handles quoted "City, ST" + doubled quotes + \\r', () => {
  const q = (v) => /[",\n\r]/.test(String(v)) ? '"' + String(v).replaceAll('"', '""') + '"' : String(v);
  const lane = { origin: 'Chicago, IL', destination: 'Fort Worth, TX', w: 5 };
  const line = `${q(lane.origin)},${q(lane.destination)},${lane.w}\r`;
  const back = splitCsvLine(line);
  if (back[0] !== 'Chicago, IL' || back[1] !== 'Fort Worth, TX' || back[2] !== '5') {
    throw new Error(`round-trip broke: ${JSON.stringify(back)}`);
  }
  const tricky = splitCsvLine('a,"say ""hi"", ok",c');
  if (tricky[1] !== 'say "hi", ok') throw new Error('doubled-quote unescape failed');
});

// ── 5. MOST bottleneck volume-ratio awareness ─────────────────────────────
t('partial-flow slow step is NOT the bottleneck when whole-flow capacity is higher', () => {
  // Step A: 100 UPH on 100% of flow → whole-flow constraint 100
  // Step B:  50 UPH on  30% of flow → whole-flow constraint 167 (old logic flagged B)
  const steps = [
    { step_name: 'Pick', adjusted_uph: 100, volume_ratio: 1, fte: 2, hours_per_day: 16 },
    { step_name: 'VAS',  adjusted_uph: 50,  volume_ratio: 0.3, fte: 1, hours_per_day: 8 },
  ];
  const r = analyzeWorkflow(steps);
  if (r.bottleneckStep !== 'Pick') throw new Error(`bottleneck=${r.bottleneckStep}, want Pick`);
  if (!near(r.bottleneckThroughputUph, 100)) throw new Error('whole-flow constraint wrong');
  const b = calcWorkflowBottleneck(steps);
  if (b.bottleneckIdx !== 0) throw new Error(`idx=${b.bottleneckIdx}, want 0`);
});
t('default volume_ratio (1) keeps the legacy min-UPH behavior', () => {
  const steps = [
    { step_name: 'Pick', adjusted_uph: 100, fte: 1, hours_per_day: 8 },
    { step_name: 'Pack', adjusted_uph: 60,  fte: 1, hours_per_day: 8 },
  ];
  const r = analyzeWorkflow(steps);
  if (r.bottleneckStep !== 'Pack' || !near(r.bottleneckUph, 60)) throw new Error('legacy behavior changed');
});

console.log(`test-p1-medium-fixes: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
