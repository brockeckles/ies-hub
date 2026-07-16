/**
 * IES Hub v3 — WSC Station-Spine Shell (W2 of the UX redesign, 2026-07-15)
 *
 * Concept D — Blended (Brock sign-off 2026-07-15): A's chassis hosting the
 * EXISTING WSC renderers unchanged. The shell emits the same contract the
 * classic chrome does — [data-tc-section] pills, [data-tc-action] buttons,
 * [data-tc-back], a #wsc-config node for renderConfigPanel and a
 * #wsc-content node for renderContentView — so bindShellEvents /
 * bindToolChromeEvents host everything with zero renderer changes
 * (CM shell-d M3 pattern).
 *
 * W2 scope: spine + config drawer + canvas + LIVE design-summary rail.
 * Station faces = W4; rail inspector/what-if = W3 (placeholder zone);
 * Adopt-flow = W5. Classic shell stays the default until the flip.
 *
 * @module tools/warehouse-sizing/shell-w
 */

import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

// ─── Shell preference (tier-service pattern, CM shell-d lineage) ─────────
const STORAGE_KEY = 'ies_wsc_shell';
export const SHELLS = ['classic', 'w'];
// W7 FLIP (2026-07-16): the station shell is the DEFAULT. Classic remains
// one click away ('Classic layout' action) and is retained until the
// post-soak cleanup — CM M8a/M8b lineage. Users who explicitly picked
// classic keep it (stored pref wins over the default).
const DEFAULT_SHELL = 'w';

const _mem = new Map();
function _store() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage
        && typeof localStorage.getItem === 'function'
        && typeof localStorage.setItem === 'function') return localStorage;
  } catch { /* sandboxed embeds */ }
  return {
    getItem: (k) => (_mem.has(k) ? _mem.get(k) : null),
    setItem: (k, v) => { _mem.set(k, String(v)); },
  };
}

/** @returns {'classic'|'w'} current WSC shell preference. */
export function getShellPref() {
  try {
    const v = _store().getItem(STORAGE_KEY);
    return SHELLS.includes(v) ? v : DEFAULT_SHELL;
  } catch { return DEFAULT_SHELL; }
}

/** Set the WSC shell preference. Invalid values are ignored. */
export function setShellPref(shell) {
  if (!SHELLS.includes(shell)) return getShellPref();
  try { _store().setItem(STORAGE_KEY, shell); } catch {}
  return shell;
}

// ─── Station map: the engineering causal chain IS the nav ────────────────
// Data → Storage → Flow → Building → Basis. Every WSC_SECTIONS key appears
// EXACTLY ONCE across stations (test-wsc-shell-w pins this against ui.js).
// W4 — station FACES: each basis-chain station renders only its own cards
// (ui-basis FACE_CARDS, keyed by `face`); the W2 scroll-anchor hop is
// retired (faces are short — nothing to scroll to). `scroll` stays as a
// key so _setWswStation's signature is stable, but no station sets one.
export const W_STATIONS = [
  { key: 'data',     num: 1, name: 'Data',
    sections: ['basis'], target: 'basis', scroll: '', face: 'data' },
  { key: 'storage',  num: 2, name: 'Storage',
    sections: [], target: 'basis', scroll: '', face: 'storage' },
  { key: 'flow',     num: 3, name: 'Flow',
    sections: [], target: 'basis', scroll: '', face: 'flow' },
  { key: 'building', num: 4, name: 'Building',
    sections: ['dashboard', 'plan', 'elevation', '3d'], target: 'dashboard', scroll: '', face: '' },
  { key: 'basis',    num: 5, name: 'Basis',
    sections: [], target: 'basis', scroll: '', face: 'basis' },
];

/** Station that OWNS a section key (partition lookup — basis → data). */
export function stationForSection(sectionKey) {
  return W_STATIONS.find(st => st.sections.includes(sectionKey)) || null;
}

// ─── Shell renderer ──────────────────────────────────────────────────────
/**
 * @param {Object} opts
 * @param {string}   opts.facilityName
 * @param {string}   opts.modeLabel     — 'Design' | 'Constraint'
 * @param {string}   opts.stateName     — 'draft' | 'modified' | 'saved'
 * @param {string}   opts.stateTitle
 * @param {Array}    opts.actions       — [{id,label,title,primary}] (data-tc-action)
 * @param {string}   opts.backTitle
 * @param {string}   opts.activeStation — W_STATIONS key
 * @param {string}   opts.activeSection — WSC section key
 * @param {Array}    opts.sections      — WSC_SECTIONS (for sub-nav labels)
 * @param {Object}   opts.subs          — { data, storage, flow, building, basis } one-liners
 */
