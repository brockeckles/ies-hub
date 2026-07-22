// test-cm-shell-d.mjs — M3: Concept D shell behind a flag (2026-07-10)
//                       M4: rail inspector + per-object what-if + compare (2026-07-13)
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
//   5. ui.js integration pins — D is the default shell (M8a); classic
//      survives behind the pref. Rail refresh rides refreshHeaderKpis; provenance
//      delegation admits #cmd-rail cells; scenario-tab delegation binds once.
//
// Run: node test-cm-shell-d.mjs

import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

// ?v= pin MUST match ui.js's import (feedback_test_cache_bust_match — a
// mismatched pin loads a SECOND module instance with its own state).
const shellD = await import('./tools/cost-model/shell-d.js?v=20260722-s3');
const { getShellPref, setShellPref, D_STATIONS, stationForSection, renderShellD, renderDSpine,
        renderDScenarioRow, updateDRail, RAIL_ROW_KEYS, WHATIF_BY_CELL, railWhatIfSection,
        whatIfKeysForCell } = shellD;

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- 1. Preference service ----
t('M8a: shell pref defaults to D; explicit classic honored; invalid ignored', () => {
  assert(getShellPref() === 'd', 'default must be d (M8a flip — Brock decision 2026-07-13)');
  assert(setShellPref('classic') === 'classic', 'escape hatch: explicit classic sticks');
  assert(getShellPref() === 'classic', 'persisted classic');
  assert(setShellPref('bogus') === 'classic', 'invalid ignored, current returned');
  assert(getShellPref() === 'classic', 'still classic after invalid set');
  setShellPref('d');
  assert(getShellPref() === 'd', 'back to d');
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
  assert(stationForSection('std-basics') === null, 'std keys have no station (spine deleted M8b; stale keys migrate in ui.js)');
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
t('ui.js: _useDShell gates on the pref alone (M8b: std guard deleted)', () => {
  assert(uiSrc.includes("shellD.getShellPref() === 'd'"), 'pref consulted');
  assert(!uiSrc.includes('_isStdKey'), 'std guard must stay deleted (M8b)');
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

t('ui.js: provenance delegation binds once (M3 walk find — stacked pairs cancelled to no-op)', () => {
  // Every renderCurrentView() used to stack a duplicate rootEl click
  // listener; an even count made open+close cancel, so provenance clicks
  // died after any tier/shell re-shell. Guard must wrap the attach.
  assert(/if \(!rootEl\.__cmProvBound\) \{\s*rootEl\.__cmProvBound = true;\s*rootEl\.addEventListener\('click'/.test(uiSrc),
    'provenance listener must be bind-once-guarded');
  // and every rootEl-level click delegation in ui.js must carry SOME guard
  const attaches = (uiSrc.match(/rootEl\.addEventListener\('click'/g) || []).length;
  const guards = (uiSrc.match(/rootEl\.__cm[A-Za-z]*Bound\) \{\s*rootEl\.__cm[A-Za-z]*Bound = true;/g) || []).length;
  assert(guards >= attaches, `unguarded rootEl click delegation: ${attaches} attaches vs ${guards} guards`);
});

t('shell-d.js: Review/Client-safe pills are LIVE (M7); module stays render-only', () => {
  const src = readFileSync('./tools/cost-model/shell-d.js', 'utf8');
  assert(src.includes('data-cmd-mode="review"') && src.includes('data-cmd-mode="clientsafe"'),
    'mode pills carry the M7 document delegation attrs');
  assert(!src.includes('arrives in M7'), 'inert-pill placeholders retired');
  assert(!src.includes("addEventListener"), 'shell-d renders HTML only — all events ride existing delegation');
});

t('ui.js: M7 mode pills open the review doc via the bind-once delegation', () => {
  assert(uiSrc.includes("e.target.closest('[data-cmd-mode]')"), 'mode delegation bound');
  assert(uiSrc.includes('function _openReviewDoc'), 'popup opener exists');
  const fn = uiSrc.slice(uiSrc.indexOf('function _openReviewDoc'), uiSrc.indexOf('function _openReviewDoc') + 1600);
  assert(fn.includes('computeAll(_computeCtx())'), 'doc data comes from the memoized seam');
  assert(fn.includes('reviewDoc.buildReviewModel') && fn.includes('reviewDoc.renderReviewHtml'), 'pure builder pattern (WSC N6)');
  assert(fn.includes("window.open('', '_blank')") && fn.includes('document.write'), 'popup document pattern');
});

// ---- 6. M4: compare-vs-baseline toggle ----
t('compare toggle: LIVE on a child scenario, off/on states, inert on the baseline itself', () => {
  const child = { ...makeOpts(), activeProjectId: 101 };
  let html = renderDScenarioRow(child);
  assert(html.includes('data-cmd-cmp'), 'child scenario gets a live toggle');
  assert(html.includes('aria-pressed="false"') && !html.includes('cmd-toggle--on'), 'off state');
  html = renderDScenarioRow({ ...child, compareOn: true });
  assert(html.includes('aria-pressed="true"') && html.includes('cmd-toggle--on'), 'on state');
  // Active project IS the baseline → inert (comparing baseline to itself is a zero row)
  html = renderDScenarioRow(makeOpts());
  assert(!html.includes('data-cmd-cmp'), 'baseline project: no live toggle');
  assert(html.includes('aria-disabled="true"'), 'inert toggle rendered');
  // No baseline in family at all → inert
  html = renderDScenarioRow({ ...makeOpts(), scenarioFamily: [{ project_id: 101, scenario_label: 'X', is_baseline: false, status: 'draft' }], activeProjectId: 101 });
  assert(!html.includes('data-cmd-cmp'), 'no baseline in family: no live toggle');
});

// ---- 7. M4: updateDRail inline compare deltas ----
function railStub2() {
  const values = {}, cls = {};
  const el = (bag, k) => ({
    set textContent(v) { values[k] = v; }, get textContent() { return values[k]; },
    set className(v) { cls[k] = v; }, get className() { return cls[k]; },
  });
  return {
    values, cls,
    querySelector(sel) {
      if (sel === '#cmd-rail') return this;
      let m = sel.match(/data-cmd-railc="([^"]+)"/);
      if (m) return el(cls, 'c:' + m[1]);
      m = sel.match(/data-cmd-rail="([^"]+)"/);
      return m ? el(values, m[1]) : null;
    },
  };
}

const RAIL_DATA = {
  ready: true, revenue: 11200000, labor: 4400000, facility: 1400000,
  equipment: 800000, overhead: 730000, vas: 0, startup: 44000,
  totalCost: 8000000, costPerUnit: 5.71, uomLabel: 'Order',
  gmPct: 28.6, targetPct: 12,
};

t('updateDRail compare: favorability directions + pp delta + badge', () => {
  const stub = railStub2();
  updateDRail(stub, { ...RAIL_DATA, compare: {
    label: 'Baseline', revenue: 12800000, labor: 4900000, facility: 1400200,
    equipment: 900000, overhead: 700000, vas: 0, startup: 44000,
    totalCost: 8600000, gmPct: 32.8,
  } });
  assert(stub.values.cmpBadge === 'Δ vs ★ Baseline', `badge: ${stub.values.cmpBadge}`);
  // labor $4.4M vs $4.9M base → cost DOWN → good
  assert(stub.values['c:labor'] === '▼ −$500K', `labor delta: ${stub.values['c:labor']}`);
  assert(stub.cls['c:labor'].includes('cmd-plc--good'), 'cost down = favorable');
  // revenue $11.2M vs $12.8M base → revenue DOWN → bad
  assert(stub.values['c:revenue'] === '▼ −$1.60M', `revenue delta: ${stub.values['c:revenue']}`);
  assert(stub.cls['c:revenue'].includes('cmd-plc--bad'), 'revenue down = unfavorable');
  // overhead UP $30K → bad
  assert(stub.values['c:overhead'] === '▲ +$30K' && stub.cls['c:overhead'].includes('cmd-plc--bad'), 'cost up = unfavorable');
  // within $500 → "= base"
  assert(stub.values['c:facility'] === '= base' && stub.cls['c:facility'].includes('cmd-plc--eq'), `near-equal: ${stub.values['c:facility']}`);
  // GM 28.6 vs 32.8 → −4.2pp bad
  assert(stub.values['c:gmPct'] === '−4.2pp vs base' && stub.cls['c:gmPct'].includes('cmd-plc--bad'), `gm pp: ${stub.values['c:gmPct']}`);
  assert(stub.cls['c:totalCost'].includes('cmd-plc--good'), 'total cost down = favorable');
});

t('updateDRail compare: slots + badge cleared when compare off or not ready', () => {
  const stub = railStub2();
  updateDRail(stub, { ...RAIL_DATA, compare: { label: 'B', revenue: 12800000, labor: 4900000, gmPct: 32.8, totalCost: 8600000, facility: 1, equipment: 1, overhead: 1, vas: 0, startup: 0 } });
  updateDRail(stub, RAIL_DATA); // compare gone
  assert(stub.values['c:labor'] === '' && stub.values.cmpBadge === '', 'deltas cleared');
  assert(stub.cls['c:labor'] === 'cmd-plc', 'stale favorability class dropped');
  updateDRail(stub, { ...RAIL_DATA, compare: { label: 'B', revenue: 1, labor: 1, facility: 1, equipment: 1, overhead: 1, vas: 0, startup: 0, totalCost: 1, gmPct: 1 } });
  updateDRail(stub, { ready: false });
  assert(stub.values['c:revenue'] === '' && stub.values.cmpBadge === '', 'not-ready clears compare too');
});

// ---- 8. M4: per-object what-if map + section renderer ----
t('WHATIF_BY_CELL: every lever exists in ui.js WHATIF_SLIDERS; every rail row is mapped', () => {
  const m = uiSrc.match(/const WHATIF_SLIDERS = \[([\s\S]*?)\n\];/);
  assert(m, 'WHATIF_SLIDERS not found in ui.js');
  const sliderKeys = new Set([...m[1].matchAll(/key:\s*'([a-z0-9_]+)'/g)].map(x => x[1]));
  assert(sliderKeys.size >= 15, `implausible WHATIF_SLIDERS parse: ${sliderKeys.size}`);
  for (const [cell, levers] of Object.entries(WHATIF_BY_CELL)) {
    for (const k of levers) assert(sliderKeys.has(k), `WHATIF_BY_CELL.${cell} references unknown lever '${k}'`);
  }
  for (const rowKey of RAIL_ROW_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(WHATIF_BY_CELL, rowKey), `rail row '${rowKey}' has no lever mapping`);
  }
  // and the rail rows the map promises actually render
  const html = renderShellD(makeOpts());
  for (const rowKey of RAIL_ROW_KEYS) {
    assert(html.includes(`data-cm-cell="${rowKey}"`), `rail row '${rowKey}' missing from shell markup`);
    assert(html.includes(`data-cmd-railc="${rowKey}"`), `rail row '${rowKey}' missing its compare-delta slot`);
  }
});

t('railWhatIfSection: inputs + escaping + studio link + reset gating', () => {
  const rows = [{ key: 'tax_rate_pct', label: 'Tax <Rate>', min: 0, max: 50, step: 0.5, unit: '%',
    value: 25, src: 'transient', impact: { good: false, text: '−$120K NI' } }];
  const html = railWhatIfSection(rows, { anyLive: true });
  assert(html.includes('data-cmd-izs="tax_rate_pct"') && html.includes('data-cmd-izn="tax_rate_pct"'), 'slider + number inputs');
  assert(html.includes('Tax &lt;Rate&gt;'), 'label escaped');
  assert(html.includes('cmd-wisrc--live'), 'live source badge');
  assert(html.includes('cmd-wichip--bad') && html.includes('−$120K NI'), 'impact chip');
  assert(html.includes('data-tc-section="whatif"'), 'studio link rides existing tool-chrome delegation');
  assert(html.includes('data-cmd-izreset'), 'reset shown when a lever is live');
  assert(!railWhatIfSection(rows, { anyLive: false }).includes('data-cmd-izreset'), 'reset hidden when nothing live');
  assert(railWhatIfSection([], {}) === '', 'no levers (e.g. startup amort) → empty string');
});

// ---- 9. M4: ui.js integration pins ----
t('ui.js: refreshProvenancePanel routes into #cmd-izbody under the D shell', () => {
  assert(uiSrc.includes("_useDShell() ? rootEl?.querySelector('#cmd-izbody')") , 'iz routing gated on D shell');
  assert(uiSrc.includes('renderProvenancePanelInner() + _railWhatIfHtml()'), 'same CM-PROV-1 builder + quick what-if in the rail');
  assert(uiSrc.includes('_wireRailWhatIf(izBody)'), 'rail what-if inputs wired after render');
});

t('ui.js: compare toggle wired + per-project reset + rail data carries compare bag', () => {
  assert(uiSrc.includes("e.target.closest('[data-cmd-cmp]')"), 'toggle handled in scen delegation');
  assert(uiSrc.includes('async function _toggleDCompare'), 'toggle impl');
  assert(uiSrc.includes('computeWhatIfPreview({}, {') && uiSrc.includes('async function _computeBaselineY1'), 'baseline computed via pure preview (no computeAll memo thrash)');
  const resets = (uiSrc.match(/_dCompareOn = false;/g) || []).length;
  assert(resets >= 3, `compare reset on mount + load + failure (found ${resets})`);
  // M4b walk find, round 2: the reset must run BEFORE renderCurrentView —
  // bindSectionEvents re-renders the rail inspector during that pass, so a
  // late reset leaves stale content on screen (exactly what the first,
  // post-render placement did).
  const loadFn = uiSrc.slice(uiSrc.indexOf('async function loadModelByCmId'));
  const loadBlock = loadFn.slice(0, loadFn.indexOf('\nasync function ', 10));
  const iReset = loadBlock.indexOf('_activeProvCell = null;');
  const iRender = loadBlock.indexOf('renderCurrentView();');
  assert(iReset !== -1, 'inspector selection cleared on project load (M4b walk find)');
  assert(iRender !== -1 && iReset < iRender, 'selection reset must precede renderCurrentView in the load path');
  const iCmpReset = loadBlock.indexOf('_dCompareOn = false;');
  assert(iCmpReset !== -1 && iCmpReset < iRender, 'compare reset must precede renderCurrentView in the load path');
  assert(uiSrc.includes('compare: (_dCompareOn && _dBaselineCmp && _dBaselineCmp.data)'), 'rail data attaches compare bag');
  // M4d — baseline bag is basis-pinned to the market labor profile identity;
  // profile drift (lazy loader resolving) forces a recompute, not a skewed delta.
  assert(uiSrc.includes('_dBaselineCmp.profile !== currentMarketLaborProfile'), 'profile-identity guard on the compare cache');
  assert((uiSrc.match(/profile: currentMarketLaborProfile/g) || []).length >= 2, 'cache stores the profile identity at compute time');
});

t('ui.js: D shell keeps the inspector across section nav; rail levers ride whatIfTransient', () => {
  assert(/if \(_useDShell\(\)\) \{[\s\S]{0,400}?refreshProvenancePanel\(\);[\s\S]{0,200}?\} else if \(section === 'summary'\)/.test(uiSrc),
    'section nav refreshes (not closes) the rail inspector under D shell');
  assert(uiSrc.includes('function _wireRailWhatIf'), 'wire helper exists');
  const wireBlock = uiSrc.slice(uiSrc.indexOf('function _wireRailWhatIf'), uiSrc.indexOf('function _wireRailWhatIf') + 2200);
  assert(wireBlock.includes('setWhatIfTransient({ ...whatIfTransient, [key]: v })'), 'rail levers write the SAME transient overlay as the studio');
  assert(wireBlock.includes('setWhatIfTransient({})'), 'reset clears the overlay');
});

// ---- 10. M5 slice 1: Labor is V2-only (Brock decision 2026-07-13) ----
t('ui.js: Labor V1 retired — no V1 renderer, no escape hatch, no V1 path', () => {
  assert(!/function renderLaborV1/.test(uiSrc), 'renderLaborV1 must stay deleted');
  assert(!/isCmV2UiOn\(\)/.test(uiSrc), 'COST_MODEL_V2_UI escape hatch must stay deleted');
  // M5-Operation: renderLabor branches D-shell → Operation face, classic →
  // V2. Either way there is NO V1 anywhere in the function body.
  assert(/function renderLabor\(\) \{[\s\S]{0,600}?return renderLaborV2\(\);\s*\}/.test(uiSrc), 'classic path still routes to V2');
  const rl = uiSrc.slice(uiSrc.indexOf('function renderLabor()'), uiSrc.indexOf('function renderLabor()') + 700);
  assert(!rl.includes('renderLaborV1'), 'no V1 call inside renderLabor (comments may mention the retirement)');
});

// ---- 11. M5-Operation: flow-as-face (2026-07-13) ----
t('whatIfKeysForCell: dl:/oparea: inherit the labor levers; static keys pass through', () => {
  assert(whatIfKeysForCell('dl:3') === WHATIF_BY_CELL.labor, 'dl:<idx> → labor levers');
  assert(whatIfKeysForCell('oparea:outbound') === WHATIF_BY_CELL.labor, 'oparea:<key> → labor levers');
  assert(whatIfKeysForCell('pb:each_pick') === WHATIF_BY_CELL.revenue, 'pb:<id> → pricing/revenue levers (M5-Price)');
  assert(whatIfKeysForCell('revenue') === WHATIF_BY_CELL.revenue, 'static key passes through');
  assert(Array.isArray(whatIfKeysForCell('nope')) && whatIfKeysForCell('nope').length === 0, 'unknown → []');
  assert(Array.isArray(whatIfKeysForCell(null)) && whatIfKeysForCell(null).length === 0, 'non-string → []');
});

t('ui.js: Operation face wired — D branch, area delegation, inspector-follow', () => {
  assert(/function renderLabor\(\) \{[\s\S]{0,600}?if \(_useDShell\(\)\) return renderOperationFace\(\);/.test(uiSrc),
    'renderLabor branches to the Operation face under the D shell');
  assert(uiSrc.includes('function renderOperationFace()'), 'face renderer exists');
  assert(uiSrc.includes("container.querySelectorAll('[data-op-area]')"), 'area-card delegation bound in bindSectionEvents');
  assert(uiSrc.includes("openProvenancePanel('dl:' + idx, 1)"), 'line select follows into the rail inspector');
  assert(uiSrc.includes("openProvenancePanel('oparea:' + key, 1)"), 'area select follows into the rail inspector');
  assert(uiSrc.includes('stationOp.renderFlowStrip'), 'face renders the flow strip from station-operation.js');
  assert(uiSrc.includes('stationOp.renderLinesTable'), 'face renders the lines table from station-operation.js');
  assert(uiSrc.includes('renderIndirectLaborBlock(opHrs, lc, totalIndirect)'), 'indirect block shared by both faces');
});

t('ui.js: _opSelectedArea resets in the PRE-renderCurrentView block (M4c ordering lesson)', () => {
  const loadIdx = uiSrc.indexOf('_opSelectedArea = null; // M5');
  assert(loadIdx > 0, 'per-project reset exists in the load path');
  const window2k = uiSrc.slice(loadIdx, loadIdx + 2000);
  const rcv = window2k.indexOf('renderCurrentView()');
  assert(rcv > 0, 'renderCurrentView follows the reset within the load block');
  assert(window2k.slice(0, rcv).includes('_activeProvCell = null'),
    'reset sits in the same pre-render block as the M4c inspector reset');
});

t('ui.js: dl:/oparea: provenance cells bypass the projections guard + rail levers use the helper', () => {
  assert(/const isOpKey = [^\n]*'dl:'[^\n]*'oparea:'[^\n]*/.test(uiSrc), 'guard bypass for Operation-face cells');
  assert(uiSrc.includes("rowKey.startsWith('dl:')"), 'dl: provenance branch exists');
  assert(uiSrc.includes("rowKey.startsWith('oparea:')"), 'oparea: provenance branch exists');
  assert(uiSrc.includes('shellD.whatIfKeysForCell(_activeProvCell.rowKey)'),
    'rail what-if resolves levers via whatIfKeysForCell, not the raw map');
});

// ---- 12. M6: progressive disclosure — Essentials/Engineering (2026-07-13) ----
const { ESSENTIALS_BY_STATION, sectionsForDepth, renderDSubnav } = shellD;

t('ESSENTIALS_BY_STATION: every station covered; every key is a real station section', () => {
  for (const st of D_STATIONS) {
    const ess = ESSENTIALS_BY_STATION[st.key];
    assert(Array.isArray(ess) && ess.length >= 1, `${st.key} has no essentials`);
    const phantom = ess.filter(k => !st.sections.includes(k));
    assert(phantom.length === 0, `${st.key} essentials not in station: ${phantom.join(',')}`);
  }
  // The retired Standard spine's coverage survives as essentials.
  const all = Object.values(ESSENTIALS_BY_STATION).flat();
  for (const k of ['setup', 'volumes', 'labor', 'facility', 'financial', 'summary']) {
    assert(all.includes(k), `std-spine section ${k} must stay essential`);
  }
});

t('sectionsForDepth: essentials curates; union rule keeps the active section visible', () => {
  const op = D_STATIONS.find(s => s.key === 'operation');
  assert(sectionsForDepth(op, 'engineering', 'labor').length === op.sections.length, 'engineering shows all');
  const ess = sectionsForDepth(op, 'essentials', 'labor');
  assert(ess.includes('labor') && !ess.includes('shiftPlanning'), 'essentials curates');
  const withActive = sectionsForDepth(op, 'essentials', 'equipment');
  assert(withActive.includes('equipment'), 'union rule: active non-essential stays visible');
});

t('renderDSubnav: depth filters pills + emits the depth toggle', () => {
  const opts = makeOpts();
  opts.depth = 'essentials';
  let html = renderDSubnav(opts);
  assert(html.includes('data-tc-section="labor"'), 'essential pill shown');
  assert(!html.includes('data-tc-section="flow"'), 'non-essential pill hidden at essentials depth');
  assert(html.includes('data-cmd-depth="essentials"') && html.includes('data-cmd-depth="engineering"'), 'depth toggle present');
  assert(/cmd-depth__opt--on"[^>]*data-cmd-depth="essentials"/.test(html), 'essentials marked active');
  opts.depth = 'engineering';
  html = renderDSubnav(opts);
  assert(html.includes('data-tc-section="flow"'), 'engineering shows everything');
  assert(/cmd-depth__opt--on"[^>]*data-cmd-depth="engineering"/.test(html), 'engineering marked active');
});

t('renderDSpine: essentials depth retargets station clicks to the first essential', () => {
  const opts = makeOpts();
  opts.depth = 'essentials';
  opts.lastVisited = {};
  const html = renderDSpine(opts);
  // Price's sections[0] is pricingBuckets; essentials lands on pricing.
  assert(/title="Price"/.test(html), 'price station rendered');
  assert(/data-tc-section="pricing"[^>]*title="Price"/.test(html), 'price station targets its first ESSENTIAL');
});

t('ui.js: std-* spine DELETED (M8b); stale keys migrate; depth pill owns tier', () => {
  assert(uiSrc.includes('const STD_MIGRATE'), 'stale-key migration map present');
  assert(/_migrateStaleStdKey\(\);/.test(uiSrc), 'migration runs before shell render');
  assert(!uiSrc.includes('STD_SECTIONS') && !/function renderStd/.test(uiSrc), 'std spine stays dead');
  assert(!uiSrc.includes("id: 'cm-tier'"), 'cm-tier action gone with the spine');
  assert(uiSrc.includes("e.target.closest('[data-cmd-depth]')"), 'depth-pill delegation bound');
  const depthBlock = uiSrc.slice(uiSrc.indexOf("closest('[data-cmd-depth]')"), uiSrc.indexOf("closest('[data-cmd-depth]')") + 420);
  assert(depthBlock.includes("tierSvc.setTier('cm'"), 'depth pill writes the SAME tier preference');
  assert(uiSrc.includes("depth: tierSvc.getTier('cm') === 'quick' ? 'essentials' : 'engineering'"),
    'depth derives from the tier service (one preference, one chrome)');
});

// ---- 2026-07-14 (Brock): assumptions pill must SURVIVE economics navigation ----
t('essentials: assumptions is an economics essential (pill no longer vanishes)', () => {
  assert(ESSENTIALS_BY_STATION.economics.includes('assumptions'),
    'assumptions missing from economics essentials');
  const econ = D_STATIONS.find(st => st.key === 'economics');
  // Active on financial (another economics pill) — assumptions must still
  // show. (Was 'facility' until it moved to Operation, 2026-07-16.)
  const vis = sectionsForDepth(econ, 'essentials', 'financial');
  assert(vis.includes('assumptions'), 'assumptions pill dropped when another economics section is active');
});

// ---- 2026-07-14 (Brock): Operation is flow-first; drop-to-connect retired ----
t('operation station: flow pill leads (define the flow, then staff it)', () => {
  const op = D_STATIONS.find(s => s.key === 'operation');
  // 2026-07-22 (Brock): facility sits directly after flow — the building is
  // flow's closest neighbor; labor follows.
  assert(op.sections[0] === 'flow' && op.sections[1] === 'facility' && op.sections[2] === 'labor',
    'order must be flow → facility → labor');
});

// ---- 2026-07-16 (Brock): facility rides Operation, not Economics ----
t('facility lives in Operation (before equipment); gone from Economics', () => {
  const op = D_STATIONS.find(s => s.key === 'operation');
  assert(op.sections.includes('facility'), 'operation owns facility');
  assert(op.sections.indexOf('facility') < op.sections.indexOf('equipment'), 'facility precedes equipment');
  const econ = D_STATIONS.find(s => s.key === 'economics');
  assert(!econ.sections.includes('facility'), 'economics no longer lists facility');
  assert(stationForSection('facility').key === 'operation', 'lookup follows');
  assert(ESSENTIALS_BY_STATION.operation.includes('facility'), 'facility stays essential (std Building coverage)');
});

t('ui.js: OFP drop-to-connect gesture retired — card drops MOVE the line', () => {
  assert(!uiSrc.includes('Connected on flow'), 'connect-on-drop handler must be gone');
  assert(uiSrc.includes('drop-to-connect RETIRED'), 'retirement documented at the bind site');
  assert(uiSrc.includes('Already in ${meta ? meta.label : targetArea}'), 'same-area drop toasts instead of silent no-op');
  const flowIdx = uiSrc.indexOf("{ key: 'flow',");
  const laborIdx = uiSrc.indexOf("{ key: 'labor',");
  assert(flowIdx !== -1 && laborIdx !== -1 && flowIdx < laborIdx, 'SECTIONS lists flow before labor');
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-shell-d: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
