/**
 * IES Hub v3 — Warehouse Sizing Calculator UI
 * Builder-pattern layout: config panel on left, capacity dashboard + visualizations on right.
 * 3-way view toggle: Dashboard / Elevation / 3D.
 *
 * @module tools/warehouse-sizing/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sL';
import { state } from '../../shared/state.js?v=20260418-sL';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sL';
import { showToast } from '../../shared/toast.js?v=20260418-sL';
import { renderToolHeader, bindPrimaryActionShortcut, flashRunButton } from '../../shared/tool-frame.js?v=20260418-sL';
import * as calc from './calc.js?v=20260418-sL';
import * as api from './api.js?v=20260418-sL';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'dashboard' | 'elevation' | '3d'} */
let activeView = 'dashboard';

/** @type {import('./types.js?v=20260418-sL').FacilityConfig} */
let facility = createDefaultFacility();

/** @type {import('./types.js?v=20260418-sL').ZoneConfig} */
let zones = createDefaultZones();

/** @type {import('./types.js?v=20260418-sL').VolumeInputs} */
let volumes = createDefaultVolumes();

/** @type {boolean} */
let isDirty = false;

/** @type {{ dispose?: () => void } | null} */
let scene3d = null;

/** @type {'landing' | 'editor'} — landing shows saved scenarios; editor is the design surface */
let viewMode = 'landing';

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Warehouse Sizing Calculator.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeView = 'dashboard';
  facility = createDefaultFacility();
  zones = createDefaultZones();
  volumes = createDefaultVolumes();
  viewMode = 'landing';

  // Listen for CM → WSC push — when CM asks to open a specific scenario,
  // jump straight to the editor with that config loaded.
  bus.on('cm:push-to-wsc', async (data) => {
    viewMode = 'editor';
    handleCmPush(data);
  });

  await renderLanding();
  bus.emit('wsc:mounted');
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Warehouse Sizing',
    toolKey: 'wsc',
    accent: '#0047AB',
    list: () => api.listConfigs(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.config_data?.name || 'Untitled facility',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle: (r) => {
      const d = r.config_data || {};
      const sqft = d.totalSqft ? `${(d.totalSqft / 1000).toFixed(0)}K sf` : null;
      const city = d.city || d.state || d.name;
      return [sqft, city].filter(Boolean).join(' · ');
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteConfig(row.id); },
    onCopy: async (row) => {
      const clone = { ...row };
      delete clone.id; delete clone.created_at; delete clone.updated_at;
      clone.name = (clone.name || 'Facility') + ' (Copy)';
      await api.saveConfig(clone);
    },
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Size a facility from peak pallets, SKU count, turn rate, and clearance height. Every scenario you save can be linked back to a cost model or deal.',
  });
}

