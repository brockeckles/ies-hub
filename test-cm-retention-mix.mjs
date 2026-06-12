#!/usr/bin/env node
// test-cm-retention-mix.mjs — Phase 4e (2026-06-12): temp/perm retention
// mix + agency-markup resolution.
//
// Pins:
//  1. permMixFracForLine / tempMarkupFracForLine resolution semantics
//  2. blendLoadedRate invariants — mix=1 ≡ legacy permanent math,
//     mix=0 ≡ Phase 4a pure-temp math (same markup)
//  3. Roadmap acceptance: 50% perm / 50% temp @ 25% markup, zero wage load
//     → loaded annual cost exactly 12.5% above the 100%-perm equivalent
//  4. Cross-engine: calc.js display/annual paths === monthly engine blend
//  5. resolveCalcHeuristics surfaces tempMarkupPct (38) + tempShareDeltaPp (0)
//  6. What-If lever: temp_share_delta_pp shifts permanent lines toward temp
//
// Run:  node test-cm-retention-mix.mjs

import * as calc from './tools/cost-model/calc.js';
import { computeMonthlyLaborFromLines } from './tools/cost-model/calc.monthly.js';
import {
  permMixFracForLine, tempMarkupFracForLine, blendLoadedRate,
  resolveCalcHeuristics, DEFAULT_TEMP_MARKUP_PCT,
} from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function near(a, b, rel = 1e-12, m = '') {
  const d = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  if (Math.abs(a - b) / d > rel) throw new Error(`${m}: expected ${b}, got ${a}`);
}

// ── 1. permMixFracForLine ─────────────────────────────────────────────
t('mix: permanent default = 1 (no retention_mix_pct set)', () => {
  near(permMixFracForLine({ employment_type: 'permanent' }), 1);
  near(permMixFracForLine({}), 1);
});
t('mix: explicit retention_mix_pct honored + clamped', () => {
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: 70 }), 0.7);
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: 0 }), 0);
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: 250 }), 1);
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: -10 }), 0);
});
t('mix: temp_agency → 0, contractor → 1 (mix ignored)', () => {
  near(permMixFracForLine({ employment_type: 'temp_agency', retention_mix_pct: 80 }), 0);
  near(permMixFracForLine({ employment_type: 'contractor', retention_mix_pct: 40 }), 1);
});
t('mix: tempShareDeltaPp shifts toward temp, clamps, skips pure-temp', () => {
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: 80 }, { tempShareDeltaPp: 20 }), 0.6);
  near(permMixFracForLine({ employment_type: 'permanent' }, { tempShareDeltaPp: 10 }), 0.9);
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: 5 }, { tempShareDeltaPp: 50 }), 0);
  near(permMixFracForLine({ employment_type: 'permanent', retention_mix_pct: 95 }, { tempShareDeltaPp: -50 }), 1);
  near(permMixFracForLine({ employment_type: 'temp_agency' }, { tempShareDeltaPp: -50 }), 0);
});

// ── 2. tempMarkupFracForLine resolution chain ─────────────────────────
t('markup: pure temp uses line value ONLY (no fallback repricing)', () => {
  near(tempMarkupFracForLine({ employment_type: 'temp_agency', temp_agency_markup_pct: 38 }), 0.38);
  near(tempMarkupFracForLine({ employment_type: 'temp_agency' }, { marketTempPremiumPct: 42, defaultTempMarkupPct: 38 }), 0);
});
t('markup: mixed line — line > market > heuristic > house default', () => {
  const ln = { employment_type: 'permanent', retention_mix_pct: 50 };
  near(tempMarkupFracForLine({ ...ln, temp_agency_markup_pct: 25 }, { marketTempPremiumPct: 42, defaultTempMarkupPct: 30 }), 0.25);
  near(tempMarkupFracForLine(ln, { marketTempPremiumPct: 42, defaultTempMarkupPct: 30 }), 0.42);
  near(tempMarkupFracForLine(ln, { defaultTempMarkupPct: 30 }), 0.30);
  near(tempMarkupFracForLine(ln, {}), DEFAULT_TEMP_MARKUP_PCT / 100);
  assert(DEFAULT_TEMP_MARKUP_PCT === 38, 'house default moved');
});

// ── 3. blendLoadedRate invariants + roadmap acceptance ────────────────
t('blend: mix=1 ≡ legacy permanent loaded rate (incl. PTO + benefits)', () => {
  const r = blendLoadedRate({ baseRate: 20, wageLoadFrac: 0.30, benefitsPerHr: 1.5, mixFrac: 1, tempMarkupFrac: 0.99, permPtoMult: 1.05 });
  near(r, (20 * 1.30 + 1.5) * 1.05);
});
t('blend: mix=0 ≡ Phase 4a pure-temp rate (markup, no load, no PTO)', () => {
  const r = blendLoadedRate({ baseRate: 20, wageLoadFrac: 0.30, benefitsPerHr: 0, mixFrac: 0, tempMarkupFrac: 0.38, permPtoMult: 1.10 });
  near(r, 20 * 1.38);
});
t('ROADMAP ACCEPTANCE: 50/50 @ 25% markup, zero load → +12.5% vs pure perm', () => {
  const perm = blendLoadedRate({ baseRate: 20, wageLoadFrac: 0, benefitsPerHr: 0, mixFrac: 1, tempMarkupFrac: 0.25 });
  const mixed = blendLoadedRate({ baseRate: 20, wageLoadFrac: 0, benefitsPerHr: 0, mixFrac: 0.5, tempMarkupFrac: 0.25 });
  near(mixed / perm, 1.125, 1e-12, 'mixed/perm ratio');
});

