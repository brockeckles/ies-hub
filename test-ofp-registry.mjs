// test-ofp-registry.mjs — S22 (2026-05-11). Pin the contract for the
// OFP registry/sort/move helpers extracted from cost-model/ui.js into
// tools/cost-model/operational-flow-registry.js.
//
// The module reads `model` via cmState (state.js) and mutates
// model.ofpAreas / model.ofpFlows in place. These tests seed cmState
// with a small model, exercise each helper, and assert post-state.
//
// Run:  node test-ofp-registry.mjs

import { cmState, setModel, resetAll } from './tools/cost-model/state.js?v=20260611-dirty1';
import {
  ofpEnsureAreaRegistry,
  ofpRegistry,
  ofpAreaMeta,
  ofpEnsureFlowRegistry,
  ofpFlowRegistry,
  ofpFlowMeta,
  ofpFlowLabel,
  ofpRegisterFlow,
  ofpNormalizeAreaSortOrder,
  ofpNormalizeFlowSortOrder,
  ofpReorderArea,
  ofpReorderFlow,
  ofpMoveAreaUp,
  ofpMoveAreaDown,
  ofpMoveFlowUp,
  ofpMoveFlowDown,
  ofpMoveSubAreaUp,
  ofpMoveSubAreaDown,
  ofpAllFlowTags,
  ofpClassifyAreaFromLine,
  ofpClassifySubAreaFromLine,
  ofpFlowColor,
} from './tools/cost-model/operational-flow-registry.js?v=20260611-dirty1';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

function seedEmptyModel() {
  setModel({ laborLines: [], indirectLaborLines: [] });
}

// ============================================================
// ofpEnsureAreaRegistry — seeds defaults, idempotent
// ============================================================
seedEmptyModel();
ofpEnsureAreaRegistry();
ok('seed: model.ofpAreas exists after ensure', Array.isArray(cmState.model.ofpAreas));
ok('seed: 6 default areas seeded',
   cmState.model.ofpAreas.length === 6);
ok('seed: inbound is sortOrder=0',
   cmState.model.ofpAreas.find(a => a.key === 'inbound').sortOrder === 0);
ok('seed: unclassified is protected',
   cmState.model.ofpAreas.find(a => a.key === 'unclassified').isProtected === true);

// Idempotency
const beforeLen = cmState.model.ofpAreas.length;
ofpEnsureAreaRegistry();
ok('idempotent: second call does not re-seed', cmState.model.ofpAreas.length === beforeLen);

// Backfill missing fields on legacy entries
setModel({ laborLines: [], ofpAreas: [{ key: 'legacy', label: 'Legacy' }] });
ofpEnsureAreaRegistry();
const legacy = cmState.model.ofpAreas.find(a => a.key === 'legacy');
ok('backfill: legacy entry got displayMode default', legacy.displayMode === 'main');
ok('backfill: legacy entry got keywords=[]', Array.isArray(legacy.keywords));
ok('backfill: legacy entry got isProtected=false', legacy.isProtected === false);
ok('backfill: unclassified added to legacy registry',
   cmState.model.ofpAreas.some(a => a.key === 'unclassified'));

// ============================================================
// ofpRegistry — returns sorted-by-sortOrder
// ============================================================
seedEmptyModel();
const reg = ofpRegistry();
ok('registry: returns array', Array.isArray(reg));
ok('registry: sorted by sortOrder (inbound first, unclassified last)',
   reg[0].key === 'inbound' && reg[reg.length - 1].key === 'unclassified');

// ============================================================
// ofpAreaMeta — lookup by key, returns null for unknown
// ============================================================
ok('areaMeta: inbound returns the area',
   ofpAreaMeta('inbound').key === 'inbound');
ok('areaMeta: unknown key returns synthetic fallback',
   ofpAreaMeta('xyzzy').key === 'xyzzy' && ofpAreaMeta('xyzzy').sortOrder === 999);

// ============================================================
// ofpEnsureFlowRegistry — seeds empty flow registry
// ============================================================
seedEmptyModel();
ofpEnsureFlowRegistry();
ok('flow registry: model.ofpFlows exists', Array.isArray(cmState.model.ofpFlows));

// ============================================================
// ofpRegisterFlow — adds a new flow if missing
// ============================================================
seedEmptyModel();
ofpRegisterFlow('returns-loop', 'Returns Loop');
ok('registerFlow: flow added',
   cmState.model.ofpFlows.some(f => f.tag === 'returns-loop' && f.label === 'Returns Loop'));
