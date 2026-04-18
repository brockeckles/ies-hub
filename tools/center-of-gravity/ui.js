/**
 * IES Hub v3 — Center of Gravity UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Tabs: Points, Analysis, Map, Sensitivity.
 *
 * @module tools/center-of-gravity/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sP';
import { state } from '../../shared/state.js?v=20260418-sP';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sP';
import { showToast } from '../../shared/toast.js?v=20260418-sP';
import { renderToolHeader, bindPrimaryActionShortcut, flashRunButton } from '../../shared/tool-frame.js?v=20260418-sP';
import { downloadCSV } from '../../shared/export.js?v=20260418-sP';
import * as calc from './calc.js?v=20260418-sP';
import * as api from './api.js?v=20260418-sP';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'points' | 'analysis' | 'map' | 'sensitivity'} */
let activeTab = 'points';

/** @type {import('./types.js?v=20260418-sP').WeightedPoint[]} */
let points = [];

/** @type {import('./types.js?v=20260418-sP').CogConfig} */
let config = { ...calc.DEFAULT_CONFIG };

/** @type {import('./types.js?v=20260418-sP').MultiCogResult|null} */
let cogResult = null;

/** @type {Array<{ k: number, totalWeightedDistance: number, estimatedCost: number, avgDistance: number }>|null} */
let sensitivityData = null;

/** @type {object|null} */
let mapInstance = null;

/**
 * Map overlay options — service-zone rings + heatmap toggles with
 * a user-editable radii list (comma-separated miles).
 */
let mapOptions = {
  zones: true,
  heat: true,
  zoneRadiiMiles: [250, 500, 750],
};

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Center of Gravity tool.
 * @param {HTMLElement} el
 */
let activeScenarioId = null;
let activeParentCmId = null;

export async function mount(el) {
  rootEl = el;
  await renderLanding();
  bus.emit('cog:mounted');
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Center of Gravity',
    toolKey: 'cog',
    accent: '#20c997',
    list: () => api.listScenarios(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.scenario_data?.name || 'Untitled COG analysis',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle: (r) => {
      const d = r.scenario_data || {};
      const nPoints = (d.points || []).length;
      const k = d.config?.k || d.k;
      return nPoints ? `${nPoints} demand points${k ? ` · ${k}-DC analysis` : ''}` : '';
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteScenario(row.id); },
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Find optimal facility locations from weighted demand. Cluster, centroid solver, sensitivity vs k-DC count, and a service-zone map overlay.',
  });
}

function openEditor(savedRow) {
  if (!rootEl) return;
  const d = savedRow?.scenario_data || {};
  activeTab = 'points';
  points = (d.points && d.points.length) ? d.points.map(p => ({ ...p })) : calc.DEMO_POINTS.map(p => ({ ...p }));
  config = { ...calc.DEFAULT_CONFIG, ...(d.config || {}) };
  cogResult = d.result || null;
  sensitivityData = null;
  activeScenarioId = savedRow?.id || null;
  activeParentCmId = savedRow?.parent_cost_model_id || null;

  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderContent();

  rootEl.querySelector('[data-action="cog-back"]')?.addEventListener('click', async () => {
    await renderLanding();
  });
}

/**
 * Cleanup.
 */
