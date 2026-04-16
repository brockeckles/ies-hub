/**
 * IES Hub v3 — Fleet Modeler UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Tabs: Lanes, Configuration, Results, Map.
 *
 * @module tools/fleet-modeler/ui
 */

import { bus } from '../../shared/event-bus.js';
import { state } from '../../shared/state.js';
import * as calc from './calc.js';
import * as api from './api.js';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'lanes' | 'config' | 'results' | 'map'} */
let activeTab = 'lanes';

/** @type {import('./types.js').Lane[]} */
let lanes = [];

/** @type {import('./types.js').VehicleSpec[]} */
let vehicles = calc.DEFAULT_VEHICLES.map(v => ({ ...v }));

/** @type {import('./types.js').FleetConfig} */
let config = { ...calc.DEFAULT_CONFIG };

/** @type {import('./types.js').FleetResult|null} */
let result = null;

/** @type {object|null} */
let mapInstance = null;

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Fleet Modeler.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeTab = 'lanes';
  lanes = calc.DEMO_LANES.map(l => ({ ...l }));
  vehicles = calc.DEFAULT_VEHICLES.map(v => ({ ...v }));
  config = { ...calc.DEFAULT_CONFIG };
  result = null;

  el.innerHTML = renderShell();
  bindShellEvents();
  renderContent();

  bus.emit('fleet:mounted');
}

/**
 * Cleanup.
 */
