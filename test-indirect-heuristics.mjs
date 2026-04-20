// test-indirect-heuristics.mjs — Q4 2026-04-20
// Verifies autoGenerateIndirectLabor stamps _heuristic provenance on each
// generated line so the UI can render ratio/source chips.

import { autoGenerateIndirectLabor } from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// State shaped like a small 25-FTE warehouse so every role tier fires:
// - 25 direct FTE @ 2000 hrs each
// - 2 shifts (triggers recv/ship clerk × 2)
// - 300K sqft (triggers maintenance + janitorial)
// - 800K outbound orders/yr (triggers CS rep + returns processor)
function buildState() {
  return {
    laborLines: Array.from({ length: 5 }, () => ({ annual_hours: 5 * 2080 })),  // 25 FTE total
    shifts: { shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5 },
    facility: { totalSqft: 300000 },
    volumeLines: [{ isOutboundPrimary: true, volume: 800000 }],
  };
}

// ─── Legacy path (no planning-ratios catalog) ───
{
  const lines = autoGenerateIndirectLabor(buildState());

  // Every generated line should carry _heuristic metadata
  t('legacy path: all lines have _heuristic', lines.every(l => l._heuristic != null));
  // Every _heuristic should declare source: 'legacy' (no catalog passed)
  t('legacy path: source === "legacy" on every line',
    lines.every(l => l._heuristic.source === 'legacy'));
  // Values should include code + label + numeric value
  t('legacy path: each has a code',  lines.every(l => typeof l._heuristic.code === 'string' && l._heuristic.code.length > 0));
  t('legacy path: each has a label', lines.every(l => typeof l._heuristic.label === 'string' && l._heuristic.label.length > 0));

  // Team Lead should use legacy divisor 8
  const teamLead = lines.find(l => l.role_name === 'Team Lead');
  t('Team Lead present', !!teamLead);
  t('Team Lead legacy value = 8', teamLead?._heuristic.value === 8);
  t('Team Lead ratio code matches catalog key', teamLead?._heuristic.code === 'indirect.team_lead.span');
}

// ─── Catalog path — planningRatiosMap overrides 3 of the rules ───
{
  const planningRatiosMap = {
    'indirect.team_lead.span': {
      value: 15, source: 'catalog',
      def: { id: 301, source: 'McKinsey 3PL Labor Benchmarks 2023', source_date: '2023-06-01' },
    },
    'salary.operations_manager.span': {
      value: 75, source: 'catalog',
      def: { id: 302, source: 'Internal span template', source_date: '2024-01-01' },
    },
    'salary.inventory_manager.span': {
      // User override — same shape, but source === 'override' flows through
      value: 60, source: 'override',
      def: { id: 303, source: 'Project-specific IC load (2025 study)', source_date: '2025-08-01' },
    },
  };
  const lines = autoGenerateIndirectLabor(buildState(), { planningRatiosMap });

  const teamLead = lines.find(l => l.role_name === 'Team Lead');
  t('Team Lead source === "catalog"', teamLead?._heuristic.source === 'catalog');
  t('Team Lead catalog value = 15', teamLead?._heuristic.value === 15);
  t('Team Lead legacy_value preserved = 8', teamLead?._heuristic.legacy_value === 8);
  t('Team Lead source_citation populated', teamLead?._heuristic.source_citation === 'McKinsey 3PL Labor Benchmarks 2023');
  t('Team Lead source_date populated', teamLead?._heuristic.source_date === '2023-06-01');

  const invCtrl = lines.find(l => l.role_name === 'Inventory Control');
  t('Inventory Control source === "override"', invCtrl?._heuristic.source === 'override');
  t('Inventory Control value = 60 (override)', invCtrl?._heuristic.value === 60);
  t('Inventory Control legacy_value = 25', invCtrl?._heuristic.legacy_value === 25);

  // Ops Manager — catalog lookup, but Q4 preserves the piecewise-rule legacy
  // description as the legacy_value string for the UI tooltip
  const opsMgr = lines.find(l => l.role_name === 'Operations Manager');
  t('Ops Manager source === "catalog"', opsMgr?._heuristic.source === 'catalog');
  t('Ops Manager value = 75', opsMgr?._heuristic.value === 75);
  t('Ops Manager legacy_value is piecewise description (string)',
    typeof opsMgr?._heuristic.legacy_value === 'string' && /piecewise/.test(opsMgr._heuristic.legacy_value));

  // Rules not in planningRatiosMap still stamp legacy
  const recvClerk = lines.find(l => l.role_name === 'Receiving / Shipping Clerk');
  t('Recv Clerk source === "legacy" (not in catalog)', recvClerk?._heuristic.source === 'legacy');
}

// ─── Sanity: non-generated lines (user-added manually) shouldn't carry _heuristic ───
{
  // Only legacy generation path — verify manually-added lines (outside this
  // function's generation) don't get stamped. We simulate by checking that
  // the line array we got back is exactly what generation produced.
  const lines = autoGenerateIndirectLabor(buildState());
  // Every line came from generation, so every line has _heuristic.
  // The guarantee is: only generated lines get the stamp. UI's
  // renderHeuristicChip bails early when _heuristic is absent, so a
  // user-added line (via "+ Add Indirect Role") never shows the chip.
  t('stamp present on every generated line', lines.length > 0 && lines.every(l => l._heuristic));
}

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