export function unmount() {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  rootEl = null;
  bus.emit('cog:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  const tabs = [
    { key: 'points', label: 'Demand Points' },
    { key: 'analysis', label: 'Analysis' },
    { key: 'map', label: 'Map' },
    { key: 'sensitivity', label: 'Sensitivity' },
  ];

  const chips = [
    { label: activeScenarioId ? 'Saved' : 'Draft', kind: activeScenarioId ? 'saved' : 'draft', dot: true },
    activeParentCmId
      ? { label: 'Linked to CM', kind: 'linked', title: `Linked to Cost Model #${activeParentCmId}` }
      : { label: 'Stand-alone', kind: 'standalone', title: 'Not linked to a Cost Model' },
  ];

  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height:100%;">
      ${renderToolHeader({
        toolName: 'Center of Gravity',
        toolKey: 'cog',
        backAction: 'cog-back',
        tabs,
        activeTab,
        tabsId: 'cog-tabs',
        statusChips: chips,
        primaryAction: { label: 'Find Optimal Location', action: 'cog-run', icon: '▶', title: 'Run k-means (Cmd/Ctrl+Enter)' },
      })}
      <div id="cog-content" style="flex:1;overflow-y:auto;padding:24px;"></div>
    </div>
  `;
}

function bindShellEvents() {
  if (!rootEl) return;

  rootEl.querySelector('#cog-tabs')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-tab]');
    if (!btn) return;
    activeTab = /** @type {any} */ (btn.dataset.tab);
    rootEl.querySelectorAll('#cog-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeTab);
    });
    renderContent();
  });

  const runBtn = rootEl.querySelector('[data-primary-action="cog-run"]');
  runBtn?.addEventListener('click', () => {
    cogResult = calc.kMeansCog(points, config.numCenters, config.maxIterations);
    sensitivityData = calc.sensitivityAnalysis(points, Math.max(config.numCenters, 5), config.transportCostPerMile, config.maxIterations);
    activeTab = 'analysis';
    rootEl.querySelectorAll('#cog-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeTab);
    });
    renderContent();
    flashRunButton(runBtn);
  });

  bindPrimaryActionShortcut(rootEl, 'cog-run');
}

function renderContent() {
  const el = rootEl?.querySelector('#cog-content');
  if (!el) return;

  switch (activeTab) {
    case 'points': renderPoints(el); break;
    case 'analysis': renderAnalysis(el); break;
    case 'map': renderMap(el); break;
    case 'sensitivity': renderSensitivity(el); break;
  }
}

// ============================================================
// POINTS TAB
// ============================================================

function renderPoints(el) {
  const totalWeight = points.reduce((s, p) => s + p.weight, 0);

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Weighted Demand Points</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-add-point">+ Add Point</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-load-demo">Load Demo</button>
        </div>
      </div>

      <!-- Config -->
      <div class="hub-card" style="margin-bottom:20px;padding:16px;border-left:3px solid var(--ies-blue);">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);margin-bottom:10px;">Analysis Configuration</div>
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Number of Nodes / Facilities:</label>
            <input type="number" value="${config.numCenters}" min="1" max="20" id="cog-k"
                   style="width:70px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:14px;font-weight:700;text-align:center;color:var(--ies-blue);">
            <span style="font-size:11px;color:var(--ies-gray-400);">How many DC locations to optimize for</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Transport $/mi:</label>
            <input type="number" value="${config.transportCostPerMile}" step="0.01" id="cog-cpm"
                   style="width:80px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Max Iterations:</label>
            <input type="number" value="${config.maxIterations || 100}" min="10" max="500" step="10" id="cog-iter"
                   style="width:80px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
          </div>
        </div>
      </div>

      <!-- Points table -->
      <div style="max-height:400px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#fff;">
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Name</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lat</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lng</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Weight</th>
              <th style="text-align:center;padding:8px 6px;font-weight:700;">Type</th>
              <th style="text-align:center;padding:8px 6px;"></th>
            </tr>
          </thead>
          <tbody>
            ${points.map((p, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${p.name || p.id}</td>
                <td style="padding:6px;text-align:right;">${p.lat.toFixed(2)}</td>
                <td style="padding:6px;text-align:right;">${p.lng.toFixed(2)}</td>
                <td style="padding:6px;text-align:right;">${p.weight.toLocaleString()}</td>
                <td style="padding:6px;text-align:center;">
                  <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;
                    background:${p.type === 'demand' ? '#dbeafe' : p.type === 'supply' ? '#dcfce7' : '#fef3c7'};
                    color:${p.type === 'demand' ? '#1d4ed8' : p.type === 'supply' ? '#15803d' : '#92400e'};">
                    ${p.type}
                  </span>
                </td>
                <td style="padding:6px;text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-pt-del="${i}" style="padding:4px 8px;">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          ${kpi('Points', String(points.length))}
          ${kpi('Total Weight', totalWeight.toLocaleString())}
          ${kpi('Centers (k)', String(config.numCenters))}
        </div>
      </div>
    </div>
  `;

  // Bind config inputs
  el.querySelector('#cog-k')?.addEventListener('change', (e) => {
    config.numCenters = Math.max(1, Math.min(20, parseInt(/** @type {HTMLInputElement} */ (e.target).value) || 1));
  });
  el.querySelector('#cog-cpm')?.addEventListener('change', (e) => {
    config.transportCostPerMile = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 2.85;
  });
  el.querySelector('#cog-iter')?.addEventListener('change', (e) => {
    config.maxIterations = Math.max(10, Math.min(500, parseInt(/** @type {HTMLInputElement} */ (e.target).value) || 100));
  });

  // Delete points
  el.querySelectorAll('[data-pt-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      points.splice(parseInt(/** @type {HTMLElement} */ (btn).dataset.ptDel), 1);
      renderPoints(el);
    });
  });

  el.querySelector('#cog-add-point')?.addEventListener('click', () => {
    points.push({ id: 'p' + Date.now(), name: 'New Point', lat: 39.83, lng: -98.58, weight: 10000, type: 'demand' });
    renderPoints(el);
  });

  el.querySelector('#cog-load-demo')?.addEventListener('click', () => {
    points = calc.DEMO_POINTS.map(p => ({ ...p }));
    renderPoints(el);
  });
}

