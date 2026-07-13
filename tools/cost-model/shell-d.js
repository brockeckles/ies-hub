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
 * M4 (2026-07-13) — the rail inspector is LIVE: the inspector zone under the
 * P&L hosts the CM-PROV-1 provenance content (ui.js routes
 * refreshProvenancePanel into #cmd-izbody under this shell), plus a
 * per-object quick what-if section (WHATIF_BY_CELL maps each P&L line to its
 * relevant What-If Studio levers, riding the same whatIfTransient overlay),
 * plus the compare-vs-baseline toggle (inline Δ vs the family's ★ baseline
 * on every rail row — ui.js computes the baseline Y1 via
 * computeWhatIfPreview and passes it as data.compare to updateDRail).
 *
 * Deferred by design: Review / Client-safe mode pills are INERT (M7 document
 * face). This module stays render-only — no event binding here; all events
 * ride ui.js's existing rootEl delegation (bind-once guarded).
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
  // M4 — live compare-vs-baseline toggle. Available only when the family has
  // a ★ baseline AND the open project is a child (comparing baseline to
  // itself is a zero row). Click handling rides ui.js's scenario-row
  // delegation via data-cmd-cmp.
  const baseRow = fam.find(r => r.is_baseline);
  const baseLabel = escapeAttr(String(baseRow?.scenario_label || 'Baseline'));
  const canCompare = !!(baseRow && baseRow.project_id !== opts.activeProjectId);
  const cmp = canCompare
    ? '<button type="button" class="cmd-cmp cmd-cmp--live" data-cmd-cmp aria-pressed="' + (opts.compareOn ? 'true' : 'false') + '"'
      + ' title="' + (opts.compareOn
        ? 'Comparing against ★ ' + baseLabel + ' — click to turn off'
        : 'Show inline Δ vs ★ ' + baseLabel + ' on the P&L rail') + '">'
      + 'Compare vs baseline <span class="cmd-toggle' + (opts.compareOn ? ' cmd-toggle--on' : '') + '"></span></button>'
    : '<span class="cmd-cmp" title="' + (baseRow
        ? 'This is the ★ baseline — open a child scenario to compare against it'
        : 'No baseline scenario in this family yet') + '">'
      + 'Compare vs baseline <span class="cmd-toggle" aria-disabled="true"></span></span>';
  return tabs
    + '<button class="cmd-stab cmd-stab--add" data-tc-section="scenarios" title="Scenario lifecycle — clone, review, approve">+</button>'
    + cmp;
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

/** The 7 rail P&L line keys, in render order. Exported so tests can pin
 *  WHATIF_BY_CELL coverage against the actual rows. */
export const RAIL_ROW_KEYS = ['revenue', 'labor', 'facility', 'equipment', 'overhead', 'vas', 'startup'];

/** Rail P&L rows — values filled by updateDRail (surgical, no re-render).
 *  M4: each row carries a compare-delta slot (data-cmd-railc) that
 *  updateDRail fills when compare-vs-baseline is on. */
function _railRows() {
  const line = (key, label) =>
    '<div class="cmd-pl" data-cm-cell="' + key + '" data-cm-year="1" title="Click for provenance">'
    + '<span class="cmd-plnm">' + label + '</span>'
    + '<span class="cmd-plv"><span class="cmd-plval" data-cmd-rail="' + key + '">—</span>'
    + '<small class="cmd-plc" data-cmd-railc="' + key + '"></small></span></div>';
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
        '<div class="cmd-rt"><h2>P&amp;L — Year 1</h2><span class="cmd-cmpbadge" data-cmd-rail="cmpBadge"></span><span class="cmd-live">LIVE</span></div>' +
        _railRows() +
        '<div class="cmd-pltotal">' +
          '<div class="cmd-plr"><span>Total cost</span><b><span data-cmd-rail="totalCost">—</span><small class="cmd-plc" data-cmd-railc="totalCost"></small></b></div>' +
          '<div class="cmd-plr"><span data-cmd-rail="cpuLabel">Cost / unit</span><b data-cmd-rail="costPerUnit">—</b></div>' +
          '<div class="cmd-plr cmd-plr--big"><span>Gross margin</span><b><span data-cmd-rail="gm">—</span> <small data-cmd-rail="gmDelta"></small><small class="cmd-plc" data-cmd-railc="gmPct"></small></b></div>' +
        '</div>' +
      '</div>' +
      '<div class="cmd-iz">' +
        '<div class="cmd-izk">INSPECTOR</div>' +
        // M4 — ui.js refreshProvenancePanel() routes the CM-PROV-1 content
        // (plus the per-object quick what-if) into this body under the D
        // shell. The hint below is the empty-selection state.
        '<div id="cmd-izbody">' +
        '<p class="cmd-izhint">Click any P&amp;L line above — or any Summary cell or KPI tile — ' +
        'for its provenance chain and quick what-if levers for that line.</p>' +
        '</div>' +
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
 *
 * M4 — optional data.compare = the ★ baseline's Y1 bag
 * ({ label, revenue…startup, totalCost, gmPct }, computed once by ui.js via
 * computeWhatIfPreview on the baseline project). When present, every row's
 * data-cmd-railc slot gets an inline Δ (current − baseline), colored by
 * whether the delta is favorable: revenue/GM up = good, costs up = bad.
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
  // M4 — compare-delta slots. Sets text + favorability class together so a
  // cleared slot never keeps a stale color.
  const setCmp = (key, text, cls) => {
    const el = rail.querySelector('[data-cmd-railc="' + key + '"]');
    if (!el) return;
    el.textContent = text;
    el.className = 'cmd-plc' + (cls ? ' ' + cls : '');
  };
  const clearCmp = () => {
    ['revenue','labor','facility','equipment','overhead','vas','startup','totalCost','gmPct'].forEach(k => setCmp(k, ''));
    set('cmpBadge', '');
  };
  if (!data || !data.ready) {
    ['revenue','labor','facility','equipment','overhead','vas','startup','totalCost','costPerUnit'].forEach(k => set(k, '—'));
    set('gm', '—'); set('gmDelta', '');
    clearCmp();
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

  // M4 — inline compare deltas vs the ★ baseline. dir: +1 = higher is
  // favorable (revenue), −1 = lower is favorable (every cost row).
  const cmp = data.compare;
  if (!cmp) { clearCmp(); return; }
  set('cmpBadge', 'Δ vs ★ ' + (cmp.label || 'Baseline'));
  const CMP_DIR = [['revenue', 1], ['labor', -1], ['facility', -1], ['equipment', -1],
    ['overhead', -1], ['vas', -1], ['startup', -1], ['totalCost', -1]];
  for (const [k, dir] of CMP_DIR) {
    const cur = data[k], base = cmp[k];
    if (!Number.isFinite(cur) || !Number.isFinite(base)) { setCmp(k, ''); continue; }
    const dd = cur - base;
    if (Math.abs(dd) < 500) { setCmp(k, '= base', 'cmd-plc--eq'); continue; }
    setCmp(k, (dd > 0 ? '▲ +' : '▼ −') + fmt(Math.abs(dd)),
      (dd * dir > 0) ? 'cmd-plc--good' : 'cmd-plc--bad');
  }
  if (Number.isFinite(data.gmPct) && Number.isFinite(cmp.gmPct)) {
    const gd = data.gmPct - cmp.gmPct;
    setCmp('gmPct', (gd >= 0 ? '+' : '−') + Math.abs(gd).toFixed(1) + 'pp vs base',
      gd >= 0 ? 'cmd-plc--good' : 'cmd-plc--bad');
  } else { setCmp('gmPct', ''); }
}

// ─── M4: per-object quick what-if (rail inspector) ────────────────────────
//
// Maps every provenance cell key to the What-If Studio levers that actually
// move that line, so the rail inspector can offer "the sliders for THIS
// selection" instead of the full 17-lever studio. Keys must exist in ui.js
// WHATIF_SLIDERS — test-cm-shell-d pins this against drift. Escalation
// levers move years 2+ (the Y1 rail line holds still) — their feedback
// surface is the per-lever Δ NI chip, which is horizon-total.
export const WHATIF_BY_CELL = {
  // Rail rows (Y1 P&L)
  revenue:   ['pricing_discount_pct', 'annual_volume_growth_pct', 'target_margin_pct'],
  labor:     ['direct_labor_productivity_pct', 'overtime_pct', 'absence_allowance_pct', 'temp_share_delta_pp'],
  facility:  ['facility_escalation_pct'],
  equipment: ['equipment_escalation_pct'],
  overhead:  ['cost_escalation_pct'],
  vas:       ['annual_volume_growth_pct'],
  startup:   [],
  // Summary P&L rows (same inspector, clicked from the Summary table)
  orders:    ['annual_volume_growth_pct'],
  cogs:      ['direct_labor_productivity_pct', 'annual_volume_growth_pct'],
  grossProfit: ['pricing_discount_pct', 'target_margin_pct', 'direct_labor_productivity_pct'],
  sga:       ['cost_escalation_pct'],
  ebitda:    ['pricing_discount_pct', 'annual_volume_growth_pct', 'labor_escalation_pct'],
  depreciation: [],
  ebit:      ['pricing_discount_pct', 'equipment_escalation_pct'],
  taxes:     ['tax_rate_pct'],
  netIncome: ['tax_rate_pct', 'pricing_discount_pct', 'target_margin_pct'],
  capex:     [],
  workingCapitalChange: ['dso_days', 'dpo_days'],
  freeCashFlow: ['dso_days', 'dpo_days', 'tax_rate_pct'],
  cumFcf:    ['dso_days', 'dpo_days', 'discount_rate_pct'],
};

/**
 * M5-Operation — resolve the quick what-if levers for ANY inspector cell,
 * including the Operation face's prefixed keys: dl:<idx> (labor-line
 * drill-in) and oparea:<key> (flow area) inherit the labor levers, since
 * every one of those objects is a labor-cost object. Static keys fall
 * through to WHATIF_BY_CELL.
 */
export function whatIfKeysForCell(rowKey) {
  if (typeof rowKey !== 'string') return [];
  if (rowKey.startsWith('dl:') || rowKey.startsWith('oparea:')) return WHATIF_BY_CELL.labor;
  return WHATIF_BY_CELL[rowKey] || [];
}

/**
 * Per-object quick what-if section for the rail inspector. Pure render —
 * ui.js assembles the rows (current values via whatIfCurrentValue, source
 * via whatIfSource, isolated Δ NI impact via computeWhatIfPreview) and
 * wires the inputs after mount.
 *
 * @param {Array<{key,label,min,max,step,unit,value,src,impact:{good,text}|null}>} rows
 * @param {{anyLive?:boolean}} [opts] — anyLive shows the reset action
 * @returns {string} HTML ('' when no rows — startup amort has no lever)
 */
export function railWhatIfSection(rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const items = rows.map(r => {
    const badge = r.src === 'transient'
      ? '<span class="cmd-wisrc cmd-wisrc--live">live</span>'
      : (r.src === 'override' ? '<span class="cmd-wisrc">override</span>' : '');
    const chip = r.impact
      ? '<span class="cmd-wichip ' + (r.impact.good ? 'cmd-wichip--good' : 'cmd-wichip--bad') + '">'
        + escapeHtml(r.impact.text) + '</span>'
      : '';
    const k = escapeAttr(String(r.key));
    return '<div class="cmd-wirow">'
      + '<div class="cmd-wihead">'
      + '<span class="cmd-wilabel">' + escapeHtml(r.label) + '</span>' + badge + chip
      + '<span class="cmd-wival"><input type="number" step="' + escapeAttr(String(r.step)) + '" min="' + escapeAttr(String(r.min)) + '" max="' + escapeAttr(String(r.max)) + '"'
      + ' value="' + escapeAttr(String(r.value)) + '" data-cmd-izn="' + k + '">'
      + '<span class="cmd-wiunit">' + escapeHtml(r.unit) + '</span></span>'
      + '</div>'
      + '<input type="range" min="' + escapeAttr(String(r.min)) + '" max="' + escapeAttr(String(r.max)) + '" step="' + escapeAttr(String(r.step)) + '"'
      + ' value="' + escapeAttr(String(r.value)) + '" data-cmd-izs="' + k + '">'
      + '</div>';
  }).join('');
  return '<div class="cmd-wiz">'
    + '<div class="cmd-wik">QUICK WHAT-IF — THIS LINE</div>'
    + items
    + '<div class="cmd-winote">Transient preview — nothing saves. '
    + '<button type="button" class="cmd-wilink" data-tc-section="whatif">Open What-If Studio</button>'
    + (opts.anyLive ? ' · <button type="button" class="cmd-wilink" data-cmd-izreset>Reset all levers</button>' : '')
    + '</div></div>';
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
  '.cmd-cmp{margin-left:auto;display:flex;align-items:center;gap:7px;color:#78716c;font-size:11.5px;padding:0 4px 7px;white-space:nowrap;cursor:not-allowed;background:none;border:none;}' +
  '.cmd-cmp--live{cursor:pointer;color:#d6d3d1;}' +
  '.cmd-cmp--live:hover{color:#fff;}' +
  '.cmd-toggle{width:30px;height:17px;border-radius:99px;background:#44403c;position:relative;display:inline-block;transition:background .15s ease;}' +
  '.cmd-toggle::after{content:"";position:absolute;width:13px;height:13px;border-radius:50%;background:#78716c;top:2px;left:2px;transition:left .15s ease,background .15s ease;}' +
  '.cmd-toggle--on{background:var(--ies-orange,#ff3a00);}' +
  '.cmd-toggle--on::after{left:15px;background:#fff;}' +
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
  '.cmd-plv{display:flex;flex-direction:column;align-items:flex-end;}' +
  '.cmd-plval{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ies-gray-900,#1c1917);}' +
  /* M4 — compare-vs-baseline delta slots + badge */
  '.cmd-plc{display:block;font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3;}' +
  '.cmd-plc:empty{display:none;}' +
  '.cmd-plc--good{color:var(--c-success-ink,#15803d);}' +
  '.cmd-pltotal .cmd-plc--good{color:#4ade80;}' +
  '.cmd-plc--bad{color:#dc2626;}' +
  '.cmd-pltotal .cmd-plc--bad{color:#f87171;}' +
  '.cmd-plc--eq{color:var(--ies-gray-400,#a8a29e);}' +
  '.cmd-cmpbadge{font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:1.5px 7px;}' +
  '.cmd-cmpbadge:empty{display:none;}' +
  '.cmd-pltotal .cmd-plr b{text-align:right;}' +
  '.cmd-pltotal{margin:7px 0 4px;padding:9px 10px;border-radius:10px;background:var(--ies-gray-900,#1c1917);color:#fff;}' +
  '.cmd-plr{display:flex;justify-content:space-between;font-size:11.5px;padding:2px 0;color:#d6d3d1;}' +
  '.cmd-plr b{color:#fff;font-variant-numeric:tabular-nums;}' +
  '.cmd-plr--big b{font-family:var(--font-display,Georgia,serif);font-size:15px;}' +
  '.cmd-plr--big small{font-size:10px;color:#fbbf24;font-family:inherit;}' +
  '.cmd-iz{border-top:1px solid var(--ies-gray-200,#e7e5e4);flex:1;overflow-y:auto;background:var(--ies-gray-50,#fafaf9);padding:11px 15px;}' +
  '.cmd-izk{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--ies-gray-400,#a8a29e);margin-bottom:5px;}' +
  '.cmd-izhint{font-size:11.5px;color:var(--ies-gray-600,#57534e);line-height:1.55;margin:0;}' +
  /* M4 — inspector body hosts the CM-PROV-1 content (its own inline styles)
     inside the rail; trim the panel-sized paddings down to rail scale. */
  '#cmd-izbody{margin:0 -15px;}' +
  '#cmd-izbody>p.cmd-izhint{margin:0 15px;}' +
  /* per-object quick what-if */
  '.cmd-wiz{padding:12px 16px;border-top:1px solid var(--ies-gray-200,#e7e5e4);background:#fff;}' +
  '.cmd-wik{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--ies-gray-500,#78716c);margin-bottom:8px;}' +
  '.cmd-wirow{margin-bottom:10px;}' +
  '.cmd-wihead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}' +
  '.cmd-wilabel{font-size:11.5px;font-weight:600;color:var(--ies-gray-800,#292524);}' +
  '.cmd-wisrc{font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:8px;padding:1px 6px;background:var(--ies-gray-100,#f5f5f4);color:var(--ies-gray-600,#57534e);}' +
  '.cmd-wisrc--live{background:var(--c-info-soft,#eff6ff);color:var(--c-info-ink,#1d4ed8);}' +
  '.cmd-wichip{font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;}' +
  '.cmd-wichip--good{color:var(--c-success-ink,#15803d);}' +
  '.cmd-wichip--bad{color:#dc2626;}' +
  '.cmd-wival{margin-left:auto;display:flex;align-items:center;gap:3px;}' +
  '.cmd-wival input{width:52px;font-size:11.5px;text-align:right;padding:1px 4px;border:1px solid var(--ies-gray-200,#e7e5e4);border-radius:5px;}' +
  '.cmd-wiunit{font-size:10px;color:var(--ies-gray-400,#a8a29e);min-width:18px;}' +
  '.cmd-wirow input[type=range]{width:100%;margin-top:3px;accent-color:var(--ies-orange,#ff3a00);}' +
  '.cmd-winote{font-size:10px;color:var(--ies-gray-500,#78716c);margin-top:2px;}' +
  '.cmd-wilink{background:none;border:none;padding:0;font-size:10px;color:var(--c-info-ink,#1d4ed8);cursor:pointer;text-decoration:underline;}' +
  /* narrow screens: collapse the rail under the center column */
  '@media (max-width:1180px){.cmd-app{grid-template-columns:200px minmax(0,1fr);}.cmd-rail{display:none;}}' +
  '</style>';
}
