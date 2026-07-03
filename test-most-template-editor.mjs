/**
 * P2-2 (2026-07-02) — MOST template editor persistence.
 *
 * The editor was broken against the live schema: ref_most_elements.id is
 * BIGSERIAL, but saveTemplateAction called el.id.includes('new') (TypeError
 * on numeric ids), new elements leaked UUID placeholder ids into the bigint
 * insert, Duplicate inserted a nonexistent `name` column, deletions never
 * persisted, and 4 of 5 chrome header actions targeted phantom selectors.
 *
 * This test drives calc.saveTemplateElements with a SCHEMA-SHAPED STUB that
 * enforces exactly what PostgREST enforces: known columns only, bigint ids,
 * NOT NULL on element_name/most_sequence/tmu_value/sequence_order, and
 * autoincrementing BIGSERIAL ids on insert.
 */
import {
  isPersistedRowId,
  sanitizeElementForWrite,
  saveTemplateElements,
  MOST_ELEMENT_WRITE_COLUMNS,
} from './tools/most-standards/calc.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = typeof fn === 'function' ? fn() : fn;
    if (r instanceof Promise) throw new Error('use tAsync');
    if (r === false) throw new Error('returned false');
    pass++;
  } catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
async function tAsync(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── schema-shaped stub: ref_most_elements as PostgREST would enforce it ──
const ELEMENT_COLUMNS = new Set([
  'id', 'template_id', 'sequence_order', 'element_name', 'most_sequence',
  'sequence_type', 'tmu_value', 'is_variable', 'variable_driver',
  'variable_formula', 'notes', 'created_at', 'freq_per_cycle',
  'variable_min', 'variable_max',
]);
const NOT_NULL = ['template_id', 'sequence_order', 'element_name', 'most_sequence', 'tmu_value'];

function makeStubDb(seedRows = []) {
  let serial = seedRows.reduce((m, r) => Math.max(m, r.id), 0);
  const rows = new Map(seedRows.map(r => [r.id, { ...r }]));
  const log = [];
  function checkColumns(data, op) {
    for (const k of Object.keys(data)) {
      if (!ELEMENT_COLUMNS.has(k)) throw new Error(`${op}: column ref_most_elements.${k} does not exist`);
    }
  }
  function checkBigint(id, op) {
    if (!/^\d+$/.test(String(id))) throw new Error(`${op}: invalid input syntax for type bigint: "${id}"`);
  }
  return {
    rows, log,
    api: {
      async createElement(data) {
        checkColumns(data, 'insert');
        if ('id' in data) checkBigint(data.id, 'insert');
        for (const k of NOT_NULL) {
          if (data[k] == null) throw new Error(`insert: null value in column "${k}" violates not-null constraint`);
        }
        const row = { id: ++serial, created_at: 'now', ...data };
        rows.set(row.id, row);
        log.push(['insert', row.id]);
        return { ...row };
      },
      async updateElement(id, data) {
        checkBigint(id, 'update');
        checkColumns(data, 'update');
        const row = rows.get(Number(id));
        if (!row) throw new Error(`update: no row with id ${id}`);
        Object.assign(row, data);
        log.push(['update', Number(id)]);
        return { ...row };
      },
      async deleteElement(id) {
        checkBigint(id, 'delete');
        rows.delete(Number(id));
        log.push(['delete', Number(id)]);
      },
    },
  };
}

// ── id classification ────────────────────────────────────────────────────
t('numeric BIGSERIAL id (number) is persisted', () => assert(isPersistedRowId(42)));
t('numeric BIGSERIAL id (string) is persisted', () => assert(isPersistedRowId('9007')));
t('UUID placeholder is NOT persisted', () => assert(!isPersistedRowId('7f3b1c2e-9a4d-4e2b-8f6a-1c2d3e4f5a6b')));
t("editor placeholder fallback ('new-' prefix) is NOT persisted", () =>
  assert(!isPersistedRowId('new-1751500000000')));
t('ui.js placeholder fallback carries the new- prefix (all-digit Date.now would misclassify)', () =>
  assert(readFileSync('./tools/most-standards/ui.js', 'utf8').includes("'new-' + Date.now()")));
t('null/undefined/empty are not persisted', () =>
  assert(!isPersistedRowId(null) && !isPersistedRowId(undefined) && !isPersistedRowId('')));
t('the old bug class: .includes on a numeric id throws', () => {
  let threw = false;
  try { const id = 42; id.includes('new'); } catch { threw = true; }
  assert(threw, 'expected TypeError');
});

// ── sanitation ────────────────────────────────────────────────────────────
t('sanitizeElementForWrite drops id, created_at, and scratch keys', () => {
  const out = sanitizeElementForWrite({
    id: 'uuid-scratch', created_at: 'x', _uiFlag: true,
    template_id: 7, sequence_order: 1, element_name: 'Reach', most_sequence: 'A1 B0 G1',
    sequence_type: 'get', tmu_value: 30, freq_per_cycle: 1, is_variable: false,
    variable_driver: null, variable_min: 0, variable_max: 0,
  });
  assert(!('id' in out) && !('created_at' in out) && !('_uiFlag' in out), 'stripped');
  assert(out.element_name === 'Reach' && out.tmu_value === 30, 'kept schema cols');
  assert(Object.keys(out).every(k => MOST_ELEMENT_WRITE_COLUMNS.includes(k)), 'whitelist only');
});

// ── integration: edit existing template (mixed persisted/new/deleted) ────
await tAsync('edit-and-save: updates persisted rows, inserts new, deletes removed', async () => {
  const stub = makeStubDb([
    { id: 11, template_id: 5, sequence_order: 1, element_name: 'Walk', most_sequence: 'A6', tmu_value: 60 },
    { id: 12, template_id: 5, sequence_order: 2, element_name: 'Reach', most_sequence: 'A1 B0 G1', tmu_value: 30 },
    { id: 13, template_id: 5, sequence_order: 3, element_name: 'Place', most_sequence: 'P3', tmu_value: 30 },
  ]);
  // editor state: kept 11, edited 12, removed 13, added one new UUID element
  const elements = [
    { id: 11, template_id: 5, element_name: 'Walk', most_sequence: 'A6', tmu_value: 60 },
    { id: 12, template_id: 5, element_name: 'Reach & grasp', most_sequence: 'A1 B3 G1', tmu_value: 50 },
    { id: 'a1b2c3d4-0000-4000-8000-abcdefabcdef', element_name: 'Scan', most_sequence: 'T1', tmu_value: 10, sequence_type: 'tool_use' },
  ];
  await saveTemplateElements(stub.api, 5, elements, [13]);
  assert(!stub.rows.has(13), 'removed element deleted from DB');
  assert(stub.rows.get(12).element_name === 'Reach & grasp', 'edit persisted');
  assert(typeof elements[2].id === 'number' && elements[2].id > 13, 'new element got a BIGSERIAL id back');
  assert(stub.rows.get(elements[2].id).template_id === 5, 'new element parented');
  assert([...stub.rows.values()].every(r => [1, 2, 3].includes(r.sequence_order)), 'sequence_order restamped 1..n');
});

// ── integration: fresh template (create path) ────────────────────────────
await tAsync('create-and-save: all elements insert with clean columns', async () => {
  const stub = makeStubDb();
  const elements = [
    { id: crypto.randomUUID(), element_name: 'Get tote', most_sequence: 'A1 B0 G1', tmu_value: 20, freq_per_cycle: 1 },
    { id: crypto.randomUUID(), element_name: 'Travel', most_sequence: 'A10', tmu_value: 100, is_variable: true, variable_driver: 'travel_distance', variable_min: 2, variable_max: 30 },
  ];
  await saveTemplateElements(stub.api, 99, elements, []);
  assert(stub.rows.size === 2 && elements.every(e => typeof e.id === 'number'), 'both inserted with numeric ids');
  assert(stub.log.every(([op]) => op === 'insert'), 'no spurious updates/deletes');
});

// ── integration: schema stub actually rejects the OLD payload shape ──────
await tAsync('stub proves the old bug: raw editor element (UUID id) fails bigint insert', async () => {
  const stub = makeStubDb();
  let threw = null;
  try {
    await stub.api.createElement({ id: crypto.randomUUID(), template_id: 1, sequence_order: 1, element_name: 'x', most_sequence: 'A1', tmu_value: 1 });
  } catch (e) { threw = e; }
  assert(threw && /bigint/.test(threw.message), 'bigint cast rejection');
});

// ── source-level wiring scans (the fix must stay wired) ──────────────────
{
  const ui = readFileSync('./tools/most-standards/ui.js', 'utf8');
  const api = readFileSync('./tools/most-standards/api.js', 'utf8');
  t('ui.js no longer calls el.id.includes(…)', () => assert(!ui.includes(".id.includes('new')")));
  t('ui.js routes element persistence through calc.saveTemplateElements', () =>
    assert(ui.includes('calc.saveTemplateElements(api,')));
  t('ui.js tracks deleted element ids', () => assert(ui.includes('editorDeletedElementIds')));
  t('ui.js imports refreshToolChromeActions (was a ReferenceError on tab switch)', () =>
    assert(/import\s*\{[^}]*refreshToolChromeActions[^}]*\}\s*from '\.\.\/\.\.\/shared\/tool-chrome\.js/.test(ui)));
  t('chrome actions call handlers directly — no phantom selectors left', () =>
    assert(!ui.includes('most-analysis-calc') && !ui.includes('data-action="most-analyze"')
        && !ui.includes('most-workflow-calc') && !ui.includes('[data-action="most-save-template"]')
        && /if \(actionId === 'most-save-template'\) \{\s*saveTemplateAction\(\);/.test(ui)));
  t('workflow phase chrome no longer offers a dead Save', () =>
    assert(!/activeTab === 'workflow'[\s\S]{0,400}most-save-scenario/.test(ui)));
  t('api.duplicateTemplate writes activity_name, not name', () =>
    assert(api.includes("activity_name: (tplData.activity_name || 'Template') + ' (Copy)'")
        && !api.includes('tplData.name +')));
  t('api.reorderElements writes sequence_order', () =>
    assert(api.includes('{ sequence_order: u.sequence }') && !api.includes('{ sequence: u.sequence }')));
  t('api element writes are sanitized', () =>
    assert(api.split('sanitizeElementForWrite(').length >= 3));

  // 2026-07-03 live-walk regressions — BIGSERIAL ids are numbers, select
  // values are strings; strict === silently no-ops the template pickers.
  t('template pickers compare ids type-safely (String() both sides)', () =>
    assert(!ui.includes('find(t => t.id === tplId)')
        && ui.split('find(t => String(t.id) === String(tplId))').length >= 3));
  t('workflow/analysis selected-option compare is type-safe', () =>
    assert(!ui.includes('step.template_id === t.id')
        && !ui.includes('line.template_id === t.id')));
  t('listTemplates stamps derived element_count (list showed 0 for all)', () =>
    assert(api.includes("element_count = counts[t.id] || 0")));

  // DM→CM handoffs used a section key that no longer exists ('projectDetails'
  // → renamed 'setup'); renderSection silently blanked the canvas.
  const cmUi = readFileSync('./tools/cost-model/ui.js', 'utf8');
  t("cost-model handoffs no longer target dead 'projectDetails' section", () =>
    assert(!cmUi.includes("activeSection = 'projectDetails'")));
  t('cost-model renderSection has unknown-key fallback', () =>
    assert(cmUi.includes('Unknown section key')));
}

console.log(`test-most-template-editor: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