/** Open the editor, optionally pre-loading a saved scenario. */
function openEditor(savedRow) {
  if (!rootEl) return;
  viewMode = 'editor';
  if (savedRow) {
    const data = savedRow.config_data || savedRow;
    facility = { ...createDefaultFacility(), ...data, id: savedRow.id, parent_cost_model_id: savedRow.parent_cost_model_id || null };
    zones = { ...createDefaultZones(), ...(data.zones || {}) };
    volumes = { ...createDefaultVolumes(), ...(data.volumes || {}) };
  } else {
    facility = createDefaultFacility();
    zones = createDefaultZones();
    volumes = createDefaultVolumes();
  }
  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderConfigPanel();
  renderContentView();
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  bus.clear('cm:push-to-wsc');
  if (scene3d?.dispose) scene3d.dispose();
  scene3d = null;
  rootEl = null;
  bus.emit('wsc:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  const tabs = [
    { key: 'dashboard', label: 'Dashboard', title: 'Capacity dashboard with utilization metrics' },
    { key: 'plan', label: '2D — Plan', title: 'Top-down floorplan showing dock doors, storage, zones' },
    { key: 'elevation', label: '2D — Elevation', title: 'Cross-section showing rack levels and clearances' },
    { key: '3d', label: '3D View', title: 'Interactive 3D model of the facility layout' },
  ];
  const chips = [
    { label: facility.id ? 'Saved' : 'Draft', kind: facility.id ? 'saved' : 'draft', dot: true },
    facility.parent_cost_model_id
      ? { label: `Linked to CM`, kind: 'linked', title: `Linked to Cost Model #${facility.parent_cost_model_id}` }
      : { label: 'Stand-alone', kind: 'standalone', title: 'Not yet pushed into a Cost Model' },
  ];
  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height: calc(100vh - 48px);">
      ${renderToolHeader({
        toolName: 'Warehouse Sizing',
        toolKey: 'wsc',
        backAction: 'wsc-back',
        tabs,
        activeTab: activeView,
        tabsId: 'wsc-tabs',
        statusChips: chips,
        primaryAction: { label: 'Use in Cost Model →', action: 'push-to-cm', icon: '⇨', title: 'Push this design into a Cost Model (Cmd/Ctrl+Enter)' },
      })}

      <div class="hub-builder" style="flex:1;min-height:0;display:grid;grid-template-columns:300px 1fr;">
        <!-- Config Sidebar -->
        <div class="hub-builder-sidebar" id="wsc-config" style="overflow-y:auto;border-right:1px solid var(--ies-gray-200);">
          <!-- Config content renders here -->
        </div>

        <!-- Content Area -->
        <div class="hub-builder-content" style="display:flex; flex-direction:column;min-height:0;">
          <!-- View Content -->
          <div id="wsc-content" style="flex:1; overflow-y:auto; padding:24px;">
            <!-- View content renders here -->
          </div>
        </div>
      </div>
    </div>

    <style>
      .wsc-view-btn {
        padding: 6px 14px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        background: #fff;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: var(--ies-gray-500);
        cursor: pointer;
        transition: all 0.15s;
      }
      .wsc-view-btn:hover { border-color: var(--ies-blue); color: var(--ies-blue); }
      .wsc-view-btn.active { background: var(--ies-blue); color: #fff; border-color: var(--ies-blue); }

      .wsc-config-section {
        padding: 16px;
        border-bottom: 1px solid var(--ies-gray-100);
      }
      .wsc-config-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        margin-bottom: 12px;
      }
      .wsc-config-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 8px;
      }
      .wsc-config-field label {
        display: block;
        font-size: 11px;
        font-weight: 600;
        color: var(--ies-gray-500);
        margin-bottom: 3px;
      }
      .wsc-config-field input, .wsc-config-field select {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
      }
      /* Checkboxes should not stretch — they inherit the wsc-config-field rule otherwise */
      .wsc-config-field input[type="checkbox"] {
        width: auto;
        padding: 0;
        border: none;
        margin: 0;
        flex-shrink: 0;
      }
      /* Single-field rows within optional zones render as a 1-col grid, not 2-col */
      .wsc-config-section .wsc-config-row.single-col {
        grid-template-columns: 1fr;
      }
      .wsc-config-field input:focus, .wsc-config-field select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 2px rgba(0,71,171,0.1);
      }

      .wsc-util-bar {
        height: 8px;
        border-radius: 4px;
        background: var(--ies-gray-100);
        overflow: hidden;
        margin: 4px 0;
      }
      .wsc-util-fill {
        height: 100%;
        border-radius: 4px;
        transition: width 0.3s;
      }
    </style>
  `;
}

function bindShellEvents() {
  // View toggle (now uses [data-tab] from shared tool-frame)
  rootEl?.querySelector('#wsc-tabs')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-tab]');
    if (!btn) return;
    activeView = /** @type {any} */ (btn.dataset.tab);
    rootEl?.querySelectorAll('#wsc-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeView);
    });
    renderContentView();
  });

  // Push to CM — primary action
  const headerRun = rootEl?.querySelector('[data-primary-action="push-to-cm"]');
  headerRun?.addEventListener('click', () => { pushToCm(); flashRunButton(headerRun); });
  bindPrimaryActionShortcut(rootEl, 'push-to-cm');
}

// ============================================================
// CONFIG PANEL (LEFT SIDEBAR)
// ============================================================

/**
 * Debounce helper: delays execution until ms has passed without new calls.
 * @param {Function} fn
 * @param {number} [ms=100]
 * @returns {Function}
 */
function debounceRender(fn, ms = 100) {
  let timeoutId = null;
  return function debounced(...args) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, ms);
  };
}

function renderConfigPanel() {
  const panel = rootEl?.querySelector('#wsc-config');
  if (!panel) return;

  panel.innerHTML = `
    <!-- Toolbar -->
    <div style="padding:12px 16px; border-bottom:1px solid var(--ies-gray-200);">
      <div class="text-subtitle" style="margin-bottom:8px;">Warehouse Sizing</div>
      <div class="flex gap-2" style="flex-wrap:wrap;">
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-back" title="Back to saved scenarios">← Scenarios</button>
        <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="wsc-save">Save</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-new">New</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-copy-summary" title="Copy summary to clipboard">Copy</button>
      </div>
      <div style="margin-top:10px;">
        <div style="font-size:10px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Quick-Start Presets</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
          ${['Retail','F&B','Pharma','Apparel','Auto','Ecomm'].map(p => `
            <button type="button" class="hub-btn hub-btn-sm" data-preset="${p}" style="font-size:10px;padding:4px 6px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);color:var(--ies-gray-700);font-weight:700;">${p}</button>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Building -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Building</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Facility Name</label>
        <input value="${facility.name}" data-fac="name" />
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Total SF</label><input type="number" value="${facility.totalSqft}" data-fac="totalSqft" /></div>
        <div class="wsc-config-field"><label>Clear Ht (ft)</label><input type="number" value="${facility.clearHeight}" step="1" data-fac="clearHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Width (ft)</label><input type="number" value="${facility.buildingWidth}" data-fac="buildingWidth" /></div>
        <div class="wsc-config-field"><label>Depth (ft)</label><input type="number" value="${facility.buildingDepth}" data-fac="buildingDepth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field">
          <label>Storage Type</label>
          <select data-fac="storageType">
            ${['single', 'double', 'bulk', 'carton', 'mix'].map(s =>
              `<option value="${s}"${facility.storageType === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="wsc-config-field"><label>Aisle Width (ft)</label><input type="number" value="${facility.aisleWidth || calc.AISLE_WIDTHS[facility.storageType] || 12}" step="0.5" data-fac="aisleWidth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Col Spacing (ft)</label><input type="number" value="${facility.columnSpacingX || 50}" data-fac="columnSpacingX" /></div>
      </div>
    </div>

    <!-- Pallet Dims -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Pallet Dimensions (in)</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Width</label><input type="number" value="${facility.palletWidth ?? 48}" data-fac="palletWidth" /></div>
        <div class="wsc-config-field"><label>Depth</label><input type="number" value="${facility.palletDepth ?? 40}" data-fac="palletDepth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Load Height</label><input type="number" value="${facility.palletHeight ?? 54}" data-fac="palletHeight" /></div>
        <div class="wsc-config-field"><label>Beam Ht</label><input type="number" value="${facility.beamHeight ?? 5}" data-fac="beamHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Flue Space</label><input type="number" value="${facility.flueSpace ?? 3}" data-fac="flueSpace" /></div>
        <div class="wsc-config-field"><label>Top Clear</label><input type="number" value="${facility.topClearance ?? 36}" data-fac="topClearance" /></div>
      </div>
    </div>

    <!-- Zones -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Zone Allocation (SF)</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Office</label><input type="number" value="${zones.officeSqft}" data-zone="officeSqft" /></div>
        <div class="wsc-config-field"><label>Recv Staging</label><input type="number" value="${zones.receiveStagingSqft}" data-zone="receiveStagingSqft" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Ship Staging</label><input type="number" value="${zones.shipStagingSqft}" data-zone="shipStagingSqft" /></div>
        <div class="wsc-config-field"><label>Charging</label><input type="number" value="${zones.chargingSqft}" data-zone="chargingSqft" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Repack/VAS</label><input type="number" value="${zones.repackSqft}" data-zone="repackSqft" /></div>
        <div class="wsc-config-field"><label>Other</label><input type="number" value="${zones.otherSqft || 0}" data-zone="otherSqft" /></div>
      </div>
    </div>

    <!-- Volumes -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Volume Requirements</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Pallet Positions</label><input type="number" value="${volumes.totalPallets}" data-vol="totalPallets" /></div>
        <div class="wsc-config-field"><label>Total SKUs</label><input type="number" value="${volumes.totalSKUs}" data-vol="totalSKUs" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Inv Turns/Yr</label><input type="number" value="${volumes.inventoryTurns}" step="1" data-vol="inventoryTurns" /></div>
        <div class="wsc-config-field"><label>Peak Multiplier</label><input type="number" value="${volumes.peakMultiplier}" step="0.1" data-vol="peakMultiplier" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Daily Inbound</label><input type="number" value="${volumes.avgDailyInbound}" data-vol="avgDailyInbound" /></div>
        <div class="wsc-config-field"><label>Daily Outbound</label><input type="number" value="${volumes.avgDailyOutbound}" data-vol="avgDailyOutbound" /></div>
      </div>
    </div>

    <!-- Storage Type Allocation -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Storage Type Allocation (%)</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Full Pallet: <span id="wsc-alloc-fp" style="font-weight:700;">${(zones.storageAllocation?.fullPallet || 60)}%</span></label>
        <input type="range" min="0" max="100" value="${zones.storageAllocation?.fullPallet || 60}" data-alloc="fullPallet" style="width:100%;" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Carton on Pallet: <span id="wsc-alloc-cp" style="font-weight:700;">${(zones.storageAllocation?.cartonOnPallet || 30)}%</span></label>
        <input type="range" min="0" max="100" value="${zones.storageAllocation?.cartonOnPallet || 30}" data-alloc="cartonOnPallet" style="width:100%;" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Carton on Shelving: <span id="wsc-alloc-cs" style="font-weight:700;">${(zones.storageAllocation?.cartonOnShelving || 10)}%</span></label>
        <input type="range" min="0" max="100" value="${zones.storageAllocation?.cartonOnShelving || 10}" data-alloc="cartonOnShelving" style="width:100%;" />
      </div>
    </div>

    <!-- Product Dimensions -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Product Dimensions</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Units/Pallet</label><input type="number" value="${zones.productDimensions?.unitsPerPallet || 48}" data-prod="unitsPerPallet" /></div>
        <div class="wsc-config-field"><label>Cartons/Pallet</label><input type="number" value="${zones.productDimensions?.cartonsPerPallet || 12}" data-prod="cartonsPerPallet" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Units/Carton</label><input type="number" value="${zones.productDimensions?.unitsPerCartonPallet || 6}" data-prod="unitsPerCartonPallet" /></div>
        <div class="wsc-config-field"><label>Units/Shelf</label><input type="number" value="${zones.productDimensions?.unitsPerCartonShelving || 6}" data-prod="unitsPerCartonShelving" /></div>
      </div>
    </div>

    <!-- Dock Configuration -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Dock Configuration</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Dock Layout</label>
        <select data-dock="sided">
          <option value="single"${zones.dockConfig?.sided === 'single' ? ' selected' : ''}>Single-Sided</option>
          <option value="two"${zones.dockConfig?.sided === 'two' ? ' selected' : ''}>Two-Sided</option>
        </select>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Inbound Doors</label><input type="number" value="${zones.dockConfig?.inboundDoors || 10}" data-dock="inboundDoors" /></div>
        <div class="wsc-config-field"><label>Outbound Doors</label><input type="number" value="${zones.dockConfig?.outboundDoors || 12}" data-dock="outboundDoors" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Pallets/Hr/Door</label><input type="number" value="${zones.dockConfig?.palletsPerDockHour || 12}" step="1" data-dock="palletsPerDockHour" /></div>
        <div class="wsc-config-field"><label>Operating Hrs</label><input type="number" value="${zones.dockConfig?.dockOperatingHours || 10}" step="0.5" data-dock="dockOperatingHours" /></div>
      </div>
    </div>

    <!-- Inventory Parameters -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Inventory Parameters</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Peak Units/Day</label><input type="number" value="${zones.peakUnitsPerDay || 500000}" data-inv="peakUnitsPerDay" /></div>
        <div class="wsc-config-field"><label>Avg Units/Day</label><input type="number" value="${zones.avgUnitsPerDay || 350000}" data-inv="avgUnitsPerDay" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Operating Days/Yr</label><input type="number" value="${zones.operatingDaysPerYear || 250}" data-inv="operatingDaysPerYear" /></div>
      </div>
    </div>

    <!-- Forward Pick -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Forward Pick Area</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" ${zones.forwardPick?.enabled ? 'checked' : ''} data-fwd="enabled" style="margin:0;" />
          <span>Enable Forward Pick</span>
        </label>
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px; display:${zones.forwardPick?.enabled ? 'block' : 'none'};" id="wsc-fwd-opts">
        <label>Pick Type</label>
        <select data-fwd="type">
          <option value="carton_flow"${zones.forwardPick?.type === 'carton_flow' ? ' selected' : ''}>Carton Flow</option>
          <option value="light_case"${zones.forwardPick?.type === 'light_case' ? ' selected' : ''}>Light Case</option>
          <option value="heavy_case"${zones.forwardPick?.type === 'heavy_case' ? ' selected' : ''}>Heavy Case</option>
        </select>
      </div>
      <div class="wsc-config-row" style="display:${zones.forwardPick?.enabled ? 'grid' : 'none'};" id="wsc-fwd-params">
        <div class="wsc-config-field"><label>SKU Count</label><input type="number" value="${zones.forwardPick?.skuCount || 2000}" data-fwd="skuCount" /></div>
        <div class="wsc-config-field"><label>Days Inventory</label><input type="number" value="${zones.forwardPick?.daysInventory || 3}" step="0.5" data-fwd="daysInventory" /></div>
      </div>
      <div class="wsc-config-field" style="display:${zones.forwardPick?.enabled ? 'block' : 'none'}; margin-top:8px;" id="wsc-fwd-outbound">
        <label>Outbound Units/Day</label>
        <input type="number" value="${zones.forwardPick?.outboundUnitsPerDay || 5000}" data-fwd="outboundUnitsPerDay" />
      </div>
    </div>

    <!-- Optional Zones -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Optional Zones</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" ${zones.optionalZones?.vas?.enabled ? 'checked' : ''} data-opt="vas-enabled" style="margin:0;" />
          <span>VAS</span>
        </label>
      </div>
      <div class="wsc-config-row single-col" id="wsc-opt-vas-row" style="display:${zones.optionalZones?.vas?.enabled ? 'grid' : 'none'};">
        <div class="wsc-config-field"><label>VAS SF</label><input type="number" value="${zones.optionalZones?.vas?.sqft || 0}" data-opt="vas-sqft" /></div>
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" ${zones.optionalZones?.returns?.enabled ? 'checked' : ''} data-opt="returns-enabled" style="margin:0;" />
          <span>Returns</span>
        </label>
      </div>
      <div class="wsc-config-row single-col" id="wsc-opt-returns-row" style="display:${zones.optionalZones?.returns?.enabled ? 'grid' : 'none'};">
        <div class="wsc-config-field"><label>Returns SF</label><input type="number" value="${zones.optionalZones?.returns?.sqft || 0}" data-opt="returns-sqft" /></div>
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" ${zones.optionalZones?.chargeback?.enabled ? 'checked' : ''} data-opt="chargeback-enabled" style="margin:0;" />
          <span>Chargeback</span>
        </label>
      </div>
      <div class="wsc-config-row single-col" id="wsc-opt-chargeback-row" style="display:${zones.optionalZones?.chargeback?.enabled ? 'grid' : 'none'};">
        <div class="wsc-config-field"><label>Chargeback SF</label><input type="number" value="${zones.optionalZones?.chargeback?.sqft || 0}" data-opt="chargeback-sqft" /></div>
      </div>
    </div>

    <!-- Custom Zones -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Custom Zones</div>
      <div id="wsc-custom-zones-list" style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px;">
        ${(zones.customZones || []).map((z, i) => `
          <div style="display:flex; gap:4px; align-items:center;">
            <input type="text" value="${z.name}" data-custom-name="${i}" placeholder="Zone name" style="flex:1; padding:4px 6px; border:1px solid var(--ies-gray-200); border-radius:4px; font-size:11px;" />
            <input type="number" value="${z.sqft}" data-custom-sqft="${i}" min="0" placeholder="SF" style="width:80px; padding:4px 6px; border:1px solid var(--ies-gray-200); border-radius:4px; font-size:11px;" />
            <button data-custom-remove="${i}" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:18px; padding:0; line-height:1;">×</button>
          </div>
        `).join('')}
      </div>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-add-custom-zone" style="width:100%;">+ Add Custom Zone</button>
    </div>
  `;

  bindConfigEvents(panel);
}

function bindConfigEvents(panel) {
  const debouncedRender = debounceRender(renderContentView, 100);

  // Facility fields (with input debounce for live update)
  panel.querySelectorAll('[data-fac]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fac;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      facility[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Zone fields (with input debounce for live update)
  panel.querySelectorAll('[data-zone]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.zone;
      zones[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Volume fields (with input debounce for live update)
  panel.querySelectorAll('[data-vol]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.vol;
      volumes[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Storage allocation sliders
  panel.querySelectorAll('[data-alloc]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!zones.storageAllocation) zones.storageAllocation = { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      zones.storageAllocation[field] = val;
      // Update display label
      const label = panel.querySelector(`#wsc-alloc-${field.slice(0, 2)}`);
      if (label) label.textContent = val + '%';
      isDirty = true;
      renderContentView();
    });
    input.addEventListener('input', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      const label = panel.querySelector(`#wsc-alloc-${field.slice(0, 2)}`);
      if (label) label.textContent = val + '%';
    });
  });

  // Product dimension fields (with input debounce for live update)
  panel.querySelectorAll('[data-prod]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.prod;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!zones.productDimensions) zones.productDimensions = { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 };
      zones.productDimensions[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Dock configuration fields (with input debounce for live update)
  panel.querySelectorAll('[data-dock]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.dock;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      if (!zones.dockConfig) zones.dockConfig = { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 };
      zones.dockConfig[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Inventory parameters (with input debounce for live update)
  panel.querySelectorAll('[data-inv]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.inv;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      zones[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Forward pick fields (with input debounce for live update)
  panel.querySelectorAll('[data-fwd]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fwd;
      if (!zones.forwardPick) zones.forwardPick = { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 };
      if (field === 'enabled') {
        zones.forwardPick[field] = /** @type {HTMLInputElement} */ (e.target).checked;
        const opts = panel.querySelector('#wsc-fwd-opts');
        const params = panel.querySelector('#wsc-fwd-params');
        const outbound = panel.querySelector('#wsc-fwd-outbound');
        if (opts) opts.style.display = zones.forwardPick.enabled ? 'block' : 'none';
        if (params) params.style.display = zones.forwardPick.enabled ? 'grid' : 'none';
        if (outbound) outbound.style.display = zones.forwardPick.enabled ? 'block' : 'none';
      } else {
        const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
        zones.forwardPick[field] = val;
      }
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Optional zone fields (with input debounce for live update)
  panel.querySelectorAll('[data-opt]').forEach(input => {
    const handleChange = (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.opt;
      if (!zones.optionalZones) zones.optionalZones = { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } };
      if (key.endsWith('-enabled')) {
        const zone = key.replace('-enabled', '');
        zones.optionalZones[zone].enabled = /** @type {HTMLInputElement} */ (e.target).checked;
        const sqftDiv = panel.querySelector(`#wsc-opt-${zone}-row`);
        if (sqftDiv) sqftDiv.style.display = zones.optionalZones[zone].enabled ? 'grid' : 'none';
      } else if (key.endsWith('-sqft')) {
        const zone = key.replace('-sqft', '');
        zones.optionalZones[zone].sqft = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Custom zone management (with input debounce for live update)
  panel.querySelectorAll('[data-custom-name], [data-custom-sqft]').forEach(input => {
    const handleChange = (e) => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.customName || /** @type {HTMLInputElement} */ (e.target).dataset.customSqft);
      if (!zones.customZones) zones.customZones = [];
      if (e.target.dataset.customName !== undefined) {
        zones.customZones[idx].name = /** @type {HTMLInputElement} */ (e.target).value;
      } else {
        zones.customZones[idx].sqft = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  panel.querySelectorAll('[data-custom-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const idx = parseInt(/** @type {HTMLElement} */ (e.target).dataset.customRemove);
      if (zones.customZones) zones.customZones.splice(idx, 1);
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    });
  });

  panel.querySelector('[data-action="wsc-add-custom-zone"]')?.addEventListener('click', () => {
    if (!zones.customZones) zones.customZones = [];
    zones.customZones.push({ name: `Custom Zone ${zones.customZones.length + 1}`, sqft: 2000 });
    isDirty = true;
    renderConfigPanel();
    renderContentView();
  });

  // Toolbar
  panel.querySelector('[data-action="wsc-new"]')?.addEventListener('click', () => {
    if (isDirty && !confirm('Unsaved changes. Start new?')) return;
    facility = createDefaultFacility();
    zones = createDefaultZones();
    volumes = createDefaultVolumes();
    isDirty = false;
    renderConfigPanel();
    renderContentView();
  });

  panel.querySelector('[data-action="wsc-back"]')?.addEventListener('click', async () => {
    if (isDirty && !confirm('Unsaved changes. Leave for the scenarios list?')) return;
    isDirty = false;
    viewMode = 'landing';
    await renderLanding();
  });

  // Copy-summary button
  panel.querySelector('[data-action="wsc-copy-summary"]')?.addEventListener('click', () => {
    copySummaryToClipboard();
  });

  // Quick-start presets
  panel.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const preset = /** @type {HTMLElement} */ (e.currentTarget).dataset.preset;
      applyVerticalPreset(preset);
    });
  });

  panel.querySelector('[data-action="wsc-save"]')?.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const saved = await api.saveConfig({ ...facility, zones, volumes });
      facility.id = saved.id || saved[0]?.id || facility.id;
      isDirty = false;
      bus.emit('wsc:saved', { id: facility.id });
      btn.textContent = '✓ Saved';
      showWscToast(`Saved "${facility.name || 'Untitled'}"`, 'success');
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    } catch (err) {
      console.error('[WSC] Save failed:', err);
      btn.textContent = orig;
      btn.disabled = false;
      showWscToast('Save failed: ' + err.message, 'error');
    }
  });

  panel.querySelector('[data-action="wsc-load"]')?.addEventListener('click', async () => {
    try {
      const configs = await api.listConfigs();
      if (!configs.length) { showWscToast('No saved configs yet.', 'info'); return; }
      const names = configs.map((c, i) => `${i + 1}. ${c.name || c.config_data?.name || 'Untitled'}`).join('\n');
      const choice = prompt('Select config:\n' + names);
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < configs.length) {
        const data = configs[idx].config_data || configs[idx];
        facility = { ...createDefaultFacility(), ...data, id: configs[idx].id };
        zones = { ...createDefaultZones(), ...data.zones };
        volumes = { ...createDefaultVolumes(), ...data.volumes };
        isDirty = false;
        renderConfigPanel();
        renderContentView();
        showWscToast(`Loaded "${facility.name || 'Untitled'}"`, 'success');
      }
    } catch (err) {
      console.error('[WSC] Load failed:', err);
      showWscToast('Load failed: ' + err.message, 'error');
    }
  });
}

