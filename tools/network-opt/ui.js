/**
 * IES Hub v3 — Network Optimization UI
 * Builder-pattern layout: config sidebar + content area with 4 views.
 * Views: Setup (facilities + demand tables), Map (Leaflet + flow lines),
 *        Results (scenario detail), Comparison (multi-scenario table).
 *
 * @module tools/network-opt/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sJ';
import { state } from '../../shared/state.js?v=20260418-sJ';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sJ';
import { showToast } from '../../shared/toast.js?v=20260418-sJ';
import { renderToolHeader, bindPrimaryActionShortcut, flashRunButton } from '../../shared/tool-frame.js?v=20260418-sJ';
import { downloadXLSX } from '../../shared/export.js?v=20260418-sJ';
import * as calc from './calc.js?v=20260418-sJ';
import * as api from './api.js?v=20260418-sJ';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'setup' | 'map' | 'results' | 'comparison'} */
let activeView = 'setup';

/** @type {'facilities' | 'demand' | 'modemix' | 'service'} */
let activeSection = 'facilities';

/** @type {import('./types.js?v=20260418-sJ').Facility[]} */
let facilities = [];

/** @type {import('./types.js?v=20260418-sJ').DemandPoint[]} */
let demands = [];

/** @type {import('./types.js?v=20260418-sJ').ModeMix} */
let modeMix = { tlPct: 30, ltlPct: 40, parcelPct: 30 };

/** @type {import('./types.js?v=20260418-sJ').RateCard} */
let rateCard = { ...calc.DEFAULT_RATES };

/** @type {import('./types.js?v=20260418-sJ').ServiceConfig} */
let serviceConfig = { ...calc.DEFAULT_SERVICE };

/** @type {import('./types.js?v=20260418-sJ').ScenarioResult[]} */
let scenarios = [];

/** @type {import('./types.js?v=20260418-sJ').ScenarioResult|null} */
let activeScenario = null;

/** @type {string|null} */
let selectedArchetype = null;

/** @type {object|null} map instance */
let mapInstance = null;

/** @type {import('./types.js?v=20260418-sJ').ScenarioResult[]|null} */
let comparisonResults = null;

/** @type {number|null} */
let recommendedDCCount = null;

/** @type {number} */
let maxDCsToTest = 5;

// ============================================================
// DEMO FACILITIES
// ============================================================

const DEMO_FACILITIES = [
  { id: 'f1', name: 'Chicago DC', city: 'Chicago', state: 'IL', lat: 41.8781, lng: -87.6298, capacity: 500000, fixedCost: 2400000, variableCost: 3.50, isOpen: true },
  { id: 'f2', name: 'Dallas DC', city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970, capacity: 400000, fixedCost: 1800000, variableCost: 3.20, isOpen: true },
  { id: 'f3', name: 'Atlanta DC', city: 'Atlanta', state: 'GA', lat: 33.7490, lng: -84.3880, capacity: 350000, fixedCost: 1600000, variableCost: 3.00, isOpen: true },
  { id: 'f4', name: 'Los Angeles DC', city: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437, capacity: 450000, fixedCost: 2800000, variableCost: 4.00, isOpen: true },
  { id: 'f5', name: 'Edison DC', city: 'Edison', state: 'NJ', lat: 40.5187, lng: -74.4121, capacity: 400000, fixedCost: 2200000, variableCost: 3.80, isOpen: true },
  { id: 'f6', name: 'Memphis DC', city: 'Memphis', state: 'TN', lat: 35.1495, lng: -90.0490, capacity: 300000, fixedCost: 1400000, variableCost: 2.80, isOpen: false },
];

// Demo demand points — major US metros
const DEMO_DEMANDS = [
  { id: 'd1', zip3: '100', lat: 40.7128, lng: -74.0060, annualDemand: 85000, maxDays: 2, avgWeight: 25 },
  { id: 'd2', zip3: '900', lat: 34.0522, lng: -118.2437, annualDemand: 72000, maxDays: 2, avgWeight: 30 },
  { id: 'd3', zip3: '606', lat: 41.8781, lng: -87.6298, annualDemand: 55000, maxDays: 3, avgWeight: 20 },
  { id: 'd4', zip3: '770', lat: 29.7604, lng: -95.3698, annualDemand: 48000, maxDays: 3, avgWeight: 35 },
  { id: 'd5', zip3: '852', lat: 33.4484, lng: -112.0740, annualDemand: 32000, maxDays: 3, avgWeight: 25 },
  { id: 'd6', zip3: '303', lat: 33.7490, lng: -84.3880, annualDemand: 42000, maxDays: 2, avgWeight: 20 },
  { id: 'd7', zip3: '752', lat: 32.7767, lng: -96.7970, annualDemand: 38000, maxDays: 3, avgWeight: 30 },
  { id: 'd8', zip3: '331', lat: 25.7617, lng: -80.1918, annualDemand: 35000, maxDays: 3, avgWeight: 25 },
  { id: 'd9', zip3: '981', lat: 47.6062, lng: -122.3321, annualDemand: 28000, maxDays: 3, avgWeight: 20 },
  { id: 'd10', zip3: '191', lat: 39.9526, lng: -75.1652, annualDemand: 40000, maxDays: 2, avgWeight: 25 },
  { id: 'd11', zip3: '021', lat: 42.3601, lng: -71.0589, annualDemand: 36000, maxDays: 2, avgWeight: 25 },
  { id: 'd12', zip3: '802', lat: 39.7392, lng: -104.9903, annualDemand: 26000, maxDays: 3, avgWeight: 30 },
  { id: 'd13', zip3: '554', lat: 44.9778, lng: -93.2650, annualDemand: 22000, maxDays: 3, avgWeight: 25 },
  { id: 'd14', zip3: '481', lat: 42.3314, lng: -83.0458, annualDemand: 30000, maxDays: 3, avgWeight: 35 },
  { id: 'd15', zip3: '980', lat: 47.2529, lng: -122.4443, annualDemand: 18000, maxDays: 3, avgWeight: 20 },
];

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Network Optimizer.
 * @param {HTMLElement} el
 */
let activeConfigId = null;
let activeParentCmId = null;

export async function mount(el) {
  rootEl = el;
  await renderLanding();
  bus.emit('netopt:mounted');
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Network Optimizer',
    toolKey: 'netopt',
    accent: '#20c997',
    list: () => api.listConfigs(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.config_data?.name || 'Untitled network',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle: (r) => {
      const d = r.config_data || {};
      const nFac = (d.facilities || []).length;
      const nDem = (d.demands || []).length;
      return nFac ? `${nFac} facilities · ${nDem} demand points` : '';
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteConfig(row.id); },
    onCopy: async (row) => await api.duplicateConfig(row.id),
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Optimize TL/LTL/Parcel mix across facility and demand sets. Run multi-DC comparisons, exhaustive searches, and heatmap overlays — every scenario saves here.',
  });
}

