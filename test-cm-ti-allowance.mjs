// test-cm-ti-allowance.mjs — TI Phase A (2026-06-11): landlord allowance /
// provider-funded split per TI Handling doc (Brock 2026-04-20).
//
// Before this change the engine amortized 100% of TI into facility rent —
// the doc's "silent $0 allowance" common mistake. Phase A:
//   allowance      = explicit total, else PSF × sqft
//   landlordFunded = min(total TI, allowance)
//   providerFunded = total TI − landlordFunded   ← the only share that amortizes
//
// Pins the doc's worked example: 250k SF, 5-yr, $20/SF allowance ($5.0M cap),
// $5.3M total TI → landlord $5.0M / provider $300k → $60k/yr ($5k/mo) amort.

import * as calc from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const ok = Math.abs(actual - expected) < 1e-6;
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}

const tiLines = [
  { equipment_name: 'Office build-out', acquisition_type: 'ti', quantity: 1, acquisition_cost: 5000000, ti_classification: 'shell' },
  { equipment_name: 'Hazmat room',      acquisition_type: 'ti', quantity: 1, acquisition_cost: 300000,  ti_classification: 'non_shell' },
  { equipment_name: 'Reach truck',      acquisition_type: 'lease', quantity: 4, monthly_cost: 850 }, // non-TI: ignored
];
const fac = { totalSqft: 250000, tiAllowancePsf: 20 };

// 1. Worked example from TI Handling doc
const split = calc.tiNetProviderCost(tiLines, fac);
eq(split.totalTi,        5300000, 'worked example: total TI');
eq(split.allowanceTotal, 5000000, 'worked example: allowance = 20 × 250k');
eq(split.landlordFunded, 5000000, 'worked example: landlord = min(total, allowance)');
eq(split.providerFunded,  300000, 'worked example: provider = remainder');
eq(calc.tiAmortAnnual(tiLines, 5, fac), 60000, 'worked example: $60k/yr = $5k/mo over 5 yrs');

// 2. Backward compat — no facility → $0 allowance → full TI amortizes (legacy)
eq(calc.tiAmortAnnual(tiLines, 5), 1060000, 'legacy: full TI / 5 yrs without facility');
eq(calc.tiNetProviderCost(tiLines, undefined).providerFunded, 5300000, 'legacy: provider = total');

// 3. Allowance exceeds TI → nothing amortizes; landlord capped at total
const richFac = { totalSqft: 250000, tiAllowancePsf: 40 }; // $10M allowance
const split3 = calc.tiNetProviderCost(tiLines, richFac);
eq(split3.landlordFunded, 5300000, 'rich allowance: landlord capped at total TI');
eq(split3.providerFunded, 0,       'rich allowance: provider 0');
eq(calc.tiAmortAnnual(tiLines, 5, richFac), 0, 'rich allowance: amort 0');

// 4. Explicit total override wins over PSF
eq(calc.tiAllowanceTotal({ totalSqft: 250000, tiAllowancePsf: 20, tiAllowanceTotal: 100000 }), 100000, 'explicit total wins');
eq(calc.tiAllowanceTotal({ totalSqft: 250000, landlord_ti_allowance_psf: 20 }), 5000000, 'snake_case column names accepted');
eq(calc.tiAllowanceTotal({ totalSqft: 250000, tiAllowancePsf: -5 }), 0, 'negative clamps to 0');
eq(calc.tiAllowanceTotal(undefined), 0, 'no facility → 0');

// 5. Shell / non-shell informational rollup (default non_shell)
eq(calc.totalEquipmentTiByClass(tiLines, 'shell'),     5000000, 'shell rollup');
eq(calc.totalEquipmentTiByClass(tiLines, 'non_shell'),  300000, 'non_shell rollup');
eq(calc.totalEquipmentTiByClass([{ acquisition_type: 'ti', quantity: 2, acquisition_cost: 100 }], 'non_shell'), 200, 'unclassified TI defaults non_shell');

