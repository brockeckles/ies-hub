// test-cm-heur1-vertical.mjs — vertical-storage scaling for the facility
// suggestion heuristic (2026-05-12).
//
// History: original heuristic used a flat 40 sqft/pallet (implicit single
// level). At Hearthwood Baseline (clearHeight=36, 3157 avg on-hand)
// produced ~230K suggested via DOH=22 workaround. With vertical scaling:
// at 36 ft clear → 5 levels → 8 sqft/pallet → suggestion shrinks ~5×.

import {
  computeVerticalPalletFootprint,
  suggestFacilitySqft,
  suggestFacilitySqftDetail,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// Build a channel that produces a specific inbound pallet count per year.
// channels feed `getAggregateInbound(state, 'pallets')`. The accessor:
//   1. takes channel.primary.value × inboundOutboundRatio  → inbound units
//   2. converts units → pallets via channel.conversions (unitsPerCase × casesPerPallet)
// So for N inbound pallets/yr with conv: 12 units/case × 40 cases/pal = 480 units/pal,
// we need primary.value × ratio / 480 = N → primary.value = N × 480 / ratio.
function channelForInboundPallets(annualInboundPallets, ratio = 1.0) {
  const unitsPerPallet = 12 * 40;
  return {
    key: 'main', name: 'Main', archetypeId: 'b2b-retail', sortOrder: 10,
    primary: { value: annualInboundPallets * unitsPerPallet / ratio, uom: 'units', activity: 'outbound', source: 'manual' },
    conversions: { unitsPerCase: 12, casesPerPallet: 40, linesPerOrder: 2, unitsPerLine: 3, weightPerUnit: 1, weightUnit: 'lbs' },
    assumptions: { returnsPercent: 0, inboundOutboundRatio: ratio, peakSurgeFactor: 1.3 },
    seasonality: { preset: 'flat', monthly_shares: Array(12).fill(100/12) },
    overrides: [],
  };
}

// ── computeVerticalPalletFootprint reference table ──
{
  const r20 = computeVerticalPalletFootprint(20);
  t('20 ft clear → 2 levels', r20.levels === 2, `got ${r20.levels}`);
  t('20 ft clear → 20 sqft/pallet', r20.sqftPerPallet === 20);

  const r24 = computeVerticalPalletFootprint(24);
  t('24 ft clear → 3 levels', r24.levels === 3, `got ${r24.levels}`);
  t('24 ft clear → 13.33 sqft/pallet', Math.abs(r24.sqftPerPallet - 40/3) < 0.01);

  const r32 = computeVerticalPalletFootprint(32);
  t('32 ft clear → 4 levels', r32.levels === 4, `got ${r32.levels}`);
  t('32 ft clear → 10 sqft/pallet', r32.sqftPerPallet === 10);

  const r36 = computeVerticalPalletFootprint(36);
  t('36 ft clear → 5 levels', r36.levels === 5, `got ${r36.levels}`);
  t('36 ft clear → 8 sqft/pallet', r36.sqftPerPallet === 8);

  const r50 = computeVerticalPalletFootprint(50);
  t('50 ft clear → capped at 6 levels', r50.levels === 6, `got ${r50.levels}`);
  t('50 ft clear → 6.67 sqft/pallet', Math.abs(r50.sqftPerPallet - 40/6) < 0.01);
}

// ── Defaults and edge cases ──
{
  t('undefined clear → default 32 ft → 4 levels',  computeVerticalPalletFootprint(undefined).levels === 4);
  t('null clear → default → 4 levels',             computeVerticalPalletFootprint(null).levels === 4);
  t('0 clear → default → 4 levels',                computeVerticalPalletFootprint(0).levels === 4);
  t('negative clear → default → 4 levels',         computeVerticalPalletFootprint(-10).levels === 4);
  t('NaN clear → default → 4 levels',              computeVerticalPalletFootprint(NaN).levels === 4);
  t('tiny clear (10 ft) → 1 level (floor)',        computeVerticalPalletFootprint(10).levels === 1);
  t('1 ft clear → 1 level (floor)',                computeVerticalPalletFootprint(1).levels === 1);
}

// ── suggestFacilitySqft scales with clear height ──
// 50K inbound pallets, DOH=30 → 4109 avg on-hand
{
  const channel = channelForInboundPallets(50000);
  const base = {
    facility: { totalSqft: 200000, daysOnHand: 30, opDaysPerYear: 250 },
    channels: [channel],
  };
  const sq24 = suggestFacilitySqft({ ...base, facility: { ...base.facility, clearHeight: 24 } });
  const sq32 = suggestFacilitySqft({ ...base, facility: { ...base.facility, clearHeight: 32 } });
  const sq36 = suggestFacilitySqft({ ...base, facility: { ...base.facility, clearHeight: 36 } });
  t('24 ft suggestion > 32 ft suggestion (vertical compresses)', sq24 > sq32, `24=${sq24} 32=${sq32}`);
  t('32 ft suggestion > 36 ft suggestion', sq32 > sq36, `32=${sq32} 36=${sq36}`);
  t('all three return non-zero',           sq24 > 0 && sq32 > 0 && sq36 > 0);
}

// ── Hearthwood Baseline shape ──
// 52,371 annual inbound pallets, DOH=22, clearHeight=36 → 5 levels → 8 sqft.
// avgOnHand=3157, area=25,256, /0.55 = 45,920 → rounded 46K.
{
  const sHearthwood = {
    facility: { totalSqft: 230000, daysOnHand: 22, clearHeight: 36, opDaysPerYear: 250 },
    channels: [channelForInboundPallets(52371)],
  };
  const sugg = suggestFacilitySqft(sHearthwood);
  t('Hearthwood (DOH=22, 36 ft) suggestion ≈ 46K', Math.abs(sugg - 46000) < 5000, `got ${sugg}`);

  const detail = suggestFacilitySqftDetail(sHearthwood);
  t('Hearthwood detail.levels === 5', detail.levels === 5, `got ${detail.levels}`);
  t('Hearthwood detail.sqftPerPallet === 8', detail.sqftPerPallet === 8, `got ${detail.sqftPerPallet}`);
  t('Hearthwood detail.sane === true', detail.sane === true);
}

// ── Compare old vs new: same Hearthwood inputs with default clearHeight ──
// (sanity: no clear height set → 32 ft default → 4 levels → 10 sqft/pallet)
{
  const sDefault = {
    facility: { totalSqft: 230000, daysOnHand: 22, opDaysPerYear: 250 }, // no clearHeight
    channels: [channelForInboundPallets(52371)],
  };
  const sugg = suggestFacilitySqft(sDefault);
  // avgOnHand 3157 × 10 / 0.55 = 57,400 → rounded 57K
  t('Hearthwood-shape, default 32 ft → ~57K', Math.abs(sugg - 57000) < 5000, `got ${sugg}`);
}

// ── Backward-compat: empty state still returns 0 ──
{
  t('null state → 0',   suggestFacilitySqft(null) === 0);
  t('empty state → 0',  suggestFacilitySqft({}) === 0);
  t('no inbound → 0',   suggestFacilitySqft({ facility: { totalSqft: 100000 }, channels: [] }) === 0);
}

console.log(`\n\ntest-cm-heur1-vertical: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