// ============================================================
// ANALYSIS TAB
// ============================================================

function renderAnalysis(el) {
  if (!cogResult) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Click "Find Optimal Location" to see results.</p></div>';
    return;
  }

  const costEst = calc.estimateTransportCost(cogResult, points, config.transportCostPerMile);

  el.innerHTML = `
    <div style="max-width:900px;">
      <!-- Action Bar -->
      <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center;">
        <h3 class="text-section" style="margin:0;flex:1;">Analysis Results</h3>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-export-csv" style="display:flex;align-items:center;gap:6px;">
          <span>↓ Export CSV</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-push-netopt" style="display:flex;align-items:center;gap:6px;">
          <span>Send to NetOpt →</span>
        </button>
      </div>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Centers Found', String(cogResult.centers.length))}
          ${kpi('Iterations', String(cogResult.iterations))}
          ${kpi('Est. Transport Cost', calc.formatCurrency(costEst.totalCost, { compact: true }))}
          ${kpi('Avg Cost/Unit', calc.formatCurrency(costEst.avgCostPerUnit))}
        </div>
      </div>

      <!-- Center Details -->
      ${cogResult.centers.map((c, i) => `
        <div class="hub-card" style="margin-bottom:16px;border-left:4px solid ${clusterColor(i)};">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
            <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${clusterColor(i)};"></span>
            <span style="font-size:14px;font-weight:700;">Center ${i + 1}: ${c.nearestCity}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;font-size:13px;">
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Location</span>
              <div style="font-weight:600;">${calc.formatLatLng(c.lat, c.lng)}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Assigned Weight</span>
              <div style="font-weight:600;">${c.totalWeight.toLocaleString()}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Avg Weighted Dist</span>
              <div style="font-weight:600;">${calc.formatMiles(c.avgWeightedDistance)}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Max Distance</span>
              <div style="font-weight:600;">${calc.formatMiles(c.maxDistance)}</div>
            </div>
          </div>
        </div>
      `).join('')}

      <!-- Assignment Table -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Point Assignments</div>
        <div style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead style="position:sticky;top:0;background:#fff;">
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:center;padding:6px;">Cluster</th>
                <th style="text-align:left;padding:6px;">Point</th>
                <th style="text-align:right;padding:6px;">Weight</th>
                <th style="text-align:right;padding:6px;">Distance</th>
                <th style="text-align:right;padding:6px;">Transport Cost</th>
              </tr>
            </thead>
            <tbody>
              ${cogResult.assignments.map(a => {
                const pt = points.find(p => p.id === a.pointId);
                const cost = a.distanceToCenter * (pt?.weight || 0) * config.transportCostPerMile;
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);">
                    <td style="padding:6px;text-align:center;">
                      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${clusterColor(a.clusterId)};"></span>
                    </td>
                    <td style="padding:6px;font-weight:600;">${pt?.name || a.pointId}</td>
                    <td style="padding:6px;text-align:right;">${(pt?.weight || 0).toLocaleString()}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatMiles(a.distanceToCenter)}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(cost, { compact: true })}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Bind CSV export
  el.querySelector('#cog-export-csv')?.addEventListener('click', () => {
    exportCogAnalysis();
  });

  // Bind NetOpt push
  el.querySelector('#cog-push-netopt')?.addEventListener('click', () => {
    pushToNetOpt();
  });
}

// ============================================================
// MAP TAB
// ============================================================

function renderMap(el) {
  if (!cogResult) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Run analysis first to see the map.</p></div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
        <h3 class="text-section" style="margin:0;">Center of Gravity Map</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${points.length} points • ${cogResult.centers.length} center(s)</span>
        <div style="margin-left:auto;display:flex;gap:10px;align-items:center;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-cog-toggle="zones" ${mapOptions.zones ? 'checked' : ''} style="margin:0;"> Service zones
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-cog-toggle="heat" ${mapOptions.heat ? 'checked' : ''} style="margin:0;"> Heatmap
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ies-gray-600);">
            Radii:
            <input type="text" data-cog-toggle="radii" value="${mapOptions.zoneRadiiMiles.join(',')}"
                   style="width:100px;padding:2px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:11px;" title="Comma-separated service ring radii in miles">
          </label>
        </div>
      </div>
      <div id="cog-map-container" style="flex:1;min-height:500px;border-radius:10px;border:1px solid var(--ies-gray-200);overflow:hidden;"></div>
      <div style="display:flex;gap:16px;margin-top:12px;font-size:11px;color:var(--ies-gray-400);flex-wrap:wrap;">
        <span><span style="display:inline-block;width:14px;height:14px;background:#ef4444;border-radius:50%;vertical-align:middle;border:2px solid #fff;box-shadow:0 0 0 1px #ef4444;"></span> Optimal Center</span>
        ${cogResult.centers.map((_, i) => `
          <span><span style="display:inline-block;width:10px;height:10px;background:${clusterColor(i)};border-radius:50%;vertical-align:middle;"></span> Cluster ${i + 1}</span>
        `).join('')}
        ${mapOptions.zones ? `<span style="opacity:0.8;">Rings: ${mapOptions.zoneRadiiMiles.join(' / ')} mi</span>` : ''}
      </div>
    </div>
  `;

  // Wire toggles — only re-init the leaflet map (NOT the whole panel) so
  // the controls keep focus and we don't get into a render loop.
  el.querySelectorAll('[data-cog-toggle]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLElement} */ (e.target).dataset.cogToggle;
      if (key === 'radii') {
        const raw = /** @type {HTMLInputElement} */ (e.target).value;
        const parsed = raw.split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n) && n > 0);
        mapOptions.zoneRadiiMiles = parsed.length ? parsed : [250, 500, 750];
      } else {
        mapOptions[key] = /** @type {HTMLInputElement} */ (e.target).checked;
      }
      initCogMap();
    });
  });

  // Init the map. The element has `flex:1` + `min-height:500px` on the
  // container so it's sized as soon as it's in the DOM — no need to
  // wait. If initCogMap does hit a zero-height snapshot on first paint
  // we fall back to a short retry.
  initCogMap();
  if (!mapInstance) {
    setTimeout(() => { if (!mapInstance) initCogMap(); }, 100);
  }
}

