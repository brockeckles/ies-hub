// 2026-04-22 PM — Seasonality preset sanity tests. The presets live in
// tools/cost-model/ui.js (not exportable without a JSDOM rig), but we can
// mirror them here and assert invariants — sums to 1.00, Q4 vs non-Q4
// weighting matches the intent, peak month sane.
//
// Run:  node test-seasonality-presets.mjs

const PRESETS = {
  flat:              [0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0837],
  ecom_holiday_peak: [0.070, 0.068, 0.072, 0.070, 0.072, 0.070, 0.080, 0.080, 0.084, 0.100, 0.120, 0.114],
  cold_chain_food:   [0.076, 0.076, 0.080, 0.080, 0.080, 0.080, 0.080, 0.080, 0.080, 0.080, 0.110, 0.098],
  apparel_2peak:     [0.072, 0.066, 0.094, 0.098, 0.080, 0.072, 0.070, 0.080, 0.094, 0.092, 0.104, 0.078],
};

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function near(a, b, tol = 0.001, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not near'}: got ${a}, expected ${b} (±${tol})`); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

for (const [name, shares] of Object.entries(PRESETS)) {
  t(`${name}: 12 elements`, () => { if (shares.length !== 12) throw new Error(`got ${shares.length}`); });
  t(`${name}: shares sum to 1.000`, () => {
    const sum = shares.reduce((a, b) => a + b, 0);
    near(sum, 1.000, 0.001, 'sum');
  });
  t(`${name}: all shares in [0, 1]`, () => {
    for (const s of shares) assert(s >= 0 && s <= 1, `share ${s} out of range`);
  });
}

t('ecom_holiday_peak: Q4 captures ~33% of annual', () => {
  const q4 = PRESETS.ecom_holiday_peak.slice(9).reduce((a, b) => a + b, 0);
  assert(q4 > 0.30 && q4 < 0.40, `Q4 share=${q4.toFixed(3)} expected 0.30-0.40`);
});

t('cold_chain_food: Nov is peak month', () => {
  const peakIdx = PRESETS.cold_chain_food.indexOf(Math.max(...PRESETS.cold_chain_food));
  if (peakIdx !== 10) throw new Error(`peak at ${peakIdx}, expected 10 (Nov)`);
});

t('apparel_2peak: has two distinct peaks (Apr + Nov)', () => {
  const shares = PRESETS.apparel_2peak;
  // Apr (idx 3) should be local max in spring
  const springPeak = shares[3];
  const springValley = shares[5]; // Jun
  assert(springPeak > springValley, `spring peak ${springPeak} > valley ${springValley}`);
  // Nov (idx 10) should be fall peak
  const fallPeak = shares[10];
  const fallValley = shares[7]; // Aug
  assert(fallPeak > fallValley, `fall peak ${fallPeak} > valley ${fallValley}`);
});

t('flat: max/min ratio ≈ 1.0', () => {
  const s = PRESETS.flat;
  const ratio = Math.max(...s) / Math.min(...s);
  assert(ratio < 1.01, `ratio ${ratio} too high`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
