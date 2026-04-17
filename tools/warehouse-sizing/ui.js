/**
 * IES Hub v3 — Warehouse Sizing Calculator UI
 * Builder-pattern layout: config panel on left, capacity dashboard + visualizations on right.
 * 3-way view toggle: Dashboard / Elevation / 3D.
 *
 * @module tools/warehouse-sizing/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260417-s1';
import { state } from '../../shared/state.js?v=20260417-s1';
import * as calc from './calc.js?v=20260417-s1';
import * as api from './api.js?v=20260417-s1';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'dashboard' | 'elevation' | '3d'} */
let activeView = 'dashboard';

/** @type {import('./types.js').FacilityConfig} */
let facility = createDefaultFacility();

/** @type {import('./types.js').ZoneConfig} */
let zones = createDefaultZones();

/** @type {import('./types.js').VolumeInputs} */
let volumes = createDefaultVolumes();

/** @type {boolean} */
let isDirty = false;

/** @type {{ dispose?: () => void } | null} */
let scene3d = null;

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

  el.innerHTML = renderShell();
  bindShellEvents();
  renderConfigPanel();
  renderContentView();

  // Listen for CM → WSC push
  bus.on('cm:push-to-wsc', handleCmPush);

  bus.emit('wsc:mounted');
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
  return `
    <div class="hub-builder" style="height: calc(100vh - 48px);">
      <!-- Config Sidebar -->
      <div class="hub-builder-sidebar" id="wsc-config" style="overflow-y:auto;">
        <!-- Config content renders here -->
      </div>

      <!-- Content Area -->
      <div class="hub-builder-content" style="display:flex; flex-direction:column;">
        <!-- View Toggle Bar -->
        <div style="display:flex; gap:8px; padding:12px 24px; border-bottom:1px solid var(--ies-gray-200); align-items:center;">
          <button class="wsc-view-btn active" data-view="dashboard">Dashboard</button>
          <button class="wsc-view-btn" data-view="elevation">Elevation</button>
          <button class="wsc-view-btn" data-view="3d">3D View</button>
          <div style="flex:1;"></div>
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="push-to-cm">Use in Cost Model →</button>
        </div>
        <!-- View Content -->
        <div id="wsc-content" style="flex:1; overflow-y:auto; padding:24px;">
          <!-- View content renders here -->
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
  // View toggle
  rootEl?.querySelectorAll('.wsc-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeView = /** @type {any} */ (btn.dataset.view);
      rootEl?.querySelectorAll('.wsc-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderContentView();
    });
  });

  // Push to CM
  rootEl?.querySelector('[data-action="push-to-cm"]')?.addEventListener('click', pushToCm);
}

// ============================================================
// CONFIG PANEL (LEFT SIDEBAR)
// ============================================================

function renderConfigPanel() {
  const panel = rootEl?.querySelector('#wsc-config');
  if (!panel) return;

  panel.innerHTML = `
    <!-- Toolbar -->
    <div style="padding:12px 16px; border-bottom:1px solid var(--ies-gray-200);">
      <div class="text-subtitle" style="margin-bottom:8px;">Warehouse Sizing</div>
      <div class="flex gap-2" style="flex-wrap:wrap;">
        <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="wsc-new">New</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-save">Save</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-load">Load</button>
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
        <div class="wsc-config-field"><label>Dock Doors</label><input type="number" value="${facility.dockDoors}" data-fac="dockDoors" /></div>
        <div class="wsc-config-field">
          <label>Storage Type</label>
          <select data-fac="storageType">
            ${['single', 'double', 'bulk', 'carton', 'mix'].map(s =>
              `<option value="${s}"${facility.storageType === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Aisle Width (ft)</label><input type="number" value="${facility.aisleWidth || calc.AISLE_WIDTHS[facility.storageType] || 12}" step="0.5" data-fac="aisleWidth" /></div>
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
  `;

  bindConfigEvents(panel);
}

function bindConfigEvents(panel) {
  // Facility fields
  panel.querySelectorAll('[data-fac]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fac;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      facility[field] = val;
      isDirty = true;
      renderContentView();
    });
  });

  // Zone fields
  panel.querySelectorAll('[data-zone]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.zone;
      zones[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      isDirty = true;
      renderContentView();
    });
  });

  // Volume fields
  panel.querySelectorAll('[data-vol]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.vol;
      volumes[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      isDirty = true;
      renderContentView();
    });
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

  panel.querySelector('[data-action="wsc-save"]')?.addEventListener('click', async () => {
    try {
      const saved = await api.saveConfig({ ...facility, zones, volumes });
      facility.id = saved.id;
      isDirty = false;
      bus.emit('wsc:saved', { id: saved.id });
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  });

  panel.querySelector('[data-action="wsc-load"]')?.addEventListener('click', async () => {
    try {
      const configs = await api.listConfigs();
      if (!configs.length) { alert('No saved configs.'); return; }
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
      }
    } catch (err) {
      alert('Load failed: ' + err.message);
    }
  });
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
    case 'elevation':
      container.innerHTML = renderElevation();
      requestAnimationFrame(() => drawElevation());
      break;
    case '3d': render3DView(container); break;
  }
}

