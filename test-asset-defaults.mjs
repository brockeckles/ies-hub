// Standalone Node ESM test runner for the 2026-04-20 Asset Defaults pass.
// Covers:
//   • 4-way acquisition_type taxonomy (capital / lease / ti / service)
//   • normalizeAcqType alias handling ('purchase' → 'capital')
//   • equipLineSummary branches
//   • totalEquipmentCapital excludes TI/lease/service
//   • totalEquipmentTiUpfront sums TI items only
//   • autoGenerateEquipment new behavior:
//       - no conveyor unless automation_level medium/high
//       - no security unless securityTier >= 2
//       - racking defaults to lease (not capital)
//       - RF/WiFi default to capital (not lease)
//       - no dock / office / breakroom auto-adds
//
// Run:  node test-asset-defaults.mjs

import {
  normalizeAcqType,
  equipLineAnnual,
  equipLineSummary,
  equipLineAmort,
  equipTotalAcq,
  totalEquipmentCost,
  totalEquipmentCapital,
  totalEquipmentTiUpfront,
  totalEquipmentAmort,
  autoGenerateEquipment,
} from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); process.stdout.write('.'); passed++; }
  catch (e) { process.stdout.write('F'); failed++; failures.push({ name, err: e }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, eps = 0.01, msg = '') => {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: expected ${b}, got ${a}`);
};

// ============================================================
// 1. normalizeAcqType taxonomy
// ============================================================
test('normalizeAcqType: capital, lease, ti, service recognized', () => {
  assert(normalizeAcqType('capital') === 'capital');
  assert(normalizeAcqType('lease') === 'lease');
  assert(normalizeAcqType('ti') === 'ti');
  assert(normalizeAcqType('service') === 'service');
});
test('normalizeAcqType: purchase aliases to capital', () => {
  assert(normalizeAcqType('purchase') === 'capital', "'purchase' should map to 'capital'");
  assert(normalizeAcqType('PURCHASE') === 'capital', "case insensitive");
});
test('normalizeAcqType: unknown falls back to lease', () => {
  assert(normalizeAcqType('') === 'lease');
  assert(normalizeAcqType(null) === 'lease');
  assert(normalizeAcqType(undefined) === 'lease');
  assert(normalizeAcqType('finance') === 'lease');
});

// ============================================================
// 2. equipLineAnnual branches
// ============================================================
test('equipLineAnnual: capital = maintenance × 12 × qty only', () => {
  const line = { acquisition_type: 'capital', quantity: 2, acquisition_cost: 5000, monthly_cost: 0, monthly_maintenance: 100, amort_years: 5 };
  near(equipLineAnnual(line), 100 * 12 * 2, 0.01, 'capital annual = maint only');
});
test('equipLineAnnual: lease = (monthly_cost + maint) × 12 × qty', () => {
  const line = { acquisition_type: 'lease', quantity: 3, monthly_cost: 800, monthly_maintenance: 100, amort_years: 5 };
  near(equipLineAnnual(line), (800 + 100) * 12 * 3, 0.01, 'lease annual');
});
test('equipLineAnnual: ti = 0', () => {
  const line = { acquisition_type: 'ti', quantity: 2, acquisition_cost: 20000, monthly_cost: 0, monthly_maintenance: 500 };
  assert(equipLineAnnual(line) === 0, `ti annual should be 0, got ${equipLineAnnual(line)}`);
});
test('equipLineAnnual: service = monthly_cost × 12 × qty (no maint)', () => {
  const line = { acquisition_type: 'service', quantity: 1, monthly_cost: 8500, monthly_maintenance: 500 };
  near(equipLineAnnual(line), 8500 * 12, 0.01, 'service annual = monthly × 12 (maint bundled)');
});

// ============================================================
// 3. equipLineSummary exposes type-specific fields
// ============================================================
test('equipLineSummary: capital surfaces capital + amort, 0 leaseMo/tiUpfront/serviceMo', () => {
  const line = { acquisition_type: 'capital', quantity: 5, acquisition_cost: 2850, monthly_maintenance: 15, amort_years: 3 };
  const s = equipLineSummary(line);
  near(s.capital, 2850 * 5, 0.01);
  near(s.amort, (2850 * 5) / 3, 0.01);
  assert(s.leaseMo === 0, 'capital should have leaseMo=0');
  assert(s.tiUpfront === 0, 'capital should have tiUpfront=0');
  assert(s.serviceMo === 0, 'capital should have serviceMo=0');
});
test('equipLineSummary: ti surfaces tiUpfront, 0 capital/amort/leaseMo', () => {
  const line = { acquisition_type: 'ti', quantity: 4, acquisition_cost: 1562, monthly_maintenance: 0 };
  const s = equipLineSummary(line);
  assert(s.capital === 0, 'ti should have capital=0');
  assert(s.amort === 0, 'ti should have amort=0');
  assert(s.leaseMo === 0, 'ti should have leaseMo=0');
  near(s.tiUpfront, 1562 * 4, 0.01);
});
test('equipLineSummary: service surfaces serviceMo', () => {
  const line = { acquisition_type: 'service', quantity: 1, monthly_cost: 8500 };
  const s = equipLineSummary(line);
  assert(s.capital === 0, 'service capital=0');
  assert(s.tiUpfront === 0, 'service ti=0');
  near(s.serviceMo, 8500, 0.01);
});

// ============================================================
// 4. Aggregate totals exclude TI from capital
// ============================================================
test('totalEquipmentCapital: includes capital only (not ti/lease/service)', () => {
  const lines = [
    { acquisition_type: 'capital', quantity: 2, acquisition_cost: 1000 },
    { acquisition_type: 'ti',      quantity: 1, acquisition_cost: 20000 },
    { acquisition_type: 'lease',   quantity: 3, monthly_cost: 800 },
    { acquisition_type: 'service', quantity: 1, monthly_cost: 500 },
  ];
  near(totalEquipmentCapital(lines), 2000, 0.01, 'only capital rows count');
});
test('totalEquipmentTiUpfront: sums TI rows only', () => {
  const lines = [
    { acquisition_type: 'capital', quantity: 2, acquisition_cost: 1000 },
    { acquisition_type: 'ti',      quantity: 1, acquisition_cost: 20000 },
    { acquisition_type: 'ti',      quantity: 4, acquisition_cost: 1562 },
    { acquisition_type: 'lease',   quantity: 3, monthly_cost: 800 },
  ];
  near(totalEquipmentTiUpfront(lines), 20000 + 4 * 1562, 0.01, 'ti upfront total');
});
test('totalEquipmentAmort: capital only', () => {
  const lines = [
    { acquisition_type: 'capital', quantity: 10, acquisition_cost: 2850, amort_years: 3 },
    { acquisition_type: 'ti',      quantity: 1,  acquisition_cost: 20000 },
    { acquisition_type: 'lease',   quantity: 3,  monthly_cost: 800 },
  ];
  near(totalEquipmentAmort(lines), (10 * 2850) / 3, 0.01, 'only capital amort');
});
test('totalEquipmentCost: excludes ti from annual opex', () => {
  const lines = [
    { acquisition_type: 'lease',   quantity: 2, monthly_cost: 800, monthly_maintenance: 100 },   // 21,600/yr
    { acquisition_type: 'ti',      quantity: 4, acquisition_cost: 1562, monthly_maintenance: 0 }, // 0/yr
    { acquisition_type: 'capital', quantity: 5, acquisition_cost: 2850, monthly_maintenance: 15 }, // 900/yr
    { acquisition_type: 'service', quantity: 1, monthly_cost: 8500 },                             // 102,000/yr
  ];
  const total = totalEquipmentCost(lines);
  const expected = (800 + 100) * 12 * 2 + 0 + 15 * 12 * 5 + 8500 * 12;
  near(total, expected, 0.01, 'totalEquipmentCost excludes TI');
});

// ============================================================
// 5. autoGenerateEquipment — new defaults
// ============================================================
function makeState(overrides = {}) {
  return {
    facility: { totalSqft: 100_000, ...(overrides.facility || {}) },
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    laborLines: overrides.laborLines ?? [{ annual_hours: 2080 * 50 }], // 50 FTE
    indirectLaborLines: overrides.indirectLaborLines ?? [],
    volumeLines: overrides.volumeLines ?? [
      { isOutboundPrimary: true, volume: 1_000_000 },
      { uom: 'pallet', volume: 50_000 },
    ],
  };
}

test('autoGen: automation_level=none → NO conveyor even at high volume', () => {
  const state = makeState({
    facility: { totalSqft: 100_000, automation_level: 'none' },
    volumeLines: [{ isOutboundPrimary: true, volume: 2_000_000 }, { uom: 'pallet', volume: 50_000 }],
  });
  const lines = autoGenerateEquipment(state);
  const conveyor = lines.find(l => /conveyor/i.test(l.equipment_name));
  assert(!conveyor, `expected no conveyor with automation_level=none, got: ${conveyor?.equipment_name}`);
});

test('autoGen: automation_level=medium → conveyor auto-added', () => {
  const state = makeState({
    facility: { totalSqft: 100_000, automation_level: 'medium' },
    volumeLines: [{ isOutboundPrimary: true, volume: 2_000_000 }, { uom: 'pallet', volume: 50_000 }],
  });
  const lines = autoGenerateEquipment(state);
  const conveyor = lines.find(l => /conveyor/i.test(l.equipment_name));
  assert(conveyor, 'conveyor expected at automation_level=medium');
  assert(conveyor.acquisition_type === 'lease', `conveyor should be lease, got ${conveyor.acquisition_type}`);
});

test('autoGen: security_tier=1 → NO security auto-add', () => {
  const state = makeState({ facility: { totalSqft: 100_000, security_tier: 1 } });
  const lines = autoGenerateEquipment(state);
  const security = lines.filter(l => l.category === 'Security');
  assert(security.length === 0, `expected 0 security at tier 1, got ${security.length}`);
});

test('autoGen: security_tier=3 → CCTV + Access Control (TI)', () => {
  const state = makeState({ facility: { totalSqft: 100_000, security_tier: 3 } });
  const lines = autoGenerateEquipment(state);
  const cctv = lines.find(l => /camera/i.test(l.equipment_name));
  const access = lines.find(l => /access control/i.test(l.equipment_name));
  assert(cctv, 'CCTV expected at tier 3');
  assert(cctv.acquisition_type === 'ti', `CCTV should be TI, got ${cctv.acquisition_type}`);
  assert(access, 'access control expected at tier 3');
  assert(access.acquisition_type === 'ti', `access control should be TI`);
});

test('autoGen: security_tier=4 → guard shack + gate (capital)', () => {
  const state = makeState({ facility: { totalSqft: 100_000, security_tier: 4 } });
  const lines = autoGenerateEquipment(state);
  const guard = lines.find(l => /guard shack/i.test(l.equipment_name));
  const gate = lines.find(l => /gate automation/i.test(l.equipment_name));
  assert(guard, 'guard shack expected at tier 4');
  assert(guard.acquisition_type === 'capital', `guard shack should be capital`);
  assert(gate && gate.acquisition_type === 'capital', 'gate capital');
});

test('autoGen: racking defaults to LEASE (not capital)', () => {
  const state = makeState();
  const lines = autoGenerateEquipment(state);
  const rack = lines.find(l => /rack/i.test(l.equipment_name));
  assert(rack, 'racking expected');
  assert(rack.acquisition_type === 'lease', `racking should be lease, got ${rack.acquisition_type}`);
  assert(Number(rack.monthly_cost) > 0, 'racking should have monthly_cost set');
});

test('autoGen: RF Handheld defaults to CAPITAL (not lease)', () => {
  const state = makeState();
  const lines = autoGenerateEquipment(state);
  const rf = lines.find(l => /RF Handheld|RF Terminal/i.test(l.equipment_name));
  assert(rf, 'RF line expected');
  assert(rf.acquisition_type === 'capital', `RF should be capital, got ${rf.acquisition_type}`);
  assert(Number(rf.acquisition_cost) > 0, 'RF should have acquisition_cost set');
});

test('autoGen: WiFi AP defaults to CAPITAL', () => {
  const state = makeState();
  const lines = autoGenerateEquipment(state);
  const ap = lines.find(l => /WiFi|Access Point/i.test(l.equipment_name));
  assert(ap, 'WiFi AP expected');
  assert(ap.acquisition_type === 'capital', `WiFi AP should be capital, got ${ap.acquisition_type}`);
});

test('autoGen: NO dock levelers (TI → facility)', () => {
  const state = makeState();
  const lines = autoGenerateEquipment(state);
  const dock = lines.find(l => /dock/i.test(l.equipment_name));
  assert(!dock, `expected no dock levelers in equipment, got: ${dock?.equipment_name}`);
});

test('autoGen: NO office / break room buildout', () => {
  const state = makeState({ indirectLaborLines: [{ headcount: 10 }] });
  const lines = autoGenerateEquipment(state);
  const office = lines.find(l => /office build|break room/i.test(l.equipment_name));
  assert(!office, `expected no office build-out, got: ${office?.equipment_name}`);
});

test('autoGen: perimeter fencing respects fenced_perimeter_lf', () => {
  const state = makeState({ facility: { totalSqft: 100_000, security_tier: 1, fenced_perimeter_lf: 1500 } });
  const lines = autoGenerateEquipment(state);
  const fence = lines.find(l => /fencing/i.test(l.equipment_name));
  assert(fence, 'perimeter fencing expected');
  assert(fence.acquisition_type === 'capital', `fencing should be capital`);
  assert(fence.quantity === 1500, `fencing qty = LF`);
});

// ============================================================
// FOOTER
// ============================================================
process.stdout.write('\n\n');
if (failed > 0) {
  for (const f of failures) {
    console.log(`\n✗ ${f.name}`);
    console.log(`    ${f.err.message}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`${passed}/${passed} passed`);
console.log('Asset defaults invariants pass ✓');
