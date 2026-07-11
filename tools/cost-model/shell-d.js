/**
 * cost-model/shell-d.js — M3: Concept D shell, behind an opt-in flag (2026-07-10).
 *
 * The blended chrome Brock signed off 2026-07-10: A's chassis (dark 5-station
 * spine with progress rings + station canvas + live P&L rail) + B's scenario
 * tab row with lifecycle chips. This module renders CHROME ONLY — it hosts
 * the EXISTING section renderers unchanged by emitting the same
 * data-tc-section / data-tc-action / data-tc-back attributes the shared
 * tool-chrome delegation (bindToolChromeEvents) already listens for, and by
 * providing the same #cm-section-content mount node renderSection() writes to.
 *
 * FLAG: tier-service pattern (Brock decision, M3 kickoff). Per-user
 * localStorage preference, classic chrome stays the default. Node-safe
 * in-memory fallback mirrors shared/tier.js so the pure suite can exercise it.
 *
 * Deferred by design: compare-vs-baseline toggle is INERT (M4 wires it to the
 * rail inspector); Review / Client-safe mode pills are INERT (M7 document
 * face); the rail's inspector zone is a hint panel until M4. The rail P&L
 * lines carry data-cm-cell/data-cm-year so the EXISTING provenance panel
 * (CM-PROV-1) answers clicks today.
 *
 * @module tools/cost-model/shell-d
 */

import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

// ─── Shell preference (tier-service pattern) ──────────────────────────────

const STORAGE_KEY = 'ies_cm_shell';
export const SHELLS = ['classic', 'd'];
const DEFAULT_SHELL = 'classic';

/** In-memory fallback so the module works under node (pure suite). */
const _mem = new Map();

function _store() {
  try {
    // Feature-probe, not mere presence (see shared/tier.js for the history:
    // node's experimental Web Storage stub exposes undefined methods).
    if (typeof localStorage !== 'undefined' && localStorage
        && typeof localStorage.getItem === 'function'
        && typeof localStorage.setItem === 'function') return localStorage;
  } catch { /* SecurityError in sandboxed embeds — fall through */ }
  return {
    getItem: (k) => (_mem.has(k) ? _mem.get(k) : null),
    setItem: (k, v) => { _mem.set(k, String(v)); },
  };
}

/** @returns {'classic'|'d'} current CM shell preference. */
export function getShellPref() {
  try {
    const v = _store().getItem(STORAGE_KEY);
    return SHELLS.includes(v) ? v : DEFAULT_SHELL;
  } catch { return DEFAULT_SHELL; }
}

/** Set the CM shell preference. Invalid values are ignored. */
export function setShellPref(shell) {
  if (!SHELLS.includes(shell)) return getShellPref();
  try { _store().setItem(STORAGE_KEY, shell); } catch {}
  return shell;
}

// ─── Station map: 21 Engineering sections → 5 causal stations ────────────
// Deal → Volume → Operation → Economics → Price. Every SECTIONS key must
// appear exactly once (test-cm-shell-d pins this against ui.js SECTIONS).

export const D_STATIONS = [
  { key: 'deal',      num: 1, name: 'Deal',      sections: ['setup', 'linked'] },
  { key: 'volume',    num: 2, name: 'Volume',    sections: ['volumes'] },
  { key: 'operation', num: 3, name: 'Operation',
    sections: ['labor', 'flow', 'shiftPlanning', 'shifts', 'equipment', 'vas', 'implementation'] },
  { key: 'economics', num: 4, name: 'Economics',
    sections: ['facility', 'overhead', 'startup', 'financial', 'assumptions', 'summary', 'timeline', 'whatif'] },
  { key: 'price',     num: 5, name: 'Price',     sections: ['pricingBuckets', 'pricing', 'scenarios'] },
];

/** @returns {Object|null} the station containing the given section key. */
export function stationForSection(sectionKey) {
  return D_STATIONS.find(st => st.sections.includes(sectionKey)) || null;
}