export function unmount() {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  rootEl = null;
  bus.emit('fleet:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  const tabs = [
    { key: 'lanes', label: 'Lanes' },
    { key: 'config', label: 'Configuration' },
    { key: 'results', label: 'Results' },
    { key: 'map', label: 'Route Map' },
  ];

  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:16px;padding:16px 24px 0 24px;flex-shrink:0;">
        <h2 class="text-page" style="margin:0;">Fleet Modeler</h2>
        <div style="display:flex;gap:8px;margin-left:auto;" id="fm-tabs">
          ${tabs.map(t => `
            <button class="hub-btn hub-btn-sm ${t.key === activeTab ? 'hub-btn-primary' : 'hub-btn-secondary'}"
                    data-tab="${t.key}">${t.label}</button>
          `).join('')}
        </div>
        <button class="hub-btn hub-btn-primary hub-btn-sm hub-btn-icon" id="fm-calculate" style="margin-left:8px;">
          ▶ Calculate Fleet
        </button>
      </div>
      <div id="fm-content" style="flex:1;overflow-y:auto;padding:24px;"></div>
    </div>
  `;
}

function bindShellEvents() {
  if (!rootEl) return;

  rootEl.querySelector('#fm-tabs')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-tab]');
    if (!btn) return;
    activeTab = /** @type {any} */ (btn.dataset.tab);
    rootEl.querySelectorAll('#fm-tabs button').forEach(b => {
      b.className = `hub-btn hub-btn-sm ${b.dataset.tab === activeTab ? 'hub-btn-primary' : 'hub-btn-secondary'}`;
    });
    renderContent();
  });

  rootEl.querySelector('#fm-calculate')?.addEventListener('click', () => {
    result = calc.analyzeFleet(lanes, vehicles, config);
    activeTab = 'results';
    rootEl.querySelectorAll('#fm-tabs button').forEach(b => {
      b.className = `hub-btn hub-btn-sm ${b.dataset.tab === activeTab ? 'hub-btn-primary' : 'hub-btn-secondary'}`;
    });
    renderContent();
  });
}

function renderContent() {
  const el = rootEl?.querySelector('#fm-content');
  if (!el) return;

  switch (activeTab) {
    case 'lanes': renderLanes(el); break;
    case 'config': renderConfig(el); break;
    case 'results': renderResults(el); break;
    case 'map': renderMap(el); break;
  }
}

// ============================================================
// LANES TAB
// ============================================================

function renderLanes(el) {
  el.innerHTML = `
    <div style="max-width:1000px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Transportation Lanes</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-add-lane">+ Add Lane</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-load-demo">Load Demo Data</button>
        </div>
      </div>

      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:800px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Origin</th>
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Destination</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Weekly Ships</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Wt (lbs)</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Cube (ft³)</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Distance (mi)</th>
              <th style="text-align:center;padding:8px 6px;"></th>
            </tr>
          </thead>
          <tbody>
            ${lanes.map((l, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${l.origin}</td>
                <td style="padding:6px;">${l.destination}</td>
                <td style="padding:6px;text-align:right;">${l.weeklyShipments}</td>
                <td style="padding:6px;text-align:right;">${l.avgWeightLbs.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${l.avgCubeFt3.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${l.distanceMiles}</td>
                <td style="padding:6px;text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-lane-del="${i}" style="padding:4px 8px;">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          ${kpi('Total Lanes', String(lanes.length))}
          ${kpi('Weekly Shipments', lanes.reduce((s, l) => s + l.weeklyShipments, 0).toLocaleString())}
          ${kpi('Total Weekly Miles', lanes.reduce((s, l) => s + l.distanceMiles * l.weeklyShipments, 0).toLocaleString())}
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('[data-lane-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      lanes.splice(parseInt(/** @type {HTMLElement} */ (btn).dataset.laneDel), 1);
      renderLanes(el);
    });
  });

  el.querySelector('#fm-add-lane')?.addEventListener('click', () => {
    lanes.push({ id: 'l' + Date.now(), origin: 'Origin', destination: 'Destination', weeklyShipments: 5, avgWeightLbs: 20000, avgCubeFt3: 1500, distanceMiles: 200 });
    renderLanes(el);
  });

  el.querySelector('#fm-load-demo')?.addEventListener('click', () => {
    lanes = calc.DEMO_LANES.map(l => ({ ...l }));
    renderLanes(el);
  });
}

// ============================================================
// CONFIG TAB
// ============================================================

function renderConfig(el) {
  el.innerHTML = `
    <div style="max-width:800px;">
      <h3 class="text-section" style="margin-bottom:16px;">Vehicle Specifications</h3>
      <div class="hub-card" style="margin-bottom:20px;padding:16px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:6px;font-weight:700;">Enabled</th>
              <th style="text-align:left;padding:6px;font-weight:700;">Vehicle</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Payload (lbs)</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Cube (ft³)</th>
              <th style="text-align:right;padding:6px;font-weight:700;">MPG</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Capital</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Insurance</th>
            </tr>
          </thead>
          <tbody>
            ${vehicles.map((v, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);${v.enabled ? '' : 'opacity:0.5;'}">
                <td style="padding:6px;"><input type="checkbox" ${v.enabled ? 'checked' : ''} data-veh-toggle="${i}"></td>
                <td style="padding:6px;font-weight:600;">${v.name}</td>
                <td style="padding:6px;text-align:right;">${v.maxPayloadLbs.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${v.maxCubeFt3.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${v.mpg}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(v.capitalCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${v.insuranceFactor}x</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <h3 class="text-section" style="margin-bottom:16px;">Cost Parameters</h3>
      <div class="hub-card" style="padding:20px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          ${cfgInput('Diesel Price', 'dieselPricePerGal', config.dieselPricePerGal, '$/gal')}
          ${cfgInput('Driver Cost', 'driverCostPerHr', config.driverCostPerHr, '$/hr')}
          ${cfgInput('Avg Speed', 'avgSpeedMph', config.avgSpeedMph, 'mph')}
          ${cfgInput('Driving Hrs/Day', 'drivingHoursPerDay', config.drivingHoursPerDay, 'hrs')}
          ${cfgInput('Operating Days/Wk', 'operatingDaysPerWeek', config.operatingDaysPerWeek, 'days')}
          ${cfgInput('Utilization', 'utilizationPct', config.utilizationPct, '%')}
          ${cfgInput('Maintenance', 'maintenanceCostPerMi', config.maintenanceCostPerMi, '$/mi')}
          ${cfgInput('Insurance Base', 'insuranceBasePerYear', config.insuranceBasePerYear, '$/yr')}
          ${cfgInput('Depreciation', 'depreciationYears', config.depreciationYears, 'yrs')}
          ${cfgInput('GXO Margin', 'gxoMarginPct', config.gxoMarginPct, '%')}
          ${cfgInput('Carrier Premium', 'carrierPremiumPct', config.carrierPremiumPct, '%')}
        </div>
        <div style="margin-top:16px;display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="fm-team" ${config.teamDriving ? 'checked' : ''}>
          <label for="fm-team" style="font-size:13px;font-weight:600;cursor:pointer;">Team Driving (doubles daily hours)</label>
        </div>
      </div>
    </div>
  `;

  // Vehicle toggles
  el.querySelectorAll('[data-veh-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (cb).dataset.vehToggle);
      vehicles[idx].enabled = /** @type {HTMLInputElement} */ (cb).checked;
      renderConfig(el);
    });
  });

  // Config inputs
  el.querySelectorAll('input[data-cfg]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.cfg;
      config[key] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
    });
  });

  // Team driving
  el.querySelector('#fm-team')?.addEventListener('change', (e) => {
    config.teamDriving = /** @type {HTMLInputElement} */ (e.target).checked;
  });
}