function openEditor(savedRow) {
  if (!rootEl) return;
  activeView = 'setup';
  activeSection = 'facilities';
  const d = savedRow?.config_data || {};
  facilities = (d.facilities && d.facilities.length) ? d.facilities.map(f => ({ ...f })) : DEMO_FACILITIES.map(f => ({ ...f }));
  demands = (d.demands && d.demands.length) ? d.demands.map(x => ({ ...x })) : DEMO_DEMANDS.map(x => ({ ...x }));
  modeMix = d.modeMix || { tlPct: 30, ltlPct: 40, parcelPct: 30 };
  rateCard = d.rateCard || { ...calc.DEFAULT_RATES };
  serviceConfig = d.serviceConfig || { ...calc.DEFAULT_SERVICE };
  scenarios = [];
  activeScenario = null;
  selectedArchetype = null;
  comparisonResults = null;
  recommendedDCCount = null;
  maxDCsToTest = 5;
  activeConfigId = savedRow?.id || null;
  activeParentCmId = savedRow?.parent_cost_model_id || null;

  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderSidebar();
  renderContentView();

  // Wire the "← Scenarios" back button.
  rootEl.querySelector('[data-action="netopt-back"]')?.addEventListener('click', async () => {
    await renderLanding();
  });
}

/**
 * Cleanup.
 */