function initCogMap() {
  const container = rootEl?.querySelector('#cog-map-container');
  if (!container || !cogResult) return;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  if (typeof L === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">Map requires Leaflet.js</div>';
    return;
  }

  mapInstance = L.map(container).setView([39.8283, -98.5795], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap'
  }).addTo(mapInstance);

  // Heatmap layer (drawn first so it sits under markers).
  // We weight each demand point and overlay a soft halo whose radius
  // scales with weight relative to the max in the dataset.
  if (mapOptions.heat) {
    const maxWeight = Math.max(1, ...points.map(p => p.weight || 0));
    points.forEach(pt => {
      const w = pt.weight || 0;
      if (w <= 0) return;
      const norm = w / maxWeight;
      // Halo radius in metres: 80km at max weight, 12km at min meaningful weight
      const haloMetres = 12000 + norm * 68000;
      L.circle([pt.lat, pt.lng], {
        radius: haloMetres,
        color: '#ff5630',
        weight: 0,
        fillColor: '#ff5630',
        fillOpacity: 0.10 + norm * 0.20,    // 0.10 → 0.30
        interactive: false,
      }).addTo(mapInstance);
    });
  }

  // Service zones — translucent rings around each center at the
  // configured radii. Sits under the cluster lines so they read clearly.
  if (mapOptions.zones && Array.isArray(mapOptions.zoneRadiiMiles)) {
    cogResult.centers.forEach((c, i) => {
      const color = clusterColor(i);
      mapOptions.zoneRadiiMiles.forEach((mi, ringIdx) => {
        L.circle([c.lat, c.lng], {
          radius: mi * 1609.34,                           // miles → metres
          color,
          weight: 1,
          opacity: 0.5,
          fillColor: color,
          fillOpacity: 0.04 + (mapOptions.zoneRadiiMiles.length - ringIdx) * 0.02,
          dashArray: ringIdx > 0 ? '4 4' : null,
          interactive: false,
        }).addTo(mapInstance);
      });
    });
  }

  // Demand points colored by cluster
  cogResult.assignments.forEach(a => {
    const pt = points.find(p => p.id === a.pointId);
    if (!pt) return;
    const color = clusterColor(a.clusterId);
    const size = Math.max(4, Math.min(10, pt.weight / 10000));
    const marker = L.circleMarker([pt.lat, pt.lng], {
      radius: size, fillColor: color, color: color, weight: 1, fillOpacity: 0.7,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>${pt.name || pt.id}</strong><br>Weight: ${pt.weight.toLocaleString()}<br>Cluster: ${a.clusterId + 1}<br>Distance: ${calc.formatMiles(a.distanceToCenter)}`);

    // Line to center
    const center = cogResult.centers[a.clusterId];
    if (center) {
      L.polyline([[pt.lat, pt.lng], [center.lat, center.lng]], {
        color, weight: 1, opacity: 0.3,
      }).addTo(mapInstance);
    }
  });

  // Center markers (star-like — larger with border)
  cogResult.centers.forEach((c, i) => {
    const marker = L.circleMarker([c.lat, c.lng], {
      radius: 14, fillColor: '#ef4444', color: '#fff', weight: 3, fillOpacity: 0.9,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>Center ${i + 1}</strong><br>${c.nearestCity}<br>Location: ${calc.formatLatLng(c.lat, c.lng)}<br>Avg Distance: ${calc.formatMiles(c.avgWeightedDistance)}`);
  });

  // Fit bounds
  const allPts = [...points.map(p => [p.lat, p.lng]), ...cogResult.centers.map(c => [c.lat, c.lng])];
  if (allPts.length > 0) mapInstance.fitBounds(allPts, { padding: [30, 30] });
}