export function renderShellW(opts) {
  const stateCls = { draft: 'wsw-chip--draft', modified: 'wsw-chip--mod', saved: 'wsw-chip--saved' }[opts.stateName] || 'wsw-chip--draft';
  const stateLbl = { draft: 'DRAFT', modified: 'MODIFIED', saved: 'SAVED' }[opts.stateName] || 'DRAFT';
  const actions = (opts.actions || []).map(a =>
    '<button class="wsw-btn' + (a.primary || a.kind === 'primary' ? ' wsw-btn--primary' : '') + '" data-tc-action="' + escapeAttr(a.id) + '" title="' + escapeAttr(a.title || '') + '">'
    + escapeHtml(a.label) + '</button>').join('');

  return '' +
  '<div class="wsw-app">' +
    '<div class="wsw-top">' +
      '<button class="wsw-back" data-tc-back title="' + escapeAttr(opts.backTitle || 'Back') + '">←</button>' +
      '<span class="wsw-mark">WS</span><b class="wsw-title">Warehouse Sizing</b>' +
      '<span class="wsw-crumb">' + escapeHtml(opts.facilityName || 'New Facility') + '</span>' +
      '<span class="wsw-chip">' + escapeHtml(opts.modeLabel || 'Design') + '</span>' +
      '<span class="wsw-chip ' + stateCls + '" data-wsw-state title="' + escapeAttr(opts.stateTitle || '') + '">' + stateLbl + '</span>' +
      // W6 — mode pills (CM M7 lineage): Working is the live surface;
      // Review/Client-safe open the print-grade Design Basis doc via the
      // data-wsw-mode delegation in ui-shell-events.
      '<span class="wsw-mode"><span class="wsw-mode--on">Working</span>' +
      '<button type="button" class="wsw-mode--doc" data-wsw-mode="review" title="Review document — the 12-section Basis of Design, print-grade (Save as PDF)">Review</button>' +
      '<button type="button" class="wsw-mode--doc" data-wsw-mode="clientsafe" title="Client-safe document — commercial figures (rack capital) never render">Client-safe</button></span>' +
      '<span class="wsw-spacer"></span>' +
      actions +
    '</div>' +
    '<div class="wsw-spine">' +
      '<div class="wsw-spinehd">DESIGN LINE</div>' +
      renderWSpine(opts) +
    '</div>' +
    '<div class="wsw-drawer">' +
      '<div class="wsw-drawerhd">Configure</div>' +
      '<div id="wsc-config"></div>' +
    '</div>' +
    '<div class="wsw-center">' +
      '<div class="wsw-subnav" id="wsw-subnav">' + renderWSubnav(opts) + '</div>' +
      '<div id="wsc-content" class="wsw-canvas"></div>' +
    '</div>' +
    '<aside class="wsw-rail">' +
      '<div class="wsw-railsec">' +
        '<div class="wsw-railt">DESIGN SUMMARY <span class="wsw-live">● LIVE</span></div>' +
        _railRow('Sized total SF', 'sizedSf', true) +
        _railRow('Storage SF', 'storageSf') +
        _railRow('Gross positions', 'positions') +
        _railRow('Utilization', 'utilPct') +
        _railRow('Dock doors', 'doors') +
        _railRow('Clear height', 'clearHt') +
        '<div class="wsw-recon" data-wsw-rail-recon hidden><b>Σ RECON</b><span data-wsw-rail="recon"></span></div>' +
        '<div class="wsw-band" data-wsw-rail-band hidden>' +
          '<div class="wsw-bandlbl"><span>RACK CAPITAL BAND</span><span><b data-wsw-rail="costMid">—</b> mid</span></div>' +
          '<div class="wsw-bandbar"></div>' +
          '<div class="wsw-bandlbl"><span data-wsw-rail="costMin">—</span><span data-wsw-rail="costMax">—</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="wsw-railsec">' +
        '<div class="wsw-railt">INSPECTOR</div>' +
        '<div id="wsw-izbody">' +
        '<p class="wsw-hint">Click a design figure for its derivation chain — factor citations, ' +
        'ASSERTED / DERIVED / ESTIMATED sources, and quick what-if levers.</p>' +
        '</div>' +
      '</div>' +
    '</aside>' +
  '</div>' +
  _wStyles();
}