// 6. computeSummary carries the split; facility cost includes provider amort only
const summary = calc.computeSummary({
  laborLines: [], indirectLaborLines: [],
  equipmentLines: tiLines.slice(0, 2), // TI only — keep facility math clean
  facility: fac,
  facilityRate: { lease_rate_psf_yr: 6.6 },
  shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
  overheadLines: [], vasLines: [], startupLines: [],
  contractYears: 5, targetMarginPct: 16, annualOrders: 100000,
});
eq(summary.tiUpfront,        5300000, 'summary.tiUpfront = total TI');
eq(summary.tiLandlordFunded, 5000000, 'summary.tiLandlordFunded');
eq(summary.tiProviderFunded,  300000, 'summary.tiProviderFunded');
eq(summary.tiAllowanceTotal, 5000000, 'summary.tiAllowanceTotal');
eq(summary.tiAmortAnnual,      60000, 'summary.tiAmortAnnual = provider share / term');
eq(summary.facilityCost, 250000 * 6.6 + 60000, 'facilityCost = lease + provider amort only');


// ── TI Phase B (Mode B rent credit) + Phase C (amort-years override) ──
// Doc worked example: rent $0.55 gross / $0.05 credit / $0.50 net PSF/mo.
const facB = { totalSqft: 250000, tiAllowancePsf: 20, tiRentCreditPsfMo: 0.05 };
eq(calc.tiRentCreditAnnual(facB), 150000, 'Phase B: credit = 0.05 × 12 × 250k');
eq(calc.tiRentCreditAnnual({ totalSqft: 250000 }), 0, 'Phase B: no credit field → 0');
eq(calc.tiRentCreditAnnual({ totalSqft: 250000, ti_rent_credit_psf_mo: 0.05 }), 150000, 'Phase B: snake_case accepted');
eq(calc.netStorageCost(1650000, facB), 1500000, 'Phase B: net = gross − credit');
eq(calc.netStorageCost(100000, facB), 0, 'Phase B: net clamps at 0');

const bdB = calc.facilityCostBreakdown(facB, { lease_rate_psf_yr: 6.6 }, undefined, { tiAmort: 60000 });
eq(bdB.total, 1710000, 'Phase B: breakdown gross total unchanged');
eq(bdB.tiRentCredit, 150000, 'Phase B: breakdown carries credit');
eq(bdB.netTotal, 1560000, 'Phase B: breakdown netTotal = gross − credit');

const sumB = calc.computeSummary({
  laborLines: [], indirectLaborLines: [],
  equipmentLines: tiLines.slice(0, 2),
  facility: facB,
  facilityRate: { lease_rate_psf_yr: 6.6 },
  shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
  overheadLines: [], vasLines: [], startupLines: [],
  contractYears: 5, targetMarginPct: 16, annualOrders: 100000,
});
eq(sumB.tiRentCreditAnnual, 150000, 'Phase B: summary carries credit');
eq(sumB.netFacilityCost, sumB.facilityCost - 150000, 'Phase B: summary net = gross − credit');
eq(sumB.totalCost, sumB.laborCost + sumB.facilityCost + sumB.equipmentCost + (sumB.equipmentAmort || 0) + sumB.overheadCost + sumB.vasCost + sumB.startupAmort, 'Phase B: credit never feeds totalCost');

// Phase C — amort-years override beats contract term
const facC = { totalSqft: 250000, tiAllowancePsf: 20, tiAmortYears: 10 };
eq(calc.tiAmortAnnual(tiLines, 5, facC), 30000, 'Phase C: $300k provider / 10-yr override = $30k/yr');
eq(calc.tiAmortAnnual(tiLines, 5, { totalSqft: 250000, tiAllowancePsf: 20, ti_amort_years: 3 }), 100000, 'Phase C: snake_case override, 3-yr = $100k/yr');
eq(calc.tiAmortAnnual(tiLines, 5, fac), 60000, 'Phase C: no override → contract term (regression)');

console.log(`test-cm-ti-allowance: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