ofpRegisterFlow('returns-loop', 'Returns Loop V2');  // duplicate
ok('registerFlow: duplicate tag does not re-add',
   cmState.model.ofpFlows.filter(f => f.tag === 'returns-loop').length === 1);

// ============================================================
// ofpFlowMeta + ofpFlowLabel
// ============================================================
ok('flowMeta: known tag returns object',
   ofpFlowMeta('returns-loop')?.tag === 'returns-loop');
ok('flowLabel: known tag returns label',
   ofpFlowLabel('returns-loop') === 'Returns Loop');
ok('flowLabel: unknown tag falls back to deterministic',
   typeof ofpFlowLabel('xyzzy-unknown') === 'string');

// ============================================================
// ofpAllFlowTags — sorted unique
// ============================================================
seedEmptyModel();
ofpRegisterFlow('b-second', 'B Second');
ofpRegisterFlow('a-first', 'A First');
ofpRegisterFlow('c-third', 'C Third');
const tags = ofpAllFlowTags();
ok('allFlowTags: sorted',
   tags[0] === 'a-first' && tags[1] === 'b-second' && tags[2] === 'c-third');
ok('allFlowTags: unique', new Set(tags).size === tags.length);

// ============================================================
// ofpMoveAreaUp / Down (swap by sortOrder)
// ============================================================
seedEmptyModel();
ofpEnsureAreaRegistry();
const inboundBefore = cmState.model.ofpAreas.find(a => a.key === 'inbound').sortOrder;
const storageBefore = cmState.model.ofpAreas.find(a => a.key === 'storage').sortOrder;
ofpMoveAreaDown('inbound');
const inboundAfter = cmState.model.ofpAreas.find(a => a.key === 'inbound').sortOrder;
const storageAfter = cmState.model.ofpAreas.find(a => a.key === 'storage').sortOrder;
ok('moveAreaDown: inbound moved past storage',
   inboundAfter > inboundBefore && storageAfter < storageBefore);

// Move it back up
ofpMoveAreaUp('inbound');
ok('moveAreaUp: inbound back to top',
   cmState.model.ofpAreas.find(a => a.key === 'inbound').sortOrder === 0);

// Move a noop edge case (move-up on first area)
const firstSortBefore = cmState.model.ofpAreas.find(a => a.key === 'inbound').sortOrder;
ofpMoveAreaUp('inbound');  // already at top
ok('moveAreaUp: noop when already first',
   cmState.model.ofpAreas.find(a => a.key === 'inbound').sortOrder === firstSortBefore);

// ============================================================
// ofpMoveFlowUp / Down
// ============================================================
seedEmptyModel();
ofpRegisterFlow('first',  'First');
ofpRegisterFlow('second', 'Second');
ofpNormalizeFlowSortOrder();
const firstBefore = cmState.model.ofpFlows.find(f => f.tag === 'first').sortOrder;
ofpMoveFlowDown('first');
const firstAfter = cmState.model.ofpFlows.find(f => f.tag === 'first').sortOrder;
ok('moveFlowDown: first moved past second', firstAfter > firstBefore);

// ============================================================
// ofpReorderArea — drag-to-position
// ============================================================
seedEmptyModel();
ofpEnsureAreaRegistry();
// Move storage to "before inbound" — storage becomes first
ofpReorderArea('storage', 'inbound', 'before');
const sortedKeys = [...cmState.model.ofpAreas]
  .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  .map(a => a.key);
ok('reorderArea: storage now before inbound',
   sortedKeys.indexOf('storage') < sortedKeys.indexOf('inbound'));

// reorder after
seedEmptyModel();
ofpEnsureAreaRegistry();
ofpReorderArea('inbound', 'outbound', 'after');
const sortedKeys2 = [...cmState.model.ofpAreas]
  .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  .map(a => a.key);
ok('reorderArea: inbound now after outbound',
   sortedKeys2.indexOf('inbound') > sortedKeys2.indexOf('outbound'));

// ============================================================
// ofpReorderFlow
// ============================================================
seedEmptyModel();
ofpRegisterFlow('aa', 'AA');
ofpRegisterFlow('bb', 'BB');
ofpRegisterFlow('cc', 'CC');
ofpNormalizeFlowSortOrder();
ofpReorderFlow('cc', 'aa', 'before');
const fSorted = [...cmState.model.ofpFlows]
  .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  .map(f => f.tag);
ok('reorderFlow: cc moved before aa', fSorted.indexOf('cc') < fSorted.indexOf('aa'));