export function unmount() {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  rootEl = null;
  bus.emit('netopt:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  const tabs = ['setup', 'map', 'results', 'comparison'].map(v => ({ key: v, label: viewLabel(v) }));
  const chips = [
    { label: activeConfigId ? 'Saved' : 'Draft', kind: activeConfigId ? 'saved' : 'draft', dot: true },
    activeParentCmId
      ? { label: 'Linked to CM', kind: 'linked', title: `Linked to Cost Model #${activeParentCmId}` }
      : { label: scenarios.length ? `${scenarios.length} scenarios run` : 'Stand-alone', kind: scenarios.length ? 'linked' : 'standalone' },
  ];
  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height:100%;">
      ${renderToolHeader({
        toolName: 'Network Optimizer',
        toolKey: 'netopt',
        backAction: 'netopt-back',
        tabs,
        activeTab: activeView,
        tabsId: 'no-view-tabs',
        statusChips: chips,
        primaryAction: { label: 'Run Scenario', action: 'netopt-run', icon: '▶', title: 'Run optimizer (Cmd/Ctrl+Enter)' },
      })}

      <!-- Main area: sidebar + content -->
      <div style="display:flex;flex:1;overflow:hidden;margin-top:12px;">
        <!-- Sidebar -->
        <div id="no-sidebar" style="width:220px;flex-shrink:0;border-right:1px solid var(--ies-gray-200);padding:16px;overflow-y:auto;">
        </div>
        <!-- Content -->
        <div id="no-content" style="flex:1;overflow-y:auto;padding:24px;">
        </div>
      </div>
    </div>
  `;
}

function viewLabel(v) {
  const labels = { setup: 'Setup', map: 'Network Map', results: 'Results', comparison: 'Compare' };
  return labels[v] || v;
}

function bindShellEvents() {
  if (!rootEl) return;

  // View tabs (now [data-tab] from shared tool-frame)
  rootEl.querySelector('#no-view-tabs')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-tab]');
    if (!btn) return;
    activeView = /** @type {any} */ (btn.dataset.tab);
    rootEl.querySelectorAll('#no-view-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeView);
    });
    renderContentView();
  });

  // Header primary action proxies to the existing sidebar Run button so we keep one code path.
  const headerRun = rootEl.querySelector('[data-primary-action="netopt-run"]');
  headerRun?.addEventListener('click', () => {
    const sidebarRun = rootEl.querySelector('[data-action="run"]');
    if (sidebarRun) /** @type {HTMLButtonElement} */ (sidebarRun).click();
    flashRunButton(headerRun);
  });
  bindPrimaryActionShortcut(rootEl, 'netopt-run');

  // Sidebar clicks
  rootEl.querySelector('#no-sidebar')?.addEventListener('click', (e) => {
    const item = /** @type {HTMLElement} */ (e.target).closest('[data-section]');
    if (!item) return;
    activeSection = /** @type {any} */ (item.dataset.section);
    renderSidebar();
    if (activeView === 'setup') renderContentView();
  });
}

// ============================================================
// SIDEBAR
// ============================================================

function renderSidebar() {
  const el = rootEl?.querySelector('#no-sidebar');
  if (!el) return;

  const sections = [
    { key: 'facilities', label: 'Facilities', icon: '🏭', count: facilities.filter(f => f.isOpen).length + '/' + facilities.length },
    { key: 'demand', label: 'Demand Points', icon: '📍', count: String(demands.length) },
    { key: 'modemix', label: 'Mode Mix', icon: '🚛', count: '' },
    { key: 'service', label: 'Service Config', icon: '⏱', count: '' },
  ];

  el.innerHTML = `
    <div style="margin-bottom:16px;">
      <span class="text-caption" style="color:var(--ies-gray-400);">CONFIGURATION</span>
    </div>
    ${sections.map(s => `
      <div data-section="${s.key}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:6px;cursor:pointer;margin-bottom:4px;
           background:${s.key === activeSection ? 'var(--ies-blue)' : 'transparent'};
           color:${s.key === activeSection ? '#fff' : 'var(--ies-gray-600)'};">
        <span style="font-size:16px;">${s.icon}</span>
        <span style="font-size:13px;font-weight:600;flex:1;">${s.label}</span>
        ${s.count ? `<span style="font-size:11px;font-weight:700;opacity:0.7;">${s.count}</span>` : ''}
      </div>
    `).join('')}

    <div style="border-top:1px solid var(--ies-gray-200);margin:20px 0 16px 0;"></div>
    <span class="text-caption" style="color:var(--ies-gray-400);">ARCHETYPES</span>
    <div style="margin-top:8px;">
      ${calc.listArchetypes().map(a => `
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-archetype="${a.key}"
                style="width:100%;margin-bottom:6px;font-size:11px;text-align:left;${selectedArchetype === a.key ? 'border-color:var(--ies-blue);color:var(--ies-blue);' : ''}">
          ${a.name}
        </button>
      `).join('')}
    </div>

    <div style="border-top:1px solid var(--ies-gray-200);margin:20px 0 16px 0;"></div>
    <span class="text-caption" style="color:var(--ies-gray-400);">OPTIMIZATION</span>
    <div style="margin-top:8px;margin-bottom:12px;">
      <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-600);margin-bottom:4px;">Max DCs to Test</label>
      <input type="number" id="netopt-max-dcs" min="1" max="20" value="${maxDCsToTest}" style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;"/>
    </div>

    <div style="border-top:1px solid var(--ies-gray-200);margin:20px 0 16px 0;"></div>
    <span class="text-caption" style="color:var(--ies-gray-400);">ACTIONS</span>
    <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
      <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="run" style="width:100%;">Run Scenario</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="compare-dcs" style="width:100%;font-size:11px;">Compare DCs</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="exact-solve" style="width:100%;font-size:11px;">Exhaustive Search</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="apply-market-rates" style="width:100%;font-size:11px;">Apply Market Rates</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="balance-mode-mix" style="width:100%;font-size:11px;">Balance Mode Mix</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="upload-rates-csv" style="width:100%;font-size:11px;">Upload Rate Card CSV</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="export-csv" style="width:100%;font-size:11px;">Export XLSX</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="clear-scenarios" style="width:100%;">Clear All</button>
      <input type="file" id="netopt-csv-upload" accept=".csv,text/csv" style="display:none;"/>
    </div>
  `;

  // Archetype buttons
  el.querySelectorAll('[data-archetype]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.archetype;
      applyArchetype(key);
    });
  });

  // Action buttons
  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = /** @type {HTMLElement} */ (btn).dataset.action;
      if (action === 'run') runScenario();
      else if (action === 'compare-dcs') compareMultipleDCs();
      else if (action === 'exact-solve') runExactSolver();
      else if (action === 'export-csv') exportToCSV();
      else if (action === 'clear-scenarios') { scenarios = []; activeScenario = null; comparisonResults = null; renderContentView(); }
      else if (action === 'apply-market-rates') applyMarketRates();
      else if (action === 'balance-mode-mix') balanceModeMix();
      else if (action === 'upload-rates-csv') document.getElementById('netopt-csv-upload')?.click();
    });
  });

  // Max DCs input
  const maxDcsInput = el.querySelector('#netopt-max-dcs');
  maxDcsInput?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10) || 5;
    maxDCsToTest = Math.max(1, Math.min(20, val));
    // Clear stale comparison results
    comparisonResults = null;
    recommendedDCCount = null;
    e.target.value = String(maxDCsToTest);
  });

  // CSV rate card upload
  const fileInput = el.querySelector('#netopt-csv-upload');
  fileInput?.addEventListener('change', handleCsvUpload);
}

/** Pull latest freight_rates avg from Supabase and apply to rateCard. */
async function applyMarketRates() {
  try {
    const rates = await api.fetchFreightRates();
    if (!rates || !rates.length) { showNoToast('No market rate data available', 'info'); return; }
    // Take latest rate per index_name
    const byIdx = new Map();
    for (const r of rates) {
      const k = r.index_name || r.rate_type || 'default';
      const prev = byIdx.get(k);
      if (!prev || (r.report_date || '') > (prev.report_date || '')) byIdx.set(k, r);
    }
    const spot = Array.from(byIdx.values()).find(r => /spot/i.test(r.rate_type || '') || /spot/i.test(r.index_name || ''));
    const contract = Array.from(byIdx.values()).find(r => /contract/i.test(r.rate_type || '') || /contract/i.test(r.index_name || ''));
    const tlPerMile = parseFloat((contract?.rate || spot?.rate || rateCard.tlPerMile || 2.25));
    rateCard.tlPerMile = tlPerMile;
    // LTL per lb approximation: TL / (TL capacity ~44000 lb)
    rateCard.ltlPerLb = Math.max(0.15, tlPerMile / 90);
    showNoToast(`Applied latest market rates (TL $${tlPerMile.toFixed(2)}/mi)`, 'success');
    renderContentView();
  } catch (err) {
    console.error('[netopt] applyMarketRates failed', err);
    showNoToast('Market rate fetch failed', 'error');
  }
}

/** Auto-balance the TL / LTL / Parcel mix to satisfy the archetype targets
 *  using average demand weight. Conservative heuristic — see calc.js. */
function balanceModeMix() {
  // Weight-based heuristic: heavier avg weight favors TL; lighter favors Parcel.
  const avgWeight = demands.reduce((s, d) => s + (d.avgWeight || 25), 0) / Math.max(1, demands.length);
  let tl, ltl, parcel;
  if (avgWeight > 500) { tl = 70; ltl = 25; parcel = 5; }
  else if (avgWeight > 100) { tl = 35; ltl = 55; parcel = 10; }
  else if (avgWeight > 25) { tl = 15; ltl = 45; parcel = 40; }
  else { tl = 5; ltl = 25; parcel = 70; }
  modeMix = { tl, ltl, parcel };
  showNoToast(`Balanced mode mix to avg weight ${avgWeight.toFixed(0)} lb`, 'success');
  renderContentView();
}

/** Parse a CSV rate card upload. Expects columns: lane,mode,rate. */
function handleCsvUpload(e) {
  const file = /** @type {HTMLInputElement} */ (e.currentTarget).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = String(ev.target.result || '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) { showNoToast('Empty CSV', 'error'); return; }
    let applied = 0;
    for (let i = 1; i < lines.length; i++) {
      const [_lane, mode, rate] = lines[i].split(',').map(s => s.trim());
      const r = parseFloat(rate);
      if (!isNaN(r)) {
        if (/tl/i.test(mode)) { rateCard.tlPerMile = r; applied++; }
        else if (/ltl/i.test(mode)) { rateCard.ltlPerLb = r; applied++; }
        else if (/parcel/i.test(mode)) { rateCard.parcelPerLb = r; applied++; }
      }
    }
    showNoToast(`Rate card CSV applied (${applied} rate${applied === 1 ? '' : 's'})`, 'success');
    renderContentView();
  };
  reader.onerror = () => showNoToast('CSV read failed', 'error');
  reader.readAsText(file);
}

function showNoToast(msg, level) {
  try {
    const ev = new CustomEvent('toast:show', { detail: { message: msg, level } });
    // Prefer event bus if present; fall back to console.
    if (window.__hubToast) window.__hubToast(msg, level);
    else console.log(`[netopt toast] ${level}: ${msg}`);
  } catch { console.log(msg); }
}

function applyArchetype(key) {
  const arch = calc.getArchetype(key);
  if (!arch) return;
  selectedArchetype = key;
  modeMix = { ...arch.modeMix };
  serviceConfig = { ...serviceConfig, globalMaxDays: arch.maxDays };
  // Apply archetype's default maxDays to all demand points
  demands = demands.map(d => ({ ...d, maxDays: arch.maxDays }));
  renderSidebar();
  if (activeView === 'setup') renderContentView();
}

// ============================================================
// SCENARIO EXECUTION
// ============================================================

function runScenario() {
  const name = `Scenario ${scenarios.length + 1} — ${facilities.filter(f => f.isOpen).length} DCs`;
  const result = calc.evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig);
  activeScenario = result;
  activeView = 'results';
  // Update view tabs
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function addToComparison() {
  const name = `Scenario ${scenarios.length + 1} — ${facilities.filter(f => f.isOpen).length} DCs`;
  const result = calc.evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig);
  scenarios.push(result);
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function compareMultipleDCs() {
  if (demands.length === 0) {
    alert('Please add demand points first.');
    return;
  }
  comparisonResults = calc.multiDCComparison(facilities, demands, modeMix, rateCard, serviceConfig, maxDCsToTest);
  const rec = calc.recommendOptimalDCs(comparisonResults);
  recommendedDCCount = rec.recommendedIdx;
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function runExactSolver() {
  if (demands.length === 0) {
    alert('Please add demand points first.');
    return;
  }
  const openCount = facilities.filter(f => f.isOpen).length;
  if (openCount === 0) {
    alert('Please activate at least one facility.');
    return;
  }
  const result = calc.exactSolver(facilities, demands, maxDCsToTest, modeMix, rateCard, serviceConfig);
  if (!result) {
    alert('Exhaustive search space is too large (>10,000 combinations). Use comparison instead.');
    return;
  }
  comparisonResults = result.scenarios;
  const rec = calc.recommendOptimalDCs(comparisonResults);
  recommendedDCCount = rec.recommendedIdx;
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function exportToCSV() {
  if (!activeScenario && !comparisonResults) {
    alert('Run a scenario first to export data.');
    return;
  }

  const sheets = {};
  const timestamp = new Date().toISOString();

  // Facilities sheet
  const facilitiesData = [
    ['Name', 'City', 'State', 'Lat', 'Lng', 'Capacity', 'Fixed Cost', 'Variable Cost', 'Is Open'],
    ...facilities.map(f => [
      f.name, f.city || '', f.state || '',
      parseFloat(f.lat.toFixed(4)),
      parseFloat(f.lng.toFixed(4)),
      f.capacity || 0, f.fixedCost || 0, f.variableCost || 0, f.isOpen ? 'Yes' : 'No'
    ])
  ];
  sheets['Facilities'] = facilitiesData;

  // Demand sheet
  const demandData = [
    ['ZIP3', 'Lat', 'Lng', 'Annual Demand', 'Max Days', 'Avg Weight (lbs)'],
    ...demands.map(d => [
      d.zip3 || '', parseFloat(d.lat.toFixed(4)), parseFloat(d.lng.toFixed(4)),
      d.annualDemand, d.maxDays || 3, d.avgWeight || 25
    ])
  ];
  sheets['Demand'] = demandData;

  // Assignments sheet (per scenario)
  if (activeScenario && activeScenario.assignments.length > 0) {
    const assignmentsData = [
      ['Facility ID', 'Demand ID', 'Distance (mi)', 'Transit Days', 'TL Cost', 'LTL Cost', 'Parcel Cost', 'Blended Cost', 'Meets SLA'],
      ...activeScenario.assignments.map(a => [
        a.facilityId, a.demandId,
        parseFloat(a.distanceMiles.toFixed(1)),
        a.transitDays,
        parseFloat(a.tlCost.toFixed(2)),
        parseFloat(a.ltlCost.toFixed(2)),
        parseFloat(a.parcelCost.toFixed(2)),
        parseFloat(a.blendedCost.toFixed(2)),
        a.meetsSlA ? 'Yes' : 'No'
      ])
    ];
    sheets['Assignments'] = assignmentsData;
  }

  // Comparison sheet (multi-scenario)
  if (comparisonResults && comparisonResults.length > 0) {
    const comparisonData = [
      ['DC Count', 'Total Cost', 'Avg Distance (mi)', 'Service Level (%)', 'SLA Met', 'Avg Cost/Unit'],
      ...comparisonResults.map((s, i) => [
        i + 1,
        parseFloat(s.totalCost.toFixed(2)),
        parseFloat(s.avgDistance.toFixed(1)),
        parseFloat(s.serviceLevel.toFixed(1)),
        `${s.slaMet}/${s.slaTotal}`,
        parseFloat(s.avgCostPerUnit.toFixed(2))
      ])
    ];
    sheets['Comparison'] = comparisonData;
  }

  downloadXLSX(sheets, `netopt-export-${new Date().getTime()}.xlsx`);
}

// ============================================================
// CONTENT VIEW ROUTER
// ============================================================

function renderContentView() {
  const el = rootEl?.querySelector('#no-content');
  if (!el) return;

  switch (activeView) {
    case 'setup': renderSetup(el); break;
    case 'map': renderMap(el); break;
    case 'results': renderResults(el); break;
    case 'comparison': renderComparison(el); break;
  }
}

// ============================================================
// SETUP VIEW
// ============================================================

function renderSetup(el) {
  switch (activeSection) {
    case 'facilities': renderFacilities(el); break;
    case 'demand': renderDemand(el); break;
    case 'modemix': renderModeMix(el); break;
    case 'service': renderServiceConfig(el); break;
  }
}

function renderFacilities(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Facility Network</h3>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-add-facility">+ Add Facility</button>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid var(--ies-gray-200);">
            <th style="text-align:left;padding:8px 6px;font-weight:700;">Active</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;">Name</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;">City</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;">State</th>
            <th style="text-align:right;padding:8px 6px;font-weight:700;">Capacity</th>
            <th style="text-align:right;padding:8px 6px;font-weight:700;">Fixed Cost</th>
            <th style="text-align:right;padding:8px 6px;font-weight:700;">$/Unit</th>
            <th style="text-align:center;padding:8px 6px;font-weight:700;"></th>
          </tr>
        </thead>
        <tbody>
          ${facilities.map((f, i) => `
            <tr style="border-bottom:1px solid var(--ies-gray-200);${f.isOpen ? '' : 'opacity:0.5;'}">
              <td style="padding:8px 6px;">
                <input type="checkbox" ${f.isOpen ? 'checked' : ''} data-fac-toggle="${i}" style="cursor:pointer;">
              </td>
              <td style="padding:8px 6px;font-weight:600;">${f.name}</td>
              <td style="padding:8px 6px;">${f.city || ''}</td>
              <td style="padding:8px 6px;">${f.state || ''}</td>
              <td style="padding:8px 6px;text-align:right;">${(f.capacity || 0).toLocaleString()}</td>
              <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(f.fixedCost || 0, { compact: true })}</td>
              <td style="padding:8px 6px;text-align:right;">$${(f.variableCost || 0).toFixed(2)}</td>
              <td style="padding:8px 6px;text-align:center;">
                <button class="hub-btn hub-btn-sm hub-btn-secondary" data-fac-delete="${i}" style="padding:4px 8px;">✕</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          <div>
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Open DCs</span>
            <div style="font-size:32px;font-weight:800;">${facilities.filter(f => f.isOpen).length}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Total Capacity</span>
            <div style="font-size:32px;font-weight:800;">${facilities.filter(f => f.isOpen).reduce((s, f) => s + (f.capacity || 0), 0).toLocaleString()}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Annual Fixed Cost</span>
            <div style="font-size:32px;font-weight:800;">${calc.formatCurrency(facilities.filter(f => f.isOpen).reduce((s, f) => s + (f.fixedCost || 0), 0), { compact: true })}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Toggle facility open/closed
  el.querySelectorAll('[data-fac-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (cb).dataset.facToggle);
      facilities[idx].isOpen = /** @type {HTMLInputElement} */ (cb).checked;
      renderFacilities(el);
      renderSidebar();
    });
  });

  // Delete facility
  el.querySelectorAll('[data-fac-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (btn).dataset.facDelete);
      facilities.splice(idx, 1);
      renderFacilities(el);
      renderSidebar();
    });
  });

  // Add facility
  el.querySelector('#no-add-facility')?.addEventListener('click', () => {
    const id = 'f' + Date.now();
    facilities.push({ id, name: 'New DC', city: '', state: '', lat: 39.8283, lng: -98.5795, capacity: 200000, fixedCost: 1000000, variableCost: 3.00, isOpen: true });
    renderFacilities(el);
    renderSidebar();
  });
}