function _railRow(label, key, hero = false) {
  // W3 — rows answer clicks: the inspector builds this cell's derivation chain.
  return '<div class="wsw-krow wsw-krow--click' + (hero ? ' wsw-krow--hero' : '') + '" data-wsw-cell="' + escapeAttr(key) + '" title="Inspect — derivation chain + what-if"><span>' + escapeHtml(label) + '</span><b data-wsw-rail="' + escapeAttr(key) + '">—</b></div>';
}

/** Spine — station buttons carry the SAME data-tc-section contract the
 *  classic pills do, plus data-wsw-station/-scroll for face memory. */
export function renderWSpine(opts) {
  // W7 — Quick tier: ui.js passes the Building-only subset so Quick keeps
  // its 5-inputs + Dashboard/3D promise under the station shell.
  return (opts.stations || W_STATIONS).map(st => {
    const active = st.key === opts.activeStation;
    const sub = (opts.subs || {})[st.key] || '';
    return '<button class="wsw-station' + (active ? ' wsw-station--active' : '') + '"' +
      ' data-tc-section="' + escapeAttr(st.target) + '"' +
      ' data-wsw-station="' + escapeAttr(st.key) + '"' +
      (st.scroll ? ' data-wsw-scroll="' + escapeAttr(st.scroll) + '"' : '') + '>' +
      '<span class="wsw-stnum">' + st.num + '</span>' +
      '<span class="wsw-stbody"><span class="wsw-stname">' + escapeHtml(st.name) + '</span>' +
      // W4 — always emit the sub slot: _refreshWswSubs updates it surgically
      // on the KPI cadence (Apply under a face flips 'Not applied' live).
      '<span class="wsw-stsub" data-wsw-sub="' + escapeAttr(st.key) + '">' + escapeHtml(sub) + '</span></span>' +
    '</button>';
  }).join('');
}

/** Sub-nav — the active station's sections as standard section pills
 *  (Building: Dashboard / 2D Plan / Elevation / 3D). */
export function renderWSubnav(opts) {
  const st = (opts.stations || W_STATIONS).find(s => s.key === opts.activeStation);
  if (!st || st.sections.length < 2) return '';
  const labels = Object.fromEntries((opts.sections || []).map(s => [s.key, s.label]));
  // W7 — only pills for sections present in opts.sections (Quick hides
  // Plan/Elevation; the tier already lands activeView on dashboard).
  const allowed = new Set((opts.sections || []).map(s => s.key));
  return st.sections.filter(key => !allowed.size || allowed.has(key)).map(key =>
    '<button class="wsw-pill' + (key === opts.activeSection ? ' wsw-pill--on' : '') + '" data-tc-section="' + escapeAttr(key) + '">' +
    escapeHtml(labels[key] || key) + '</button>').join('');
}

/** Live rail update (KPI cadence — called from _refreshWscKpis).
 *  bag = { sizedSf, storageSf, positions, utilPct, doors, clearHt,
 *          recon: {text, ok} | null, cost: {min, mid, max} | null } */
export function updateWRail(rootEl, bag) {
  if (!rootEl || !bag) return;
  const set = (key, val) => {
    const el = rootEl.querySelector('[data-wsw-rail="' + key + '"]');
    if (el) el.textContent = val;
  };
  const sf = (n) => n > 0 ? Math.round(n).toLocaleString() : '—';
  set('sizedSf', sf(bag.sizedSf));
  set('storageSf', sf(bag.storageSf));
  set('positions', bag.positions > 0 ? Math.round(bag.positions).toLocaleString() : '—');
  set('utilPct', bag.utilPct > 0 ? bag.utilPct + '%' : '—');
  set('doors', bag.doors > 0 ? String(bag.doors) : '—');
  set('clearHt', bag.clearHt > 0 ? bag.clearHt + ' ft' : '—');
  const recon = rootEl.querySelector('[data-wsw-rail-recon]');
  if (recon) {
    recon.hidden = !bag.recon;
    if (bag.recon) {
      recon.classList.toggle('wsw-recon--short', !bag.recon.ok);
      set('recon', bag.recon.text);
    }
  }
  const band = rootEl.querySelector('[data-wsw-rail-band]');
  if (band) {
    band.hidden = !bag.cost;
    if (bag.cost) {
      const money = (n) => '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.round(n / 1000) + 'K');
      set('costMin', money(bag.cost.min));
      set('costMid', money(bag.cost.mid));
      set('costMax', money(bag.cost.max));
    }
  }
}

