/**
 * IES Hub v3 — Fleet Modeler UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Tabs: Lanes, Configuration, Results, Map.
 *
 * @module tools/fleet-modeler/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-s3';
import { state } from '../../shared/state.js?v=20260418-s3';
import * as calc from './calc.js?v=20260418-s3';
import * as api from './api.js?v=20260418-s3';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'lanes' | 'config' | 'results' | 'map'} */
let activeTab = 'lanes';

/** @type {import('./types.js?v=20260418-s3').Lane[]} */
let lanes = [];

/** @type {import('./types.js?v=20260418-s3').VehicleSpec[]} */
let vehicles = calc.DEFAULT_VEHICLES.map(v => ({ ...v }));

/** @type {import('./types.js?v=20260418-s3').FleetConfig} */
let config = { ...calc.DEFAULT_CONFIG };

/** @type {import('./types.js?v=20260418-s3').FleetResult|null} */
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
  config = { ...calc.DEFAULT_CONFIG, leaseMode: false };
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
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-import-csv">⬆ Import CSV</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-export-csv">⬇ Export CSV</button>
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

      <input type="file" id="fm-csv-input" accept=".csv" style="display:none;">

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

  el.querySelector('#fm-import-csv')?.addEventListener('click', () => {
    el.querySelector('#fm-csv-input')?.click();
  });

  el.querySelector('#fm-csv-input')?.addEventListener('change', (e) => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const csv = event.target?.result;
        const lines = String(csv).split('\n');
        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        lanes = [];
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const values = lines[i].split(',').map(v => v.trim());
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = values[idx]; });
          if (obj.origin && obj.destination) {
            lanes.push({
              id: 'l' + Date.now() + i,
              origin: obj.origin,
              destination: obj.destination,
              weeklyShipments: parseInt(obj.weekly_shipments) || 1,
              avgWeightLbs: parseFloat(obj.avg_weight_lbs) || parseFloat(obj.avg_weight) || 5000,
              avgCubeFt3: parseFloat(obj.avg_cube_ft3) || parseFloat(obj.avg_cube) || 300,
              distanceMiles: parseFloat(obj.distance_miles) || parseFloat(obj.distance) || 200,
            });
          }
        }
        renderLanes(el);
      } catch (err) {
        console.error('Error importing CSV:', err);
      }
    };
    reader.readAsText(file);
  });

  el.querySelector('#fm-export-csv')?.addEventListener('click', () => {
    const csv = ['origin,destination,weekly_shipments,avg_weight_lbs,avg_cube_ft3,distance_miles'];
    lanes.forEach(lane => {
      csv.push(`${lane.origin},${lane.destination},${lane.weeklyShipments},${lane.avgWeightLbs},${lane.avgCubeFt3},${lane.distanceMiles}`);
    });
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fleet-lanes.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ============================================================
// CONFIG TAB
// ============================================================

function renderConfig(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      <h3 class="text-section" style="margin-bottom:16px;">Financing Mode</h3>
      <div class="hub-card" style="margin-bottom:20px;padding:16px;">
        <div style="display:flex;gap:24px;margin-bottom:16px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="radio" name="fm-financing" value="purchase" ${!config.leaseMode ? 'checked' : ''} id="fm-financing-purchase">
            <span style="font-weight:600;">Purchase (Depreciation)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="radio" name="fm-financing" value="lease" ${config.leaseMode ? 'checked' : ''} id="fm-financing-lease">
            <span style="font-weight:600;">Lease (Monthly Payment)</span>
          </label>
        </div>
        <div style="padding:12px;background:var(--ies-gray-100);border-radius:6px;font-size:12px;color:var(--ies-gray-600);">
          ${!config.leaseMode
            ? 'Purchase: Straight-line depreciation over 5-7 years with 15% residual value'
            : 'Lease: Monthly rates vary by vehicle type (Dry Van $2,200-$2,800/mo)'}
        </div>
      </div>

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
        <div style="margin-top:16px;display:flex;gap:20px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="fm-team" ${config.teamDriving ? 'checked' : ''}>
            <span style="font-weight:600;">Team Driving (doubles daily hours, 2 drivers/vehicle)</span>
          </label>
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

  // Financing mode
  el.querySelectorAll('input[name="fm-financing"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      config.leaseMode = /** @type {HTMLInputElement} */ (e.target).value === 'lease';
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
    <div style="max-width:1200px;">
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

      <!-- 3-Way Comparison Cards -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">3-Way Cost Comparison</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
          ${renderComparisonCard('Private Fleet', r.comparison.private, r.comparison, '#0047AB')}
          ${renderComparisonCard('Dedicated (GXO)', r.comparison.dedicated, r.comparison, '#8b5cf6')}
          ${renderComparisonCard('Common Carrier', r.comparison.carrier, r.comparison, '#ef4444')}
        </div>
      </div>

      <!-- ATRI Benchmark Table -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">ATRI 2024 Benchmark Comparison</div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:2px solid var(--ies-gray-200);background:var(--ies-gray-100);">
                <th style="text-align:left;padding:8px;font-weight:700;">Category</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Your Fleet</th>
                <th style="text-align:right;padding:8px;font-weight:700;">ATRI 2024</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Variance</th>
                <th style="text-align:center;padding:8px;font-weight:700;">Status</th>
              </tr>
            </thead>
            <tbody>
              ${renderAtriBenchmarkRow('Total CPM', r.atriBenchmark.modelCostPerMile, r.atriBenchmark.atriCostPerMile)}
              ${renderAtriBenchmarkRow('Fuel/Mi', r.atriBenchmark.modelCostPerMile * 0.26, 0.583)}
              ${renderAtriBenchmarkRow('Drivers/Mi', r.atriBenchmark.modelCostPerMile * 0.37, 0.827)}
              ${renderAtriBenchmarkRow('Vehicle/Mi', r.atriBenchmark.modelCostPerMile * 0.13, 0.296)}
              ${renderAtriBenchmarkRow('Insurance/Mi', r.atriBenchmark.modelCostPerMile * 0.06, 0.117)}
              ${renderAtriBenchmarkRow('Maintenance/Mi', r.atriBenchmark.modelCostPerMile * 0.08, 0.198)}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Sensitivity Matrix -->
      ${renderSensitivityMatrixCard()}

      <!-- Volume Sensitivity -->
      ${renderVolumeSensitivityCard()}

      <!-- Lane Assignments -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
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

  // Bind export buttons
  setTimeout(() => {
    rootEl?.querySelector('#fm-export-csv')?.addEventListener('click', exportFleetCSV);
  }, 0);
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

function renderComparisonCard(label, amount, comparison, color) {
  const isLowest = amount === Math.min(comparison.private, comparison.dedicated, comparison.carrier);
  const variance = Math.max(comparison.private, comparison.dedicated, comparison.carrier) - amount;
  return `
    <div style="border:1px solid var(--ies-gray-200);border-radius:8px;padding:16px;${isLowest ? `background:linear-gradient(135deg,${color}08,${color}04);border-color:${color};` : ''} ">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:700;">${label}</div>
        ${isLowest ? `<div style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;">✓ LOWEST</div>` : ''}
      </div>
      <div style="font-size:20px;font-weight:800;color:${color};margin-bottom:12px;">${calc.formatCurrency(amount, { compact: true })}</div>
      <div style="font-size:12px;color:var(--ies-gray-600);line-height:1.6;margin-bottom:8px;">
        <div>Cost/Mile: <strong>${calc.formatCpm(amount / (result?.totalAnnualMiles || 1))}</strong></div>
      </div>
      ${isLowest ? `<div style="font-size:11px;color:${color};font-weight:600;">Saves ${calc.formatCurrency(variance, { compact: true })}</div>` : ''}
    </div>
  `;
}

function renderAtriBenchmarkRow(category, yourValue, atriBenchmark) {
  const variance = atriBenchmark > 0 ? ((yourValue - atriBenchmark) / atriBenchmark) * 100 : 0;
  let statusColor = '#22c55e'; // green
  let statusText = 'On Target';
  if (Math.abs(variance) > 25) {
    statusColor = '#ef4444'; // red
    statusText = variance > 0 ? 'Above' : 'Below';
  } else if (Math.abs(variance) > 10) {
    statusColor = '#f59e0b'; // yellow
    statusText = variance > 0 ? 'Above' : 'Below';
  }
  return `
    <tr style="border-bottom:1px solid var(--ies-gray-200);">
      <td style="padding:8px;font-weight:600;color:var(--ies-navy);">${category}</td>
      <td style="padding:8px;text-align:right;font-weight:600;">${calc.formatCpm(yourValue)}</td>
      <td style="padding:8px;text-align:right;">${calc.formatCpm(atriBenchmark)}</td>
      <td style="padding:8px;text-align:right;font-weight:600;color:${statusColor};">${variance > 0 ? '+' : ''}${variance.toFixed(1)}%</td>
      <td style="padding:8px;text-align:center;"><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusColor}20;color:${statusColor};">${statusText}</span></td>
    </tr>
  `;
}

function renderSensitivityMatrixCard() {
  try {
    const matrix = calc.calcSensitivityMatrix(lanes, vehicles, config);
    const driverRates = matrix.rowLabels;
    const dieselPrices = matrix.colLabels;

    const getCellColor = (cpm) => {
      if (cpm < 2.00) return '#22c55e'; // green
      if (cpm < 2.50) return '#fbbf24'; // yellow
      if (cpm < 3.00) return '#f97316'; // orange
      return '#ef4444'; // red
    };

    let tableHtml = `
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Sensitivity Analysis: Driver Rate × Diesel Price</div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead>
              <tr style="background:var(--ies-gray-100);border-bottom:2px solid var(--ies-gray-200);">
                <th style="padding:6px;text-align:center;font-weight:700;">Driver/Diesel</th>
    `;

    dieselPrices.forEach(price => {
      tableHtml += `<th style="padding:6px;text-align:center;font-weight:700;">${calc.formatCurrency(price, { compact: false }).replace('$', '')}</th>`;
    });

    tableHtml += `</tr></thead><tbody>`;

    matrix.matrix.forEach((row, rowIdx) => {
      tableHtml += `<tr><td style="padding:6px;text-align:center;font-weight:700;background:var(--ies-gray-100);">$${driverRates[rowIdx]}</td>`;
      row.forEach((cell, colIdx) => {
        const bgColor = getCellColor(cell.costPerMile);
        const isCurrent = cell.isCurrent;
        const borderStyle = isCurrent ? '2px solid var(--ies-navy)' : '1px solid var(--ies-gray-200)';
        tableHtml += `<td style="padding:6px;text-align:center;border:${borderStyle};background:${bgColor}15;font-weight:${isCurrent ? '700' : '500'};">${cell.costPerMile.toFixed(2)}</td>`;
      });
      tableHtml += `</tr>`;
    });

    tableHtml += `</tbody></table></div>
      <div style="margin-top:12px;font-size:11px;color:var(--ies-gray-600);">
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <span><span style="display:inline-block;width:12px;height:12px;background:#22c55e;margin-right:4px;"></span>Excellent &lt;$2.00/mi</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#fbbf24;margin-right:4px;"></span>Good $2.00-2.50/mi</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#f97316;margin-right:4px;"></span>Fair $2.50-3.00/mi</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#ef4444;margin-right:4px;"></span>High &gt;$3.00/mi</span>
        </div>
        <div style="margin-top:8px;"><strong>Current scenario</strong> shown with navy border.</div>
      </div>
    </div>`;
    return tableHtml;
  } catch (e) {
    console.error('Error rendering sensitivity matrix:', e);
    return '';
  }
}

function renderVolumeSensitivityCard() {
  try {
    const scenarios = calc.calcVolumeSensitivity(lanes, vehicles, config);
    return `
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Volume Sensitivity Analysis</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--ies-gray-100);border-bottom:2px solid var(--ies-gray-200);">
              <th style="padding:8px;text-align:left;font-weight:700;">Scenario</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Vehicles</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Annual Cost</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Cost/Mile</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Cost Variance</th>
            </tr>
          </thead>
          <tbody>
            ${scenarios.map(s => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);${Math.abs(s.multiplier - 1.0) < 0.01 ? 'background:var(--ies-blue)08;' : ''}">
                <td style="padding:8px;font-weight:${Math.abs(s.multiplier - 1.0) < 0.01 ? '700' : '500'};">${s.scenario}</td>
                <td style="padding:8px;text-align:right;">${s.totalVehicles}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(s.totalAnnualCost, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCpm(s.costPerMile)}</td>
                <td style="padding:8px;text-align:right;${s.variance.cost < 0 ? 'color:#22c55e;' : 'color:#ef4444;'}">${s.variance.cost > 0 ? '+' : ''}${calc.formatCurrency(s.variance.cost, { compact: true })}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    console.error('Error rendering volume sensitivity:', e);
    return '';
  }
}

function exportFleetCSV() {
  if (!result) return;
  const csv = ['origin,destination,weekly_shipments,vehicle,trips_per_week,annual_miles,cost_per_trip'];
  result.assignments.forEach(a => {
    const lane = lanes.find(l => l.id === a.laneId);
    csv.push(`${lane?.origin || ''},${lane?.destination || ''},${lane?.weeklyShipments || ''},${a.vehicleName},${a.tripsPerWeek},${Math.round(a.annualMiles)},${a.perTripCost.toFixed(2)}`);
  });
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fleet-results.csv';
  a.click();
  URL.revokeObjectURL(url);
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