/** True when the user has entered enough volume data to compute a meaningful SF recommendation. */
function hasMeaningfulVolumes(v) {
  if (!v) return false;
  const pallets = v.totalPallets || 0;
  const skus = v.totalSKUs || 0;
  const daily = (v.avgDailyInbound || 0) + (v.avgDailyOutbound || 0);
  return pallets > 0 || skus > 0 || daily > 0;
}

/** Non-blocking success/error toast (bottom-right, 4s). */
/**
 * Vertical quick-start presets — adjust facility scale, storage allocation,
 * and dock config to a typical baseline for the chosen vertical. Users can
 * still tune any field after applying.
 * @param {string} preset
 */
function applyVerticalPreset(preset) {
  const presets = {
    'Retail': {
      totalSqft: 350000, clearHeight: 36, inboundDoors: 19, outboundDoors: 19,
      storageAlloc: { fullPallet: 55, cartonOnPallet: 30, cartonOnShelving: 15 },
      peakUnitsPerDay: 350000, avgUnitsPerDay: 220000,
    },
    'F&B': {
      totalSqft: 250000, clearHeight: 32, inboundDoors: 16, outboundDoors: 16,
      storageAlloc: { fullPallet: 75, cartonOnPallet: 20, cartonOnShelving: 5 },
      peakUnitsPerDay: 220000, avgUnitsPerDay: 160000,
    },
    'Pharma': {
      totalSqft: 180000, clearHeight: 36, inboundDoors: 9, outboundDoors: 9,
      storageAlloc: { fullPallet: 30, cartonOnPallet: 30, cartonOnShelving: 40 },
      peakUnitsPerDay: 180000, avgUnitsPerDay: 130000,
    },
    'Apparel': {
      totalSqft: 280000, clearHeight: 36, inboundDoors: 12, outboundDoors: 12,
      storageAlloc: { fullPallet: 25, cartonOnPallet: 35, cartonOnShelving: 40 },
      peakUnitsPerDay: 280000, avgUnitsPerDay: 180000,
    },
    'Auto': {
      totalSqft: 320000, clearHeight: 32, inboundDoors: 15, outboundDoors: 15,
      storageAlloc: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
      peakUnitsPerDay: 200000, avgUnitsPerDay: 150000,
    },
    'Ecomm': {
      totalSqft: 600000, clearHeight: 40, inboundDoors: 25, outboundDoors: 25,
      storageAlloc: { fullPallet: 30, cartonOnPallet: 40, cartonOnShelving: 30 },
      peakUnitsPerDay: 800000, avgUnitsPerDay: 500000,
    },
  };
  const p = presets[preset];
  if (!p) return;
  facility.totalSqft = p.totalSqft;
  facility.clearHeight = p.clearHeight;
  zones.dockConfig = { ...zones.dockConfig, inboundDoors: p.inboundDoors, outboundDoors: p.outboundDoors };
  zones.storageAllocation = { ...zones.storageAllocation, ...p.storageAlloc };
  zones.peakUnitsPerDay = p.peakUnitsPerDay;
  zones.avgUnitsPerDay = p.avgUnitsPerDay;
  isDirty = true;
  renderConfigPanel();
  renderContentView();
  showWscToast(`Applied ${preset} preset`, 'success');
}