// ─── Chrome renderers ─────────────────────────────────────────────────────
//
// opts contract (assembled by ui.js _buildDShellOpts):
// {
//   chrome:        _buildCmChromeOpts() result (sections, actions, saveState, activeSection, sectionCompleteness fn)
//   modelName:     string
//   scenarioLabel: string, isBaseline: bool, scenarioStatus: string|null
//   stationSubs:   { deal, volume, operation, economics, price } one-line summaries
//   lastVisited:   { [stationKey]: sectionKey } — station click returns where you were
//   scenarioFamily: rows from listScenarioFamilyForProject (may be [])
//   activeProjectId: number|null
//   completeness:  { complete, total } — confidence card rollup
// }

const RING_CIRC = 78.5; // 2πr, r=12.5 — matches the signed-off mockup

function _stationProgress(st, completenessFn) {
  let score = 0;
  for (const key of st.sections) {
    const c = completenessFn ? completenessFn(key) : 'empty';
    if (c === 'complete') score += 1;
    else if (c === 'partial') score += 0.5;
  }
  return st.sections.length ? score / st.sections.length : 0;
}

function _statusChip(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'approved') return '<span class="cmd-st cmd-st--a">APPROVED</span>';
  if (s === 'review')   return '<span class="cmd-st cmd-st--r">REVIEW</span>';
  if (s === 'archived') return '<span class="cmd-st cmd-st--d">ARCHIVED</span>';
  return '<span class="cmd-st cmd-st--d">DRAFT</span>';
}

/** Scenario tab row (B). Real family rows; falls back to a single tab. */
export function renderDScenarioRow(opts) {
  const fam = Array.isArray(opts.scenarioFamily) ? opts.scenarioFamily : [];
  let tabs = '';
  if (fam.length) {
    tabs = fam.map(row => {
      const pid = row.project_id;
      const on = pid === opts.activeProjectId;
      const label = escapeHtml(row.scenario_label || (row.is_baseline ? 'Baseline' : 'Scenario'));
      const star = row.is_baseline ? '<span class="cmd-star">★</span> ' : '';
      return '<button class="cmd-stab' + (on ? ' cmd-stab--on' : '') + '" data-cmd-scen="' + escapeAttr(String(pid)) + '"'
        + ' title="' + (on ? 'Currently open' : 'Switch to this scenario') + '">'
        + star + label + ' ' + _statusChip(row.status) + '</button>';
    }).join('');
  } else {
    const label = escapeHtml(opts.scenarioLabel || 'Baseline');
    const star = opts.isBaseline ? '<span class="cmd-star">★</span> ' : '';
    tabs = '<button class="cmd-stab cmd-stab--on">' + star + label + ' '
      + _statusChip(opts.scenarioStatus) + '</button>';
  }
  return tabs
    + '<button class="cmd-stab cmd-stab--add" data-tc-section="scenarios" title="Scenario lifecycle — clone, review, approve">+</button>'
    + '<span class="cmd-cmp" title="Compare vs baseline — arrives with the rail inspector (M4)">'
    + 'Compare vs baseline <span class="cmd-toggle" aria-disabled="true"></span></span>';
}

/** Spine (A): 5 stations with progress rings + one-line subs. */
export function renderDSpine(opts) {
  const activeStation = stationForSection(opts.chrome.activeSection);
  const rows = D_STATIONS.map(st => {
    const on = activeStation && activeStation.key === st.key;
    const prog = _stationProgress(st, opts.chrome.sectionCompleteness);
    const dash = (prog * RING_CIRC).toFixed(1) + ' ' + RING_CIRC;
    const target = (opts.lastVisited && opts.lastVisited[st.key]) || st.sections[0];
    const sub = escapeHtml((opts.stationSubs && opts.stationSubs[st.key]) || '');
    return '<button class="cmd-station' + (on ? ' cmd-station--on' : '') + '" data-tc-section="' + escapeAttr(target) + '" title="' + escapeAttr(st.name) + '">'
      + '<span class="cmd-num"><svg viewBox="0 0 31 31" aria-hidden="true">'
      + '<circle class="cmd-track" cx="15.5" cy="15.5" r="12.5"></circle>'
      + '<circle class="cmd-prog" cx="15.5" cy="15.5" r="12.5" stroke-dasharray="' + dash + '"></circle>'
      + '</svg>' + st.num + '</span>'
      + '<span class="cmd-stmeta"><span class="cmd-stname">' + escapeHtml(st.name) + '</span>'
      + (sub ? '<span class="cmd-stsub">' + sub + '</span>' : '') + '</span>'
      + '</button>';
  }).join('');
  const c = opts.completeness || { complete: 0, total: 21 };
  const pct = c.total ? Math.round((c.complete / c.total) * 100) : 0;
  const conf = '<button class="cmd-conf" data-tc-section="assumptions" title="Open the assumptions register">'
    + '<span class="cmd-confring" style="background:conic-gradient(var(--c-success-ink,#15803d) 0 ' + pct + '%, #44403c ' + pct + '% 100%)"><b>' + pct + '</b></span>'
    + '<span><span class="cmd-conft">Build ' + pct + '%</span><span class="cmd-confs">' + c.complete + '/' + c.total + ' sections complete</span></span>'
    + '</button>';
  return '<div class="cmd-label">MODEL SPINE</div>' + rows + conf;
}

