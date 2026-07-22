// test-c5-most-audit.mjs — C5 MOST audit-trail pin (2026-07-22)
//
// Closes the C4 finding on tools/most-standards/api.js:
//   1. The three allowance-profile audit calls used a WRONG shape
//      ({ entity, entityId, action: 'create', meta }) — recordAudit requires
//      `entry.table` and silently returns without it, so they were silent
//      no-ops (and 'create' isn't in the action enum). Pin: that shape must
//      never reappear anywhere in the file.
//   2. Ten mutating fns had no audit at all. Pin: every exported mutating
//      fn records an audit in house convention (fire-and-forget
//      `.catch(() => {})`, enum actions, real table names). duplicateTemplate
//      delegates to createTemplate/createElement (both audited) — accepted.
// Source scan only — no network, no db. Run: node test-c5-most-audit.mjs

import { readFileSync } from 'node:fs';

const apiSrc = readFileSync('./tools/most-standards/api.js', 'utf8');

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
t('imports recordAudit from shared/audit.js with the WSC/CM pin', () => {
  assert(
    apiSrc.includes("import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';"),
    'audit.js import missing or pin drifted from ?v=20260504-auth1'
  );
});

// ── the old no-op shape is gone for good ─────────────────────────────────
t('no { entity, entityId } audit shape remains (was a silent no-op)', () => {
  assert(!/recordAudit\(\{\s*entity\s*:/.test(apiSrc), 'legacy `entity:` shape found');
  assert(!apiSrc.includes('entityId'), 'legacy `entityId` key found');
  assert(!apiSrc.includes("action: 'create'"), "'create' is not in the audit action enum");
});

// ── mutating fns each record an audit row ────────────────────────────────
const MUTATING = [
  { header: 'export async function createTemplate(data)',             direct: true },
  { header: 'export async function updateTemplate(id, data)',         direct: true },
  { header: 'export async function deleteTemplate(id)',               direct: true },
  { header: 'export async function duplicateTemplate(id)',            direct: false }, // delegates
  { header: 'export async function createElement(data)',              direct: true },
  { header: 'export async function updateElement(id, data)',          direct: true },
  { header: 'export async function deleteElement(id)',                direct: true },
  { header: 'export async function reorderElements(updates)',         direct: true },
  { header: 'export async function createAllowanceProfile(data)',     direct: true },
  { header: 'export async function updateAllowanceProfile(id, patch)', direct: true },
  { header: 'export async function deleteAllowanceProfile(id)',       direct: true },
  { header: 'export async function saveAnalysis(analysis)',           direct: true },
  { header: 'export async function deleteAnalysis(id)',               direct: true },
  { header: 'export async function linkToCm(analysisId, cmId)',       direct: true },
  { header: 'export async function unlinkFromCm(analysisId)',         direct: true },
];

for (const { header, direct } of MUTATING) {
  const name = header.replace('export async function ', '').replace(/\(.*/, '');
  t(`${name} records an audit trail`, () => {
    const body = extractFn(apiSrc, header);
    if (direct) {
      assert(body.includes('recordAudit('), `${name} has no recordAudit call`);
    } else {
      assert(
        body.includes('recordAudit(') || (body.includes('createTemplate(') && body.includes('createElement(')),
        `${name} neither calls recordAudit nor routes through audited create fns`
      );
    }
  });
}

t('saveAnalysis audits BOTH branches (update + insert)', () => {
  const body = extractFn(apiSrc, 'export async function saveAnalysis(analysis)');
  assert(body.includes("action: 'update'"), 'update branch not audited');
  assert(body.includes("action: 'insert'"), 'insert branch not audited');
});

t('reorderElements audits ONE row per call with a count', () => {
  const body = extractFn(apiSrc, 'export async function reorderElements(updates)');
  const calls = body.match(/recordAudit\(/g) || [];
  assert(calls.length === 1, `expected exactly 1 recordAudit in reorderElements, found ${calls.length}`);
  assert(body.includes('count: updates.length'), 'bulk audit missing count field');
  // per-element loop must not contain the audit call
  const loop = body.slice(body.indexOf('for ('), body.indexOf('}', body.indexOf('sequence_order')) + 1);
  assert(!loop.includes('recordAudit('), 'recordAudit is inside the per-element loop');
});

// ── every call: enum action, real table, fire-and-forget ────────────────
t('every recordAudit call uses enum actions, real tables, .catch(() => {})', () => {
  // match from `recordAudit(` to the end of the statement line
  const calls = apiSrc.match(/recordAudit\(\{.*?\}\)[^;\n]*/gs) || [];
  assert(calls.length >= 15, `expected >=15 recordAudit calls, found ${calls.length}`);
  const TABLES = ["'ref_most_templates'", "'ref_most_elements'", "'ref_allowance_profiles'", "'most_analyses'"];
  const ACTIONS = ["'insert'", "'update'", "'delete'", "'link'", "'unlink'"];
  for (const c of calls) {
    assert(TABLES.some(tb => c.includes(`table: ${tb}`)), `call missing/unknown table: ${c}`);
    assert(ACTIONS.some(a => c.includes(`action: ${a}`)), `call action not in enum: ${c}`);
    assert(c.includes('.catch(() => {})'), `call not fire-and-forget (.catch(() => {}) missing): ${c}`);
  }
});

// ── read paths stay silent ───────────────────────────────────────────────
t('read-only fns do NOT record audits', () => {
  for (const header of [
    'export async function listTemplates(filters = {})',
    'export async function getTemplate(id)',
    'export async function listElements(templateId)',
    'export async function listAllowanceProfiles()',
    'export async function listAnalyses()',
    'export async function getAnalysis(id)',
    'export async function loadRefData()',
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