// ============================================================
// SENSITIVITY TAB
// ============================================================

function renderSensitivity(el) {
  if (!sensitivityData) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Run analysis first to see sensitivity data.</p></div>';
    return;
  }

  const maxCost = Math.max(...sensitivityData.map(d => d.estimatedCost));
  const minCost = Math.min(...sensitivityData.map(d => d.estimatedCost));
  const costRange = maxCost - minCost;

  // Network summary
  const optimal = sensitivityData[sensitivityData.length - 1];
  const baseline = sensitivityData[0];
  const savings = baseline.estimatedCost - optimal.estimatedCost;
  const savingsPct = baseline.estimatedCost > 0 ? (savings / baseline.estimatedCost * 100).toFixed(1) : 0;

  el.innerHTML = `
    <div style="max-width:900px;">
      <h3 class="text-section" style="margin-bottom:16px;">Sensitivity: Number of Centers vs. Cost</h3>

      <!-- Network Summary -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;background:linear-gradient(135deg,#f0fdf4,#f0fdf4);border-left:4px solid #22c55e;">
        <div style="font-size:13px;font-weight:700;color:#15803d;margin-bottom:8px;">Optimal Network Summary</div>
        <div style="font-size:13px;line-height:1.6;color:#166534;">
          Optimal network of <strong>${cogResult.centers.length}</strong> facilit${cogResult.centers.length === 1 ? 'y' : 'ies'} reduces
          avg distance to <strong>${cogResult.centers[0] ? calc.formatMiles(cogResult.centers.reduce((s, c) => s + c.avgWeightedDistance, 0) / cogResult.centers.length) : 'N/A'}</strong>
          per facility, with total annual transport cost of <strong>${calc.formatCurrency(cogResult.assignments ?
            calc.estimateTransportCost(cogResult, points, config.transportCostPerMile).totalCost : 0)}</strong>.
          Compared to single facility: <strong>${savingsPct}%</strong> savings.
        </div>
      </div>

      <!-- Cost Curve Chart (SVG) -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Cost Curve: Number of Centers vs. Annual Transport Cost</div>
        <svg width="100%" height="280" style="background:var(--ies-gray-50);border-radius:8px;">
          <!-- Grid lines -->
          ${sensitivityData.map((_, i) => {
            const chartW = Math.max(sensitivityData.length * 60, 300);
            const x = 60 + (i / (sensitivityData.length - 1)) * chartW;
            return `<line x1="${x}" y1="30" x2="${x}" y2="240" stroke="var(--ies-gray-200)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
          }).join('')}
          <line x1="50" y1="240" x2="${50 + Math.max(sensitivityData.length * 60, 300)}" y2="240" stroke="var(--ies-gray-400)" stroke-width="2"/>
          <line x1="50" y1="30" x2="50" y2="240" stroke="var(--ies-gray-400)" stroke-width="2"/>

          <!-- Bars -->
          ${sensitivityData.map((d, i) => {
            const chartW = Math.max(sensitivityData.length * 60, 300);
            const barW = Math.max(40, chartW / sensitivityData.length - 12);
            const x = 50 + (i + 0.5) / sensitivityData.length * chartW;
            const barH = costRange > 0 ? ((d.estimatedCost - minCost) / costRange) * 190 : 10;
            const y = 240 - barH;
            const isCurrent = d.k === config.numCenters;
            const isElbow = d.isElbow === true;
            const color = isElbow ? '#f97316' : isCurrent ? '#2563eb' : '#93c5fd';
            const borderStyle = isElbow ? 'stroke="#ea580c" stroke-width="2"' : '';
            return `
              <rect x="${x - barW/2}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="4" ${borderStyle}/>
              ${isElbow ? `<text x="${x}" y="${y - 8}" text-anchor="middle" font-size="14" fill="#f97316">★</text>` : ''}
              <text x="${x}" y="260" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ies-gray-600)">k=${d.k}</text>
            `;
          }).join('')}

          <!-- Y-axis labels -->
          <text x="40" y="250" text-anchor="end" font-size="11" fill="var(--ies-gray-400)">$0</text>
          <text x="40" y="135" text-anchor="end" font-size="11" fill="var(--ies-gray-400)">${calc.formatCurrency(minCost + costRange/2, { compact: true })}</text>
          <text x="40" y="35" text-anchor="end" font-size="11" fill="var(--ies-gray-400)">${calc.formatCurrency(maxCost, { compact: true })}</text>
        </svg>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:8px;">
          <span style="margin-right:16px;"><strong style="color:var(--ies-gray-600);">Blue bar</strong> = current selection (k=${config.numCenters})</span>
          <span><strong style="color:#f97316;">Orange bar ★</strong> = elbow point (optimal k)</span>
        </div>
      </div>

      <!-- Cost breakdown -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Estimated Annual Transport Cost by Number of Centers</div>
        ${sensitivityData.map((d, i) => {
          const pct = maxCost > 0 ? (d.estimatedCost / maxCost) * 100 : 0;
          const isCurrent = d.k === config.numCenters;
          return `
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:${isCurrent ? '700' : '600'};">
                  k = ${d.k} ${isCurrent ? ' ← current' : ''}
                </span>
                <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(d.estimatedCost, { compact: true })}</span>
              </div>
              <div style="height:24px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${isCurrent ? 'var(--ies-blue)' : 'var(--ies-gray-400)'};border-radius:6px;"></div>
              </div>
              <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">
                Avg distance: ${calc.formatMiles(d.avgDistance)}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="hub-card" style="padding:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:center;padding:8px;font-weight:700;">k</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Total Weighted Distance</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Est. Annual Cost</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Avg Distance</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Marginal Savings</th>
            </tr>
          </thead>
          <tbody>
            ${sensitivityData.map((d, i) => {
              const prev = i > 0 ? sensitivityData[i - 1].estimatedCost : d.estimatedCost;
              const savings = prev - d.estimatedCost;
              return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);${d.k === config.numCenters ? 'background:#f0f9ff;' : ''}">
                  <td style="padding:8px;text-align:center;font-weight:700;">${d.k}</td>
                  <td style="padding:8px;text-align:right;">${Math.round(d.totalWeightedDistance).toLocaleString()}</td>
                  <td style="padding:8px;text-align:right;font-weight:600;">${calc.formatCurrency(d.estimatedCost, { compact: true })}</td>
                  <td style="padding:8px;text-align:right;">${calc.formatMiles(d.avgDistance)}</td>
                  <td style="padding:8px;text-align:right;color:${savings > 0 ? '#22c55e' : '#6b7280'};">${i > 0 ? calc.formatCurrency(savings, { compact: true }) : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="hub-card" style="margin-top:16px;background:#f0fdf4;border-color:#22c55e;">
        <div style="font-size:13px;font-weight:600;color:#15803d;margin-bottom:4px;">Interpretation Guide</div>
        <div style="font-size:13px;color:#166534;line-height:1.6;">
          Look for the "elbow" where adding another center yields diminishing returns. If the marginal savings from k to k+1 is less than the fixed cost of an additional facility, the current k is optimal.
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// EXPORT / INTEGRATION
// ============================================================

/**
 * Export current analysis to CSV.
 * Three sections: Summary (6 KPIs), Optimal Centers, Demand Points & Assignments.
 * F1 (P0) — CSV Export
 */
function exportCogAnalysis() {
  if (!cogResult) {
    showToast('No analysis results to export', 'warning');
    return;
  }

  const costEst = calc.estimateTransportCost(cogResult, points, config.transportCostPerMile);
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `cog-analysis-${now}.csv`;

  // Build CSV sections
  const sections = [];

  // Section 1: Summary KPIs
  sections.push('SUMMARY');
  sections.push('Metric,Value');
  sections.push(`Number of Centers,${cogResult.centers.length}`);
  sections.push(`Total Demand Weight,"${points.reduce((s, p) => s + p.weight, 0).toLocaleString()}"`);
  sections.push(`Estimated Annual Transport Cost,"${calc.formatCurrency(costEst.totalCost).replace(/[$,]/g, '')}"`);
  sections.push(`Average Cost per Unit,"${calc.formatCurrency(costEst.avgCostPerUnit).replace(/[$,]/g, '')}"`);
  sections.push(`K-means Iterations,${cogResult.iterations}`);
  sections.push(`Transport Cost per Mile,$${config.transportCostPerMile}`);
  sections.push('');

  // Section 2: Optimal Centers
  sections.push('OPTIMAL CENTERS');
  sections.push('Center,Latitude,Longitude,Nearest City,Assigned Weight,Avg Weighted Distance (mi),Max Distance (mi)');
  cogResult.centers.forEach((c, i) => {
    sections.push(`Center ${i + 1},"${c.lat.toFixed(4)}","${c.lng.toFixed(4)}","${c.nearestCity}","${c.totalWeight.toLocaleString()}","${c.avgWeightedDistance.toFixed(2)}","${c.maxDistance.toFixed(2)}"`);
  });
  sections.push('');

  // Section 3: Demand Points & Assignments
  sections.push('DEMAND POINTS & ASSIGNMENTS');
  sections.push('Name,Latitude,Longitude,Weight,Assigned To Center,Distance to Center (mi),Transport Cost');
  cogResult.assignments.forEach(a => {
    const pt = points.find(p => p.id === a.pointId);
    const cost = a.distanceToCenter * (pt?.weight || 0) * config.transportCostPerMile;
    if (pt) {
      sections.push(`"${pt.name || pt.id}","${pt.lat.toFixed(4)}","${pt.lng.toFixed(4)}","${pt.weight}","Center ${a.clusterId + 1}","${a.distanceToCenter.toFixed(2)}","${cost.toFixed(2)}"`);
    }
  });

  const csvContent = sections.join('\n');
  downloadCSV(csvContent, filename);
  showToast('Analysis exported successfully', 'success');
}

/**
 * Push optimal centers to Network Optimizer as candidate facilities.
 * X11 (P1) — Push to NetOpt
 * Emits cog:push-to-netopt event with candidate facility data.
 */
function pushToNetOpt() {
  if (!cogResult) {
    showToast('No analysis results to push', 'warning');
    return;
  }

  const candidates = cogResult.centers.map((c, i) => ({
    name: `Center ${i + 1} (${c.nearestCity})`,
    lat: c.lat,
    lng: c.lng,
    annualDemand: c.totalWeight,
  }));

  bus.emit('cog:push-to-netopt', { candidates });
  showToast(`Pushed ${candidates.length} center(s) to Network Optimizer`, 'success');
}

// ============================================================
// HELPERS
// ============================================================

const CLUSTER_COLORS = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];

function clusterColor(idx) {
  return CLUSTER_COLORS[idx % CLUSTER_COLORS.length];
}

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}
