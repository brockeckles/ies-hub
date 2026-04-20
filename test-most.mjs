// test-most.mjs — MOST Labor Standards calc regression tests
// Covers:
//   - PFD adjustment (adjustedUph)
//   - Productivity factor (effectiveUph)  -- new 2026-04-20
//   - frequency-aware TMU summation (sumElementTmu)
//   - sequence validation (validateElementSequence)
//   - analysis line derivation (computeAnalysisLine)
//   - workflow step derivation (computeWorkflowStep)

import {
  adjustedUph,
  effectiveUph,
  baseUph,
  sumElementTmu,
  sumElementTmuRaw,
  validateElementSequence,
  elementFrequency,
  computeAnalysisLine,
  computeWorkflowStep,
} from './tools/most-standards/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ─── PFD (unchanged baseline) ───
{
  t('adjustedUph: 1000 UPH × 14% PFD → ~877', near(adjustedUph(1000, 14), 877.19, 0.5));
  t('adjustedUph: 0 PFD → unchanged',        near(adjustedUph(500, 0), 500));
  t('adjustedUph: 0 UPH returns 0',          adjustedUph(0, 14) === 0);
}

// ─── Productivity factor (new) ───
{
  // No productivity override → same as adjustedUph
  t('effectiveUph default 100% = adjustedUph', near(effectiveUph(1000, 14), adjustedUph(1000, 14)));
  // 90% productivity on top of 14% PFD
  // adjUph = 1000 × 100/114 = 877.19; × 0.9 = 789.47
  t('effectiveUph: 1000 × PFD14% × prod 90% → ~789', near(effectiveUph(1000, 14, 90), 789.47, 0.5));
  // 85% productivity — bottom of typical range
  t('effectiveUph: 500 × PFD10% × prod 85% → ~386', near(effectiveUph(500, 10, 85), 386.36, 0.5));
  // Edge: productivity 0 → clamped to 1%
  t('effectiveUph: prod 0 clamped to 1%', near(effectiveUph(1000, 0, 0), 10));
  // Edge: productivity > 150% → clamped to 150
  t('effectiveUph: prod 200 clamped to 150%', near(effectiveUph(1000, 0, 200), 1500));
  // Edge: productivity negative → clamped to 1
  t('effectiveUph: prod -50 clamped to 1%', near(effectiveUph(1000, 0, -50), 10));
  // Zero base UPH short-circuits
  t('effectiveUph: 0 UPH returns 0', effectiveUph(0, 14, 90) === 0);
}

// ─── computeAnalysisLine threads productivity through ───
{
  // 1000 base, 14% PFD, 90% productivity, 10K daily, 8 shift hrs
  // adjUph = 1000 × 100/114 × 0.9 = 789.47
  // hours = 10000 / 789.47 = 12.67
  // fte = 12.67 / 8 = 1.58
  const r = computeAnalysisLine({
    base_uph: 1000, pfd_pct: 14, productivity_pct: 90,
    daily_volume: 10000, shift_hours: 8, hourly_rate: 20,
  });
  t('computeAnalysisLine: adj UPH honors productivity', near(r.adjusted_uph, 789.47, 0.5), `got ${r.adjusted_uph}`);
  t('computeAnalysisLine: hours/day reflects productivity drag', near(r.hours_per_day, 12.67, 0.1), `got ${r.hours_per_day}`);
  t('computeAnalysisLine: FTE reflects productivity drag', near(r.fte, 1.58, 0.02), `got ${r.fte}`);
  t('computeAnalysisLine: daily cost = hours × rate', near(r.daily_cost, 12.67 * 20, 0.5));
}
{
  // Same inputs, productivity_pct omitted → default 100 → same as adjustedUph
  const r = computeAnalysisLine({
    base_uph: 1000, pfd_pct: 14,
    daily_volume: 10000, shift_hours: 8,
  });
  t('computeAnalysisLine: no productivity_pct = 100% (backward compat)', near(r.adjusted_uph, 877.19, 0.5));
}
{
  // Productivity affects headcount: 90% drag ⇒ needs ceil(1.58) = 2 heads, vs 100% at 1.42 also = 2
  // Pick a case where productivity flips a boundary: 500 vol / 1000 uph = 0.5 FTE → 1 HC
  //   vs 500 / (1000×0.9) = 0.56 → 1 HC (same). Try 800 / 1000 = 0.8 → 1 HC
  //   vs 800 / 900 = 0.89 → 1 HC. Need to cross a ceiling...
  //   800 / 787 = 1.016 → 2 HC (crossed boundary when PFD folded in)
  const withProd = computeAnalysisLine({
    base_uph: 1000, pfd_pct: 14, productivity_pct: 90,
    daily_volume: 6500, shift_hours: 8,
  });
  const withoutProd = computeAnalysisLine({
    base_uph: 1000, pfd_pct: 14, productivity_pct: 100,
    daily_volume: 6500, shift_hours: 8,
  });
  t('productivity drag can increase headcount across ceilings',
    withProd.headcount >= withoutProd.headcount,
    `with=${withProd.headcount} without=${withoutProd.headcount}`);
}