/** Center sub-nav: the active station's section pills (existing keys). */
export function renderDSubnav(opts) {
  const activeStation = stationForSection(opts.chrome.activeSection) || D_STATIONS[0];
  const secs = opts.chrome.sections.filter(s => activeStation.sections.includes(s.key));
  return secs.map(s => {
    const on = s.key === opts.chrome.activeSection;
    const c = opts.chrome.sectionCompleteness ? opts.chrome.sectionCompleteness(s.key) : 'empty';
    const dot = c === 'complete' ? 'cmd-dot--g' : (c === 'partial' ? 'cmd-dot--w' : '');
    return '<button class="cmd-pill' + (on ? ' cmd-pill--on' : '') + '" data-tc-section="' + escapeAttr(s.key) + '">'
      + '<span class="cmd-dot ' + dot + '"></span>' + escapeHtml(s.label) + '</button>';
  }).join('');
}

/** Top-bar save-state chip + crumb (dark-friendly). */
export function renderDTopMeta(opts) {
  const name = escapeHtml(opts.modelName || 'Untitled Model');
  const scen = opts.scenarioLabel
    ? '<span class="cmd-crumbscen">' + (opts.isBaseline ? '★ ' : '') + escapeHtml(opts.scenarioLabel) + '</span>'
    : '';
  const ss = opts.chrome.saveState || {};
  const chipCls = ss.state === 'saved' ? 'cmd-save--ok' : (ss.state === 'modified' ? 'cmd-save--mod' : 'cmd-save--draft');
  const chipLabel = ss.state === 'saved' ? 'Saved' : (ss.state === 'modified' ? 'Modified' : 'Draft');
  return '<span class="cmd-crumb"><b>' + name + '</b>' + scen + '</span>'
    + '<span class="cmd-savechip ' + chipCls + '" title="' + escapeAttr(ss.title || '') + '">● ' + chipLabel
    + (ss.when ? ' · ' + escapeHtml(ss.when) : '') + '</span>';
}

/** Rail P&L rows — values filled by updateDRail (surgical, no re-render). */
function _railRows() {
  const line = (key, label) =>
    '<div class="cmd-pl" data-cm-cell="' + key + '" data-cm-year="1" title="Click for provenance">'
    + '<span class="cmd-plnm">' + label + '</span>'
    + '<span class="cmd-plval" data-cmd-rail="' + key + '">—</span></div>';
  return line('revenue', 'Revenue')
    + line('labor', 'Direct + indirect labor')
    + line('facility', 'Facility & occupancy')
    + line('equipment', 'Equipment & automation')
    + line('overhead', 'Overhead')
    + line('vas', 'VAS')
    + line('startup', 'Start-up amort.');
}

