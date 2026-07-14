// test-cm-persistence-contract.mjs — M1 CM contract tests (P5a, 2026-07-10)
//
// THE safety net before the CM UX redesign touches ui.js (M2 recompute seam,
// M3 D-shell). Locks the persistence contract between the in-memory model
// and cost_model_projects / cost_model_scenarios so chrome/render refactors
// can't silently change what gets saved or how legacy rows hydrate.
//
// Four surfaces:
//   1. reconstructModelFromFlatRow (ui.js, extracted + executed) — legacy
//      flat-row hydration: volume columns, env split fallback, margin split
//      fallback, pricing_buckets passthrough.
//   2. Save envelope (api.js createModel/updateModel against a stubbed db) —
//      column payload shape + model→row→model round-trip coherence.
//   3. Scenario lifecycle (api.js against an in-memory db) — saveScenario
//      insert/update, cloneScenario deep-copy (strip id/created_at/updated_at,
//      line tables, parent_scenario_id), approveScenarioRpc envelope,
//      archiveScenario, getScenarioByProject, listScenarioFamilyForProject
//      parent-chain walk.
//   4. Source pins (ui.js load path + labor migration) — ga/mgmt 37.5/62.5
//      fallback split, backfills invoked on load, PTO/holiday hour migration.
//
// ENGINES FROZEN: this file only reads calc/api/ui source and stubs the db.
// No network. Run: node test-cm-persistence-contract.mjs

import { readFileSync } from 'node:fs';

// Shim window so shared/supabase.js loads without a browser (test-env-split pattern)
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const api = await import('./tools/cost-model/api.js?test=m1');
const { db } = await import('./shared/supabase.js?v=20260703-hw1');