// ─── computeWorkflowStep threads productivity ───
{
  const r = computeWorkflowStep({
    base_uph: 1000, pfd_pct: 14, productivity_pct: 85,
    target_volume: 10000, volume_ratio: 0.5, shift_hours: 8,
  });
  // adjUph = 1000 × 100/114 × 0.85 = 745.61
  // dailyVol = 10000 × 0.5 = 5000
  // hours = 5000 / 745.61 = 6.71
  // fte = 6.71 / 8 = 0.84
  t('computeWorkflowStep: productivity threaded', near(r.adjusted_uph, 745.61, 0.5), `got ${r.adjusted_uph}`);
  t('computeWorkflowStep: volume ratio applied', near(r.daily_volume, 5000));
  t('computeWorkflowStep: fte reflects productivity', near(r.fte, 0.84, 0.02), `got ${r.fte}`);
}

// ─── frequency-aware TMU ───
{
  const els = [
    { tmu_value: 100, freq_per_cycle: 1 },
    { tmu_value: 50,  freq_per_cycle: 0.5 },  // every-other cycle
    { tmu_value: 10,  freq_per_cycle: 3 },    // 3x per cycle
    { tmu_value: 20 /* no freq → defaults to 1 */ },
  ];
  t('sumElementTmu: freq-weighted = 100×1 + 50×0.5 + 10×3 + 20 = 175', sumElementTmu(els) === 175);
  t('sumElementTmuRaw: unweighted = 100 + 50 + 10 + 20 = 180', sumElementTmuRaw(els) === 180);
  t('elementFrequency: missing defaults to 1', elementFrequency({}) === 1);
  t('elementFrequency: string coerced', elementFrequency({ freq_per_cycle: '2.5' }) === 2.5);
  t('elementFrequency: negative falls back to default 1 (safe)', elementFrequency({ freq_per_cycle: -1 }) === 1);
}

// ─── sequence validation ───
{
  const issues = validateElementSequence([
    { element_name: 'Walk 3m', sequence_type: 'get', tmu_value: 10, sequence_order: 1, freq_per_cycle: 1 },
    { element_name: 'Place',   sequence_type: 'put', tmu_value: 12, sequence_order: 2, freq_per_cycle: 1 },
  ]);
  t('sequence valid: no issues on well-formed pair', issues.length === 0);
}
{
  const issues = validateElementSequence([
    { element_name: '', sequence_type: 'get', tmu_value: 10, sequence_order: 1, freq_per_cycle: 1 },
  ]);
  t('sequence: empty element_name flagged', issues.some(i => /name/i.test(i.message)));
}
{
  const issues = validateElementSequence([
    { element_name: 'x', sequence_type: 'get', tmu_value: 10, sequence_order: 1, freq_per_cycle: -1 },
  ]);
  t('sequence: negative freq flagged as error',
    issues.some(i => i.severity === 'error' && /frequency/i.test(i.message)),
    JSON.stringify(issues));
}
{
  const issues = validateElementSequence([
    { element_name: 'Place', sequence_type: 'put', tmu_value: 10, sequence_order: 1, freq_per_cycle: 1 },
    { element_name: 'Walk',  sequence_type: 'get', tmu_value: 10, sequence_order: 2, freq_per_cycle: 1 },
  ]);
  t('sequence: PUT-before-GET warning emitted',
    issues.some(i => /PUT.*before.*GET/i.test(i.message)));
}

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
