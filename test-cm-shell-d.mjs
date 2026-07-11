// test-cm-shell-d.mjs — M3: Concept D shell behind a flag (2026-07-10)
//
// Locks the D-shell contract:
//   1. Shell preference service — tier-service pattern: default 'classic',
//      set/get round-trip (node in-memory fallback), invalid values ignored.
//   2. Station map — the 5 causal stations cover EVERY Engineering section
//      key in ui.js SECTIONS exactly once (anti-drift: adding a section
//      without assigning a station breaks this test, not the live spine).
//   3. Chrome contract — renderShellD emits the SAME delegation surface the
//      shared tool-chrome binds (#cm-section-content mount node,
//      data-tc-section / data-tc-action / data-tc-back) so the existing
//      renderers + bindToolChromeEvents host unchanged. Rail rows carry
//      data-cm-cell/year for the CM-PROV-1 panel.
//   4. updateDRail formatting + not-ready blanking (uses a DOM stub).
//   5. ui.js integration pins — classic stays default; D branch exists in
//      renderCurrentView; rail refresh rides refreshHeaderKpis; provenance
//      delegation admits #cmd-rail cells; scenario-tab delegation binds once.
//
// Run: node test-cm-shell-d.mjs

import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const shellD = await import('./tools/cost-model/shell-d.js?v=20260710-m3');
const { getShellPref, setShellPref, D_STATIONS, stationForSection, renderShellD, renderDSpine, updateDRail } = shellD;

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- 1. Preference service ----
t('shell pref defaults to classic; set/get round-trips; invalid ignored', () => {
  assert(getShellPref() === 'classic', 'default must be classic (old chrome stays default)');
  assert(setShellPref('d') === 'd', 'set d');
  assert(getShellPref() === 'd', 'persisted d');
  assert(setShellPref('bogus') === 'd', 'invalid ignored, current returned');
  assert(getShellPref() === 'd', 'still d after invalid set');
  setShellPref('classic');
  assert(getShellPref() === 'classic', 'back to classic');
});

// ---- 2. Station map vs ui.js SECTIONS ----
const uiSrc = readFileSync('./tools/cost-model/ui.js', 'utf8');

t('D_STATIONS covers every SECTIONS key exactly once', () => {
  const m = uiSrc.match(/const SECTIONS = \[([\s\S]*?)\n\];/);
  assert(m, 'SECTIONS array not found in ui.js');
  const sectionKeys = [...m[1].matchAll(/key:\s*'([A-Za-z]+)'/g)].map(x => x[1]);
  assert(sectionKeys.length >= 20, `implausible SECTIONS parse: ${sectionKeys.length}`);
  const stationKeys = D_STATIONS.flatMap(st => st.sections);
  const dupes = stationKeys.filter((k, i) => stationKeys.indexOf(k) !== i);
  assert(dupes.length === 0, `duplicated in stations: ${dupes.join(',')}`);
  const missing = sectionKeys.filter(k => !stationKeys.includes(k));
  assert(missing.length === 0, `sections with NO station (spine would strand them): ${missing.join(',')}`);
  const phantom = stationKeys.filter(k => !sectionKeys.includes(k));
  assert(phantom.length === 0, `stations reference nonexistent sections: ${phantom.join(',')}`);
});

t('stations follow the causal order Deal→Volume→Operation→Economics→Price', () => {
  assert(D_STATIONS.map(s => s.name).join('>') === 'Deal>Volume>Operation>Economics>Price', 'order changed');
  assert(stationForSection('setup').key === 'deal', 'setup lives in Deal');
  assert(stationForSection('pricing').key === 'price', 'pricing lives in Price');
  assert(stationForSection('summary').key === 'economics', 'summary lives in Economics');
  assert(stationForSection('std-basics') === null, 'std keys have no station (Quick tier keeps classic chrome)');
});

// ---- 3. Chrome contract ----
function makeOpts() {
  return {
    chrome: {
      activeSection: 'labor',
      sections: [
        { key: 'labor', label: 'Labor' }, { key: 'flow', label: 'Operational Flow' },
        { key: 'equipment', label: 'Equipment' }, { key: 'setup', label: 'Setup' },
      ],
      sectionCompleteness: (k) => (k === 'labor' ? 'complete' : 'partial'),
      actions: [
        { id: 'cm-save', label: 'Save', title: 'Save', primary: true },
        { id: 'cm-shell', label: 'Classic layout', title: 'Back to classic' },
      ],
      saveState: { state: 'saved', title: 'Last saved now', when: 'just now' },
      backTitle: 'Back to all models',
    },
    modelName: 'Hearthwood <script>',
    scenarioLabel: 'Baseline',
    isBaseline: true,
    scenarioStatus: 'approved',
    stationSubs: { deal: 'Hearthwood - Columbus - 5 yr', operation: '12 labor lines - 118 FTE' },
    lastVisited: { operation: 'equipment' },
    scenarioFamily: [
      { project_id: 100, scenario_label: 'Baseline', is_baseline: true, status: 'approved' },
      { project_id: 101, scenario_label: 'Peak-Volume', is_baseline: false, status: 'draft' },
    ],
    activeProjectId: 100,
    completeness: { complete: 12, total: 21 },
  };
}

