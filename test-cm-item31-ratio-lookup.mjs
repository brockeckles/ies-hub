// test-cm-item31-ratio-lookup.mjs — Item 31 closure (2026-06-11).
// The six density ratios the gap-analysis verification found hardcoded
// (CSR /500k orders, returns /100k, maint tech /100k SF, WiFi AP /10k SF,
// switch /50k SF, CCTV /30k SF) now resolve from planningRatiosMap with
// the original constants as legacy fallbacks.

import { autoGenerateIndirectLabor, autoGenerateEquipment } from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

function buildState() {
  return {
    laborLines: Array.from({ length: 5 }, () => ({ annual_hours: 5 * 2080 })),
    shifts: { shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5 },
    facility: { totalSqft: 300000, securityTier: 3 },
    volumeLines: [{ isOutboundPrimary: true, volume: 10000000 }] // 10M units → 1M derived orders,
  };
}

// ── Legacy path: constants unchanged ──
{
  const lines = autoGenerateIndirectLabor(buildState());
  const csr = lines.find(l => l.role_name === 'Customer Service Rep');
  t('CSR legacy: 2 reps at 1M orders / 500K', csr?.headcount === 2);
  t('CSR legacy: _heuristic.value = 500000', csr?._heuristic.value === 500000);
  const maint = lines.find(l => l.role_name === 'Maintenance Technician');
  t('Maint legacy: 3 techs at 300K sqft / 100K', maint?.headcount === 3);

  const eq = autoGenerateEquipment(buildState());
  const wifi = eq.find(l => l.equipment_name.startsWith('WiFi'));
  t('WiFi legacy: 30 APs at 300K / 10K', wifi?.quantity === 30);
  t('WiFi legacy: source = legacy', wifi?._heuristic.source === 'legacy');
  const sw = eq.find(l => l.equipment_name.startsWith('Switch'));
  t('Switch legacy: 6 at 300K / 50K', sw?.quantity === 6);
  const cams = eq.find(l => l.equipment_name === 'Security Cameras');
  t('CCTV legacy: 10 at 300K / 30K', cams?.quantity === 10);
}

// ── Catalog path: overrides change quantities + stamp provenance ──
{
  const M = (v, src = 'catalog') => ({ value: v, source: src, def: { id: 1, source: 'Test catalog', source_date: '2026-06-11' } });
  const planningRatiosMap = {
    'indirect.customer_service.per_500k_orders': M(250000),
    'indirect.maintenance.per_100k_sqft': M(150000),
    'indirect.returns_processor.per_100k_return_orders': M(50000),
    'equipment.it.wifi_ap': M(20000),
    'equipment.it.network_switch': M(100000),
    'equipment.security.cameras': M(15000, 'override'),
  };

  const lines = autoGenerateIndirectLabor(buildState(), { planningRatiosMap });
  const csr = lines.find(l => l.role_name === 'Customer Service Rep');
  t('CSR catalog: 4 reps at 1M / 250K', csr?.headcount === 4);
  t('CSR catalog: source = catalog', csr?._heuristic.source === 'catalog');
  t('CSR catalog: legacy_value preserved 500000', csr?._heuristic.legacy_value === 500000);
  t('CSR catalog: citation flows', csr?._heuristic.source_citation === 'Test catalog');
  const maint = lines.find(l => l.role_name === 'Maintenance Technician');
  t('Maint catalog: 2 techs at 300K / 150K', maint?.headcount === 2);

  const eq = autoGenerateEquipment(buildState(), { planningRatiosMap });
  const wifi = eq.find(l => l.equipment_name.startsWith('WiFi'));
  t('WiFi catalog: 15 APs at 300K / 20K', wifi?.quantity === 15);
  t('WiFi catalog: source = catalog', wifi?._heuristic.source === 'catalog');
  t('WiFi catalog: legacy_value = 10000', wifi?._heuristic.legacy_value === 10000);
  const sw = eq.find(l => l.equipment_name.startsWith('Switch'));
  t('Switch catalog: 3 at 300K / 100K', sw?.quantity === 3);
  const cams = eq.find(l => l.equipment_name === 'Security Cameras');
  t('CCTV override: 20 at 300K / 15K', cams?.quantity === 20);
  t('CCTV override: source = override', cams?._heuristic.source === 'override');
}

// ── Garbage values fall back to legacy ──
{
  const planningRatiosMap = { 'equipment.it.wifi_ap': { value: 0, source: 'catalog', def: null } };
  const eq = autoGenerateEquipment(buildState(), { planningRatiosMap });
  const wifi = eq.find(l => l.equipment_name.startsWith('WiFi'));
  t('zero catalog value falls back to legacy 10000', wifi?.quantity === 30 && wifi?._heuristic.source === 'legacy');
}

console.log(`test-cm-item31-ratio-lookup: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
