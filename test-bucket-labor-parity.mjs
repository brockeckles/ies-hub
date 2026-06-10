// test-bucket-labor-parity.mjs — regression net for 2026-06-10 Critical #4:
// "pricing-bucket cost rollup recomputes labor with its own divergent formula."
//
// Pre-fix: computeBucketCosts priced direct labor as rate × (1 + burden/100)
// + benefits with burden defaulting 0% (engine default: 30%), no temp-agency
// markup, no OT/shift/PTO — so recommended bucket rates under-recovered by up
// to ~30% vs the P&L the same screen displays.
//
// Post-fix contract: bucket labor routes through the engine's own
// directLineAnnual / indirectLineAnnual, so Σ bucket labor === totalLaborCost
// under identical opts — for default-burden lines, temp-agency lines, and
// explicit per-line burden alike.
//
// Run:  node test-bucket-labor-parity.mjs

import {
  computeBucketCosts,
  totalLaborCost,
  directLineAnnual,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function near(a, b, eps = 0.5, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`);
}

const BUCKETS = [{ id: 'fulfillment' }, { id: 'storage' }];
const OP_HOURS = 4000;

// The exact bug class: NO per-line burden_pct → engine falls back to 30%,
// old bucket math fell back to 0%.
const DIRECT_NO_BURDEN = { description: 'Picker', hourly_rate: 18, annual_hours: 2080, pricing_bucket: 'fulfillment' };
const DIRECT_TEMP      = { description: 'Peak temp', hourly_rate: 16, annual_hours: 1000, employment_type: 'temp_agency', temp_agency_markup_pct: 35, pricing_bucket: 'fulfillment' };
const DIRECT_EXPLICIT  = { description: 'Lead', hourly_rate: 24, annual_hours: 2080, burden_pct: 22, benefits_per_hour: 3, pricing_bucket: 'storage' };
const INDIRECT         = { description: 'Supervisor', hourly_rate: 32, headcount: 2, pricing_bucket: 'storage' };

function bucketLaborTotal(laborLines, indirectLaborLines, laborOpts) {
  const costs = computeBucketCosts({
    buckets: BUCKETS,
    laborLines, indirectLaborLines,
    equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    facilityCost: 0, operatingHours: OP_HOURS,
    ...(laborOpts ? { laborOpts } : {}),
  });
  return (costs['fulfillment'] || 0) + (costs['storage'] || 0) + (costs['_unassigned'] || 0);
}

t('default-burden line: bucket cost matches engine (30% fallback, not 0%)', () => {
  const engine = totalLaborCost([DIRECT_NO_BURDEN], [], { operatingHours: OP_HOURS });
  const bucket = bucketLaborTotal([DIRECT_NO_BURDEN], []);
  near(bucket, engine, 0.5, 'bucket vs engine');
  // sanity: the 30% load is actually present (old math gave 18 × 2080 = 37,440)
  near(engine, 18 * 1.30 * 2080, 0.5, 'engine 30% load sanity');
});

t('temp-agency markup priced into buckets', () => {
  const engine = totalLaborCost([DIRECT_TEMP], [], { operatingHours: OP_HOURS });
  const bucket = bucketLaborTotal([DIRECT_TEMP], []);
  near(bucket, engine, 0.5, 'temp line bucket vs engine');
  if (!(bucket > 16 * 1000)) throw new Error('markup missing — bucket priced at raw rate');
});

t('explicit per-line burden + benefits parity', () => {
  const engine = totalLaborCost([DIRECT_EXPLICIT], [], { operatingHours: OP_HOURS });
  const bucket = bucketLaborTotal([DIRECT_EXPLICIT], []);
  near(bucket, engine, 0.5);
});

t('indirect labor parity (headcount × opHours path)', () => {
  const engine = totalLaborCost([], [INDIRECT], { operatingHours: OP_HOURS });
  const bucket = bucketLaborTotal([], [INDIRECT]);
  near(bucket, engine, 0.5);
});

t('full mix parity: Σ buckets === totalLaborCost', () => {
  const L = [DIRECT_NO_BURDEN, DIRECT_TEMP, DIRECT_EXPLICIT];
  const I = [INDIRECT];
  const engine = totalLaborCost(L, I, { operatingHours: OP_HOURS });
  const bucket = bucketLaborTotal(L, I);
  near(bucket, engine, 1, 'mixed-line parity');
});

t('laborOpts threading: OT moves buckets the same as a direct engine call', () => {
  const opts = { otPct: 0.10 };
  const engineLine = directLineAnnual(DIRECT_NO_BURDEN, opts);
  const costs = computeBucketCosts({
    buckets: BUCKETS,
    laborLines: [DIRECT_NO_BURDEN], indirectLaborLines: [],
    equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    facilityCost: 0, operatingHours: OP_HOURS,
    laborOpts: opts,
  });
  near(costs['fulfillment'], engineLine, 0.5, 'OT-loaded bucket vs engine');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