// ============================================================
// DASHBOARD VIEW
// ============================================================

function renderDashboard() {
  const storage = calc.computeStorage(facility, zones);
  const summary = calc.computeCapacitySummary(facility, zones, volumes);
  const dock = calc.dockUtilization(facility.dockDoors, volumes.avgDailyInbound, volumes.avgDailyOutbound, volumes.peakMultiplier);
  const zoneBD = calc.zoneBreakdown(zones);
  const elev = calc.elevationParams(facility);

  return `
    <!-- KPI Bar -->
    <div class="hub-kpi-bar mb-6">
      <div class="hub-kpi-item"><div class="hub-kpi-label">Total SF</div><div class="hub-kpi-value">${calc.formatSqft(summary.totalSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Storage SF</div><div class="hub-kpi-value">${calc.formatSqft(summary.storageSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Pallet Positions</div><div class="hub-kpi-value">${summary.totalPalletPositions.toLocaleString()}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Rack Levels</div><div class="hub-kpi-value">${summary.rackLevels}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Suggested SF</div><div class="hub-kpi-value" style="color:${summary.suggestedSqft > summary.totalSqft ? 'var(--ies-red)' : 'var(--ies-green)'};">${calc.formatSqft(summary.suggestedSqft)}</div></div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <!-- Storage Utilization -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Capacity Utilization</div>
        ${renderUtilBar('Storage Area', summary.storageUtilizationPct)}
        ${renderUtilBar('Pallet Capacity', summary.capacityUtilizationPct)}
        ${renderUtilBar('Cubic Utilization', summary.cubicUtilizationPct)}
        ${renderUtilBar('Dock Door (Peak)', summary.dockDoorUtilization)}
      </div>

      <!-- Zone Breakdown -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Zone Allocation</div>
        <div style="display:flex; height:24px; border-radius:4px; overflow:hidden; margin-bottom:12px;">
          <div style="width:${summary.storageUtilizationPct}%; background:var(--ies-blue);" title="Storage"></div>
          <div style="width:${100 - summary.storageUtilizationPct}%; background:var(--ies-gray-200);" title="Non-Storage"></div>
        </div>
        <div style="font-size:13px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <span style="font-weight:600; color:var(--ies-blue);">Storage</span>
            <span style="font-weight:700;">${calc.formatSqft(summary.storageSqft)}</span>
          </div>
          ${zoneBD.breakdown.map(z => `
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
              <span style="color:var(--ies-gray-500);">${z.label}</span>
              <span style="font-weight:600;">${calc.formatSqft(z.sqft)}</span>
            </div>
          `).join('')}
        </div>
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

      <!-- Dock Utilization -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Dock Door Analysis</div>
        <div class="hub-kpi-bar mb-4">
          <div class="hub-kpi-item"><div class="hub-kpi-label">Doors</div><div class="hub-kpi-value">${facility.dockDoors}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Doors Needed</div><div class="hub-kpi-value" style="color:${dock.doorsNeeded > facility.dockDoors ? 'var(--ies-red)' : 'var(--ies-green)'};">${dock.doorsNeeded}</div></div>
        </div>
        ${renderUtilBar('Avg Utilization', dock.avgUtil)}
        ${renderUtilBar('Peak Utilization', dock.peakUtil)}
        <div style="font-size:11px; color:var(--ies-gray-400); margin-top:8px;">Based on ${calc.DOOR_CAPACITY_PER_DAY} pallets/door/day capacity</div>
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
  const elev = calc.elevationParams(facility);

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
  container.innerHTML = `
    <div class="hub-card" style="padding:0; overflow:hidden;">
      <div id="wsc-3d-container" style="width:100%; height:500px;"></div>
    </div>
    <div style="font-size:11px; color:var(--ies-gray-400); margin-top:8px;">
      3D view requires Three.js CDN loaded. Click and drag to orbit.
    </div>
  `;

  // Defer 3D scene build to next frame
  requestAnimationFrame(() => build3DScene());
}

function build3DScene() {
  const el = rootEl?.querySelector('#wsc-3d-container');
  if (!el) return;

  try {
    // Dynamic import of the wrapper (Three.js must be loaded via CDN)
    const THREE = /** @type {any} */ (window).THREE;
    if (!THREE) {
      el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">Three.js not loaded. 3D view unavailable.</div>';
      return;
    }

    const width = el.clientWidth;
    const height = el.clientHeight || 500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f0f2f5');

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(100, 150, 80);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Build warehouse geometry from facility config
    const bw = facility.buildingWidth || 200;
    const bd = facility.buildingDepth || 300;
    const ch = facility.clearHeight || 32;
    const scale = 0.5; // 1ft = 0.5 units

    // Floor slab
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(bw * scale, 0.5, bd * scale),
      new THREE.MeshStandardMaterial({ color: 0xcccccc })
    );
    floor.position.set(0, -0.25, 0);
    floor.receiveShadow = true;
    scene.add(floor);

    // Walls (wireframe)
    const wallGeo = new THREE.BoxGeometry(bw * scale, ch * scale, bd * scale);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, transparent: true, opacity: 0.15 });
    const walls = new THREE.Mesh(wallGeo, wallMat);
    walls.position.set(0, ch * scale / 2, 0);
    scene.add(walls);

    // Wall edges
    const edges = new THREE.EdgesGeometry(wallGeo);
    const edgeLine = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x999999 }));
    edgeLine.position.copy(walls.position);
    scene.add(edgeLine);

    // Simple rack rows
    const elev = calc.elevationParams(facility);
    const moduleW = (elev.rackDepthFt + elev.aisleWidth + elev.rackDepthFt) * scale;
    const rackH = calc.topOfSteelFt(elev.rackLevels) * scale;
    const rackColor = 0xff6600;
    let rx = -bw * scale / 2 + 10 * scale;
    while (rx + moduleW < bw * scale / 2 - 10 * scale) {
      const rackGeo = new THREE.BoxGeometry(elev.rackDepthFt * scale, rackH, (bd - 20) * scale);
      const rackMat = new THREE.MeshStandardMaterial({ color: rackColor, transparent: true, opacity: 0.35 });
      // Left rack
      const left = new THREE.Mesh(rackGeo, rackMat);
      left.position.set(rx + elev.rackDepthFt * scale / 2, rackH / 2, 0);
      scene.add(left);
      // Right rack
      const right = new THREE.Mesh(rackGeo, rackMat);
      right.position.set(rx + (elev.rackDepthFt + elev.aisleWidth) * scale + elev.rackDepthFt * scale / 2, rackH / 2, 0);
      scene.add(right);
      rx += moduleW + 2 * scale;
    }

    // Dock doors
    const doorW = 3 * scale;
    const doorH = 4.5 * scale;
    for (let i = 0; i < (facility.dockDoors || 0); i++) {
      const doorZ = -bd * scale / 2 + (i + 1) * (bd * scale / ((facility.dockDoors || 1) + 1));
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, doorH, doorW),
        new THREE.MeshStandardMaterial({ color: 0x333333 })
      );
      door.position.set(-bw * scale / 2, doorH / 2, doorZ);
      scene.add(door);
    }

    // Camera position
    camera.position.set(bw * scale * 0.7, ch * scale * 1.2, bd * scale * 0.5);
    camera.lookAt(0, ch * scale * 0.3, 0);

    // Simple orbit controls via mouse drag
    let isDragging = false;
    let theta = Math.atan2(camera.position.z, camera.position.x);
    let phi = 0.5;
    let dist = camera.position.length();
    let lastX = 0, lastY = 0;

    renderer.domElement.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener('mouseup', () => { isDragging = false; });
    renderer.domElement.addEventListener('mousemove', e => {
      if (!isDragging) return;
      theta -= (e.clientX - lastX) * 0.005;
      phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.01, phi + (e.clientY - lastY) * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
      camera.position.set(dist * Math.cos(phi) * Math.cos(theta), dist * Math.sin(phi), dist * Math.cos(phi) * Math.sin(theta));
      camera.lookAt(0, ch * scale * 0.3, 0);
    });
    renderer.domElement.addEventListener('wheel', e => {
      dist = Math.max(50, Math.min(500, dist + e.deltaY * 0.5));
      camera.position.set(dist * Math.cos(phi) * Math.cos(theta), dist * Math.sin(phi), dist * Math.cos(phi) * Math.sin(theta));
      camera.lookAt(0, ch * scale * 0.3, 0);
    });

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
  /** @type {import('./types.js').WscToCmPayload} */
  const payload = {
    totalSqft: facility.totalSqft || 0,
    clearHeight: facility.clearHeight || 0,
    dockDoors: facility.dockDoors || 0,
    officeSqft: zones.officeSqft || 0,
    stagingSqft: (zones.receiveStagingSqft || 0) + (zones.shipStagingSqft || 0),
  };
  bus.emit('wsc:push-to-cm', payload);
  console.log('[WSC] Pushed facility data to Cost Model:', payload);
  // Navigate to Cost Model Builder
  window.location.hash = 'designtools/cost-model';
}

/**
 * Handle CM → WSC push (e.g., "Size with Calculator" from CM).
 * @param {import('./types.js').CmToWscPayload} payload
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
    dockDoors: 24,
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
  };
}

function createDefaultVolumes() {
  return {
    totalPallets: 8000,
    totalSKUs: 2000,
    inventoryTurns: 18,
    avgDailyInbound: 200,
    avgDailyOutbound: 250,
    peakMultiplier: 1.3,
  };
}
