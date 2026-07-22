// test-c4-wsc-audit.mjs — C4 WSC audit-trail pin (2026-07-22)
//
// Audit finding closed this wave: WSC api.js was the last revamped tool api
// with zero recordAudit. This pin asserts every exported MUTATING function
// in tools/warehouse-sizing/api.js carries a recordAudit call in its body,
// in the house convention (fire-and-forget `.catch(() => {})`, shared
// audit.js pin matching the other importers). Source scan only — no
// network, no db. Run: node test-c4-wsc-audit.mjs

import { readFileSync } from 'node:fs';

const apiSrc = readFileSync('./tools/warehouse-sizing/api.js', 'utf8');

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

// ── import pin ───────────────────────────────────────────────────────────
t('imports recordAudit from shared/audit.js with the fleet/COG/CM pin', () => {
  assert(
    apiSrc.includes("import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';"),
    'audit.js import missing or pin drifted from ?v=20260504-auth1'
  );
});

// ── mutating fns each record an audit row ────────────────────────────────
// duplicateConfig routes through saveConfig (COG duplicateScenario pattern),
// so its insert is audited there — accept either a direct recordAudit or
// the saveConfig delegation.
const MUTATING = [
  { header: 'export async function saveConfig(config)',        direct: true },
  { header: 'export async function deleteConfig(id)',          direct: true },
  { header: 'export async function linkToCm(scenarioId, cmId)', direct: true },
  { header: 'export async function unlinkFromCm(scenarioId)',  direct: true },
  { header: 'export async function duplicateConfig(id)',       direct: false },
];

for (const { header, direct } of MUTATING) {
  const name = header.replace('export async function ', '').replace(/\(.*/, '');
  t(`${name} records an audit trail`, () => {
    const body = extractFn(apiSrc, header);
    if (direct) {
      assert(body.includes('recordAudit('), `${name} has no recordAudit call`);
    } else {
      assert(
        body.includes('recordAudit(') || body.includes('saveConfig('),
        `${name} neither calls recordAudit nor routes through saveConfig`
      );
    }
  });
}

t('saveConfig audits BOTH branches (update + insert)', () => {
  const body = extractFn(apiSrc, 'export async function saveConfig(config)');
  assert(body.includes("action: 'update'"), 'update branch not audited');
  assert(body.includes("action: 'insert'"), 'insert branch not audited');
});

t('deleteConfig / link / unlink use the audit.js action vocabulary', () => {
  assert(extractFn(apiSrc, 'export async function deleteConfig(id)').includes("action: 'delete'"), 'deleteConfig action');
  assert(extractFn(apiSrc, 'export async function linkToCm(scenarioId, cmId)').includes("action: 'link'"), 'linkToCm action');
  assert(extractFn(apiSrc, 'export async function unlinkFromCm(scenarioId)').includes("action: 'unlink'"), 'unlinkFromCm action');
});

t('every recordAudit call targets wsc_facility_configs and is fire-and-forget', () => {
  const calls = apiSrc.match(/recordAudit\(\{[^}]*\}[^)]*\)[^;\n]*/g) || [];
  assert(calls.length >= 5, `expected >=5 recordAudit calls (update, insert, delete, link, unlink), found ${calls.length}`);
  for (const c of calls) {
    assert(c.includes("table: 'wsc_facility_configs'"), `call not targeting wsc_facility_configs: ${c}`);
    assert(c.includes('.catch(() => {})'), `call not fire-and-forget (.catch(() => {}) missing): ${c}`);
  }
});

// ── read paths stay silent ───────────────────────────────────────────────
t('read-only fns do NOT record audits', () => {
  for (const header of [
    'export async function listConfigs()',
    'export async function getConfig(id)',
    'export async function fetchFacilityRates(marketId)',
    'export async function fetchWscFactors()',
  ]) {
    const body = extractFn(apiSrc, header);
    assert(!body.includes('recordAudit('), `${header} unexpectedly audits a read`);
  }
});

// ── report ───────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
