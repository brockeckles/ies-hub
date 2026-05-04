// test-wsc-racking-structure.mjs — Phase 1 redesign coverage for computeRackingStructure.
// Validates beam row generation under all 4 combinations of bottomBeam × topBeam,
// edge cases (zero levels, zero pitch), and topOfSteel computation.
import { computeRackingStructure } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

// ── 5 levels, no bottom, no top (real selective default) ──
{
  const r = computeRackingStructure({ levels: 5, levelHeightFt: 6, bottomBeam: false, topBeam: false });
  // Beams between levels: at heights of bottom of L2..L5 = [6, 12, 18, 24]
  t('5 levels no-bottom no-top: 4 beams', r.beamCount === 4);
  t('5 levels no-bottom no-top: heights = [6,12,18,24]',
    r.beamRowHeightsFt.length === 4 &&
    close(r.beamRowHeightsFt[0], 6) &&
    close(r.beamRowHeightsFt[1], 12) &&
    close(r.beamRowHeightsFt[2], 18) &&
    close(r.beamRowHeightsFt[3], 24)
  );
  t('5 levels topOfSteelFt = 30', close(r.topOfSteelFt, 30));
}

// ── 5 levels, bottom-beam ON, no top ──
{
  const r = computeRackingStructure({ levels: 5, levelHeightFt: 6, bottomBeam: true, topBeam: false });
  // [0, 6, 12, 18, 24]
  t('5 levels bottom-on: 5 beams', r.beamCount === 5);
  t('5 levels bottom-on: first beam = 0', close(r.beamRowHeightsFt[0], 0));
  t('5 levels bottom-on: last beam = 24', close(r.beamRowHeightsFt[4], 24));
}

// ── 5 levels, no bottom, top-beam ON (legacy compat) ──
{
  const r = computeRackingStructure({ levels: 5, levelHeightFt: 6, bottomBeam: false, topBeam: true });
  // [6, 12, 18, 24, 30]
  t('5 levels top-on: 5 beams', r.beamCount === 5);
  t('5 levels top-on: last beam = 30 (orphan)', close(r.beamRowHeightsFt[4], 30));
}

// ── 5 levels, both ON (legacy ALL the beams) ──
{
  const r = computeRackingStructure({ levels: 5, levelHeightFt: 6, bottomBeam: true, topBeam: true });
  // [0, 6, 12, 18, 24, 30]
  t('5 levels both-on: 6 beams', r.beamCount === 6);
}

// ── 1 level no bottom no top: 0 beams (single floor pallet, no rack at all) ──
{
  const r = computeRackingStructure({ levels: 1, levelHeightFt: 6, bottomBeam: false, topBeam: false });
  t('1 level no-bottom no-top: 0 beams', r.beamCount === 0);
}

// ── 1 level bottom-on: 1 beam (floor) ──
{
  const r = computeRackingStructure({ levels: 1, levelHeightFt: 6, bottomBeam: true });
  t('1 level bottom-on: 1 beam', r.beamCount === 1);
  t('1 level bottom-on: at h=0', close(r.beamRowHeightsFt[0], 0));
}

// ── 1 level top-on (orphan only): 1 beam at top ──
{
  const r = computeRackingStructure({ levels: 1, levelHeightFt: 6, topBeam: true });
  t('1 level top-on: 1 beam', r.beamCount === 1);
  t('1 level top-on: at h=6', close(r.beamRowHeightsFt[0], 6));
}

// ── 0 levels: 0 beams regardless ──
{
  const r1 = computeRackingStructure({ levels: 0, levelHeightFt: 6, bottomBeam: true, topBeam: true });
  t('0 levels: always 0 beams', r1.beamCount === 0);
  t('0 levels: empty array', r1.beamRowHeightsFt.length === 0);
  t('0 levels: topOfSteelFt = 0', r1.topOfSteelFt === 0);
}

// ── Negative levels clamped to 0 ──
{
  const r = computeRackingStructure({ levels: -3, levelHeightFt: 6 });
  t('negative levels: 0 beams', r.beamCount === 0);
}

// ── Zero pitch: 0 beams (degenerate) ──
{
  const r = computeRackingStructure({ levels: 5, levelHeightFt: 0, bottomBeam: true, topBeam: true });
  t('zero pitch: 0 beams', r.beamCount === 0);
  t('zero pitch: topOfSteel = 0', r.topOfSteelFt === 0);
}

// ── 7-level rack at 5.42 ft pitch (Wayfair Memphis FC profile) ──
{
  const r = computeRackingStructure({ levels: 7, levelHeightFt: 5.4167, bottomBeam: false, topBeam: false });
  // Beams at L2..L7 bottom = [5.42, 10.83, 16.25, 21.67, 27.08, 32.50]
  t('7 levels Wayfair: 6 beams', r.beamCount === 6);
  t('7 levels Wayfair last beam', close(r.beamRowHeightsFt[5], 32.50, 0.01));
  t('7 levels Wayfair topOfSteel ≈ 37.92', close(r.topOfSteelFt, 7 * 5.4167, 0.01));
}

// ── Beam row heights ascending sorted ──
{
  const r = computeRackingStructure({ levels: 4, levelHeightFt: 5, bottomBeam: true, topBeam: true });
  for (let i = 1; i < r.beamRowHeightsFt.length; i++) {
    t(`heights ascending [${i-1}<${i}]`, r.beamRowHeightsFt[i-1] < r.beamRowHeightsFt[i]);
  }
}

// ── topOfSteel = levels × pitch even when no beams ──
{
  const r = computeRackingStructure({ levels: 5, levelHeightFt: 6, bottomBeam: false, topBeam: false });
  t('topOfSteel even with no top beam', close(r.topOfSteelFt, 30));
}

// ── Defaults: bottomBeam false, topBeam false ──
{
  const r = computeRackingStructure({ levels: 4, levelHeightFt: 5 });
  t('defaults: bottomBeam false', r.bottomBeam === false);
  t('defaults: topBeam false', r.topBeam === false);
  t('defaults: 3 beams for 4 levels', r.beamCount === 3);
}

console.log(`\n\ntest-wsc-racking-structure: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