function renderDemand(el) {
  const totalDemand = demands.reduce((s, d) => s + d.annualDemand, 0);

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Demand Points</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-add-demand">+ Add Point</button>
        </div>
      </div>

      <div style="max-height:400px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#fff;z-index:1;">
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">ZIP3</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lat</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lng</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Annual Demand</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Max Days</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Wt (lbs)</th>
              <th style="text-align:center;padding:8px 6px;font-weight:700;"></th>
            </tr>
          </thead>
          <tbody>
            ${demands.map((d, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${d.zip3 || '—'}</td>
                <td style="padding:6px;text-align:right;">${d.lat.toFixed(2)}</td>
                <td style="padding:6px;text-align:right;">${d.lng.toFixed(2)}</td>
                <td style="padding:6px;text-align:right;">${d.annualDemand.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${d.maxDays || 3}</td>
                <td style="padding:6px;text-align:right;">${d.avgWeight || 25}</td>
                <td style="padding:6px;text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-dem-delete="${i}" style="padding:4px 8px;">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          <div>
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Demand Points</span>
            <div style="font-size:32px;font-weight:800;">${demands.length}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Total Annual Demand</span>
            <div style="font-size:32px;font-weight:800;">${totalDemand.toLocaleString()}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Avg per Point</span>
            <div style="font-size:32px;font-weight:800;">${demands.length > 0 ? Math.round(totalDemand / demands.length).toLocaleString() : '0'}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('[data-dem-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      demands.splice(parseInt(/** @type {HTMLElement} */ (btn).dataset.demDelete), 1);
      renderDemand(el);
      renderSidebar();
    });
  });

  el.querySelector('#no-add-demand')?.addEventListener('click', () => {
    demands.push({ id: 'd' + Date.now(), zip3: '', lat: 39.83, lng: -98.58, annualDemand: 10000, maxDays: 3, avgWeight: 25 });
    renderDemand(el);
    renderSidebar();
  });
}

function renderModeMix(el) {
  el.innerHTML = `
    <div style="max-width:500px;">
      <h3 class="text-section" style="margin-bottom:16px;">Transportation Mode Mix</h3>

      <div class="hub-card" style="margin-bottom:20px;">
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${renderSlider('Truckload (TL)', 'tlPct', modeMix.tlPct)}
          ${renderSlider('Less-Than-Truckload (LTL)', 'ltlPct', modeMix.ltlPct)}
          ${renderSlider('Parcel', 'parcelPct', modeMix.parcelPct)}
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--ies-gray-200);font-size:13px;font-weight:600;text-align:right;">
          Total: ${modeMix.tlPct + modeMix.ltlPct + modeMix.parcelPct}%
          ${(modeMix.tlPct + modeMix.ltlPct + modeMix.parcelPct) !== 100 ? '<span style="color:var(--ies-orange);margin-left:8px;">Must equal 100%</span>' : '<span style="color:#22c55e;margin-left:8px;">✓</span>'}
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:16px;">Rate Card</h3>
      <div class="hub-card">
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${renderInput('TL Rate per Mile', 'tlRatePerMile', rateCard.tlRatePerMile, '$')}
          ${renderInput('LTL Base Rate ($/CWT)', 'ltlBaseRate', rateCard.ltlBaseRate, '$')}
          ${renderInput('Fuel Surcharge', 'fuelSurcharge', (rateCard.fuelSurcharge * 100).toFixed(0), '%')}
        </div>
      </div>
    </div>
  `;

  // Bind sliders
  el.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.key;
      const val = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
      modeMix[key] = val;
      renderModeMix(el);
    });
  });

  // Bind rate inputs
  el.querySelectorAll('input[data-rate]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.rate;
      let val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (key === 'fuelSurcharge') val = val / 100;
      rateCard[key] = val;
    });
  });
}

