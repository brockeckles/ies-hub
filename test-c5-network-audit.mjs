// test-c5-network-audit.mjs — C5 NetOpt + Fleet audit-trail pin (2026-07-22)
//
// Wave C5 closes the last two revamped tool apis with unaudited mutations:
// tools/network-opt/api.js (zero recordAudit before this wave) and
// tools/fleet-modeler/api.js (partial — saveScenario/updateCarrierRate only).
// This pin asserts every exported MUTATING function in both files carries a
// recordAudit call in its body, in the house convention (fire-and-forget
// `.catch(() => {})`, shared audit.js pin matching the other importers).
// Source scan only — no network, no db. Run: node test-c5-network-audit.mjs

import { readFileSync } from 'node:fs';

const netoptSrc = readFileSync('./tools/network-opt/api.js', 'utf8');
const fleetSrc = readFileSync('./tools/fleet-modeler/api.js', 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// Brace-matched function-body extractor (CM M1 pattern).
function extractFn(src, header) {
  const start = src.indexOf(header);
  assert(start !== -1, `function not found in source: ${header}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ── import pins ──────────────────────────────────────────────────────────
const AUDIT_IMPORT = "import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';";
t('network-opt imports recordAudit with the WSC/CM/COG pin', () => {
  assert(netoptSrc.includes(AUDIT_IMPORT), 'audit.js import missing or pin drifted from ?v=20260504-auth1');
});
t('fleet-modeler imports recordAudit with the WSC/CM/COG pin', () => {
  assert(fleetSrc.includes(AUDIT_IMPORT), 'audit.js import missing or pin drifted from ?v=20260504-auth1');
});

// ── every mutating fn records an audit row ───────────────────────────────
const NETOPT_MUTATING = [
  'export async function saveConfig(config)',
  'export async function deleteConfig(id)',
  'export async function linkToCm(scenarioId, cmId)',
  'export async function unlinkFromCm(scenarioId)',
  'export async function duplicateConfig(id)',
  'export async function saveScenarioResult(configId, name, result)',
  'export async function deleteScenarioResult(id)',
];
const FLEET_MUTATING = [
  'export async function saveScenario(scenario)',
  'export async function deleteScenario(id)',
  'export async function linkToCm(scenarioId, cmId)',
  'export async function unlinkFromCm(scenarioId)',
  'export async function duplicateScenario(id)',
  'export async function saveLanes(scenarioId, lanes)',
  'export async function updateCarrierRate(id, patch)',
  'export async function deactivateCarrierRate(id)',
];

for (const [label, src, headers] of [
  ['network-opt', netoptSrc, NETOPT_MUTATING],
  ['fleet-modeler', fleetSrc, FLEET_MUTATING],
]) {
  for (const header of headers) {
    const name = header.replace('export async function ', '').replace(/\(.*/, '');
    t(`${label} ${name} records an audit trail`, () => {
      assert(extractFn(src, header).includes('recordAudit('), `${name} has no recordAudit call`);
    });
  }
}

// ── branch + action-vocabulary pins ──────────────────────────────────────
t('netopt saveConfig audits BOTH branches (update + insert)', () => {
  const body = extractFn(netoptSrc, 'export async function saveConfig(config)');
  assert(body.includes("action: 'update'"), 'update branch not audited');
  assert(body.includes("action: 'insert'"), 'insert branch not audited');
});

t('netopt delete / link / unlink / duplicate use the audit.js action vocabulary', () => {
  assert(extractFn(netoptSrc, 'export async function deleteConfig(id)').includes("action: 'delete'"), 'deleteConfig action');
  assert(extractFn(netoptSrc, 'export async function linkToCm(scenarioId, cmId)').includes("action: 'link'"), 'linkToCm action');
  assert(extractFn(netoptSrc, 'export async function unlinkFromCm(scenarioId)').includes("action: 'unlink'"), 'unlinkFromCm action');
  assert(extractFn(netoptSrc, 'export async function duplicateConfig(id)').includes("action: 'insert'"), 'duplicateConfig action (direct insert)');
});

t('netopt scenario results audit against netopt_scenario_results', () => {
  const save = extractFn(netoptSrc, 'export async function saveScenarioResult(configId, name, result)');
  assert(save.includes("table: 'netopt_scenario_results'") && save.includes("action: 'insert'"), 'saveScenarioResult');
  const del = extractFn(netoptSrc, 'export async function deleteScenarioResult(id)');
  assert(del.includes("table: 'netopt_scenario_results'") && del.includes("action: 'delete'"), 'deleteScenarioResult');
});

t('fleet delete / link / unlink / duplicate use the audit.js action vocabulary', () => {
  assert(extractFn(fleetSrc, 'export async function deleteScenario(id)').includes("action: 'delete'"), 'deleteScenario action');
  assert(extractFn(fleetSrc, 'export async function linkToCm(scenarioId, cmId)').includes("action: 'link'"), 'linkToCm action');
  assert(extractFn(fleetSrc, 'export async function unlinkFromCm(scenarioId)').includes("action: 'unlink'"), 'unlinkFromCm action');
  assert(extractFn(fleetSrc, 'export async function duplicateScenario(id)').includes("action: 'insert'"), 'duplicateScenario action (direct insert)');
});

t('fleet saveLanes audits ONCE per bulk call (fields: { count }), not per row', () => {
  const body = extractFn(fleetSrc, 'export async function saveLanes(scenarioId, lanes)');
  const calls = body.match(/recordAudit\(/g) || [];
  assert(calls.length === 1, `expected exactly 1 recordAudit in saveLanes, found ${calls.length}`);
  assert(body.includes("table: 'fleet_lanes'"), 'saveLanes audit not targeting fleet_lanes');
  assert(body.includes('count: lanes.length'), 'saveLanes audit missing fields: { count }');
});

t('fleet deactivateCarrierRate audits against ref_fleet_carrier_rates', () => {
  const body = extractFn(fleetSrc, 'export async function deactivateCarrierRate(id)');
  assert(body.includes("table: 'ref_fleet_carrier_rates'"), 'wrong table');
  assert(body.includes('is_active: false'), 'fields missing is_active: false');
});

// ── C5-added calls are fire-and-forget ───────────────────────────────────
t('every network-opt recordAudit call is fire-and-forget (.catch(() => {}))', () => {
  const calls = netoptSrc.match(/recordAudit\(\{[^}]*\}[^)]*\)[^;\n]*/g) || [];
  assert(calls.length >= 8, `expected >=8 recordAudit calls, found ${calls.length}`);
  for (const c of calls) {
    assert(c.includes('.catch(() => {})'), `call not fire-and-forget: ${c}`);
  }
});

// ── read paths stay silent ───────────────────────────────────────────────
t('read-only fns do NOT record audits', () => {
  for (const [src, header] of [
    [netoptSrc, 'export async function listConfigs()'],
    [netoptSrc, 'export async function getConfig(id)'],
    [netoptSrc, 'export async function listScenarioResults(configId)'],
    [netoptSrc, 'export async function fetchFreightRates()'],
    [fleetSrc, 'export async function listScenarios()'],
    [fleetSrc, 'export async function getScenario(id)'],
    [fleetSrc, 'export async function listLanes(scenarioId)'],
    [fleetSrc, 'export async function listCarrierRates()'],
  ]) {
    const body = extractFn(src, header);
    assert(!body.includes('recordAudit('), `${header} unexpectedly audits a read`);
  }
});

// ── report ───────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