/** Copy an English summary of the current config to the clipboard. */
function copySummaryToClipboard() {
  const dock = zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = dock.inboundDoors + dock.outboundDoors;
  const summary = [
    `Warehouse Sizing — ${facility.name || 'Untitled'}`,
    `Total SF: ${facility.totalSqft.toLocaleString()}`,
    `Building: ${facility.buildingWidth} × ${facility.buildingDepth} ft, clear ${facility.clearHeight} ft`,
    `Storage: ${facility.storageType}, aisle ${facility.aisleWidth || ''} ft`,
    `Dock: ${dock.inboundDoors} inbound + ${dock.outboundDoors} outbound = ${totalDoors} doors`,
    `Storage Allocation: ${zones.storageAllocation?.fullPallet || 0}% pallet · ${zones.storageAllocation?.cartonOnPallet || 0}% carton-on-pallet · ${zones.storageAllocation?.cartonOnShelving || 0}% carton-on-shelving`,
    `Volumes: peak ${(zones.peakUnitsPerDay || 0).toLocaleString()}/day · avg ${(zones.avgUnitsPerDay || 0).toLocaleString()}/day`,
  ].join('\n');
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(summary).then(
      () => showWscToast('Summary copied to clipboard', 'success'),
      () => showWscToast('Clipboard write failed', 'error'),
    );
  } else {
    showWscToast('Clipboard not available', 'error');
  }
}