t('renderShellD hosts the existing delegation contract', () => {
  const html = renderShellD(makeOpts());
  assert(html.includes('id="cm-section-content"'), 'section mount node missing — renderSection() would have nowhere to draw');
  assert(html.includes('data-tc-back'), 'back button contract');
  assert(html.includes('data-tc-action="cm-save"'), 'save action contract');
  assert(html.includes('data-tc-action="cm-shell"'), 'shell toggle present in D chrome');
  const stations = (html.match(/class="cmd-station/g) || []).length;
  assert(stations === 5, `expected 5 spine stations, found ${stations}`);
  assert(html.includes('data-cm-cell="labor"') && html.includes('data-cm-year="1"'), 'rail rows carry provenance cell attrs');
  assert(html.includes('id="cmd-rail"'), 'rail node');
  assert(!html.includes('<script>'), 'model name must be HTML-escaped');
});

t('spine: active station highlighted, last-visited target wins, rings reflect completeness', () => {
  const spine = renderDSpine(makeOpts());
  // active section 'labor' → Operation station active
  const opIdx = spine.indexOf('Operation');
  assert(opIdx !== -1 && spine.slice(0, opIdx).includes('cmd-station--on') === false
    ? spine.includes('cmd-station--on') : true, 'active class present');
  assert(spine.includes('cmd-station--on'), 'one station is active');
  // Operation station button targets last-visited 'equipment', not first section
  assert(/data-tc-section="equipment"[^>]*title="Operation"/.test(spine), 'station returns to last-visited section');
  // Deal station (never visited) targets its first section
  assert(/data-tc-section="setup"[^>]*title="Deal"/.test(spine), 'unvisited station targets first section');
  assert(spine.includes('stroke-dasharray'), 'progress rings render');
});

t('scenario tabs: active by project id, lifecycle chips, + routes to scenarios section', () => {
  const html = renderShellD(makeOpts());
  assert(/data-cmd-scen="100"[^>]*>[\s\S]*?★/.test(html) || html.includes('data-cmd-scen="100"'), 'baseline tab present');
  assert(html.includes('data-cmd-scen="101"'), 'sibling tab present');
  assert(html.includes('APPROVED') && html.includes('DRAFT'), 'lifecycle chips');
  const onTab = html.match(/<button class="cmd-stab cmd-stab--on" data-cmd-scen="(\d+)"/);
  assert(onTab && onTab[1] === '100', 'active tab = open project');
  assert(/cmd-stab--add" data-tc-section="scenarios"/.test(html), '+ tab routes to the scenarios section');
});

// ---- 4. updateDRail (DOM stub) ----
function railStub() {
  const values = {};
  const el = (k) => ({ set textContent(v) { values[k] = v; }, get textContent() { return values[k]; } });
  return {
    values,
    querySelector(sel) {
      if (sel === '#cmd-rail') return this;
      const m = sel.match(/data-cmd-rail="([^"]+)"/);
      return m ? el(m[1]) : null;
    },
  };
}

t('updateDRail formats values and computes GM delta vs target', () => {
  const stub = railStub();
  updateDRail(stub, {
    ready: true, revenue: 11200000, labor: 4400000, facility: 1400000,
    equipment: 800000, overhead: 730000, vas: 0, startup: 44000,
    totalCost: 8000000, costPerUnit: 5.71, uomLabel: 'Order',
    gmPct: 29.3, targetPct: 12,
  });
  assert(stub.values.revenue === '$11.2M', `revenue fmt: ${stub.values.revenue}`);
  assert(stub.values.labor === '$4.40M', `labor fmt: ${stub.values.labor}`);
  assert(stub.values.startup === '$44K', `startup fmt: ${stub.values.startup}`);
  assert(stub.values.costPerUnit === '$5.71', `cpu fmt: ${stub.values.costPerUnit}`);
  assert(stub.values.cpuLabel === 'Cost / Order', 'uom label');
  assert(stub.values.gm === '29.3%', `gm: ${stub.values.gm}`);
  assert(stub.values.gmDelta === 'meets target ✓', `delta: ${stub.values.gmDelta}`);
});

t('updateDRail blanks all values when not ready', () => {
  const stub = railStub();
  updateDRail(stub, { ready: false });
  assert(stub.values.revenue === '—' && stub.values.totalCost === '—' && stub.values.gm === '—', 'blanked');
});

// ---- 5. ui.js integration pins ----
t('ui.js: classic default — D shell only via _useDShell() (pref + engineering tier)', () => {
  assert(uiSrc.includes("shellD.getShellPref() === 'd'"), 'pref consulted');
  assert(uiSrc.includes('&& !_isStdKey(activeSection);'), 'Quick tier keeps classic chrome');
  assert(uiSrc.includes('? (shellD.renderShellD(_buildDShellOpts()) + _cmExtraStyles())'), 'renderCurrentView branches to D shell + keeps provenance/form styles');
  assert(uiSrc.includes(': renderShell();'), 'classic path intact');
});

t('ui.js: rail refresh rides refreshHeaderKpis; provenance admits rail cells', () => {
  assert(uiSrc.includes('try { _refreshDRail(); } catch (_) {}'), 'rail hook on KPI cadence');
  assert(uiSrc.includes("cell.closest('#cmd-rail')"), 'rail provenance exception');
});

t('ui.js: scenario-tab delegation binds once (listener-stacking class)', () => {
  assert(uiSrc.includes('rootEl.__cmdScenBound'), 'bind-once guard');
  const guarded = /if \(!rootEl\.__cmdScenBound\) \{\s*rootEl\.__cmdScenBound = true;/.test(uiSrc);
  assert(guarded, 'guard set before listener attach');
});

t('shell-d.js: compare toggle + Review/Client-safe pills are inert placeholders (M4/M7)', () => {
  const src = readFileSync('./tools/cost-model/shell-d.js', 'utf8');
  assert(src.includes('M4'), 'compare deferral documented');
  assert(src.includes('M7'), 'review mode deferral documented');
  assert(!src.includes("addEventListener"), 'shell-d renders HTML only — all events ride existing delegation');
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-shell-d: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