// ─── Styles (scoped .wsw-*) ──────────────────────────────────────────────
function _wStyles() {
  return `<style>
  .wsw-app{display:grid;grid-template-columns:210px 296px 1fr 300px;grid-template-rows:46px 1fr;height:calc(100vh - 56px);min-height:560px;background:var(--ies-gray-50,#fafaf9);border-radius:12px;overflow:hidden;border:1px solid var(--ies-gray-200,#e7e5e4)}
  .wsw-top{grid-column:1/5;display:flex;align-items:center;gap:11px;background:#1c1917;color:#d6d3d1;padding:0 14px}
  .wsw-back{background:none;border:1px solid #44403c;border-radius:7px;color:#d6d3d1;font-size:14px;padding:2px 9px;cursor:pointer}
  .wsw-mark{width:24px;height:24px;border-radius:6px;background:var(--ies-orange,#ff3a00);display:grid;place-items:center;color:#fff;font-weight:700;font-size:10px}
  .wsw-title{color:#fff;font-size:13px}
  .wsw-crumb{font-size:12px;color:#a8a29e;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wsw-chip{font-size:9.5px;font-weight:700;letter-spacing:.05em;border-radius:99px;padding:2.5px 9px;background:#292524;color:#a8a29e}
  .wsw-chip--draft{background:#3f3320;color:#fbbf24}.wsw-chip--mod{background:#432c1e;color:#fb923c}.wsw-chip--saved{background:#1b3524;color:#4ade80}
  .wsw-spacer{flex:1}
  .wsw-mode{display:flex;background:#292524;border-radius:999px;padding:3px;margin-left:4px;flex:none}
  .wsw-mode--on{font-size:10.5px;font-weight:600;padding:3.5px 11px;border-radius:999px;background:var(--ies-orange,#ff3a00);color:#fff}
  .wsw-mode--doc{background:transparent;border:none;font-size:10.5px;font-weight:600;padding:3.5px 11px;border-radius:999px;color:#a8a29e;cursor:pointer}
  .wsw-mode--doc:hover{color:#fff}
  .wsw-btn{font-size:11.5px;font-weight:600;border-radius:8px;border:1px solid #44403c;background:transparent;color:#d6d3d1;padding:5.5px 11px;cursor:pointer}
  .wsw-btn--primary{background:var(--ies-orange,#ff3a00);border-color:var(--ies-orange,#ff3a00);color:#fff}
  .wsw-spine{background:#1c1917;color:#d6d3d1;padding:13px 9px;display:flex;flex-direction:column;gap:3px;overflow-y:auto}
  .wsw-spinehd{font-size:9.5px;font-weight:600;letter-spacing:.09em;color:#78716c;padding:0 10px 7px}
  .wsw-station{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;border:none;border-left:3px solid transparent;background:none;text-align:left;color:#d6d3d1;width:100%}
  .wsw-station:hover{background:#292524}
  .wsw-station--active{background:rgba(255,58,0,.13);border-left-color:var(--ies-orange,#ff3a00)}
  .wsw-station--active .wsw-stname{color:#fff}
  .wsw-stnum{width:23px;height:23px;border-radius:50%;background:#3a3633;display:grid;place-items:center;font-size:10px;font-weight:700;flex:none}
  .wsw-station--active .wsw-stnum{background:var(--ies-orange,#ff3a00);color:#fff}
  .wsw-stbody{display:flex;flex-direction:column;min-width:0}
  .wsw-stname{font-size:12.5px;font-weight:600}
  .wsw-stsub{font-size:9.5px;color:#78716c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:128px}
  .wsw-drawer{background:#fff;border-right:1px solid var(--ies-gray-200,#e7e5e4);overflow-y:auto;padding:12px 14px}
  .wsw-drawerhd{font-size:12.5px;font-weight:700;margin-bottom:8px}
  .wsw-center{display:flex;flex-direction:column;overflow:hidden}
  .wsw-subnav{display:flex;gap:6px;padding:9px 16px 0}
  .wsw-subnav:empty{display:none}
  .wsw-pill{font-size:11px;font-weight:600;border-radius:99px;border:1px solid var(--ies-gray-300,#d6d3d1);background:#fff;color:var(--ies-gray-600,#57534e);padding:4px 12px;cursor:pointer}
  .wsw-pill--on{background:#1c1917;border-color:#1c1917;color:#fff}
  .wsw-canvas{flex:1;overflow-y:auto;padding:14px 16px 48px}
  .wsw-rail{background:#fff;border-left:1px solid var(--ies-gray-200,#e7e5e4);overflow-y:auto}
  .wsw-railsec{padding:13px 15px;border-bottom:1px solid var(--ies-gray-100,#f5f5f4)}
  .wsw-railt{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--ies-gray-400,#a8a29e);margin-bottom:8px;display:flex;align-items:center}
  .wsw-live{margin-left:auto;font-size:8.5px;color:var(--c-success-strong,#15803d)}
  .wsw-krow{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}
  .wsw-krow span{color:var(--ies-gray-600,#57534e)}
  .wsw-krow b{font-variant-numeric:tabular-nums}
  .wsw-krow--hero b{font-size:15px}
  .wsw-recon[hidden],.wsw-band[hidden]{display:none!important}
  .wsw-recon{display:flex;align-items:center;gap:8px;background:var(--c-success-bg,#f0fdf4);border:1px solid #bbe5c8;border-radius:9px;padding:7px 10px;font-size:11px;margin-top:8px}
  .wsw-recon b{color:var(--c-success-ink,#15803d);font-size:9.5px}
  .wsw-recon--short{background:#fef2f2;border-color:#fecaca}
  .wsw-recon--short b{color:#b91c1c}
  .wsw-band{margin-top:9px}
  .wsw-bandlbl{display:flex;justify-content:space-between;font-size:9.5px;color:var(--ies-gray-400,#a8a29e)}
  .wsw-bandbar{height:7px;border-radius:99px;background:linear-gradient(90deg,#fed7c9,var(--ies-orange,#ff3a00));margin:5px 0 3px}
  .wsw-hint{font-size:11px;color:var(--ies-gray-500,#78716c);line-height:1.5}
  .wsw-krow--click{cursor:pointer;border-radius:6px;margin:0 -6px;padding-left:6px;padding-right:6px}
  .wsw-krow--click:hover{background:var(--ies-gray-100,#f5f5f4)}
  .wsw-krow--sel{background:var(--c-info-soft,#eff4ff)}
  .wsw-path{font-size:10px;color:var(--ies-gray-400,#a8a29e);margin-bottom:7px}
  .wsw-chain{border-left:2px solid var(--ies-gray-200,#e7e5e4);padding-left:11px;display:flex;flex-direction:column;gap:7px}
  .wsw-step{font-size:11.5px}
  .wsw-step b{font-variant-numeric:tabular-nums}
  .wsw-why{color:var(--ies-gray-600,#57534e);font-size:10.5px}
  .wsw-cite{font-size:9.5px;color:var(--ies-gray-400,#a8a29e);font-style:italic}
  .wsw-src{font-size:8px;font-weight:700;letter-spacing:.04em;border-radius:99px;padding:1px 5px;margin-left:3px;vertical-align:1px}
  .wsw-src--derived{background:var(--c-success-bg,#f0fdf4);color:var(--c-success-ink,#15803d)}
  .wsw-src--estimated{background:var(--c-warn-soft,#fffbeb);color:var(--c-warn-deep,#b45309)}
  .wsw-src--asserted{background:var(--c-info-soft,#eff4ff);color:var(--c-info-strong,#2563eb)}
  .wsw-note{margin-top:9px;font-size:10.5px;color:var(--ies-gray-600,#57534e);background:var(--ies-gray-50,#fafaf9);border:1px solid var(--ies-gray-200,#e7e5e4);border-radius:8px;padding:7px 9px}
  .wsw-lever{margin-bottom:9px}
  .wsw-leverlbl{display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px}
  .wsw-leverlbl b{font-variant-numeric:tabular-nums}
  .wsw-lever input[type=range]{width:100%;accent-color:var(--ies-orange,#ff3a00)}
  .wsw-delta{font-size:10.5px;color:var(--ies-gray-600,#57534e);margin-top:4px}
  .wsw-delta--idle{color:var(--ies-gray-400,#a8a29e)}
  .wsw-reset{background:none;border:none;color:var(--ies-orange,#ff3a00);font-size:10px;font-weight:700;cursor:pointer;text-decoration:underline;padding:0 0 0 6px}
  </style>`;
}