function cfgInput(label, key, value, unit) {
  return `
    <div style="display:flex;align-items:center;gap:8px;">
      <label style="font-size:13px;font-weight:600;flex:1;">${label}</label>
      <input type="number" value="${value}" data-cfg="${key}" step="0.01"
             style="width:90px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
      <span style="font-size:11px;color:var(--ies-gray-400);width:36px;">${unit}</span>
    </div>
  `;
}

// ============================================================
// RESULTS TAB
// ============================================================

function renderResults(el) {
  if (!result) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Click "Calculate Fleet" to see results.</p></div>';
    return;
  }

  const r = result;
  const atriColor = { 'BELOW': '#22c55e', 'AT': '#f59e0b', 'ABOVE': '#ef4444' }[r.atriBenchmark.verdict];

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Total Vehicles', String(r.totalVehicles))}
          ${kpi('Annual Miles', calc.formatMiles(r.totalAnnualMiles))}
          ${kpi('Annual Cost', calc.formatCurrency(r.totalAnnualCost, { compact: true }))}
          ${kpi('Cost/Mile', calc.formatCpm(r.avgCostPerMile))}
          ${kpi('ATRI Benchmark', r.atriBenchmark.verdict, atriColor)}
        </div>
      </div>

      <!-- Fleet Composition -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Fleet Composition</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:6px;font-weight:700;">Vehicle</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Units</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Annual Miles</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Fuel</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Driver</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Maint</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Depr</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Insurance</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Total</th>
              <th style="text-align:right;padding:6px;font-weight:700;">$/Mile</th>
            </tr>
          </thead>
          <tbody>
            ${r.fleetComposition.map(f => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${f.vehicleName}</td>
                <td style="padding:6px;text-align:right;">${f.unitsNeeded}</td>
                <td style="padding:6px;text-align:right;">${Math.round(f.annualMiles).toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualFuelCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualDriverCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualMaintenanceCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualDepreciation, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualInsurance, { compact: true })}</td>
                <td style="padding:6px;text-align:right;font-weight:700;">${calc.formatCurrency(f.totalAnnualCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCpm(f.costPerMile)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- 3-Way Comparison -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">3-Way Cost Comparison</div>
        ${comparisonBar('Private Fleet', r.comparison.private, r.comparison.carrier, '#0047AB')}
        ${comparisonBar('Dedicated (GXO)', r.comparison.dedicated, r.comparison.carrier, '#8b5cf6')}
        ${comparisonBar('Common Carrier', r.comparison.carrier, r.comparison.carrier, '#ef4444')}
      </div>

      <!-- ATRI Benchmark -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;border-left:4px solid ${atriColor};">
        <div style="font-size:14px;font-weight:700;margin-bottom:8px;">ATRI 2024 Benchmark Comparison</div>
        <div style="display:flex;gap:40px;font-size:13px;">
          <div>
            <span style="color:var(--ies-gray-400);">Your Model:</span>
            <strong>${calc.formatCpm(r.atriBenchmark.modelCostPerMile)}</strong>
          </div>
          <div>
            <span style="color:var(--ies-gray-400);">ATRI Average:</span>
            <strong>${calc.formatCpm(r.atriBenchmark.atriCostPerMile)}</strong>
          </div>
          <div>
            <span style="color:var(--ies-gray-400);">Delta:</span>
            <strong style="color:${atriColor};">${r.atriBenchmark.deltaPct > 0 ? '+' : ''}${r.atriBenchmark.deltaPct.toFixed(1)}%</strong>
          </div>
        </div>
      </div>

      <!-- Lane Assignments -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Lane Assignments</div>
        <div style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead style="position:sticky;top:0;background:#fff;">
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:6px;font-weight:700;">Lane</th>
                <th style="text-align:left;padding:6px;font-weight:700;">Vehicle</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Trips/Wk</th>
                <th style="text-align:right;padding:6px;font-weight:700;">RT Miles</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Annual Miles</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Per Trip</th>
              </tr>
            </thead>
            <tbody>
              ${r.assignments.map(a => {
                const lane = lanes.find(l => l.id === a.laneId);
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);">
                    <td style="padding:6px;font-weight:600;">${lane ? lane.origin + ' → ' + lane.destination : a.laneId}</td>
                    <td style="padding:6px;">${a.vehicleName}</td>
                    <td style="padding:6px;text-align:right;">${a.tripsPerWeek}</td>
                    <td style="padding:6px;text-align:right;">${a.roundTripMiles.toLocaleString()}</td>
                    <td style="padding:6px;text-align:right;">${Math.round(a.annualMiles).toLocaleString()}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.perTripCost)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function comparisonBar(label, amount, maxAmount, color) {
  const pct = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;
  return `
    <div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:600;">${label}</span>
        <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(amount, { compact: true })}</span>
      </div>
      <div style="height:24px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:6px;"></div>
      </div>
    </div>
  `;
}

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

// ============================================================
// MAP TAB
// ============================================================

function renderMap(el) {
  if (!result) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Calculate fleet first to see route map.</p></div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <h3 class="text-section" style="margin:0;">Route Map</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${lanes.length} lanes • ${result.totalVehicles} vehicles</span>
      </div>
      <div id="fm-map-container" style="flex:1;min-height:500px;border-radius:10px;border:1px solid var(--ies-gray-200);overflow:hidden;"></div>
      <div style="display:flex;gap:16px;margin-top:12px;font-size:11px;color:var(--ies-gray-400);">
        <span><span style="display:inline-block;width:20px;height:3px;background:#0047AB;vertical-align:middle;"></span> Dry Van</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#22c55e;vertical-align:middle;"></span> Reefer</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#f59e0b;vertical-align:middle;"></span> Flatbed</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#8b5cf6;vertical-align:middle;"></span> Straight Truck</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#ec4899;vertical-align:middle;"></span> Sprinter</span>
      </div>
    </div>
  `;

  requestAnimationFrame(() => initFleetMap());
}

function initFleetMap() {
  const container = rootEl?.querySelector('#fm-map-container');
  if (!container) return;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  if (typeof L === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">Map requires Leaflet.js</div>';
    return;
  }

  mapInstance = L.map(container).setView([39.8283, -98.5795], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap'
  }).addTo(mapInstance);

  // Note: Fleet map would need geocoded lane endpoints.
  // For now, show a placeholder message over the map.
  const info = L.control({ position: 'topright' });
  info.onAdd = () => {
    const div = L.DomUtil.create('div', '');
    div.style.cssText = 'background:#fff;padding:10px 14px;border-radius:6px;font-size:13px;box-shadow:0 2px 6px rgba(0,0,0,.15);';
    div.innerHTML = `<strong>${lanes.length} lanes</strong> • ${result?.totalVehicles || 0} vehicles<br><span style="font-size:11px;color:#888;">Route visualization requires geocoded lane endpoints</span>`;
    return div;
  };
  info.addTo(mapInstance);
}