function renderSlider(label, key, value) {
  return `
    <div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:600;">${label}</span>
        <span style="font-size:13px;font-weight:700;">${value}%</span>
      </div>
      <input type="range" min="0" max="100" value="${value}" data-key="${key}"
             style="width:100%;accent-color:var(--ies-blue);">
    </div>
  `;
}

function renderInput(label, key, value, prefix) {
  return `
    <div style="display:flex;align-items:center;gap:12px;">
      <label style="font-size:13px;font-weight:600;flex:1;">${label}</label>
      <div style="display:flex;align-items:center;gap:4px;">
        ${prefix === '$' ? '<span style="font-size:13px;font-weight:600;">$</span>' : ''}
        <input type="number" value="${value}" data-rate="${key}" step="0.01"
               style="width:100px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
        ${prefix === '%' ? '<span style="font-size:13px;font-weight:600;">%</span>' : ''}
      </div>
    </div>
  `;
}

function renderServiceConfig(el) {
  el.innerHTML = `
    <div style="max-width:500px;">
      <h3 class="text-section" style="margin-bottom:16px;">Service Requirements</h3>
      <div class="hub-card">
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Target Service Level</label>
            <div style="display:flex;align-items:center;gap:4px;">
              <input type="number" value="${serviceConfig.targetServicePct}" data-svc="targetServicePct" min="0" max="100"
                     style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="font-size:13px;font-weight:600;">%</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Global Max Transit Days</label>
            <input type="number" value="${serviceConfig.globalMaxDays}" data-svc="globalMaxDays" min="1" max="14"
                   style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Average Truck Speed</label>
            <div style="display:flex;align-items:center;gap:4px;">
              <input type="number" value="${serviceConfig.truckSpeedMph}" data-svc="truckSpeedMph" min="20" max="80"
                     style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="font-size:13px;font-weight:600;">mph</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Hard SLA Constraint</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" ${serviceConfig.hardConstraint ? 'checked' : ''} data-svc="hardConstraint">
              <span style="font-size:11px;color:var(--ies-gray-400);">${serviceConfig.hardConstraint ? 'Scenarios below target will fail' : 'Soft constraint (warn only)'}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="hub-card" style="margin-top:16px;background:#f0fdf4;border-color:#22c55e;">
        <div style="font-size:13px;font-weight:600;color:#15803d;margin-bottom:8px;">Service Level Guide</div>
        <div style="font-size:13px;color:#166534;line-height:1.6;">
          <strong>95%+</strong> — Premium service, typical for healthcare/pharma and DTC e-commerce.<br>
          <strong>90-95%</strong> — Standard for CPG big-box and industrial distribution.<br>
          <strong>85-90%</strong> — Acceptable for bulk/commodity, cost-optimized networks.<br>
          <strong>&lt;85%</strong> — Risk zone. Consider adding facilities or relaxing transit requirements.
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('input[data-svc]').forEach(input => {
    const handler = (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.svc;
      if (key === 'hardConstraint') {
        serviceConfig[key] = /** @type {HTMLInputElement} */ (e.target).checked;
      } else {
        serviceConfig[key] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
    };
    input.addEventListener('change', handler);
  });
}

// ============================================================
// MAP VIEW
// ============================================================

function renderMap(el) {
  // Run scenario first to get assignments for flow lines
  if (!activeScenario) {
    const result = calc.evaluateScenario('Preview', facilities, demands, modeMix, rateCard, serviceConfig);
    activeScenario = result;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <h3 class="text-section" style="margin:0;">Network Map</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">
          ${facilities.filter(f => f.isOpen).length} facilities • ${demands.length} demand points • ${activeScenario?.assignments?.length || 0} lanes
        </span>
        <div style="margin-left:auto;display:flex;gap:6px;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-map-toggle="heat" checked style="margin:0;"/> Heatmap
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-map-toggle="zones" checked style="margin:0;"/> Service zones
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-map-toggle="flows" checked style="margin:0;"/> Flow lines
          </label>
        </div>
      </div>
      <div id="no-map-container" style="flex:1;min-height:500px;border-radius:10px;border:1px solid var(--ies-gray-200);overflow:hidden;"></div>
      <div style="display:flex;gap:20px;margin-top:12px;font-size:11px;color:var(--ies-gray-400);">
        <span><span style="display:inline-block;width:12px;height:12px;background:var(--ies-blue);border-radius:50%;vertical-align:middle;"></span> Facility (open)</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:var(--ies-gray-300);border-radius:50%;vertical-align:middle;"></span> Facility (closed)</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:var(--ies-orange);border-radius:50%;vertical-align:middle;"></span> Demand point</span>
        <span><span style="display:inline-block;width:20px;height:2px;background:#22c55e;vertical-align:middle;"></span> SLA met</span>
        <span><span style="display:inline-block;width:20px;height:2px;background:#ef4444;vertical-align:middle;border-style:dashed;border-width:1px 0;"></span> SLA missed</span>
      </div>
    </div>
  `;

  // Initialize Leaflet map
  requestAnimationFrame(() => initMap());
}