function showWscToast(message, level) {
  const color = level === 'error' ? '#dc2626' : level === 'info' ? '#2563eb' : '#16a34a';
  const bg    = level === 'error' ? '#fef2f2' : level === 'info' ? '#eff6ff' : '#f0fdf4';
  const existing = document.getElementById('wsc-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'wsc-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 16px;border-radius:8px;border:1px solid ${color};background:${bg};color:${color};font-size:13px;font-weight:600;z-index:9999;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.12);`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}

// ============================================================
// CONTENT VIEW RENDERING
// ============================================================

function renderContentView() {
  const container = rootEl?.querySelector('#wsc-content');
  if (!container) return;

  // Clean up 3D scene if switching away
  if (activeView !== '3d' && scene3d) {
    scene3d.dispose();
    scene3d = null;
  }

  switch (activeView) {
    case 'dashboard': container.innerHTML = renderDashboard(); break;
    case 'plan':
      container.innerHTML = renderPlan();
      requestAnimationFrame(() => drawPlan());
      break;
    case 'elevation':
      container.innerHTML = renderElevation();
      requestAnimationFrame(() => drawElevation());
      break;
    case '3d': render3DView(container); break;
  }
}

// ============================================================
// 2D PLAN VIEW (Top-down floorplan)
// ============================================================

function renderPlan() {
  const storage = calc.computeStorage(facility, zones);
  return `
    <div class="hub-card">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom: var(--sp-2);">
        <h3 class="text-subtitle" style="margin:0;">Floorplan (Top-Down)</h3>
        <span class="text-caption text-muted">Scale: 1 px ≈ ${Math.max(1, Math.round(Math.sqrt((facility.totalSqft || 0) * 1.5) / 800))} ft</span>
      </div>
      <canvas id="wsc-plan-canvas" width="900" height="520" style="width:100%; border:1px solid var(--ies-gray-200); border-radius:6px; background:#fff;"></canvas>
      <div style="margin-top:var(--sp-3); display:flex; flex-wrap:wrap; gap:16px; font-size:11px; color:var(--ies-gray-500);">
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#eff6ff;border:1px solid #93c5fd;border-radius:2px;"></span>Storage</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:2px;"></span>Receive Staging</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#fef3c7;border:1px solid #fcd34d;border-radius:2px;"></span>Ship Staging</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#f3e8ff;border:1px solid #c4b5fd;border-radius:2px;"></span>Office</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#ffedd5;border:1px solid #fdba74;border-radius:2px;"></span>Charging</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#fecaca;border:1px solid #f87171;border-radius:2px;"></span>Dock Door</span>
      </div>
    </div>
  `;
}

function drawPlan() {
  const canvas = rootEl?.querySelector('#wsc-plan-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  const totalSqft = facility.totalSqft || 0;
  if (totalSqft <= 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Set facility Total SF to render the floorplan.', cw / 2, ch / 2);
    return;
  }

  // Pull sized facility numbers so this view agrees with the dashboard.
  const sized = calc.sizeFacility(toSizingInputs());
  const elev = calc.elevationParams(facility);

  // Building dimensions (ft)
  const widthFt  = facility.buildingWidth  || Math.round(Math.sqrt(totalSqft * 1.5));
  const depthFt  = facility.buildingDepth  || Math.round(totalSqft / Math.max(1, widthFt));

  // Fit-to-canvas with padding for dimension labels
  const padX = 60, padY = 60;
  const usableW = cw - padX * 2;
  const usableH = ch - padY * 2;
  const pxPerFt = Math.min(usableW / widthFt, usableH / depthFt);

  const Wpx = widthFt * pxPerFt;
  const Hpx = depthFt * pxPerFt;
  const X0  = (cw - Wpx) / 2;
  const Y0  = (ch - Hpx) / 2;

  // ---------- Outer shell ----------
  ctx.fillStyle = '#fafafa';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 2;
  ctx.fillRect(X0, Y0, Wpx, Hpx);
  ctx.strokeRect(X0, Y0, Wpx, Hpx);

  // ---------- Compute zone strips along the dock face (front = bottom edge) ----------
  // Layout convention (top-down view):
  //   Top edge      = back of building
  //   Bottom edge   = dock face (where trucks pull up)
  //   Strip just inside dock face (bottom)  = Ship Staging  (sized.shipStagingSqft)
  //   Strip just below back-wall (top)      = Receive Staging (sized.recvStagingSqft) — only if non-zero
  //   Front-left corner inside ship staging = Office (overlay)
  //   Storage racks fill the rest of the interior
  const shipFrac  = Math.min(0.30, (sized.shipStagingSqft / Math.max(1, sized.totalSqft)));
  const recvFrac  = Math.min(0.18, (sized.recvStagingSqft / Math.max(1, sized.totalSqft)));
  const officeFrac= Math.min(0.18, (sized.officeSqft     / Math.max(1, sized.totalSqft)));

  const shipHpx  = Math.max(20, shipFrac  * Hpx);
  const recvHpx  = recvFrac > 0.01 ? Math.max(16, recvFrac * Hpx) : 0;
  const officeWpx= Math.max(40, officeFrac * Wpx);
  const officeHpx= Math.min(shipHpx * 0.9, 80);

  const storageY = Y0 + recvHpx;
  const storageH = Hpx - recvHpx - shipHpx;

  // ---------- Storage rack rows ----------
  // Honest geometry: back-to-back rack pairs with aisles between them.
  // Module width = 2 × rackDepth + aisle (roughly 12 ft + 12 ft = 24 ft per module).
  const rackDepthFt = elev.rackDepthFt || 4.3;
  const aisleFt     = (facility.aisleWidth || elev.aisleWidth || 12);
  // Visual module = back-to-back pair (~2× depth) + aisle on one side.
  const moduleFt    = (2 * rackDepthFt) + aisleFt;
  const rackPx      = rackDepthFt * pxPerFt;
  const aislePx     = aisleFt * pxPerFt;
  const modulePx    = moduleFt * pxPerFt;
  // Margin from side walls so racks don't run into the walls.
  const sideMarginPx = Math.max(8, 6 * pxPerFt);

  // Light storage background
  ctx.fillStyle = '#f0f7ff';
  ctx.fillRect(X0 + 2, storageY, Wpx - 4, storageH);

  // Draw the rack rows
  ctx.fillStyle = '#ff8c42';
  ctx.strokeStyle = '#c2410c';
  ctx.lineWidth = 1;
  let mx = X0 + sideMarginPx;
  let rackCount = 0;
  while (mx + 2 * rackPx + aislePx < X0 + Wpx - sideMarginPx) {
    // Back-to-back pair: two thin rectangles separated by a small gap, then an aisle
    // Leave 8 ft endcap clearance from staging zones above / below
    const racksTop    = storageY + 8 * pxPerFt;
    const racksBottom = storageY + storageH - 8 * pxPerFt;
    const racksH      = Math.max(0, racksBottom - racksTop);
    if (racksH > 0) {
      ctx.fillRect(mx, racksTop, rackPx, racksH);
      ctx.strokeRect(mx, racksTop, rackPx, racksH);
      ctx.fillRect(mx + rackPx + 2, racksTop, rackPx, racksH);
      ctx.strokeRect(mx + rackPx + 2, racksTop, rackPx, racksH);
    }
    rackCount += 2;
    mx += modulePx;
  }

  // Storage label
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 12px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(
    `Storage  ·  ${calc.formatSqft(sized.storageSqft)}  ·  ${rackCount} rack rows  ·  ${aisleFt} ft aisles`,
    X0 + sideMarginPx,
    storageY + 14,
  );

  // ---------- Receive Staging strip (top) ----------
  if (recvHpx > 0) {
    ctx.fillStyle = '#ecfdf5';
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 1;
    ctx.fillRect(X0 + 2, Y0 + 2, Wpx - 4, recvHpx - 2);
    ctx.strokeRect(X0 + 2, Y0 + 2, Wpx - 4, recvHpx - 2);
    ctx.fillStyle = '#166534';
    ctx.font = 'bold 11px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Receive Staging  ·  ${calc.formatSqft(sized.recvStagingSqft)}`, X0 + Wpx / 2, Y0 + recvHpx / 2 + 4);
  }

  // ---------- Ship Staging strip (bottom, just inside dock face) ----------
  ctx.fillStyle = '#fffbeb';
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 1;
  ctx.fillRect(X0 + 2, Y0 + Hpx - shipHpx, Wpx - 4, shipHpx - 2);
  ctx.strokeRect(X0 + 2, Y0 + Hpx - shipHpx, Wpx - 4, shipHpx - 2);
  ctx.fillStyle = '#92400e';
  ctx.font = 'bold 11px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Ship Staging  ·  ${calc.formatSqft(sized.shipStagingSqft)}`, X0 + Wpx / 2, Y0 + Hpx - shipHpx / 2 + 4);

  // ---------- Office (front-left corner, overlapping the ship staging strip) ----------
  if (officeFrac > 0.005) {
    const ox = X0 + 4;
    const oy = Y0 + Hpx - shipHpx + 4;
    ctx.fillStyle = '#f5f3ff';
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 1;
    ctx.fillRect(ox, oy, officeWpx, officeHpx);
    ctx.strokeRect(ox, oy, officeWpx, officeHpx);
    ctx.fillStyle = '#5b21b6';
    ctx.font = 'bold 10px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    if (officeWpx > 70 && officeHpx > 24) {
      ctx.fillText('Office', ox + officeWpx / 2, oy + officeHpx / 2 - 2);
      ctx.fillStyle = '#6b21a8';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.fillText(`${calc.formatSqft(sized.officeSqft)}`, ox + officeWpx / 2, oy + officeHpx / 2 + 12);
    }
  }

  // ---------- Dock doors at bottom edge, aligned with ship staging ----------
  // Use the sized engine's door count so this view agrees with the KPI bar.
  const totalDoors = sized.dock.totalDoors || 0;
  const inboundDoors = sized.dock.inboundDoors || 0;
  const outboundDoors = sized.dock.outboundDoors || 0;
  const twoSided = facility.dockConfig === 'two';

  function drawDoorRow(count, yTop, label, color) {
    if (count <= 0) return;
    const doorWPx  = Math.max(6, 8 * pxPerFt);  // 8 ft door
    const doorSpcPx= Math.max(10, 12 * pxPerFt); // 12 ft on-center
    const totalDoorW = count * doorSpcPx;
    const startX = X0 + (Wpx - totalDoorW) / 2;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = 1;
    for (let i = 0; i < count; i++) {
      const x = startX + i * doorSpcPx + (doorSpcPx - doorWPx) / 2;
      ctx.fillRect(x, yTop, doorWPx, 12);
      ctx.strokeRect(x, yTop, doorWPx, 12);
    }
    ctx.fillStyle = '#7f1d1d';
    ctx.font = 'bold 10px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, X0 + Wpx / 2, yTop + 28);
  }

  if (twoSided) {
    drawDoorRow(outboundDoors, Y0 + Hpx - 6, `${outboundDoors} Outbound Doors`, '#fecaca');
    drawDoorRow(inboundDoors,  Y0 - 6,        `${inboundDoors} Inbound Doors`,  '#bfdbfe');
  } else {
    // Single-sided: combine inbound + outbound on the bottom face
    drawDoorRow(totalDoors, Y0 + Hpx - 6, `${totalDoors} Dock Doors (combined I/O)`, '#fecaca');
  }

  // ---------- Building dimension labels ----------
  ctx.fillStyle = '#374151';
  ctx.font = '11px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${widthFt.toLocaleString()} ft`, X0 + Wpx / 2, Y0 + Hpx + 44);
  ctx.save();
  ctx.translate(X0 - 22, Y0 + Hpx / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${depthFt.toLocaleString()} ft`, 0, 0);
  ctx.restore();

  // Compass / orientation
  ctx.fillStyle = '#6b7280';
  ctx.font = '10px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('▲ BACK', X0 + 4, Y0 - 8);
  ctx.fillText('▼ DOCK FACE', X0 + 4, Y0 + Hpx + 22);

  // Title block (top-left, outside building)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(facility.name || 'Facility', 12, 22);
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Montserrat, sans-serif';
  ctx.fillText(
    `${calc.formatSqft(sized.totalSqft)} sized  ·  ${calc.formatSqft(facility.totalSqft || 0)} existing  ·  clear ht ${facility.clearHeight || 0} ft`,
    12, 38,
  );

  // Scale bar + building dimension labels
  ctx.fillStyle = '#6b7280';
  ctx.font = '10px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${widthFt.toLocaleString()} ft`, offsetX + buildingWpx / 2, offsetY + buildingHpx + 36);
  ctx.save();
  ctx.translate(offsetX - 16, offsetY + buildingHpx / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${depthFt.toLocaleString()} ft`, 0, 0);
  ctx.restore();

  // Title
  ctx.fillStyle = '#111827';
  ctx.font = 'bold 12px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(facility.name || 'Facility', 12, 22);
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Montserrat, sans-serif';
  ctx.fillText(`${(totalSqft).toLocaleString()} sqft · clear ht ${facility.clearHeight || 0} ft`, 12, 38);
}

// ============================================================
// DASHBOARD VIEW
// ============================================================

/**
 * Convert the UI's (facility, zones, volumes) state into SizingInputs
 * for the v2-equivalent calc.sizeFacility engine.
 * @returns {import('./calc.js?v=20260418-sL').SizingInputs}
 */
function toSizingInputs() {
  const alloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
  const prod = zones.productDimensions || {};
  const dock = zones.dockConfig || {};
  const fp = zones.forwardPick || null;
  const opt = zones.optionalZones || {};
  const aisleMap = { 12: 'wide', 10: 'narrow', 6: 'vna' };
  const aisleType = aisleMap[Math.round(facility.aisleWidth || 0)] || 'narrow';

  const optionalZones = [];
  if (opt.vas?.enabled) optionalZones.push({ label: 'VAS / Kitting', sqft: opt.vas.sqft || 0 });
  if (opt.returns?.enabled) optionalZones.push({ label: 'Returns / QC', sqft: opt.returns.sqft || 0 });
  if (opt.chargeback?.enabled) optionalZones.push({ label: 'Chargeback', sqft: opt.chargeback.sqft || 0 });
  if (zones.chargingSqft > 0) optionalZones.push({ label: 'Charging / Maint.', sqft: zones.chargingSqft });
  if (zones.repackSqft > 0) optionalZones.push({ label: 'Repack', sqft: zones.repackSqft });

  return {
    peakUnits: zones.peakUnitsPerDay || 500000,
    avgUnits: zones.avgUnitsPerDay || 350000,
    outboundUnitsYr: (zones.avgUnitsPerDay || 0) * (zones.operatingDaysPerYear || 250),
    operatingDaysYr: zones.operatingDaysPerYear || 250,
    fullPalletPct: (alloc.fullPallet || 0) / 100,
    cartonOnPalletPct: (alloc.cartonOnPallet || 0) / 100,
    cartonOnShelvingPct: (alloc.cartonOnShelving || 0) / 100,
    unitsPerPallet: prod.unitsPerPallet || 48,
    unitsPerCartonPal: prod.unitsPerCartonPallet || 6,
    cartonsPerPallet: prod.cartonsPerPallet || 12,
    unitsPerCartonShelv: prod.unitsPerCartonShelving || 6,
    cartonsPerLocation: prod.cartonsPerLocation || 4,
    clearHeightFt: facility.clearHeight || 36,
    loadHeightIn: facility.palletHeight || 48,
    sprinklerClearanceIn: facility.topClearance || 18,
    storeType: facility.storageType || 'single',
    aisleType,
    bulkDepth: 4,
    stackHi: 3,
    mixRackPct: 0.70,
    honeycombPct: 10,
    surgePct: 20,
    inPalletsDay: volumes.avgDailyInbound || 200,
    outPalletsDay: volumes.avgDailyOutbound || 200,
    palletsPerDoorHour: dock.palletsPerDockHour || 20,
    dockHours: dock.dockOperatingHours || 8,
    dockConfig: dock.sided === 'two' ? 'two' : 'one',
    availableWallFt: 0,
    officePct: (facility.totalSqft && zones.officeSqft)
      ? Math.max(0.02, Math.min(0.15, zones.officeSqft / facility.totalSqft))
      : 0.05,
    forwardPick: fp && fp.enabled ? {
      enabled: true,
      skus: fp.skuCount || 0,
      activePickPct: 20,                    // audit default — full UI for this is in B-series
      pickType: fp.type === 'heavy_case' ? 'pallet' : 'carton',
      daysInventory: fp.daysInventory || 3,
    } : null,
    optionalZones,
    customZones: (zones.customZones || []).map(z => ({ label: z.name || 'Custom', sqft: z.sqft || 0 })),
  };
}

function renderDashboard() {
  const storage = calc.computeStorage(facility, zones);
  const summary = calc.computeCapacitySummary(facility, zones, volumes);
  const dock = calc.dockUtilization(facility.dockDoors, volumes.avgDailyInbound, volumes.avgDailyOutbound, volumes.peakMultiplier);
  const dockAnalysis = calc.calcDockAnalysis(facility, zones, volumes);
  const storageByType = calc.calcStorageByType(facility, zones);
  const dioh = calc.calcDIOH(zones);
  const fwdPick = calc.calcForwardPick(zones);
  const correctedSf = calc.calcSuggestedSF(facility, zones, volumes);
  const zoneBD = calc.zoneBreakdown(zones);
  const elev = calc.elevationParams(facility);

  // v2-equivalent volume-first sizing (the engine we actually trust).
  const sized = calc.sizeFacility(toSizingInputs());

  return `
    <!-- KPI Bar — Sized Facility (v2-equivalent volume-first engine) -->
    <div class="hub-kpi-bar mb-6">
      <div class="hub-kpi-item"><div class="hub-kpi-label">Sized Total SF</div><div class="hub-kpi-value" title="Sum of pallet storage + carton shelving + dock + staging + zones + office, computed from peak units / mix / dock throughput. v2-equivalent engine.">${calc.formatSqft(sized.totalSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Storage SF</div><div class="hub-kpi-value">${calc.formatSqft(sized.storageSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Gross Positions</div><div class="hub-kpi-value" title="Designed positions + ${sized.utilization.designed > 0 ? Math.round((sized.positions.surgePositions / sized.utilization.designed) * 100) : 0}% surge buffer">${sized.positions.grossPositions.toLocaleString()}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Rack Levels</div><div class="hub-kpi-value">${sized.rackLevels}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Dock Doors</div><div class="hub-kpi-value" title="${sized.dock.inboundDoors} in + ${sized.dock.outboundDoors} out, +25% surge buffer">${sized.dock.totalDoors}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Avg Util</div><div class="hub-kpi-value" style="color:${sized.utilization.warning === 'high_util' ? 'var(--ies-red)' : sized.utilization.warning === 'low_util' ? 'var(--ies-orange)' : 'var(--ies-green)'};" title="Avg inventory positions / designed positions">${sized.utilization.utilizationPct}%</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Existing Bldg SF</div><div class="hub-kpi-value" style="color:${facility.totalSqft >= sized.totalSqft ? 'var(--ies-green)' : 'var(--ies-red)'};" title="Compare existing building Total SF to Sized Total SF — green = adequate, red = under-sized">${calc.formatSqft(facility.totalSqft)}</div></div>
    </div>

    <!-- Sized Facility Recommendation Card -->
    <div class="hub-card mb-6" style="border-left:4px solid var(--ies-blue);padding:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div class="text-section" style="margin:0;">${calc.formatSqft(sized.totalSqft)} Facility — ${calc.labelForStoreType(sized.storageDetail.storeType)}</div>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">${escapeHtml(sized.storageDetail.layoutDescription)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">SF / Position</div>
          <div style="font-size:20px;font-weight:800;">${sized.sfPerPosition.toFixed(1)}</div>
        </div>
      </div>

      <table class="cm-grid-table" style="font-size:13px;width:100%;">
        <tbody>
          <tr><td colspan="2" style="padding-top:8px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;">Inventory → Positions</td></tr>
          <tr><td>Full Pallet (${Math.round(sized.meta.normalisedMix.fullPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.fullPalletPositions.toLocaleString()} pos</td></tr>
          <tr><td>Carton on Pallet (${Math.round(sized.meta.normalisedMix.cartonOnPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.cartonPalletPositions.toLocaleString()} pos</td></tr>
          <tr><td>Carton Shelving (${Math.round(sized.meta.normalisedMix.cartonOnShelvingPct * 100)}%)</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()} loc</td></tr>
          <tr><td><strong>Designed (post-honeycomb)</strong></td><td class="cm-num"><strong>${sized.utilization.designed.toLocaleString()} pos</strong></td></tr>
          <tr><td>+ Surge buffer</td><td class="cm-num">${sized.positions.surgePositions.toLocaleString()} pos</td></tr>
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Gross Positions</strong></td><td class="cm-num"><strong>${sized.positions.grossPositions.toLocaleString()}</strong></td></tr>

          <tr><td colspan="2" style="padding-top:14px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;">Zone Breakdown</td></tr>
          ${sized.zoneBreakdown.map(z => `
            <tr><td>${escapeHtml(z.label)}</td><td class="cm-num">${calc.formatSqft(z.sqft)} <span style="color:var(--ies-gray-400);font-size:11px;">${z.pct}%</span></td></tr>
          `).join('')}
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Total Facility</strong></td><td class="cm-num"><strong>${calc.formatSqft(sized.totalSqft)}</strong></td></tr>
        </tbody>
      </table>

      ${sized.utilization.warning === 'high_util' ? `
        <div style="margin-top:12px;padding:10px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#92400e;font-size:12px;">
          ⚠ <strong>High Utilization (${sized.utilization.utilizationPct}%)</strong> — limited operational flexibility for receiving surges and seasonal peaks. Consider increasing facility size or reducing peak inventory assumptions.
        </div>
      ` : sized.utilization.warning === 'low_util' ? `
        <div style="margin-top:12px;padding:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;color:#9a3412;font-size:12px;">
          ⚠ <strong>Low Utilization (${sized.utilization.utilizationPct}%)</strong> — gap between average (${sized.utilization.avg.toLocaleString()}) and peak (${sized.utilization.peak.toLocaleString()}) is significant. Verify the facility is sized for the right scenario.
        </div>
      ` : ''}

      ${!sized.dock.dockWallOk ? `
        <div style="margin-top:8px;padding:10px;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;color:#991b1b;font-size:12px;">
          ⚠ <strong>Dock Wall Constraint:</strong> required ${sized.dock.dockWallRequiredFt} ft for ${sized.dock.totalDoors} doors at 12' on-center spacing exceeds available wall length (${sized.dock.dockWallAvailableFt} ft). Consider a second dock face or fewer doors.
        </div>
      ` : ''}

      ${facility.totalSqft && facility.totalSqft < sized.totalSqft ? `
        <div style="margin-top:8px;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#7f1d1d;font-size:12px;">
          Existing building (${calc.formatSqft(facility.totalSqft)}) is <strong>${calc.formatSqft(sized.totalSqft - facility.totalSqft)} under</strong> the sized requirement.
        </div>
      ` : facility.totalSqft && facility.totalSqft > sized.totalSqft * 1.05 ? `
        <div style="margin-top:8px;padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;color:#166534;font-size:12px;">
          Existing building (${calc.formatSqft(facility.totalSqft)}) has <strong>${calc.formatSqft(facility.totalSqft - sized.totalSqft)} headroom</strong> over the sized requirement.
        </div>
      ` : ''}
    </div>

    <!-- Capacity Analysis (existing-building view) -->
    <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:8px;text-transform:uppercase;font-weight:700;">Capacity Analysis (existing-building view)</div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <!-- Capacity Utilization — tied to sizing engine -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Capacity Utilization</div>
        ${renderUtilBar('Storage SF vs Existing', facility.totalSqft > 0 ? Math.round((sized.storageSqft / facility.totalSqft) * 100) : 0)}
        ${renderUtilBar('Sized SF vs Existing',   facility.totalSqft > 0 ? Math.round((sized.totalSqft   / facility.totalSqft) * 100) : 0)}
        ${renderUtilBar('Pallet Position Util',   sized.utilization.utilizationPct)}
        ${renderUtilBar('Cubic Utilization',      summary.cubicUtilizationPct)}
      </div>

      <!-- Storage Type Breakdown — same source as Sized Facility card -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Storage Type Breakdown</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Full Pallet</td><td class="cm-num">${sized.positions.fullPalletPositions.toLocaleString()}</td><td class="cm-num" style="color:var(--ies-gray-400);">pos</td></tr>
            <tr><td>Carton on Pallet</td><td class="cm-num">${sized.positions.cartonPalletPositions.toLocaleString()}</td><td class="cm-num" style="color:var(--ies-gray-400);">pos</td></tr>
            <tr><td>Carton on Shelving</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()}</td><td class="cm-num" style="color:var(--ies-gray-400);">loc</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Zone Allocation — same breakdown as Sized Facility -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Zone Allocation</div>
        <div style="display:flex; height:24px; border-radius:4px; overflow:hidden; margin-bottom:12px;">
          ${sized.zoneBreakdown.map((z, i) => {
            const palette = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
            return `<div style="width:${z.pct}%;background:${palette[i % palette.length]};" title="${escapeHtml(z.label)}"></div>`;
          }).join('')}
        </div>
        <div style="font-size:13px;">
          ${sized.zoneBreakdown.map((z, i) => {
            const palette = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
            return `
              <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:${palette[i % palette.length]};font-weight:600;">${escapeHtml(z.label)}</span>
                <span style="font-weight:700;">${calc.formatSqft(z.sqft)} <span style="color:var(--ies-gray-400);font-weight:400;font-size:11px;">${z.pct}%</span></span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Dock Analysis — tied to sizing engine so numbers match the KPI bar -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Dock Analysis</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Inbound Doors (sized)</td><td class="cm-num" style="color:var(--ies-blue);">${sized.dock.inboundDoors}</td></tr>
            <tr><td>Outbound Doors (sized)</td><td class="cm-num" style="color:var(--ies-blue);">${sized.dock.outboundDoors}</td></tr>
            <tr><td>Total Doors (incl. surge)</td><td class="cm-num" style="font-weight:700;">${sized.dock.totalDoors}</td></tr>
            <tr><td>Dock Wall Required</td><td class="cm-num" style="color:${sized.dock.dockWallOk ? 'var(--ies-green)' : 'var(--ies-red)'};">${sized.dock.dockWallRequiredFt} ft${sized.dock.dockWallOk ? '' : ` > ${sized.dock.dockWallAvailableFt} ft avail`}</td></tr>
            <tr><td>Dock Staging SF</td><td class="cm-num">${calc.formatSqft(sized.dockSqft || 0)}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Rack Geometry -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Rack Geometry</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Rack Levels</td><td class="cm-num" style="font-weight:700;">${storage.rackLevels}</td></tr>
            <tr><td>Level Height</td><td class="cm-num">${calc.formatFt(storage.positionHeight)}</td></tr>
            <tr><td>Top of Steel</td><td class="cm-num">${calc.formatFt(calc.topOfSteelFt(storage.rackLevels))}</td></tr>
            <tr><td>Usable Height</td><td class="cm-num">${calc.formatFt(storage.usableHeight)}</td></tr>
            <tr><td>Sprinkler Clearance</td><td class="cm-num">${calc.formatFt(elev.topClearanceFt)}</td></tr>
            <tr><td>Bay Width</td><td class="cm-num">${calc.formatFt(storage.bayWidth)}</td></tr>
            <tr><td>Rack Depth</td><td class="cm-num">${calc.formatFt(storage.bayDepth)}</td></tr>
            <tr><td>Aisle Width</td><td class="cm-num">${calc.formatFt(elev.aisleWidth)}</td></tr>
            <tr><td>Aisle Count</td><td class="cm-num">${storage.aisleCount}</td></tr>
            <tr><td>Bays/Aisle</td><td class="cm-num">${storage.bayCountPerAisle}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Inventory Metrics -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Inventory Metrics</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Peak Units/Day</td><td class="cm-num">${(zones.peakUnitsPerDay || 500000).toLocaleString()}</td></tr>
            <tr><td>Avg Units/Day</td><td class="cm-num">${(zones.avgUnitsPerDay || 350000).toLocaleString()}</td></tr>
            <tr><td>Operating Days/Yr</td><td class="cm-num">${(zones.operatingDaysPerYear || 250)}</td></tr>
            <tr><td>DIOH (Days)</td><td class="cm-num">${dioh.toFixed(1)}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Forward Pick -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Forward Pick Area</div>
        ${zones.forwardPick?.enabled ? `
          <table class="cm-grid-table" style="font-size:13px;">
            <tbody>
              <tr><td>Pick Type</td><td class="cm-num">${(zones.forwardPick.type || 'carton_flow').replace('_', ' ')}</td></tr>
              <tr><td>SKU Count</td><td class="cm-num">${(zones.forwardPick.skuCount || 0).toLocaleString()}</td></tr>
              <tr><td>Days Inventory</td><td class="cm-num">${(zones.forwardPick.daysInventory || 0).toFixed(1)}</td></tr>
              <tr><td>Forward Pick SF</td><td class="cm-num">${calc.formatSqft(fwdPick)}</td></tr>
            </tbody>
          </table>
        ` : `
          <div style="padding:12px; text-align:center; color:var(--ies-gray-400); font-size:13px;">
            Forward pick not enabled
          </div>
        `}
      </div>

      <!-- Size Recommendation — single source of truth: same numbers as Sized Facility card -->
      <div class="hub-card">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;">
          <div class="text-subtitle" style="margin:0;">Size Recommendation</div>
          <span style="font-size:10px;color:var(--ies-gray-400);">from sizing engine — matches dashboard KPI</span>
        </div>
        <div style="font-size:13px;">
          ${sized.zoneBreakdown.map(z => `
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
              <span>${escapeHtml(z.label)}</span>
              <span style="font-weight:700;">${calc.formatSqft(z.sqft)}</span>
            </div>
          `).join('')}
          <div style="border-top:2px solid var(--ies-blue); padding-top:8px; display:flex; justify-content:space-between;margin-top:6px;">
            <span style="font-weight:700;">Recommended Total</span>
            <span style="font-weight:700; font-size:16px; color:${!facility.totalSqft ? 'var(--ies-blue)' : (sized.totalSqft > facility.totalSqft ? 'var(--ies-red)' : 'var(--ies-green)')};">${calc.formatSqft(sized.totalSqft)}</span>
          </div>
          <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-400);line-height:1.4;">
            ${!facility.totalSqft
              ? 'Set the existing building Total SF in the Building section to compare against this recommendation.'
              : (sized.totalSqft > facility.totalSqft
                  ? `Your facility (${calc.formatSqft(facility.totalSqft)}) is <strong>${calc.formatSqft(sized.totalSqft - facility.totalSqft)} under</strong> the recommended size.`
                  : `Your facility (${calc.formatSqft(facility.totalSqft)}) has <strong>${calc.formatSqft(facility.totalSqft - sized.totalSqft)} headroom</strong> over the recommendation.`)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderUtilBar(label, pct) {
  const color = pct > 95 ? 'var(--ies-red)' : pct > 80 ? 'var(--ies-orange)' : 'var(--ies-green)';
  return `
    <div style="margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px;">
        <span style="font-weight:600;">${label}</span>
        <span style="font-weight:700; color:${color};">${calc.formatPct(pct)}</span>
      </div>
      <div class="wsc-util-bar">
        <div class="wsc-util-fill" style="width:${Math.min(100, pct)}%; background:${color};"></div>
      </div>
    </div>
  `;
}

// ============================================================
// ELEVATION VIEW (Canvas 2D)
// ============================================================

function renderElevation() {
  const elev = calc.elevationParams(facility, zones);

  return `
    <div class="hub-card">
      <div class="text-subtitle mb-4">Building Cross-Section (Elevation View)</div>
      <canvas id="wsc-elevation-canvas" width="900" height="450" style="width:100%; border:1px solid var(--ies-gray-200); border-radius:6px; background:#fff;"></canvas>
      <div style="font-size:11px; color:var(--ies-gray-400); margin-top:8px;">
        ${facility.storageType.charAt(0).toUpperCase() + facility.storageType.slice(1)}-deep racking ·
        ${elev.rackLevels} levels ·
        ${calc.formatFt(elev.aisleWidth)} aisles ·
        ${calc.formatFt(facility.clearHeight)} clear height
      </div>
    </div>
  `;
}

// Deferred: call after DOM is rendered
function drawElevation() {
  const canvas = rootEl?.querySelector('#wsc-elevation-canvas');
  if (!canvas) return;
  const ctx = /** @type {HTMLCanvasElement} */ (canvas).getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const pad = { l: 60, r: 100, t: 40, b: 60 };
  const drawW = w - pad.l - pad.r;
  const drawH = h - pad.t - pad.b;

  const elev = calc.elevationParams(facility);
  const exteriorGrade = -4;
  const maxH = elev.clearHeight + 5;
  const scaleX = drawW / (elev.buildingWidth || 1);
  const scaleY = drawH / (maxH - exteriorGrade);

  const toX = (ft) => pad.l + ft * scaleX;
  const toY = (ft) => pad.t + (maxH - ft) * scaleY;

  ctx.clearRect(0, 0, w, h);

  // Exterior grade
  ctx.fillStyle = '#e8e4d8';
  ctx.fillRect(0, toY(0), w, toY(exteriorGrade) - toY(0));

  // Building outline
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.strokeRect(toX(0), toY(elev.clearHeight), drawW, toY(0) - toY(elev.clearHeight));

  // Floor slab
  ctx.fillStyle = '#ccc';
  ctx.fillRect(toX(0), toY(0), drawW, 3);

  // Roof
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(elev.clearHeight));
  ctx.lineTo(toX(elev.buildingWidth / 2), toY(elev.clearHeight + 3));
  ctx.lineTo(toX(elev.buildingWidth), toY(elev.clearHeight));
  ctx.closePath();
  ctx.fillStyle = '#8B4513';
  ctx.fill();

  // Racks
  const levels = elev.rackLevels;
  const posH = elev.positionHeight;
  const rackD = elev.rackDepthFt;
  const aisleW = elev.aisleWidth;
  const moduleW = rackD + aisleW + rackD;
  const startX = 10; // offset from wall

  let x = startX;
  while (x + moduleW < elev.buildingWidth - 10) {
    // Left rack
    drawRackProfile(ctx, toX, toY, x, rackD, levels, posH, elev.storageType);
    // Right rack
    drawRackProfile(ctx, toX, toY, x + rackD + aisleW, rackD, levels, posH, elev.storageType);
    // Aisle label
    ctx.fillStyle = '#0047AB';
    ctx.font = '10px Montserrat';
    ctx.textAlign = 'center';
    ctx.fillText(`${aisleW}'`, toX(x + rackD + aisleW / 2), toY(0) + 14);
    x += moduleW + 2;
  }

  // Dock platform
  ctx.fillStyle = '#999';
  ctx.fillRect(toX(-5), toY(0), toX(0) - toX(-5), toY(-4) - toY(0));
  ctx.fillStyle = '#333';
  ctx.font = '10px Montserrat';
  ctx.textAlign = 'center';
  ctx.fillText('Dock', toX(-2.5), toY(-2));

  // Right-side dimension: clear height
  drawDimV(ctx, toX(elev.buildingWidth) + 20, toY(elev.clearHeight), toY(0), `${elev.clearHeight}' Clear`);
  // TOS
  const tos = calc.topOfSteelFt(levels);
  if (levels > 0) {
    drawDimV(ctx, toX(elev.buildingWidth) + 50, toY(tos), toY(0), `${tos.toFixed(1)}' TOS`);
  }

  // Bottom dimension: building width
  drawDimH(ctx, toX(0), toX(elev.buildingWidth), toY(0) + 40, `${Math.round(elev.buildingWidth)}' Width`);
}

function drawRackProfile(ctx, toX, toY, xFt, depthFt, levels, posH, storageType) {
  if (levels <= 0) return;

  // Uprights
  ctx.strokeStyle = '#ff6600';
  ctx.lineWidth = 2;
  const totalH = levels * posH;

  // Front upright
  ctx.beginPath();
  ctx.moveTo(toX(xFt), toY(0));
  ctx.lineTo(toX(xFt), toY(totalH));
  ctx.stroke();

  // Back upright
  ctx.beginPath();
  ctx.moveTo(toX(xFt + depthFt), toY(0));
  ctx.lineTo(toX(xFt + depthFt), toY(totalH));
  ctx.stroke();

  // If double-deep, middle upright
  if (storageType === 'double') {
    ctx.beginPath();
    ctx.moveTo(toX(xFt + depthFt / 2), toY(0));
    ctx.lineTo(toX(xFt + depthFt / 2), toY(totalH));
    ctx.stroke();
  }

  // Beams per level
  ctx.strokeStyle = '#ff8800';
  ctx.lineWidth = 1.5;
  for (let l = 1; l <= levels; l++) {
    const y = l * posH;
    ctx.beginPath();
    ctx.moveTo(toX(xFt), toY(y));
    ctx.lineTo(toX(xFt + depthFt), toY(y));
    ctx.stroke();
  }

  // Pallets (blue boxes)
  ctx.fillStyle = 'rgba(0,71,171,0.15)';
  for (let l = 0; l < levels; l++) {
    const baseY = l * posH;
    const palletH = posH * 0.8;
    ctx.fillRect(toX(xFt + 0.2), toY(baseY + palletH), toX(xFt + depthFt - 0.2) - toX(xFt + 0.2), toY(baseY) - toY(baseY + palletH));
  }
}

function drawDimV(ctx, x, y1, y2, label) {
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, y1); ctx.lineTo(x + 4, y1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, y2); ctx.lineTo(x + 4, y2); ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.font = '10px Montserrat';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 8, (y1 + y2) / 2 + 4);
}

function drawDimH(ctx, x1, x2, y, label) {
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2, y - 4); ctx.lineTo(x2, y + 4); ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.font = '10px Montserrat';
  ctx.textAlign = 'center';
  ctx.fillText(label, (x1 + x2) / 2, y - 8);
}

// ============================================================
// 3D VIEW (Three.js)
// ============================================================

function render3DView(container) {
  const sized = calc.sizeFacility(toSizingInputs());
  container.innerHTML = `
    <div class="hub-card" style="padding:16px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
        <h3 class="text-subtitle" style="margin:0;">3D Walkthrough</h3>
        <span class="text-caption text-muted">
          ${calc.formatSqft(sized.totalSqft)} sized  ·  ${facility.buildingWidth || '—'} × ${facility.buildingDepth || '—'} ft  ·  clear ht ${facility.clearHeight || 0} ft  ·  ${sized.dock.totalDoors} dock doors
        </span>
      </div>
      <div id="wsc-3d-container" style="width:100%; height:520px; background:#e9eef5; border-radius:6px; overflow:hidden;"></div>
      <div style="font-size:11px; color:var(--ies-gray-500); margin-top:8px;">
        Drag to orbit  ·  Scroll to zoom  ·  Racks shown at 50% opacity for floor visibility
      </div>
    </div>
  `;

  // Defer 3D scene build so the flex layout settles first.
  setTimeout(() => build3DScene(), 80);
}

function build3DScene() {
  const el = rootEl?.querySelector('#wsc-3d-container');
  if (!el) return;

  try {
    const THREE = /** @type {any} */ (window).THREE;
    if (!THREE) {
      el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">Three.js not loaded. 3D view unavailable.</div>';
      return;
    }

    const width  = el.clientWidth || 800;
    const height = el.clientHeight || 520;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e9eef5');

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    // ---------- Lighting ----------
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(120, 200, 120);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xb6c8e3, 0.25);
    fillLight.position.set(-120, 80, -120);
    scene.add(fillLight);

    // ---------- Geometry inputs ----------
    const bw = facility.buildingWidth  || 300;  // X axis
    const bd = facility.buildingDepth  || 500;  // Z axis (depth into screen)
    const ch = facility.clearHeight    || 32;
    const scale = 0.5;                          // 1 ft = 0.5 units

    const W = bw * scale;
    const D = bd * scale;
    const H = ch * scale;

    // ---------- Floor with grid ----------
    const floorGeo = new THREE.BoxGeometry(W, 0.4, D);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xd6d3d1 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.2;
    scene.add(floor);

    const grid = new THREE.GridHelper(Math.max(W, D), 20, 0x9ca3af, 0xcbd5e1);
    grid.position.y = 0.05;
    scene.add(grid);

    // ---------- Wall frame (edges only — keep interior visible) ----------
    const wallGeo = new THREE.BoxGeometry(W, H, D);
    const edges = new THREE.EdgesGeometry(wallGeo);
    const edgeLine = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4b5563, linewidth: 2 }));
    edgeLine.position.set(0, H / 2, 0);
    scene.add(edgeLine);

    // ---------- Rack rows (orange, semi-transparent so we can see through) ----------
    const elev = calc.elevationParams(facility);
    const sized = calc.sizeFacility(toSizingInputs());

    const rackDepthFt = elev.rackDepthFt || 4.3;
    const aisleFt     = facility.aisleWidth || elev.aisleWidth || 12;
    const rackHeightFt= calc.topOfSteelFt(elev.rackLevels || 5);
    const moduleFt    = (2 * rackDepthFt) + aisleFt;

    const rackDepthU  = rackDepthFt * scale;
    const moduleU     = moduleFt * scale;
    const rackHeightU = rackHeightFt * scale;

    // Reserve front (-Z, dock face) and back (+Z) margins for staging
    const stagingFt = 30;            // 30 ft staging strip front + back
    const stagingU  = stagingFt * scale;
    const rackZStart = -D / 2 + stagingU;
    const rackZEnd   =  D / 2 - stagingU;
    const rackLengthU= Math.max(0, rackZEnd - rackZStart);

    const rackMatA = new THREE.MeshStandardMaterial({ color: 0xea580c, transparent: true, opacity: 0.55 });
    const rackMatB = new THREE.MeshStandardMaterial({ color: 0xf97316, transparent: true, opacity: 0.55 });

    let mx = -W / 2 + 6 * scale;
    let rowCount = 0;
    while (mx + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
      const rackGeo = new THREE.BoxGeometry(rackDepthU, rackHeightU, rackLengthU);
      // Pair of back-to-back rows
      const r1 = new THREE.Mesh(rackGeo, rackMatA);
      r1.position.set(mx + rackDepthU / 2, rackHeightU / 2, (rackZStart + rackZEnd) / 2);
      scene.add(r1);
      const r2 = new THREE.Mesh(rackGeo, rackMatB);
      r2.position.set(mx + rackDepthU + 0.5 + rackDepthU / 2, rackHeightU / 2, (rackZStart + rackZEnd) / 2);
      scene.add(r2);
      // Subtle wireframe so the rack frames read clearly
      const wf1 = new THREE.LineSegments(new THREE.EdgesGeometry(rackGeo), new THREE.LineBasicMaterial({ color: 0x9a3412 }));
      wf1.position.copy(r1.position);
      scene.add(wf1);
      const wf2 = new THREE.LineSegments(new THREE.EdgesGeometry(rackGeo), new THREE.LineBasicMaterial({ color: 0x9a3412 }));
      wf2.position.copy(r2.position);
      scene.add(wf2);
      rowCount += 2;
      mx += moduleU;
    }

    // ---------- Dock doors along the FRONT edge (-Z) ----------
    const totalDoors = sized.dock.totalDoors || 0;
    if (totalDoors > 0) {
      const doorWFt   = 8;          // 8 ft wide
      const doorHFt   = 9;          // 9 ft tall (standard 9x10 door)
      const doorWU    = doorWFt * scale;
      const doorHU    = doorHFt * scale;
      const doorMat   = new THREE.MeshStandardMaterial({ color: 0x1f2937 });
      // Spread doors evenly across the front wall, leaving 12 ft margins
      const usableW   = W - 12 * scale * 2;
      const spacing   = usableW / (totalDoors + 1);
      for (let i = 0; i < totalDoors; i++) {
        const dx = -W / 2 + 12 * scale + spacing * (i + 1) - doorWU / 2;
        const door = new THREE.Mesh(
          new THREE.BoxGeometry(doorWU, doorHU, 0.6),
          doorMat,
        );
        door.position.set(dx + doorWU / 2, doorHU / 2, -D / 2 + 0.1);
        scene.add(door);
      }
    }

    // ---------- Office cube (front-left corner) ----------
    if (sized.officeSqft > 0) {
      const officeFt = Math.sqrt(sized.officeSqft);
      const oW = officeFt * scale;
      const oD = officeFt * scale;
      const oH = 12 * scale;       // 12 ft office ceiling
      const officeMesh = new THREE.Mesh(
        new THREE.BoxGeometry(oW, oH, oD),
        new THREE.MeshStandardMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.45 }),
      );
      officeMesh.position.set(-W / 2 + oW / 2 + 1, oH / 2, -D / 2 + oD / 2 + 1);
      scene.add(officeMesh);
      const oEdges = new THREE.LineSegments(new THREE.EdgesGeometry(officeMesh.geometry), new THREE.LineBasicMaterial({ color: 0x5b21b6 }));
      oEdges.position.copy(officeMesh.position);
      scene.add(oEdges);
    }

    // ---------- Camera ----------
    // Iso-style 3/4 view from front-right-above, looking at the building center
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    const dist0 = Math.max(W, D) * 1.4;
    let theta = Math.PI / 4;        // 45° around Y
    let phi   = Math.PI / 4;         // 45° elevation
    let dist  = dist0;
    function applyCamera() {
      camera.position.set(
        dist * Math.cos(phi) * Math.sin(theta),
        dist * Math.sin(phi),
        dist * Math.cos(phi) * Math.cos(theta),
      );
      camera.lookAt(0, H * 0.4, 0);
    }
    applyCamera();

    // Orbit controls (manual)
    let isDragging = false, lastX = 0, lastY = 0;
    renderer.domElement.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener('mouseup',   () => { isDragging = false; });
    renderer.domElement.addEventListener('mousemove', e => {
      if (!isDragging) return;
      theta -= (e.clientX - lastX) * 0.006;
      phi    = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, phi + (e.clientY - lastY) * 0.006));
      lastX  = e.clientX;
      lastY  = e.clientY;
      applyCamera();
    });
    renderer.domElement.addEventListener('wheel', e => {
      dist = Math.max(W * 0.5, Math.min(W * 5, dist + e.deltaY * 0.6));
      applyCamera();
      e.preventDefault();
    }, { passive: false });

    // Animate
    function animate() {
      if (!rootEl) return;
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    scene3d = {
      dispose() {
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
  } catch (err) {
    console.warn('[WSC] 3D rendering failed:', err);
    el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">3D rendering failed. Check console.</div>';
  }
}

// ============================================================
// WSC ↔ CM INTEGRATION
// ============================================================

function pushToCm() {
  const dock = zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = dock.inboundDoors + dock.outboundDoors;
  /** @type {import('./types.js?v=20260418-sL').WscToCmPayload} */
  const payload = {
    totalSqft: facility.totalSqft || 0,
    clearHeight: facility.clearHeight || 0,
    dockDoors: totalDoors,
    officeSqft: zones.officeSqft || 0,
    stagingSqft: (zones.receiveStagingSqft || 0) + (zones.shipStagingSqft || 0),
  };
  // Also stash in sessionStorage so CM can pick it up on mount if it isn't
  // already mounted (bus event would be lost). CM clears the stash after consuming.
  try {
    sessionStorage.setItem('wsc_pending_push', JSON.stringify({ ...payload, at: Date.now() }));
  } catch {}
  bus.emit('wsc:push-to-cm', payload);
  console.log('[WSC] Pushed facility data to Cost Model:', payload);
  // Navigate to Cost Model Builder
  window.location.hash = 'designtools/cost-model';
}

/**
 * Handle CM → WSC push (e.g., "Size with Calculator" from CM).
 * @param {import('./types.js?v=20260418-sL').CmToWscPayload} payload
 */
function handleCmPush(payload) {
  if (payload.clearHeight) facility.clearHeight = payload.clearHeight;
  if (payload.totalSqft) facility.totalSqft = payload.totalSqft;
  renderConfigPanel();
  renderContentView();
  console.log('[WSC] Received facility data from Cost Model:', payload);
}

// ============================================================
// HELPERS
// ============================================================

function createDefaultFacility() {
  return {
    id: null,
    name: 'New Facility',
    totalSqft: 150000,
    clearHeight: 32,
    buildingWidth: 300,
    buildingDepth: 500,
    columnSpacingX: 50,
    columnSpacingY: 50,
    storageType: 'single',
    aisleWidth: null,
    palletWidth: 48,
    palletDepth: 40,
    palletHeight: 54,
    beamHeight: 5,
    flueSpace: 3,
    topClearance: 36,
  };
}

function createDefaultZones() {
  return {
    officeSqft: 5000,
    receiveStagingSqft: 10000,
    shipStagingSqft: 10000,
    chargingSqft: 2000,
    repackSqft: 3000,
    otherSqft: 0,
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    dockConfig: { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 },
    productDimensions: { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 },
    forwardPick: { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 },
    optionalZones: { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } },
    customZones: [],
    peakUnitsPerDay: 500000,
    avgUnitsPerDay: 350000,
    operatingDaysPerYear: 250,
  };
}

function createDefaultVolumes() {
  // Sized to roughly match the default 150K sqft facility (so Recommended SF
  // lands in the same ballpark as Total SF on a fresh model). 60K pallets/yr
  // at 12 turns = 5K on-hand × 20 sqft/position ≈ 100K sqft reserve, plus
  // 3K SKUs × 2 sqft pick + 1.3x support uplift + dock staging ≈ 140K sqft
  // — matches the 150K facility with modest headroom. Replace with real
  // project numbers as you go.
  return {
    totalPallets: 60000,
    totalSKUs: 3000,
    inventoryTurns: 12,
    avgDailyInbound: 250,
    avgDailyOutbound: 290,
    peakMultiplier: 1.3,
  };
}

/** Minimal HTML-escape for user-supplied strings in the dashboard. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