/** Full D chrome. ui.js appends _cmExtraStyles() (provenance panel + form CSS). */
export function renderShellD(opts) {
  const actions = (opts.chrome.actions || []).map(a =>
    '<button class="cmd-btn' + (a.primary ? ' cmd-btn--primary' : '') + '" data-tc-action="' + escapeAttr(a.id) + '" title="' + escapeAttr(a.title || '') + '">'
    + escapeHtml(a.label) + '</button>').join('');

  return '' +
  '<div class="cmd-app" id="cmd-app">' +
    '<div class="cmd-top">' +
      '<button class="cmd-back" data-tc-back title="' + escapeAttr(opts.chrome.backTitle || 'Back') + '">←</button>' +
      '<span class="cmd-mark">CM</span><b class="cmd-title">Cost Model</b>' +
      '<span id="cmd-topmeta">' + renderDTopMeta(opts) + '</span>' +
      '<span class="cmd-mode"><span class="cmd-mode--on">Model</span>' +
      '<span class="cmd-mode--off" title="Review mode — the document face arrives in M7">Review</span>' +
      '<span class="cmd-mode--off" title="Client-safe export view — arrives in M7">Client-safe</span></span>' +
      '<span class="cmd-spacer"></span>' +
      actions +
    '</div>' +
    '<div class="cmd-scen" id="cmd-scen">' + renderDScenarioRow(opts) + '</div>' +
    '<div class="cmd-spine" id="cmd-spine">' + renderDSpine(opts) + '</div>' +
    '<div class="cmd-center">' +
      '<div class="cmd-subnav" id="cmd-subnav">' + renderDSubnav(opts) + '</div>' +
      '<div class="hub-builder-form" id="cm-section-content"></div>' +
    '</div>' +
    '<aside class="cmd-rail" id="cmd-rail">' +
      '<div class="cmd-plz">' +
        '<div class="cmd-rt"><h2>P&amp;L — Year 1</h2><span class="cmd-live">LIVE</span></div>' +
        _railRows() +
        '<div class="cmd-pltotal">' +
          '<div class="cmd-plr"><span>Total cost</span><b data-cmd-rail="totalCost">—</b></div>' +
          '<div class="cmd-plr"><span data-cmd-rail="cpuLabel">Cost / unit</span><b data-cmd-rail="costPerUnit">—</b></div>' +
          '<div class="cmd-plr cmd-plr--big"><span>Gross margin</span><b><span data-cmd-rail="gm">—</span> <small data-cmd-rail="gmDelta"></small></b></div>' +
        '</div>' +
      '</div>' +
      '<div class="cmd-iz">' +
        '<div class="cmd-izk">INSPECTOR</div>' +
        '<p class="cmd-izhint">Click any P&amp;L line above for its provenance chain. ' +
        'The full follow-your-selection inspector (per-object what-if, source pills, tornado) lands in the next milestone.</p>' +
      '</div>' +
    '</aside>' +
  '</div>' +
  _dStyles();
}

/**
 * Surgical chrome refresh — spine, sub-nav, scenario row, top meta. Never
 * touches #cm-section-content (focus-loss class) or the rail values.
 */
export function refreshShellD(rootEl, opts) {
  if (!rootEl) return;
  const spine = rootEl.querySelector('#cmd-spine');
  if (spine) spine.innerHTML = renderDSpine(opts);
  const subnav = rootEl.querySelector('#cmd-subnav');
  if (subnav) subnav.innerHTML = renderDSubnav(opts);
  const scen = rootEl.querySelector('#cmd-scen');
  if (scen) scen.innerHTML = renderDScenarioRow(opts);
  const meta = rootEl.querySelector('#cmd-topmeta');
  if (meta) meta.innerHTML = renderDTopMeta(opts);
}

/**
 * Live P&L rail update. data is a plain values bag (ui.js derives it from
 * computeAll's memoized result — Y1 projection row + summary):
 * { revenue, labor, facility, equipment, overhead, vas, startup,
 *   totalCost, costPerUnit, uomLabel, gmPct, targetPct, ready }
 */