const uiSrc = readFileSync('./tools/cost-model/ui.js', 'utf8');
const apiSrc = readFileSync('./tools/cost-model/api.js', 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
async function ta(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// ── Function extraction (brace-matched) ─────────────────────────────────
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

const fnSrc = [
  extractFn(uiSrc, 'function createEmptyModel()'),
  extractFn(uiSrc, 'function _legacyEnvToStorage(legacy)'),
  extractFn(uiSrc, 'function _legacyEnvToVertical(legacy)'),
  extractFn(uiSrc, 'function reconstructModelFromFlatRow(row)'),
].join('\n');
const { createEmptyModel, reconstructModelFromFlatRow } =
  new Function(`${fnSrc}\nreturn { createEmptyModel, reconstructModelFromFlatRow };`)();

// ════════════════════════════════════════════════════════════════════════
// 1. reconstructModelFromFlatRow — legacy flat-row hydration
// ════════════════════════════════════════════════════════════════════════
console.log('\n── 1. reconstructModelFromFlatRow ──────────────────────────');

const richRow = {
  id: 555,
  name: 'Legacy Model',
  client_name: 'Acme Corp',
  market_id: 'mkt-atl',
  storage_environment: 'refrigerated',
  environment_type: 'refrigerated',
  contract_term_years: 7,
  deal_deals_id: 'deal-9',
  facility_sqft: 250000,
  shifts_per_day: 2, hours_per_shift: '10', days_per_week: 6, operating_weeks_per_year: 50,
  ga_margin_pct: 6, mgmt_fee_margin_pct: 10, target_margin_pct: 16,
  labor_escalation_pct: 3.5, annual_volume_growth_pct: 2,
  vol_pallets_received: 1000,
  vol_pallets_shipped: 950,
  vol_cases_picked: 50000,
  vol_eaches_picked: 0,          // zero → filtered out
  pricing_buckets: [{ id: 'storage', name: 'Storage', type: 'variable', uom: 'pallet' }],
};

t('rich row: identity + projectDetails hydrate from flat columns', () => {
  const m = reconstructModelFromFlatRow(richRow);
  eq(m.id, 555, 'id');
  eq(m.projectDetails.name, 'Legacy Model', 'name');
  eq(m.projectDetails.clientName, 'Acme Corp', 'clientName');
  eq(m.projectDetails.market, 'mkt-atl', 'market');
  eq(m.projectDetails.contractTerm, 7, 'contractTerm');
  eq(m.projectDetails.dealId, 'deal-9', 'dealId');
});

t('rich row: volume columns map to volumeLines, zeros filtered, shipped is outbound-primary', () => {
  const m = reconstructModelFromFlatRow(richRow);
  eq(m.volumeLines.length, 3, 'line count (zeros/absent filtered)');
  const shipped = m.volumeLines.find(v => v.name === 'Pallets Shipped');
  assert(shipped, 'Pallets Shipped present');
  eq(shipped.volume, 950, 'shipped volume');
  eq(shipped.uom, 'pallets', 'shipped uom');
  eq(shipped.isOutboundPrimary, true, 'shipped is outbound primary');
  const cases = m.volumeLines.find(v => v.name === 'Cases Picked');
  eq(cases && cases.uom, 'cases', 'cases uom');
  eq(m.volumeLines.filter(v => v.isOutboundPrimary).length, 1, 'exactly one outbound primary');
});

t('rich row: shifts + facility + financial columns hydrate (string coercion incl.)', () => {
  const m = reconstructModelFromFlatRow(richRow);
  eq(m.facility.totalSqft, 250000, 'sqft');
  eq(m.shifts.shiftsPerDay, 2, 'shiftsPerDay');
  eq(m.shifts.hoursPerShift, 10, 'hoursPerShift coerced to number');
  eq(m.shifts.daysPerWeek, 6, 'daysPerWeek');
  eq(m.shifts.weeksPerYear, 50, 'weeksPerYear');
  eq(m.financial.gaMargin, 6, 'explicit gaMargin wins');
  eq(m.financial.mgmtFeeMargin, 10, 'explicit mgmtFeeMargin wins');
  eq(m.financial.targetMargin, 16, 'targetMargin');
  eq(m.financial.annualEscalation, 3.5, 'escalation from labor_escalation_pct');
  eq(m.financial.volumeGrowth, 2, 'volumeGrowth');
});

t('rich row: pricing_buckets array passes through verbatim', () => {
  const m = reconstructModelFromFlatRow(richRow);
  eq(m.pricingBuckets, richRow.pricing_buckets, 'passthrough');
});

t('env fallback: legacy environment_type routes via _legacyEnvTo* when split columns absent', () => {
  const frozen = reconstructModelFromFlatRow({ id: 1, environment_type: 'frozen' });
  eq(frozen.projectDetails.storageEnvironment, 'freezer', 'frozen → freezer (storage)');
  eq(frozen.projectDetails.vertical, '', 'frozen has no vertical');
  const retail = reconstructModelFromFlatRow({ id: 2, environment_type: 'retail' });
  eq(retail.projectDetails.storageEnvironment, '', 'retail has no storage');
  eq(retail.projectDetails.vertical, 'retail', 'retail → vertical');
  eq(retail.projectDetails.environment, 'retail', 'legacy field preserved');
});

t('env precedence: explicit storage_environment column beats legacy mapping', () => {
  const m = reconstructModelFromFlatRow({ id: 3, storage_environment: 'ambient', environment_type: 'frozen' });
  eq(m.projectDetails.storageEnvironment, 'ambient', 'split column wins');
});

t('margin split fallback: no ga/mgmt columns → 37.5/62.5 of target_margin_pct', () => {
  const m = reconstructModelFromFlatRow({ id: 4, target_margin_pct: 20 });
  eq(m.financial.gaMargin, 7.5, 'ga = 20 × .375');
  eq(m.financial.mgmtFeeMargin, 12.5, 'mgmt = 20 × .625');
  eq(m.financial.targetMargin, 20, 'target preserved');
});

t('margin split fallback: no margin columns at all → 12-based split, target = derived sum (W1 2026-07-13)', () => {
  // The 16-vs-12 wart is CLOSED (Brock ruling 2026-07-13): fallbacks
  // standardized on the empty-model default 12, and reconstruct now ALWAYS
  // derives targetMargin = ga + mgmt, so header and components cannot
  // disagree on column-less legacy rows.
  const m = reconstructModelFromFlatRow({ id: 5 });
  eq(m.financial.gaMargin, 4.5, 'ga = 12 × .375');
  eq(m.financial.mgmtFeeMargin, 7.5, 'mgmt = 12 × .625');
  eq(m.financial.targetMargin, 12, 'target = derived ga + mgmt sum');
  eq(m.financial.targetMargin, m.financial.gaMargin + m.financial.mgmtFeeMargin, 'header ≡ components by construction');
});

t('margin consistency: explicit ga/mgmt columns with a stale target column → target = derived sum', () => {
  // Mirrors the prod Hearthwood rows pre-scrub: flat ga=6/mgmt=10 with a
  // stale target_margin_pct=12 — the derived sum (16) must win.
  const m = reconstructModelFromFlatRow({ id: 51, ga_margin_pct: 6, mgmt_fee_margin_pct: 10, target_margin_pct: 12 });
  eq(m.financial.targetMargin, 16, 'derived sum beats the stale flat column');
});

t('empty row: no volume columns → empty-model volumeLines; defaults survive', () => {
  const empty = createEmptyModel();
  const m = reconstructModelFromFlatRow({ id: 6 });
  eq(m.volumeLines, empty.volumeLines, 'volumeLines fallback');
  eq(m.pricingBuckets, empty.pricingBuckets, 'pricingBuckets fallback (8 standard buckets)');
  eq(m.projectDetails.contractTerm, 5, 'contract term default');
  eq(m.facility.totalSqft, empty.facility.totalSqft, 'sqft default');
  // Structural blobs must come along from the empty skeleton
  assert(m.laborCosting && m.implementationTimeline && m.uiPrefs, 'empty-model skeleton spread intact');
});

// ════════════════════════════════════════════════════════════════════════
// 2. Save envelope — createModel / updateModel payloads (stubbed db)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\n── 2. Save envelope (cost_model_projects) ──────────────────');

const realDb = { from: db.from, insert: db.insert, update: db.update, fetchAll: db.fetchAll, fetchById: db.fetchById, rpc: db.rpc };

function makeMemDb(store) {
  const ops = [];
  let idSeq = 1000;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function from(table) {
    const st = { filters: [], op: null, payload: null, orFilter: null };
    const rows = () => store[table] || (store[table] = []);
    const matches = (r) => st.filters.every(([c, v]) => r[c] === v);
    async function exec(single) {
      if (st.op === 'insert') {
        const arr = Array.isArray(st.payload) ? st.payload : [st.payload];
        const inserted = arr.map(p => { const r = clone(p); if (r.id == null) r.id = ++idSeq; rows().push(r); return r; });
        ops.push({ op: 'insert', table, payload: clone(st.payload) });
        return { data: single ? inserted[0] : inserted, error: null };
      }
      if (st.op === 'update') {
        const hit = rows().filter(matches);
        hit.forEach(r => Object.assign(r, clone(st.payload)));
        ops.push({ op: 'update', table, payload: clone(st.payload), filters: clone(st.filters) });
        return { data: single ? (hit[0] || null) : hit, error: null };
      }
      let hit = rows().filter(matches);
      if (st.orFilter) {
        const parts = st.orFilter.split(',').map(p => p.split('.eq.'));
        hit = rows().filter(r => parts.some(([c, v]) => String(r[c]) === String(v)));
      }
      return { data: single ? (hit[0] || null) : hit, error: null };
    }
    const b = {
      select() { return b; },
      eq(c, v) { st.filters.push([c, v]); return b; },
      or(expr) { st.orFilter = expr; return b; },
      order() { return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      maybeSingle() { return exec(true); },
      single() { return exec(true).then(r => (r.data == null ? { data: null, error: Object.assign(new Error('no row'), { code: 'PGRST116' }) } : r)); },
      then(res, rej) { return exec(false).then(res, rej); },
    };
    return b;
  }
  return {
    ops, store,
    from,
    insert: async (table, record) => (await from(table).insert(record).single()).data,
    update: async (table, id, payload) => { const { data } = await from(table).update(payload).eq('id', id).single(); return data; },
    fetchAll: async (table) => (await from(table)).data || [],
    fetchById: async (table, id) => (await from(table).select().eq('id', id).maybeSingle()).data,
    rpc: async (name, payload) => { ops.push({ op: 'rpc', name, payload: clone(payload) }); return { ok: true }; },
  };
}

function installMemDb(store = {}) {
  const mem = makeMemDb(store);
  db.from = mem.from; db.insert = mem.insert; db.update = mem.update;
  db.fetchAll = mem.fetchAll; db.fetchById = mem.fetchById; db.rpc = mem.rpc;
  return mem;
}
function restoreDb() { Object.assign(db, realDb); }

const rtModel = {
  ...createEmptyModel(),
  projectDetails: {
    name: 'RT Model', clientName: 'Roundtrip Inc', market: 'mkt-dfw',
    storageEnvironment: 'ambient', vertical: 'ecommerce', environment: '',
    facilityLocation: '', contractTerm: 7, dealId: 'deal-42',
    contractType: 'fixed_variable',
  },
  facility: { totalSqft: 250000, clearHeightFt: 32 },
  financial: { ...createEmptyModel().financial, gaMargin: 6.75, mgmtFeeMargin: 11.25, targetMargin: 18 },
  headlineFacts: { source: 'cm-engine', totalAnnualRevenue: 5100000, totalAnnualCost: 4300000 },
};

let createPayload = null;
await ta('createModel writes the full flat-column envelope + project_data blob', async () => {
  const mem = installMemDb();
  try {
    const row = await api.createModel(rtModel);
    const ins = mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_projects');
    assert(ins, 'insert op recorded');
    createPayload = ins.payload;
    eq(createPayload.name, 'RT Model', 'name');
    eq(createPayload.client_name, 'Roundtrip Inc', 'client_name');
    eq(createPayload.market_id, 'mkt-dfw', 'market_id');
    eq(createPayload.storage_environment, 'ambient', 'storage_environment');
    eq(createPayload.industry_vertical, 'ecommerce', 'industry_vertical');
    eq(createPayload.environment_type, 'ambient', 'legacy environment_type');
    eq(createPayload.contract_term_years, 7, 'contract_term_years');
    eq(createPayload.deal_deals_id, 'deal-42', 'deal_deals_id');
    eq(createPayload.facility_sqft, 250000, 'headline facility_sqft');
    eq(createPayload.target_margin_pct, 18, 'headline target_margin_pct');
    eq(createPayload.total_annual_revenue, 5100000, 'engine revenue lifted');
    eq(createPayload.total_annual_cost, 4300000, 'engine cost lifted');
    eq(createPayload.contract_type, 'fixed_variable', 'contract_type');
    assert(createPayload.project_data && createPayload.project_data.projectDetails.name === 'RT Model', 'project_data is the full model');
    assert(!('updated_at' in createPayload), 'create relies on column default for updated_at');
    assert(row && row.id, 'insert returns row with id');
  } finally { restoreDb(); }
});

await ta('createModel omits deal_deals_id when the model has no deal', async () => {
  const mem = installMemDb();
  try {
    const m = { ...rtModel, projectDetails: { ...rtModel.projectDetails, dealId: null } };
    await api.createModel(m);
    const ins = mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_projects');
    assert(!('deal_deals_id' in ins.payload), 'key omitted, not nulled');
  } finally { restoreDb(); }
});

await ta('updateModel stamps updated_at and always writes deal_deals_id (null when unlinked)', async () => {
  const mem = installMemDb({ cost_model_projects: [{ id: 77, name: 'old' }] });
  try {
    await api.updateModel(77, { ...rtModel, projectDetails: { ...rtModel.projectDetails, dealId: null } });
    const upd = mem.ops.find(o => o.op === 'update' && o.table === 'cost_model_projects');
    assert(upd, 'update op recorded');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(upd.payload.updated_at), 'updated_at is ISO stamp');
    eq(upd.payload.deal_deals_id, null, 'deal_deals_id explicitly nulled on update');
    eq(upd.payload.project_data.projectDetails.name, 'RT Model', 'project_data rides along');
    eq(upd.filters, [['id', 77]], 'targets the row by id');
  } finally { restoreDb(); }
});

t('round-trip: createModel flat columns → reconstructModelFromFlatRow → coherent model', () => {
  assert(createPayload, 'createModel payload captured');
  const { project_data, ...flat } = createPayload; // legacy rows have NO project_data
  const m = reconstructModelFromFlatRow({ ...flat, id: 555 });
  eq(m.projectDetails.name, 'RT Model', 'name survives');
  eq(m.projectDetails.clientName, 'Roundtrip Inc', 'client survives');
  eq(m.projectDetails.market, 'mkt-dfw', 'market survives');
  eq(m.projectDetails.contractTerm, 7, 'term survives');
  eq(m.projectDetails.dealId, 'deal-42', 'deal link survives');
  eq(m.projectDetails.storageEnvironment, 'ambient', 'storage env survives');
  eq(m.projectDetails.vertical, 'ecommerce', 'vertical survives');
  eq(m.facility.totalSqft, 250000, 'sqft survives');
  eq(m.financial.targetMargin, 18, 'target margin survives');
  // ga/mgmt columns are not part of the headline envelope — the 37.5/62.5
  // split must reconstruct a sum equal to the stamped target margin.
  eq(Number((m.financial.gaMargin + m.financial.mgmtFeeMargin).toFixed(2)), 18, 'ga+mgmt sum coherent with target');
});

// ════════════════════════════════════════════════════════════════════════
// 3. Scenario lifecycle — cost_model_scenarios (in-memory db)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\n── 3. Scenario lifecycle (cost_model_scenarios) ────────────');

function seedFamily() {
  return {
    cost_model_scenarios: [
      { id: 10, project_id: 100, deal_id: 5, parent_scenario_id: null, is_baseline: true, status: 'approved', scenario_label: 'Base', created_at: '2026-01-01', updated_at: '2026-01-02' },
      { id: 11, project_id: 101, deal_id: 5, parent_scenario_id: 10, is_baseline: false, status: 'draft', scenario_label: 'Alt A', created_at: '2026-02-01', updated_at: '2026-02-02' },
    ],
    cost_model_projects: [
      { id: 100, name: 'Model A', status: 'approved', scenario_label: 'Base', created_at: 'x', updated_at: 'y', project_data: { note: 'src' } },
      { id: 101, name: 'Model A — Alt A', status: 'draft', scenario_label: 'Alt A', created_at: 'x', updated_at: 'y' },
    ],
    cost_model_labor: [
      { id: 1, project_id: 100, activity_name: 'Pick', created_at: 'x', updated_at: 'y' },
      { id: 2, project_id: 999, activity_name: 'Other project — must not clone' },
    ],
    cost_model_equipment: [{ id: 3, project_id: 100, equipment_name: 'Forklift', created_at: 'x' }],
    cost_model_overhead: [],
    cost_model_vas: [],
    cost_model_volumes: [{ id: 4, project_id: 100, uom: 'cases' }],
  };
}

await ta('saveScenario (no id) inserts and stamps updated_at', async () => {
  const mem = installMemDb();
  try {
    const row = await api.saveScenario({ deal_id: 5, project_id: 200, scenario_label: 'Fresh', status: 'draft' });
    const ins = mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_scenarios');
    assert(ins, 'insert path taken');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(ins.payload.updated_at), 'updated_at stamped');
    eq(ins.payload.status, 'draft', 'payload fields pass through');
    assert(row.id, 'returns inserted row with id');
  } finally { restoreDb(); }
});

await ta('saveScenario (with id) updates the existing row by id', async () => {
  const mem = installMemDb(seedFamily());
  try {
    const row = await api.saveScenario({ id: 11, status: 'review' });
    const upd = mem.ops.find(o => o.op === 'update' && o.table === 'cost_model_scenarios');
    assert(upd, 'update path taken');
    eq(upd.filters, [['id', 11]], 'targets row by id');
    eq(row.status, 'review', 'returns updated row');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(row.updated_at), 'updated_at restamped');
  } finally { restoreDb(); }
});