function initMap() {
  const container = rootEl?.querySelector('#no-map-container');
  if (!container) return;

  // Clean up previous map
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  // Check if Leaflet is loaded
  if (typeof L === 'undefined') {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">
        <div style="text-align:center;">
          <div style="font-size:20px;margin-bottom:8px;">Map requires Leaflet.js</div>
          <div>Add Leaflet CSS + JS to index.html to enable the network map view.</div>
        </div>
      </div>
    `;
    return;
  }

  mapInstance = L.map(container).setView([39.8283, -98.5795], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap'
  }).addTo(mapInstance);

  // Layer groups so toggles can show/hide each class of overlay
  const zoneLayer = L.layerGroup().addTo(mapInstance);
  const flowLayer = L.layerGroup().addTo(mapInstance);
  let heatLayer = null;
  if (typeof L.heatLayer === 'function') {
    const heatPoints = demands.map(d => [d.lat, d.lng, Math.min(1, (d.annualDemand || 0) / 200000)]);
    heatLayer = L.heatLayer(heatPoints, {
      radius: 28, blur: 22, minOpacity: 0.35, maxZoom: 10,
      gradient: { 0.2: '#2563eb', 0.4: '#7c3aed', 0.6: '#ea580c', 0.8: '#dc2626', 1.0: '#b91c1c' },
    }).addTo(mapInstance);
  }
  // Wire up layer toggles.
  rootEl?.querySelectorAll('[data-map-toggle]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.currentTarget);
      const key = t.dataset.mapToggle;
      const on = t.checked;
      if (key === 'zones') on ? mapInstance.addLayer(zoneLayer) : mapInstance.removeLayer(zoneLayer);
      else if (key === 'flows') on ? mapInstance.addLayer(flowLayer) : mapInstance.removeLayer(flowLayer);
      else if (key === 'heat' && heatLayer) on ? mapInstance.addLayer(heatLayer) : mapInstance.removeLayer(heatLayer);
    });
  });

  // Facility markers
  const facColors = ['#0047AB', '#22c55e', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];
  const openFacs = facilities.filter(f => f.isOpen);

  facilities.forEach((f, i) => {
    const color = f.isOpen ? facColors[i % facColors.length] : '#9ca3af';
    const marker = L.circleMarker([f.lat, f.lng], {
      radius: 10, fillColor: color, color: '#fff', weight: 2, fillOpacity: f.isOpen ? 0.9 : 0.4,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>${f.name}</strong><br>${f.city}, ${f.state}<br>Capacity: ${(f.capacity || 0).toLocaleString()}<br>${f.isOpen ? 'OPEN' : 'CLOSED'}`);

    // Service zone circle (approximate 2-day radius for open facilities)
    if (f.isOpen) {
      // Rough estimate: ~500 miles at 50 mph = 10 hours → ~1 day, so 2-day = ~800 miles
      const radiusMiles = 800;
      const radiusMeters = radiusMiles * 1609.34;
      L.circle([f.lat, f.lng], {
        radius: radiusMeters,
        color: color,
        weight: 1,
        opacity: 0.2,
        fillColor: color,
        fillOpacity: 0.08,
      }).addTo(zoneLayer);
    }
  });

  // Demand markers
  demands.forEach(d => {
    const marker = L.circleMarker([d.lat, d.lng], {
      radius: Math.max(3, Math.min(8, d.annualDemand / 10000)),
      fillColor: '#ff3a00', color: '#ff3a00', weight: 1, fillOpacity: 0.6,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>ZIP3: ${d.zip3 || '—'}</strong><br>Demand: ${d.annualDemand.toLocaleString()}/yr<br>Max transit: ${d.maxDays || 3} days`);
  });

  // Flow lines from assignments
  if (activeScenario?.assignments) {
    activeScenario.assignments.forEach(a => {
      const fac = facilities.find(f => f.id === a.facilityId);
      const dem = demands.find(d => d.id === a.demandId);
      if (!fac || !dem) return;

      // Color by mode (TL = blue, LTL = orange, Parcel = purple); fall back to SLA color
      let modeColor = a.meetsSlA ? '#22c55e' : '#ef4444';
      if (a.tlCost > 0 && a.tlCost <= a.ltlCost && a.tlCost <= a.parcelCost) modeColor = '#0047AB';
      else if (a.ltlCost > 0 && a.ltlCost <= a.tlCost && a.ltlCost <= a.parcelCost) modeColor = '#ea580c';
      else if (a.parcelCost > 0) modeColor = '#7c3aed';
      const line = L.polyline([[fac.lat, fac.lng], [dem.lat, dem.lng]], {
        color: modeColor, weight: 1.5, opacity: 0.5, dashArray: a.meetsSlA ? null : '5,5',
      }).addTo(flowLayer);
      line.bindPopup(`${fac.name} → ZIP ${dem.zip3}<br>Distance: ${calc.formatMiles(a.distanceMiles)}<br>Transit: ${a.transitDays} day(s)<br>Cost: ${calc.formatCurrency(a.blendedCost)}`);
    });
  }

  // Fit bounds
  const allPoints = [...facilities.map(f => [f.lat, f.lng]), ...demands.map(d => [d.lat, d.lng])];
  if (allPoints.length > 0) {
    mapInstance.fitBounds(allPoints, { padding: [30, 30] });
  }
}

// ============================================================
// RESULTS VIEW
// ============================================================

function renderResults(el) {
  if (!activeScenario) {
    el.innerHTML = `<div class="hub-card"><p class="text-body text-muted">Run a scenario first to see results here.</p></div>`;
    return;
  }

  const s = activeScenario;
  const slaColor = s.serviceLevel >= 95 ? '#22c55e' : s.serviceLevel >= 90 ? '#f59e0b' : '#ef4444';

  el.innerHTML = `
    <div style="max-width:1000px;">
      <h3 class="text-section" style="margin-bottom:16px;">${s.name}</h3>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Total Cost', calc.formatCurrency(s.totalCost, { compact: true }))}
          ${kpi('Cost/Unit', calc.formatCurrency(s.avgCostPerUnit))}
          ${kpi('Avg Distance', calc.formatMiles(s.avgDistance))}
          ${kpi('Service Level', calc.formatPct(s.serviceLevel), slaColor)}
          ${kpi('SLA Met', `${s.slaMet}/${s.slaTotal}`)}
          ${kpi('Total Demand', s.totalDemand.toLocaleString())}
        </div>
      </div>

      <!-- Cost Breakdown -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px;">
        ${costCard('Facility Costs', s.costBreakdown.facility, s.totalCost)}
        ${costCard('Transportation', s.costBreakdown.transport, s.totalCost)}
        ${costCard('Handling', s.costBreakdown.handling, s.totalCost)}
      </div>

      <!-- Primary Actions -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        <button class="hub-btn hub-btn-primary hub-btn-sm" id="no-push-fleet" style="display:flex;align-items:center;gap:6px;">
          📊 Push to Fleet
        </button>
      </div>

      <!-- Assignment Table -->
      <div class="hub-card" style="padding:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <span style="font-size:14px;font-weight:700;">Lane Assignments</span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${s.assignments.length} lanes</span>
        </div>
        <div style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead style="position:sticky;top:0;background:#fff;">
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:6px;">Facility</th>
                <th style="text-align:left;padding:6px;">Demand</th>
                <th style="text-align:right;padding:6px;">Distance</th>
                <th style="text-align:right;padding:6px;">Transit</th>
                <th style="text-align:right;padding:6px;">TL Cost</th>
                <th style="text-align:right;padding:6px;">LTL Cost</th>
                <th style="text-align:right;padding:6px;">Parcel</th>
                <th style="text-align:right;padding:6px;">Blended</th>
                <th style="text-align:center;padding:6px;">SLA</th>
              </tr>
            </thead>
            <tbody>
              ${s.assignments.map(a => {
                const fac = facilities.find(f => f.id === a.facilityId);
                const dem = demands.find(d => d.id === a.demandId);
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);">
                    <td style="padding:6px;font-weight:600;">${fac?.name || a.facilityId}</td>
                    <td style="padding:6px;">ZIP ${dem?.zip3 || a.demandId}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatMiles(a.distanceMiles)}</td>
                    <td style="padding:6px;text-align:right;">${a.transitDays}d</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.tlCost)}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.ltlCost)}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.parcelCost)}</td>
                    <td style="padding:6px;text-align:right;font-weight:600;">${calc.formatCurrency(a.blendedCost)}</td>
                    <td style="padding:6px;text-align:center;">
                      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${a.meetsSlA ? '#22c55e' : '#ef4444'};"></span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Bind Push to Fleet button
  el.querySelector('#no-push-fleet')?.addEventListener('click', () => {
    if (!activeScenario) return;
    pushToFleet(activeScenario);
  });
}