// ============================================================
// Normalize sort orders — densify the gaps
// ============================================================
setModel({
  laborLines: [],
  ofpAreas: [
    { key: 'a', label: 'A', sortOrder: 7, displayMode: 'main', isProtected: false, keywords: [] },
    { key: 'b', label: 'B', sortOrder: 13, displayMode: 'main', isProtected: false, keywords: [] },
    { key: 'c', label: 'C', sortOrder: 22, displayMode: 'main', isProtected: false, keywords: [] },
    { key: 'unclassified', label: 'X', sortOrder: 99, displayMode: 'wide', isProtected: true, keywords: [] },
  ],
});
ofpNormalizeAreaSortOrder();
const aSort = cmState.model.ofpAreas.find(a => a.key === 'a').sortOrder;
const bSort = cmState.model.ofpAreas.find(a => a.key === 'b').sortOrder;
const cSort = cmState.model.ofpAreas.find(a => a.key === 'c').sortOrder;
ok('normalize: densified to 0/1/2',
   aSort === 0 && bSort === 1 && cSort === 2);

// ============================================================
// Sub-area move (within an area)
// ============================================================
setModel({
  laborLines: [],
  ofpAreas: [
    { key: 'inbound', label: 'Inbound', sortOrder: 0, displayMode: 'main', isProtected: false, keywords: [],
      subAreas: [
        { key: 'unload', label: 'Unload',   sortOrder: 0 },
        { key: 'putaway-prep', label: 'Prep', sortOrder: 1 },
        { key: 'qa', label: 'QA',           sortOrder: 2 },
      ]
    },
  ],
});
ofpMoveSubAreaDown('inbound', 'unload');
const subSorted = [...cmState.model.ofpAreas[0].subAreas]
  .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  .map(s => s.key);
ok('subarea move: unload moved past prep',
   subSorted.indexOf('unload') > subSorted.indexOf('putaway-prep'));

ofpMoveSubAreaUp('inbound', 'qa');
const subSorted2 = [...cmState.model.ofpAreas[0].subAreas]
  .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  .map(s => s.key);
ok('subarea move: qa moved up', subSorted2.indexOf('qa') < subSorted2.length - 1);

// ============================================================
// ofpFlowColor — deterministic palette hash (no model needed)
// ============================================================
ok('flowColor: stable for same tag',
   ofpFlowColor('full-pallet') === ofpFlowColor('full-pallet'));
ok('flowColor: returns hex color string',
   typeof ofpFlowColor('xyz') === 'string' && ofpFlowColor('xyz').startsWith('#'));
ok('flowColor: different tags can produce different colors',
   ofpFlowColor('a-flow') !== ofpFlowColor('b-flow') ||
   ofpFlowColor('a-flow') !== ofpFlowColor('c-flow'));  // at least one mismatch

// ============================================================
// Classifier — _classifyAreaFromLine + _classifySubAreaFromLine
// ============================================================
seedEmptyModel();
ok('classifier: keyword match → outbound',
  ofpClassifyAreaFromLine({ activity_name: 'Pick & Pack' }) === 'outbound');
ok('classifier: flowLane override wins',
  ofpClassifyAreaFromLine({ flowLane: 'support', activity_name: 'Picking' }) === 'support');
ok('classifier: no match falls back to unclassified',
  ofpClassifyAreaFromLine({ activity_name: 'XYZZY' }) === 'unclassified');
ok('classifier: null line → unclassified',
  ofpClassifyAreaFromLine(null) === 'unclassified');

setModel({
  laborLines: [],
  ofpAreas: [
    { key: 'inbound', label: 'Inbound', sortOrder: 0, displayMode: 'main', isProtected: false, keywords: ['receiv'],
      subAreas: [
        { key: 'unload', label: 'Unload', sortOrder: 0, keywords: ['unload', 'dock'] },
        { key: 'qa',     label: 'QA',     sortOrder: 1, keywords: ['inspect', 'qa'] },
      ]},
  ],
});
ok('sub-classifier: keyword match → unload',
  ofpClassifySubAreaFromLine({ activity_name: 'Unload pallets' }, 'inbound') === 'unload');
ok('sub-classifier: flowSubArea override wins',
  ofpClassifySubAreaFromLine({ flowSubArea: 'qa', activity_name: 'Unload' }, 'inbound') === 'qa');
ok('sub-classifier: no match → null',
  ofpClassifySubAreaFromLine({ activity_name: 'XYZZY' }, 'inbound') === null);
ok('sub-classifier: area without subAreas → null',
  ofpClassifySubAreaFromLine({ activity_name: 'unload' }, 'outbound') === null);

// ============================================================
// Cleanup
// ============================================================
resetAll();
ok('cleanup: cmState.model is null after resetAll', cmState.model === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failed:', fails);
  process.exit(1);
}