await ta('cloneScenario deep-copies project + line tables and links the child', async () => {
  const mem = installMemDb(seedFamily());
  try {
    const { scenario, projectId } = await api.cloneScenario(10, 'Alt B');
    // New project: copy-on-write with identity/status reset
    const projIns = mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_projects');
    assert(projIns, 'new project inserted');
    assert(!('id' in projIns.payload) && !('created_at' in projIns.payload) && !('updated_at' in projIns.payload),
      'id/created_at/updated_at stripped from project copy');
    eq(projIns.payload.name, 'Model A — Alt B', 'child name derived');
    eq(projIns.payload.status, 'draft', 'child reset to draft');
    eq(projIns.payload.scenario_label, 'Alt B', 'child scenario_label');
    eq(projIns.payload.project_data, { note: 'src' }, 'project_data blob copied');
    assert(projectId && projectId !== 100, 'fresh project id');
    // Line tables: only source-project rows, re-pointed, ids stripped
    const laborIns = mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_labor');
    assert(laborIns, 'labor rows cloned');
    const laborRows = Array.isArray(laborIns.payload) ? laborIns.payload : [laborIns.payload];
    eq(laborRows.length, 1, 'only project-100 labor cloned (project-999 excluded)');
    eq(laborRows[0].project_id, projectId, 'labor re-pointed to child project');
    assert(!('id' in laborRows[0]) && !('created_at' in laborRows[0]), 'labor id/created_at stripped');
    assert(mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_equipment'), 'equipment cloned');
    assert(mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_volumes'), 'volumes cloned');
    assert(!mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_overhead'), 'empty overhead skipped');
    assert(!mem.ops.find(o => o.op === 'insert' && o.table === 'cost_model_vas'), 'empty vas skipped');
    // New scenario row
    eq(scenario.parent_scenario_id, 10, 'parent link');
    eq(scenario.deal_id, 5, 'deal_id copied from source scenario');
    eq(scenario.is_baseline, false, 'child never baseline');
    eq(scenario.status, 'draft', 'child scenario starts draft');
    eq(scenario.project_id, projectId, 'scenario points at the new project');
    eq(scenario.scenario_label, 'Alt B', 'label');
  } finally { restoreDb(); }
});

await ta('approveScenarioRpc fires approve_scenario with numeric p_scenario_id', async () => {
  const mem = installMemDb(seedFamily());
  try {
    await api.approveScenarioRpc('11', 'brock@gxo.com');
    const rpc = mem.ops.find(o => o.op === 'rpc');
    assert(rpc, 'rpc fired');
    eq(rpc.name, 'approve_scenario', 'rpc name');
    eq(rpc.payload, { p_scenario_id: 11, p_user_email: 'brock@gxo.com' }, 'payload envelope (id coerced to number)');
  } finally { restoreDb(); }
});

await ta('archiveScenario sets status=archived + restamps updated_at, preserving the row', async () => {
  const mem = installMemDb(seedFamily());
  try {
    const row = await api.archiveScenario(11);
    eq(row.status, 'archived', 'status');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(row.updated_at), 'updated_at restamped');
    eq(row.parent_scenario_id, 10, 'rest of row untouched');
  } finally { restoreDb(); }
});

await ta('getScenarioByProject: 1:1 lookup, null when absent, null on falsy id', async () => {
  installMemDb(seedFamily());
  try {
    const hit = await api.getScenarioByProject(100);
    eq(hit && hit.id, 10, 'finds scenario by project_id');
    eq(await api.getScenarioByProject(424242), null, 'missing → null');
    eq(await api.getScenarioByProject(null), null, 'falsy id → null, no query');
  } finally { restoreDb(); }
});

await ta('listScenarioFamilyForProject climbs to root from a child and returns baseline first', async () => {
  installMemDb(seedFamily());
  try {
    const fam = await api.listScenarioFamilyForProject(101); // start from CHILD
    eq(fam.map(s => s.id), [10, 11], 'root first, then children');
  } finally { restoreDb(); }
});

// ════════════════════════════════════════════════════════════════════════
// 4. Source pins — load path + legacy migrations (ui.js / api.js)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\n── 4. Source pins (load path + migrations) ─────────────────');

t('load path: project_data branch spreads onto empty skeleton with row id', () => {
  assert(uiSrc.includes('{ ...createEmptyModel(), ...full.project_data, id: full.id }'),
    'hydration spread contract changed');
});

t('load path: flat-row fallback branch calls reconstructModelFromFlatRow + legacy toast', () => {
  assert(uiSrc.includes('model = setModel(reconstructModelFromFlatRow(full));'), 'fallback branch');
  assert(uiSrc.includes('Legacy model loaded from summary fields'), 'legacy toast');
});

t('load path: ga/mgmt hydration fallback keeps the 37.5/62.5 split and recomputes target as the sum', () => {
  assert(/\* 0\.375\)\.toFixed\(2\)/.test(uiSrc), 'ga 37.5% fallback');
  assert(/\* 0\.625\)\.toFixed\(2\)/.test(uiSrc), 'mgmt 62.5% fallback');
  assert(uiSrc.includes('fin.targetMargin = Number((Number(fin.gaMargin || 0) + Number(fin.mgmtFeeMargin || 0)).toFixed(2))'),
    'targetMargin = ga + mgmt');
});

