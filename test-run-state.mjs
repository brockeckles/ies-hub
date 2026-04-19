// test-run-state.mjs — regression for shared/run-state.js (Run-button "clean/dirty" tracker)
import { hashRunInputs, stableStringify, RunStateTracker } from './shared/run-state.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── stableStringify: key order doesn't matter ──
{
  const a = { a: 1, b: 2, c: { d: 3, e: 4 } };
  const b = { c: { e: 4, d: 3 }, b: 2, a: 1 };
  t('key-order independence', stableStringify(a) === stableStringify(b));
}

// ── stableStringify: array order DOES matter ──
{
  const a = [1, 2, 3];
  const b = [3, 2, 1];
  t('array order is preserved', stableStringify(a) !== stableStringify(b));
}

// ── stableStringify: float drift normalized ──
{
  const a = { rate: 0.1 + 0.2 };           // = 0.30000000000000004
  const b = { rate: 0.3 };
  t('float drift normalized to 10dp', stableStringify(a) === stableStringify(b));
}

// ── stableStringify: NaN and Infinity become null (don't blow up) ──
{
  const a = { n: NaN, i: Infinity };
  // JSON.stringify replaces NaN and Infinity with null via the replacer
  t('NaN → null serialization', stableStringify(a) === '{"i":null,"n":null}');
}

// ── hashRunInputs: same inputs → same hash ──
{
  const a = { facilities: [{ id: 1 }], demands: [{ id: 'a' }], k: 3 };
  const b = { facilities: [{ id: 1 }], demands: [{ id: 'a' }], k: 3 };
  t('same inputs → same hash', hashRunInputs(a) === hashRunInputs(b));
}

// ── hashRunInputs: nested change is detected ──
{
  const a = { config: { k: 3, maxIter: 100 } };
  const b = { config: { k: 3, maxIter: 101 } };
  t('nested change detected', hashRunInputs(a) !== hashRunInputs(b));
}

// ── RunStateTracker: brand-new tracker is dirty ──
{
  const r = new RunStateTracker();
  t('fresh tracker is dirty', r.state({ x: 1 }) === 'dirty');
  t('fresh tracker has no baseline', r.hasBaseline() === false);
}

// ── RunStateTracker: markClean → matching inputs read clean ──
{
  const r = new RunStateTracker();
  const inputs = { points: [1, 2, 3], k: 5 };
  r.markClean(inputs);
  t('markClean → state(same) === clean', r.state({ points: [1, 2, 3], k: 5 }) === 'clean');
  t('hasBaseline true after markClean', r.hasBaseline() === true);
}

// ── RunStateTracker: input change → dirty ──
{
  const r = new RunStateTracker();
  r.markClean({ points: [1, 2, 3], k: 5 });
  t('point change → dirty', r.state({ points: [1, 2, 4], k: 5 }) === 'dirty');
  t('k change → dirty', r.state({ points: [1, 2, 3], k: 6 }) === 'dirty');
}

// ── RunStateTracker: float drift on inputs is NOT a false dirty ──
{
  const r = new RunStateTracker();
  r.markClean({ rate: 0.3 });
  t('float drift is not a false dirty', r.state({ rate: 0.1 + 0.2 }) === 'clean');
}

// ── RunStateTracker: reset() clears baseline ──
{
  const r = new RunStateTracker();
  r.markClean({ x: 1 });
  r.reset();
  t('reset() drops baseline', r.hasBaseline() === false);
  t('reset() forces dirty even on identical inputs', r.state({ x: 1 }) === 'dirty');
}

// ── RunStateTracker: markDirty() forces dirty without clearing baseline-aware-ness ──
{
  const r = new RunStateTracker();
  r.markClean({ x: 1 });
  r.markDirty();
  t('markDirty() forces dirty', r.state({ x: 1 }) === 'dirty');
}

// ── Realistic NetOpt-shaped scenario ──
{
  const r = new RunStateTracker();
  const inputs = {
    facilities: [
      { id: 'f1', name: 'Chicago', lat: 41.88, lng: -87.63, isOpen: true, fixedCost: 1_200_000 },
      { id: 'f2', name: 'Atlanta', lat: 33.75, lng: -84.39, isOpen: true, fixedCost: 950_000 },
    ],
    demands: [
      { id: 'd1', city: 'New York', weight: 5000 },
      { id: 'd2', city: 'Dallas',   weight: 3000 },
    ],
    modeMix: { tlPct: 30, ltlPct: 40, parcelPct: 30 },
    rateCard: { tlRate: 2.5, ltlRate: 4.5, parcelRate: 8 },
  };
  r.markClean(inputs);
  // Same inputs in a fresh object copy: still clean
  const sameDeep = JSON.parse(JSON.stringify(inputs));
  t('NetOpt-shaped clean baseline holds across deep copy', r.state(sameDeep) === 'clean');
  // Toggle a facility open → dirty
  const flipped = JSON.parse(JSON.stringify(inputs));
  flipped.facilities[0].isOpen = false;
  t('NetOpt-shaped facility toggle → dirty', r.state(flipped) === 'dirty');
}

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