export function updateDRail(rootEl, data) {
  if (!rootEl) return;
  const rail = rootEl.querySelector('#cmd-rail');
  if (!rail) return;
  const fmt = (v) => {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
    if (abs >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  };
  const set = (key, text) => {
    const el = rail.querySelector('[data-cmd-rail="' + key + '"]');
    if (el) el.textContent = text;
  };
  if (!data || !data.ready) {
    ['revenue','labor','facility','equipment','overhead','vas','startup','totalCost','costPerUnit'].forEach(k => set(k, '—'));
    set('gm', '—'); set('gmDelta', '');
    return;
  }
  set('revenue', fmt(data.revenue));
  set('labor', fmt(data.labor));
  set('facility', fmt(data.facility));
  set('equipment', fmt(data.equipment));
  set('overhead', fmt(data.overhead));
  set('vas', fmt(data.vas));
  set('startup', fmt(data.startup));
  set('totalCost', fmt(data.totalCost));
  set('cpuLabel', 'Cost / ' + (data.uomLabel || 'unit'));
  set('costPerUnit', Number.isFinite(data.costPerUnit)
    ? '$' + data.costPerUnit.toFixed(data.costPerUnit < 10 ? 2 : 0) : '—');
  set('gm', Number.isFinite(data.gmPct) ? data.gmPct.toFixed(1) + '%' : '—');
  const d = (Number.isFinite(data.gmPct) && Number.isFinite(data.targetPct))
    ? data.gmPct - data.targetPct : null;
  set('gmDelta', d == null ? ''
    : (d >= 0 ? 'meets target ✓' : d.toFixed(1) + ' vs target'));
}

// ─── Styles (scoped .cmd-*) ───────────────────────────────────────────────

function _dStyles() {
  return '<style>' +
  '.cmd-app{display:grid;grid-template-columns:212px minmax(0,1fr) 318px;grid-template-rows:46px 38px minmax(0,1fr);height:calc(100vh - 45px);background:var(--ies-gray-50,#fafaf9);}' +
  /* top bar */
  '.cmd-top{grid-column:1/4;display:flex;align-items:center;gap:10px;background:var(--ies-gray-900,#1c1917);color:#d6d3d1;padding:0 12px;min-width:0;}' +
  '.cmd-back{background:transparent;border:1px solid #44403c;color:#d6d3d1;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:13px;}' +
  '.cmd-back:hover{background:#292524;}' +
  '.cmd-mark{width:24px;height:24px;border-radius:6px;background:var(--ies-orange,#ff3a00);display:grid;place-items:center;color:#fff;font-weight:700;font-size:10px;flex:none;}' +
  '.cmd-title{color:#fff;font-size:13px;white-space:nowrap;}' +
  '.cmd-crumb{font-size:12px;color:#a8a29e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;}' +
  '.cmd-crumb b{color:#e7e5e4;font-weight:600;}' +
  '.cmd-crumbscen{margin-left:8px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:#292524;border:1px solid #44403c;border-radius:8px;padding:2px 7px;color:#d6d3d1;}' +
  '.cmd-savechip{font-size:10.5px;font-weight:600;border-radius:99px;padding:3px 9px;margin-left:6px;white-space:nowrap;}' +
  '.cmd-save--ok{background:rgba(21,128,61,.18);color:#4ade80;}' +
  '.cmd-save--mod{background:rgba(180,83,9,.2);color:#fbbf24;}' +
  '.cmd-save--draft{background:#292524;color:#a8a29e;}' +
  '.cmd-mode{display:flex;background:#292524;border-radius:999px;padding:3px;margin-left:4px;flex:none;}' +
  '.cmd-mode span{font-size:10.5px;font-weight:600;padding:3.5px 11px;border-radius:999px;}' +
  '.cmd-mode--on{background:var(--ies-orange,#ff3a00);color:#fff;}' +
  '.cmd-mode--off{color:#78716c;cursor:not-allowed;}' +
  '.cmd-spacer{flex:1;}' +
  '.cmd-btn{font-size:12px;font-weight:600;border-radius:8px;border:1px solid #44403c;background:transparent;color:#d6d3d1;padding:5px 12px;cursor:pointer;white-space:nowrap;}' +
  '.cmd-btn:hover{background:#292524;}' +
  '.cmd-btn--primary{background:var(--ies-orange,#ff3a00);border-color:var(--ies-orange,#ff3a00);color:#fff;}' +
  /* scenario row */
  '.cmd-scen{grid-column:1/4;display:flex;align-items:flex-end;gap:2px;background:var(--ies-gray-900,#1c1917);padding:0 12px;border-bottom:1px solid var(--ies-gray-200,#e7e5e4);overflow-x:auto;}' +
  '.cmd-stab{display:flex;align-items:center;gap:7px;background:#292524;color:#d6d3d1;border:none;border-radius:9px 9px 0 0;padding:8px 14px 7px;font-size:12px;cursor:pointer;white-space:nowrap;}' +
  '.cmd-stab--on{background:var(--ies-gray-50,#fafaf9);color:var(--ies-gray-900,#1c1917);font-weight:600;}' +
  '.cmd-stab--add{background:none;color:#78716c;font-size:15px;padding:7px 9px;border-radius:9px;}' +
  '.cmd-star{color:var(--ies-orange,#ff3a00);}' +
  '.cmd-st{font-size:8.5px;font-weight:700;letter-spacing:.06em;border-radius:99px;padding:1.5px 6px;}' +
  '.cmd-st--d{background:#44403c;color:#d6d3d1;}.cmd-stab--on .cmd-st--d{background:var(--ies-gray-200,#e7e5e4);color:var(--ies-gray-600,#57534e);}' +
  '.cmd-st--r{background:rgba(180,83,9,.18);color:#fbbf24;}.cmd-stab--on .cmd-st--r{background:#fffbeb;color:#b45309;}' +
  '.cmd-st--a{background:rgba(21,128,61,.18);color:#4ade80;}.cmd-stab--on .cmd-st--a{background:#f0fdf4;color:#15803d;}' +
  '.cmd-cmp{margin-left:auto;display:flex;align-items:center;gap:7px;color:#78716c;font-size:11.5px;padding:0 4px 7px;white-space:nowrap;cursor:not-allowed;}' +
  '.cmd-toggle{width:30px;height:17px;border-radius:99px;background:#44403c;position:relative;display:inline-block;}' +
  '.cmd-toggle::after{content:"";position:absolute;width:13px;height:13px;border-radius:50%;background:#78716c;top:2px;left:2px;}' +
  /* spine */
  '.cmd-spine{background:var(--ies-gray-900,#1c1917);color:#d6d3d1;padding:13px 9px;display:flex;flex-direction:column;gap:3px;overflow-y:auto;}' +
  '.cmd-label{font-size:10px;font-weight:600;letter-spacing:.09em;color:#78716c;padding:0 10px 7px;}' +
  '.cmd-station{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;border:none;border-left:3px solid transparent;background:transparent;color:#d6d3d1;text-align:left;width:100%;}' +
  '.cmd-station:hover{background:#292524;}' +
  '.cmd-station--on{background:rgba(255,58,0,.12);border-left-color:var(--ies-orange,#ff3a00);}' +
  '.cmd-station--on .cmd-stname{color:#fff;}' +
  '.cmd-num{width:25px;height:25px;border-radius:50%;display:grid;place-items:center;font-size:10.5px;font-weight:700;flex:none;position:relative;color:#e7e5e4;}' +
  '.cmd-num svg{position:absolute;inset:-3px;width:31px;height:31px;transform:rotate(-90deg);}' +
  '.cmd-num circle{fill:none;stroke-width:2.5;}' +
  '.cmd-track{stroke:#3f3a36;}' +
  '.cmd-prog{stroke:var(--c-success-ink,#15803d);stroke-linecap:round;}' +
  '.cmd-station--on .cmd-prog{stroke:var(--ies-orange,#ff3a00);}' +
  '.cmd-stmeta{display:flex;flex-direction:column;min-width:0;}' +
  '.cmd-stname{font-size:12.5px;font-weight:600;color:#d6d3d1;}' +
  '.cmd-stsub{font-size:10px;color:#78716c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:126px;}' +
  '.cmd-conf{margin-top:auto;background:#292524;border:none;border-radius:10px;padding:10px 12px;font-size:11px;color:#a8a29e;cursor:pointer;display:flex;align-items:center;gap:8px;text-align:left;width:100%;}' +
  '.cmd-confring{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex:none;position:relative;}' +
  '.cmd-confring::after{content:"";width:16px;height:16px;background:#292524;border-radius:50%;position:absolute;}' +
  '.cmd-confring b{position:relative;z-index:1;font-size:8px;color:#fff;}' +
  '.cmd-conft{display:block;color:#d6d3d1;font-weight:600;font-size:11.5px;}' +
  '.cmd-confs{display:block;font-size:10px;color:#78716c;}' +
  /* center */
  '.cmd-center{overflow-y:auto;padding:14px 22px 60px;min-width:0;}' +
  '.cmd-subnav{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px;}' +
  '.cmd-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;border:1px solid var(--ies-gray-200,#e7e5e4);background:#fff;color:var(--ies-gray-600,#57534e);border-radius:999px;padding:4.5px 12px;cursor:pointer;}' +
  '.cmd-pill:hover{border-color:var(--ies-orange,#ff3a00);}' +
  '.cmd-pill--on{background:var(--ies-gray-900,#1c1917);border-color:var(--ies-gray-900,#1c1917);color:#fff;}' +
  '.cmd-dot{width:6px;height:6px;border-radius:50%;background:var(--ies-gray-300,#d6d3d1);flex:none;}' +
  '.cmd-dot--g{background:var(--c-success-ink,#15803d);}' +
  '.cmd-dot--w{background:var(--c-warn-ink,#b45309);}' +
  '.cmd-pill--on .cmd-dot{background:rgba(255,255,255,.55);}' +
  '.cmd-pill--on .cmd-dot--g{background:#4ade80;}.cmd-pill--on .cmd-dot--w{background:#fbbf24;}' +
  /* rail */
  '.cmd-rail{background:#fff;border-left:1px solid var(--ies-gray-200,#e7e5e4);display:flex;flex-direction:column;overflow:hidden;}' +
  '.cmd-plz{padding:13px 15px 10px;overflow-y:auto;flex:none;max-height:62%;}' +
  '.cmd-rt{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;}' +
  '.cmd-rt h2{font-family:var(--font-display,Georgia,serif);font-size:14.5px;font-weight:700;margin:0;color:var(--ies-gray-900,#1c1917);}' +
  '.cmd-live{margin-left:auto;font-size:9.5px;color:var(--c-success-ink,#15803d);font-weight:600;display:flex;align-items:center;gap:4px;}' +
  '.cmd-live::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--c-success-ink,#15803d);animation:cmdpulse 2s infinite;}' +
  '@keyframes cmdpulse{50%{opacity:.35}}' +
  '.cmd-pl{display:flex;justify-content:space-between;gap:8px;padding:5.5px 7px;border-radius:7px;cursor:pointer;align-items:center;}' +
  '.cmd-pl:hover{background:var(--ies-gray-50,#fafaf9);}' +
  '.cmd-plnm{font-size:11.5px;color:var(--ies-gray-600,#57534e);}' +
  '.cmd-plval{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ies-gray-900,#1c1917);}' +
  '.cmd-pltotal{margin:7px 0 4px;padding:9px 10px;border-radius:10px;background:var(--ies-gray-900,#1c1917);color:#fff;}' +
  '.cmd-plr{display:flex;justify-content:space-between;font-size:11.5px;padding:2px 0;color:#d6d3d1;}' +
  '.cmd-plr b{color:#fff;font-variant-numeric:tabular-nums;}' +
  '.cmd-plr--big b{font-family:var(--font-display,Georgia,serif);font-size:15px;}' +
  '.cmd-plr--big small{font-size:10px;color:#fbbf24;font-family:inherit;}' +
  '.cmd-iz{border-top:1px solid var(--ies-gray-200,#e7e5e4);flex:1;overflow-y:auto;background:var(--ies-gray-50,#fafaf9);padding:11px 15px;}' +
  '.cmd-izk{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--ies-gray-400,#a8a29e);margin-bottom:5px;}' +
  '.cmd-izhint{font-size:11.5px;color:var(--ies-gray-600,#57534e);line-height:1.55;margin:0;}' +
  /* narrow screens: collapse the rail under the center column */
  '@media (max-width:1180px){.cmd-app{grid-template-columns:200px minmax(0,1fr);}.cmd-rail{display:none;}}' +
  '</style>';
}