// ── 4. engine-level: monthly blend + cross-engine equality ────────────
const CTX = {
  calcHeur: { overtimePct: 0, absenceAllowancePct: 0, benefitLoadPct: 30, tempMarkupPct: 38, tempShareDeltaPp: 0 },
  marketLaborProfile: null, calendarMonth: 1, seasonalShare: 1 / 12,
  escLaborMult: 1, volMult: 1, rampLaborMult: 1,
};
const BASE_LINE = { annual_hours: 2080, hourly_rate: 20, burden_pct: 30, benefits_per_hour: 0 };

t('monthly engine: mixed 70/30 line = 0.7×perm + 0.3×temp(38%)', () => {
  const perm  = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent' }], CTX);
  const temp  = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'temp_agency', temp_agency_markup_pct: 38 }], CTX);
  const mixed = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent', retention_mix_pct: 70 }], CTX);
  near(mixed, 0.7 * perm + 0.3 * temp, 1e-9, 'blend decomposition');
});
t('monthly engine: mix=100 and unset price identically (no repricing)', () => {
  const a = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent' }], CTX);
  const b = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent', retention_mix_pct: 100 }], CTX);
  near(a, b);
});
t('monthly engine: PTO uplift hits perm share only', () => {
  const ctxPto = { ...CTX, ptoPct: 0.10 };
  const mixed  = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent', retention_mix_pct: 50, temp_agency_markup_pct: 25 }], ctxPto);
  const perm   = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent' }], ctxPto);
  const temp   = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'temp_agency', temp_agency_markup_pct: 25 }], ctxPto);
  near(mixed, 0.5 * perm + 0.5 * temp, 1e-9, 'PTO rides the perm half only');
});
t('monthly engine: calcHeur.tempShareDeltaPp shifts permanent lines', () => {
  const shifted = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent' }],
    { ...CTX, calcHeur: { ...CTX.calcHeur, tempShareDeltaPp: 30 } });
  const manual  = computeMonthlyLaborFromLines([{ ...BASE_LINE, employment_type: 'permanent', retention_mix_pct: 70 }], CTX);
  near(shifted, manual, 1e-9, 'delta lever ≡ manual mix');
});

t('cross-engine: fullyLoadedRate + directLineAnnual match the blend', () => {
  const line = { ...BASE_LINE, employment_type: 'permanent', retention_mix_pct: 60, temp_agency_markup_pct: 25 };
  const expectRate = 0.6 * (20 * 1.30) + 0.4 * (20 * 1.25);
  near(calc.fullyLoadedRate(line), expectRate, 1e-12, 'fullyLoadedRate');
  near(calc.directLineAnnual(line), 2080 * expectRate, 1e-12, 'directLineAnnual');
  near(calc.directLineAnnualSimple(line), 2080 * expectRate, 1e-12, 'directLineAnnualSimple');
});
t('cross-engine: monthly ≡ 12 × no-op-month legacy for a mixed line', () => {
  const line = { ...BASE_LINE, employment_type: 'permanent', retention_mix_pct: 60, temp_agency_markup_pct: 25 };
  const monthly = computeMonthlyLaborFromLines([line], CTX) * 12;
  near(monthly, calc.directLineAnnual(line), 1e-9, 'annualized monthly vs legacy');
});

// ── 5. resolveCalcHeuristics keys ─────────────────────────────────────
t('resolveCalcHeuristics: tempMarkupPct default 38, tempShareDeltaPp 0', () => {
  const h = resolveCalcHeuristics(null, null, null, {}, null);
  assert(h.tempMarkupPct === 38, `tempMarkupPct ${h.tempMarkupPct}`);
  assert(h.tempShareDeltaPp === 0, `tempShareDeltaPp ${h.tempShareDeltaPp}`);
});
t('resolveCalcHeuristics: transient slider values win', () => {
  const h = resolveCalcHeuristics(null, null, null, {}, { temp_markup_pct: 45, temp_share_delta_pp: 15 });
  assert(h.tempMarkupPct === 45, `transient markup ${h.tempMarkupPct}`);
  assert(h.tempShareDeltaPp === 15, `transient delta ${h.tempShareDeltaPp}`);
  assert(h.used.temp_markup_pct === 'transient', 'provenance');
});

console.log(`\ntest-cm-retention-mix: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