t('load path: legacy migrations run on every load (labor positions + equipment types + channels)', () => {
  assert(uiSrc.includes('migrateLaborLinesToPositions(model);'), 'labor migration invoked');
  assert(uiSrc.includes('api.backfillEquipmentLineTypes(model);'), 'equipment backfill invoked');
  assert(uiSrc.includes('api.backfillChannelsFromLegacy(model);'), 'channels backfill invoked');
});

t('labor migration: PTO/holiday legacy % → hours (2080 base) with 80/64 defaults, 85 utilization', () => {
  const src = extractFn(uiSrc, 'function migrateLaborLinesToPositions(m)');
  assert(/legacyPct \/ 100 \* 2080/.test(src), 'pct→hours formula');
  assert(/:\s*80;/.test(src), 'PTO default 80h');
  assert(/:\s*64;/.test(src), 'holiday default 64h');
  assert(/directUtilization == null\) s\.directUtilization = 85/.test(src), 'utilization default 85');
  assert(src.includes('_catalogVersion !== CATALOG_VERSION'), 'catalog re-seed gated by version flag');
});

t('scenario family walk: parent-chain climb is guarded and deliberately NOT deal_id-filtered', () => {
  const src = extractFn(apiSrc, 'export async function listScenarioFamilyForProject(projectId)');
  assert(src.includes('guard++ < 10'), 'chain-climb guard');
  assert(src.includes('id.eq.${rootId},parent_scenario_id.eq.${rootId}'), 'root + direct children .or() shape');
  assert(!src.includes(".eq('deal_id'"), 'must not filter family by deal_id (NULL deal_id rows were dropped historically)');
});

t('saveScenario audits both insert and update paths', () => {
  const src = extractFn(apiSrc, 'export async function saveScenario(payload)');
  const audits = (src.match(/recordAudit\(/g) || []).length;
  eq(audits, 2, 'one audit per branch');
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
}
console.log(`test-cm-persistence-contract: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