function pushToFleet(scenario) {
  if (!scenario || !scenario.assignments) return;

  // Build lanes array from assignments
  const lanes = scenario.assignments.map(a => {
    const fac = facilities.find(f => f.id === a.facilityId);
    const dem = demands.find(d => d.id === a.demandId);
    if (!fac || !dem) return null;

    return {
      origin: fac,
      destination: dem,
      weeklyShipments: Math.ceil(dem.annualDemand / 52),
      avgWeightLbs: dem.avgWeight || 25,
      avgCubeFt3: (dem.avgWeight || 25) / 10, // Rough estimate: 1 cu ft per 10 lbs
      distanceMiles: a.distanceMiles,
    };
  }).filter(Boolean);

  // Emit event for Fleet Modeler to listen
  bus.emit('netopt:push-to-fleet', { lanes, sourceScenario: scenario.name });
  showNoToast(`Pushed ${lanes.length} lanes to Fleet Modeler`, 'success');
}

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

function costCard(label, amount, total) {
  const pct = total > 0 ? (amount / total) * 100 : 0;
  return `
    <div class="hub-card" style="padding:16px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);margin-bottom:8px;">${label}</div>
      <div style="font-size:20px;font-weight:800;margin-bottom:8px;">${calc.formatCurrency(amount, { compact: true })}</div>
      <div style="height:6px;border-radius:3px;background:var(--ies-gray-200);overflow:hidden;">
        <div style="height:100%;width:${Math.min(100, pct)}%;background:var(--ies-blue);border-radius:3px;"></div>
      </div>
      <div style="font-size:11px;color:var(--ies-gray-400);margin-top:4px;">${pct.toFixed(1)}% of total</div>
    </div>
  `;
}

// ============================================================
// COMPARISON VIEW
// ============================================================

function renderComparison(el) {
  // Show multi-DC comparison if available, otherwise show scenario comparison
  if (comparisonResults && comparisonResults.length > 0) {
    renderMultiDCComparison(el);
  } else if (scenarios.length === 0) {
    el.innerHTML = `
      <div class="hub-card">
        <p class="text-body text-muted">No scenarios to compare yet. Use "Compare 1-5 DCs" or "Add to Comparison" in the sidebar to build your comparison set.</p>
      </div>
    `;
    return;
  } else {
    renderScenarioComparison(el);
  }
}

