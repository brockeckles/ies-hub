// test-cm-ti-candidate.mjs — TI-candidate validator (gap-analysis items
// 10/13, 2026-06-11). Flags capital/lease equipment lines that look like
// Tenant Improvement scope per Asset Defaults Guidance: dock hardware,
// office/break-room build-out, ELECTRONIC security. Physical security
// (fence / gate / guard shack) is legitimately Capital and must NOT flag.

import * as calc from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
function is(actual, expected, label) {
  if (actual === expected) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}

const C = (name, acq, extra = {}) => ({ equipment_name: name, acquisition_type: acq, quantity: 1, acquisition_cost: 1000, ...extra });

// Should flag — misclassified TI scope
is(calc.isTiCandidate(C('Dock Leveler', 'capital')), true,  'dock leveler capital flags');
is(calc.isTiCandidate(C('Dock Seals & Restraints', 'lease')), true, 'dock seals lease flags');
is(calc.isTiCandidate(C('Office Build-Out', 'purchase')), true, 'office build-out (legacy purchase) flags');
is(calc.isTiCandidate(C('Breakroom buildout', 'capital')), true, 'breakroom buildout flags');
is(calc.isTiCandidate(C('CCTV Head-End', 'capital')), true, 'CCTV flags');
is(calc.isTiCandidate(C('Access Control Readers', 'lease')), true, 'access control flags');
is(calc.isTiCandidate(C('Burglar Alarm System', 'capital')), true, 'alarm flags');
is(calc.isTiCandidate(C('Misc dock package', 'capital', { category: 'Dock' })), true, 'category Dock flags');
is(calc.isTiCandidate(C('Reception fit-out', 'capital', { category: 'Office' })), true, 'category Office flags');
is(calc.isTiCandidate(C('Freezer room build', 'capital')), true, 'freezer build flags');

// Must NOT flag — correct classifications
is(calc.isTiCandidate(C('Dock Leveler', 'ti')), false, 'already TI never flags');
is(calc.isTiCandidate(C('Security Monitoring', 'service')), false, 'service never flags');
is(calc.isTiCandidate(C('Perimeter Fencing', 'capital')), false, 'fence excluded (physical security)');
is(calc.isTiCandidate(C('Automated Gate', 'capital')), false, 'gate excluded');
is(calc.isTiCandidate(C('Guard Shack', 'capital')), false, 'guard shack excluded');
is(calc.isTiCandidate(C('HVLS Fan', 'capital')), false, 'HVLS fan excluded');
is(calc.isTiCandidate(C('Reach Truck', 'lease')), false, 'reach truck does not flag');
is(calc.isTiCandidate(C('Selective Rack', 'lease')), false, 'rack does not flag');
is(calc.isTiCandidate(C('Label Printer', 'capital')), false, 'label printer does not flag');
is(calc.isTiCandidate(null), false, 'null line safe');

// validateModel integration — warning carries area=equipment + TI hint
const warnings = calc.validateModel({
  projectDetails: { name: 'T', market: 'M', contractTerm: 5 },
  facility: { totalSqft: 100000 },
  laborLines: [{ activity_name: 'Pick', hourly_rate: 18, annual_hours: 2080, volume: 1000 }],
  equipmentLines: [C('Dock Leveler', 'capital'), C('Reach Truck', 'lease', { monthly_cost: 850 })],
});
const tiWarns = warnings.filter(w => w.area === 'equipment' && /Tenant Improvement/.test(w.message));
is(tiWarns.length, 1, 'validateModel emits exactly one TI-candidate warning');
is(/Dock Leveler/.test(tiWarns[0]?.message || ''), true, 'warning names the line');
is(tiWarns[0]?.level, 'warning', 'level is warning');

console.log(`test-cm-ti-candidate: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