function renderMultiDCComparison(el) {
  const rec = calc.recommendOptimalDCs(comparisonResults);

  el.innerHTML = `
    <div style="max-width:1200px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">DC Network Comparison (1-5 facilities)</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${comparisonResults.length} scenario(s)</span>
      </div>

      <!-- Recommendation Panel -->
      <div class="hub-card" style="margin-bottom:20px;background:linear-gradient(135deg,#f0fdf4,#f0f9ff);border:1px solid #22c55e;padding:16px 20px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <span style="font-size:20px;">✓</span>
          <span style="font-size:14px;font-weight:700;color:#059669;">RECOMMENDED</span>
        </div>
        <div style="font-size:13px;color:var(--ies-gray-700);line-height:1.6;margin-bottom:12px;">
          <strong>${rec.recommendedIdx + 1} Distribution Centers:</strong> ${rec.recommendation}
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;">
          <div style="background:#fff;padding:12px 16px;border-radius:6px;border:1px solid #22c55e;">
            <div style="font-size:11px;color:var(--ies-gray-500);font-weight:600;text-transform:uppercase;">Annual Savings</div>
            <div style="font-size:18px;font-weight:800;color:#059669;">${calc.formatCurrency(rec.savings, { compact: true })}</div>
            <div style="font-size:10px;color:var(--ies-gray-500);">${calc.formatPct(rec.savingsPct)} vs 1 DC</div>
          </div>
        </div>
      </div>

      <!-- Comparison Table -->
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:800px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);background:#f9fafb;">
              <th style="text-align:left;padding:10px 8px;font-weight:700;">DCs</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Avg Distance</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Annual Freight</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Transit Days</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Service Level</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Savings vs 1 DC</th>
              <th style="text-align:center;padding:10px 8px;font-weight:700;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${comparisonResults.map((s, i) => {
              const baseline = comparisonResults[0].totalCost;
              const savings = baseline - s.totalCost;
              const savingsPct = baseline > 0 ? (savings / baseline) * 100 : 0;
              const isRecommended = i === rec.recommendedIdx;

              return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);background:${isRecommended ? '#f0fdf4' : 'transparent'};">
                  <td style="padding:10px 8px;font-weight:700;color:var(--ies-navy);">${i + 1}</td>
                  <td style="padding:10px 8px;text-align:right;">${calc.formatMiles(s.avgDistance)}</td>
                  <td style="padding:10px 8px;text-align:right;">${calc.formatCurrency(s.costBreakdown.transport, { compact: true })}</td>
                  <td style="padding:10px 8px;text-align:right;">${s.assignments.length > 0 ? (s.assignments.reduce((sum, a) => sum + a.transitDays, 0) / s.assignments.length).toFixed(1) : '—'} days</td>
                  <td style="padding:10px 8px;text-align:right;font-weight:600;color:${s.serviceLevel >= 95 ? '#22c55e' : s.serviceLevel >= 90 ? '#f59e0b' : '#ef4444'};">${calc.formatPct(s.serviceLevel)}</td>
                  <td style="padding:10px 8px;text-align:right;font-weight:700;${savings < 0 ? 'color:#ef4444;' : 'color:#22c55e;'}">${savings >= 0 ? '+' : ''}${calc.formatCurrency(savings, { compact: true })}</td>
                  <td style="padding:10px 8px;text-align:center;">
                    ${isRecommended ? '<span style="display:inline-block;padding:4px 12px;background:#22c55e;color:#fff;border-radius:12px;font-size:11px;font-weight:700;">RECOMMENDED</span>' : ''}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost Comparison Chart -->
      <div class="hub-card" style="margin-top:20px;padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Total Cost by DC Count</div>
        <div style="display:flex;align-items:flex-end;gap:12px;height:200px;align-items:flex-end;">
          ${comparisonResults.map((s, i) => {
            const maxCost = Math.max(...comparisonResults.map(r => r.totalCost));
            const pct = maxCost > 0 ? (s.totalCost / maxCost) * 100 : 0;
            const isRecommended = i === rec.recommendedIdx;

            return `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;">
                <div style="width:100%;background:${isRecommended ? '#22c55e' : '#3b82f6'};border-radius:6px 6px 0 0;height:${pct}%;transition:all 0.3s;" title="${calc.formatCurrency(s.totalCost)}"></div>
                <div style="font-size:12px;font-weight:700;color:var(--ies-navy);">${i + 1} DC</div>
                <div style="font-size:10px;color:var(--ies-gray-500);">${calc.formatCurrency(s.totalCost, { compact: true })}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderScenarioComparison(el) {
  const compared = calc.compareScenarios(scenarios);

  el.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Scenario Comparison</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${scenarios.length} scenario(s)</span>
      </div>

      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:900px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Scenario</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Total Cost</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Δ Cost%</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Cost/Unit</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Facility</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Transport</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Handling</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Dist</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Service</th>
              <th style="text-align:center;padding:8px 6px;font-weight:700;">Verdict</th>
            </tr>
          </thead>
          <tbody>
            ${compared.map(s => {
              const verdictColor = {
                'OPTIMAL': '#22c55e', 'BEST COST': '#0047AB', 'BEST SERVICE': '#8b5cf6',
                'VIABLE': '#6b7280', 'SLA RISK': '#ef4444',
              }[s.verdict] || '#6b7280';

              return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);">
                  <td style="padding:8px 6px;font-weight:600;">${s.name}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.totalCost, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;color:${s.deltaPct > 0 ? '#ef4444' : '#22c55e'};">${s.deltaPct > 0 ? '+' : ''}${s.deltaPct.toFixed(1)}%</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.avgCostPerUnit)}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.costBreakdown.facility, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.costBreakdown.transport, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.costBreakdown.handling, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatMiles(s.avgDistance)}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatPct(s.serviceLevel)}</td>
                  <td style="padding:8px 6px;text-align:center;">
                    <span style="display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${verdictColor};color:#fff;">${s.verdict}</span>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost comparison bar chart -->
      <div class="hub-card" style="margin-top:20px;padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Cost Comparison</div>
        ${compared.map(s => {
          const maxCost = Math.max(...compared.map(sc => sc.totalCost));
          const pct = maxCost > 0 ? (s.totalCost / maxCost) * 100 : 0;
          const verdictColor = {
            'OPTIMAL': '#22c55e', 'BEST COST': '#0047AB', 'BEST SERVICE': '#8b5cf6',
            'VIABLE': '#6b7280', 'SLA RISK': '#ef4444',
          }[s.verdict] || '#6b7280';

          return `
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;">${s.name}</span>
                <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(s.totalCost, { compact: true })}</span>
              </div>
              <div style="height:24px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;position:relative;">
                <div style="height:100%;width:${pct}%;background:${verdictColor};border-radius:6px;transition:width 0.3s;"></div>
                <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:${pct > 60 ? '#fff' : 'var(--ies-gray-600)'};">
                  ${calc.formatPct(s.serviceLevel)} SLA
                </span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}
