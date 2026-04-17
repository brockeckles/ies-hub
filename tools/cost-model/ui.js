/**
 * IES Hub v3 — Cost Model Builder UI
 * Builder-pattern layout: 220px sidebar nav + fluid content area.
 * Each section renders from state via template literals + innerHTML.
 *
 * @module tools/cost-model/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260417-p4';
import { state } from '../../shared/state.js?v=20260417-p4';
import * as calc from './calc.js?v=20260417-p4';
import * as api from './api.js?v=20260417-p4';

// ============================================================
// STATE — tool-local reactive state
// ============================================================

/** @type {import('./types.js?v=20260417-p4').CostModelData} */
let model = createEmptyModel();

/** @type {Object} */
let refData = {};

/** @type {string} */
let activeSection = 'setup';

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {boolean} */
let isDirty = false;

/** @type {boolean} Track whether user has interacted — suppresses validation on fresh model */
let userHasInteracted = false;

// ============================================================
// DEMO FALLBACK DATA — used when Supabase ref tables unavailable
// ============================================================

const DEMO_MARKETS_FALLBACK = [
  { market_id: 'mem', name: 'Memphis, TN' },
  { market_id: 'ind', name: 'Indianapolis, IN' },
  { market_id: 'chi', name: 'Chicago, IL' },
  { market_id: 'dal', name: 'Dallas-Fort Worth, TX' },
  { market_id: 'atl', name: 'Atlanta, GA' },
  { market_id: 'lax', name: 'Los Angeles, CA' },
  { market_id: 'njy', name: 'Northern NJ / NYC Metro' },
  { market_id: 'col', name: 'Columbus, OH' },
  { market_id: 'leh', name: 'Lehigh Valley, PA' },
  { market_id: 'sav', name: 'Savannah, GA' },
  { market_id: 'lou', name: 'Louisville, KY' },
  { market_id: 'pho', name: 'Phoenix, AZ' },
  { market_id: 'cin', name: 'Cincinnati, OH' },
  { market_id: 'rvs', name: 'Riverside / Inland Empire, CA' },
  { market_id: 'nas', name: 'Nashville, TN' },
  { market_id: 'hou', name: 'Houston, TX' },
  { market_id: 'kci', name: 'Kansas City, MO' },
  { market_id: 'rno', name: 'Reno, NV' },
  { market_id: 'cha', name: 'Charlotte, NC' },
  { market_id: 'sea', name: 'Seattle-Tacoma, WA' },
];

// ============================================================
// SECTIONS — 13 nav sections
// ============================================================

const SECTIONS = [
  { key: 'setup', label: 'Setup', icon: 'settings' },
  { key: 'volumes', label: 'Volumes', icon: 'bar-chart' },
  { key: 'orderProfile', label: 'Order Profile', icon: 'package' },
  { key: 'facility', label: 'Facility', icon: 'home' },
  { key: 'shifts', label: 'Shifts', icon: 'clock' },
  { key: 'labor', label: 'Labor', icon: 'users' },
  { key: 'equipment', label: 'Equipment', icon: 'truck' },
  { key: 'overhead', label: 'Overhead', icon: 'layers' },
  { key: 'vas', label: 'VAS', icon: 'star' },
  { key: 'financial', label: 'Financial', icon: 'trending-up' },
  { key: 'startup', label: 'Start-Up / Capital', icon: 'zap' },
  { key: 'pricing', label: 'Pricing', icon: 'tag' },
  { key: 'summary', label: 'Summary', icon: 'pie-chart' },
];

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Cost Model Builder.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeSection = 'setup';
  model = createEmptyModel();
  userHasInteracted = false;

  // Render shell
  el.innerHTML = renderShell();

  // Wire up sidebar nav
  el.querySelectorAll('.cm-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const key = item.dataset.section;
      if (key) navigateSection(key);
    });
  });

  // Wire up toolbar
  el.querySelector('#cm-new-btn')?.addEventListener('click', handleNew);
  el.querySelector('#cm-save-btn')?.addEventListener('click', handleSave);
  el.querySelector('#cm-load-btn')?.addEventListener('click', handleLoad);

  // Load reference data
  try {
    refData = await api.loadAllRefData();
  } catch (err) {
    console.warn('[CM] Failed to load ref data:', err);
    refData = {};
  }

  // Listen for cross-tool push events
  bus.on('most:push-to-cm', handleMostPush);
  bus.on('wsc:push-to-cm', handleWscPush);

  // Render initial section
  renderSection();
  updateValidation();

  bus.emit('cm:mounted');
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  bus.clear('most:push-to-cm');
  bus.clear('wsc:push-to-cm');
  if (isDirty) {
    console.log('[CM] Unmounting with unsaved changes');
  }
  rootEl = null;
  bus.emit('cm:unmounted');
}

// ============================================================
// SHELL RENDERING
// ============================================================

function renderShell() {
  return `
    <div class="hub-builder" style="height: calc(100vh - 48px);">
      <!-- Builder Sidebar (220px) -->
      <div class="hub-builder-sidebar">
        <!-- Toolbar -->
        <div style="padding: 12px 16px; border-bottom: 1px solid var(--ies-gray-200);">
          <div class="text-subtitle" style="margin-bottom: 8px;">Cost Model Builder</div>
          <div class="flex gap-2" style="flex-wrap: wrap;">
            <button class="hub-btn hub-btn-primary hub-btn-sm" id="cm-new-btn">New</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-save-btn">Save</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-load-btn">Load</button>
          </div>
        </div>
        <!-- Section Nav -->
        <nav style="padding: 8px 0;">
          ${SECTIONS.map(s => `
            <div class="cm-nav-item${s.key === activeSection ? ' active' : ''}" data-section="${s.key}">
              <span class="cm-nav-check" id="cm-check-${s.key}"></span>
              <span class="cm-nav-label">${s.label}</span>
            </div>
          `).join('')}
        </nav>
        <!-- Validation -->
        <div id="cm-validation" style="padding: 8px 16px; border-top: 1px solid var(--ies-gray-200); font-size: 11px;"></div>
      </div>

      <!-- Content Area -->
      <div class="hub-builder-content" id="cm-content">
        <div class="hub-builder-form" id="cm-section-content">
          <!-- Section content renders here -->
        </div>
      </div>
    </div>

    <style>
      .cm-nav-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: var(--ies-gray-600);
        transition: all 0.15s ease;
        border-left: 3px solid transparent;
      }
      .cm-nav-item:hover { background: var(--ies-gray-50); color: var(--ies-navy); }
      .cm-nav-item.active { background: rgba(0,71,171,0.06); color: var(--ies-blue); border-left-color: var(--ies-blue); }
      .cm-nav-check {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid var(--ies-gray-300);
        flex-shrink: 0;
      }
      .cm-nav-check.complete {
        background: var(--ies-green);
        border-color: var(--ies-green);
        position: relative;
      }
      .cm-nav-check.complete::after {
        content: '';
        position: absolute;
        left: 4px;
        top: 1px;
        width: 4px;
        height: 8px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }

      .cm-form-group { margin-bottom: 20px; }
      .cm-form-label {
        display: block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        margin-bottom: 6px;
      }
      .cm-form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .cm-form-row-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 16px;
      }

      .cm-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 20px;
        padding-bottom: 12px;
        border-bottom: 2px solid var(--ies-gray-200);
      }
      .cm-section-title { font-size: 16px; font-weight: 700; color: var(--ies-navy); }
      .cm-section-desc { font-size: 13px; color: var(--ies-gray-500); margin-top: 4px; }

      .cm-grid-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .cm-grid-table th {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        text-align: left;
        padding: 8px 10px;
        border-bottom: 2px solid var(--ies-gray-200);
        white-space: nowrap;
      }
      .cm-grid-table td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--ies-gray-100);
        vertical-align: middle;
      }
      .cm-grid-table input, .cm-grid-table select {
        padding: 6px 8px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
      }
      .cm-grid-table input:focus, .cm-grid-table select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 2px rgba(0,71,171,0.1);
      }
      .cm-num { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
      .cm-total-row td { font-weight: 700; border-top: 2px solid var(--ies-gray-300); background: var(--ies-gray-50); }

      .cm-add-row-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 8px;
        padding: 6px 12px;
        background: none;
        border: 1px dashed var(--ies-gray-300);
        border-radius: 6px;
        color: var(--ies-blue);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        font-family: Montserrat, sans-serif;
      }
      .cm-add-row-btn:hover { border-color: var(--ies-blue); background: rgba(0,71,171,0.04); }

      .cm-delete-btn {
        background: none;
        border: none;
        color: var(--ies-red);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
      }
      .cm-delete-btn:hover { background: rgba(220,53,69,0.08); }
    </style>
  `;
}

// ============================================================
// SECTION NAVIGATION
// ============================================================

function navigateSection(key) {
  activeSection = key;
  state.set('costModel.activeSection', key);

  // Update nav highlighting
  rootEl?.querySelectorAll('.cm-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === key);
  });

  renderSection();
  bus.emit('cm:section-changed', { section: key });
}

// ============================================================
// SECTION RENDERING — delegates to section-specific renderers
// ============================================================

function renderSection() {
  const container = rootEl?.querySelector('#cm-section-content');
  if (!container) return;

  const renderers = {
    setup: renderSetup,
    volumes: renderVolumes,
    orderProfile: renderOrderProfile,
    facility: renderFacility,
    shifts: renderShifts,
    labor: renderLabor,
    equipment: renderEquipment,
    overhead: renderOverhead,
    vas: renderVas,
    financial: renderFinancial,
    startup: renderStartup,
    pricing: renderPricing,
    summary: renderSummary,
  };

  const render = renderers[activeSection];
  if (render) {
    container.innerHTML = render();
    bindSectionEvents(activeSection, container);
  }
}

// ============================================================
// SECTION 1: SETUP
// ============================================================

function renderSetup() {
  const pd = model.projectDetails;
  const markets = (refData.markets && refData.markets.length > 0) ? refData.markets : DEMO_MARKETS_FALLBACK;

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Project Setup</div>
        <div class="cm-section-desc">Define the project basics — client, market, environment, and contract term.</div>
      </div>
    </div>

    <div class="cm-form-group">
      <label class="cm-form-label">Project Name</label>
      <input class="hub-input" id="cm-name" value="${pd.name || ''}" placeholder="e.g., Acme Ecommerce Fulfillment" data-field="projectDetails.name" />
    </div>

    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Client Name</label>
        <input class="hub-input" id="cm-client" value="${pd.clientName || ''}" placeholder="Client name" data-field="projectDetails.clientName" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Facility Location</label>
        <input class="hub-input" id="cm-location" value="${pd.facilityLocation || ''}" placeholder="City, State" data-field="projectDetails.facilityLocation" />
      </div>
    </div>

    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Market</label>
        <select class="hub-select" id="cm-market" data-field="projectDetails.market">
          <option value="">Select market...</option>
          ${markets.map(m => `<option value="${m.market_id}"${m.market_id === pd.market ? ' selected' : ''}>${m.market_name || m.name || m.market_id}</option>`).join('')}
        </select>
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Environment</label>
        <select class="hub-select" id="cm-env" data-field="projectDetails.environment">
          <option value="">Select environment...</option>
          ${['Ecommerce', 'Retail', 'Food & Beverage', 'Industrial', 'Pharmaceutical', 'Automotive', 'Consumer Goods'].map(e =>
            `<option value="${e.toLowerCase()}"${pd.environment === e.toLowerCase() ? ' selected' : ''}>${e}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Contract Term (Years)</label>
        <input class="hub-input" type="number" id="cm-term" value="${pd.contractTerm || 5}" min="1" max="20" step="1" data-field="projectDetails.contractTerm" data-type="number" />
      </div>
      <div></div>
    </div>
  `;
}

// ============================================================
// SECTION 2: VOLUMES
// ============================================================

function renderVolumes() {
  const lines = model.volumeLines || [];
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Annual Volumes</div>
        <div class="cm-section-desc">Define annual throughput volumes by activity type. Star the primary outbound line for unit cost metrics.</div>
      </div>
    </div>

    <table class="cm-grid-table">
      <thead>
        <tr>
          <th style="width:30px;"></th>
          <th>Activity</th>
          <th>Annual Volume</th>
          <th>UOM</th>
          <th style="width:60px;"></th>
        </tr>
      </thead>
      <tbody id="cm-volume-rows">
        ${lines.map((l, i) => `
          <tr>
            <td><button class="cm-star-btn${l.isOutboundPrimary ? ' active' : ''}" data-idx="${i}" title="Set as primary outbound">&#9733;</button></td>
            <td><input value="${l.name || ''}" style="width:180px;" data-idx="${i}" data-field="name" /></td>
            <td><input type="number" value="${l.volume || 0}" style="width:120px;" data-idx="${i}" data-field="volume" data-type="number" /></td>
            <td>
              <select style="width:90px;" data-idx="${i}" data-field="uom">
                ${['pallet', 'case', 'each', 'order', 'line'].map(u =>
                  `<option value="${u}"${l.uom === u ? ' selected' : ''}>${u}</option>`
                ).join('')}
              </select>
            </td>
            <td><button class="cm-delete-btn" data-action="delete-volume" data-idx="${i}">Delete</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-volume">+ Add Volume Line</button>

    <style>
      .cm-star-btn { background: none; border: none; cursor: pointer; font-size: 18px; color: var(--ies-gray-300); }
      .cm-star-btn.active { color: var(--ies-orange); }
      .cm-star-btn:hover { color: var(--ies-orange); }
    </style>
  `;
}

// ============================================================
// SECTION 3: ORDER PROFILE
// ============================================================

function renderOrderProfile() {
  const op = model.orderProfile || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Order Profile</div>
        <div class="cm-section-desc">Average order characteristics for cost-per-unit calculations.</div>
      </div>
    </div>

    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Lines Per Order</label>
        <input class="hub-input" type="number" value="${op.linesPerOrder || ''}" placeholder="e.g., 3.5" step="0.1" data-field="orderProfile.linesPerOrder" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Units Per Line</label>
        <input class="hub-input" type="number" value="${op.unitsPerLine || ''}" placeholder="e.g., 1.8" step="0.1" data-field="orderProfile.unitsPerLine" data-type="number" />
      </div>
    </div>

    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Average Order Weight</label>
        <input class="hub-input" type="number" value="${op.avgOrderWeight || ''}" placeholder="e.g., 12.5" step="0.1" data-field="orderProfile.avgOrderWeight" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Weight Unit</label>
        <select class="hub-select" data-field="orderProfile.weightUnit">
          <option value="lbs"${op.weightUnit === 'lbs' || !op.weightUnit ? ' selected' : ''}>Pounds (lbs)</option>
          <option value="kg"${op.weightUnit === 'kg' ? ' selected' : ''}>Kilograms (kg)</option>
        </select>
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 4: FACILITY
// ============================================================

function renderFacility() {
  const f = model.facility || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Facility</div>
        <div class="cm-section-desc">Warehouse dimensions and infrastructure. Facility cost is calculated from market rates.</div>
      </div>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="launch-wsc">Size with Calculator →</button>
    </div>

    <div class="cm-form-row-3">
      <div class="cm-form-group">
        <label class="cm-form-label">Total Square Footage</label>
        <input class="hub-input" type="number" value="${f.totalSqft || ''}" placeholder="e.g., 150000" step="1000" data-field="facility.totalSqft" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Clear Height (ft)</label>
        <input class="hub-input" type="number" value="${f.clearHeight || ''}" placeholder="e.g., 32" step="1" data-field="facility.clearHeight" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Dock Doors</label>
        <input class="hub-input" type="number" value="${f.dockDoors || ''}" placeholder="e.g., 24" step="1" data-field="facility.dockDoors" data-type="number" />
      </div>
    </div>

    ${renderFacilityCostCard()}
  `;
}

function renderFacilityCostCard() {
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const bd = calc.facilityCostBreakdown(model.facility || {}, fr, ur);

  if (bd.total === 0 && !market) {
    return `<div class="hub-card mt-4" style="background: var(--ies-gray-50);"><p class="text-body text-muted">Select a market in Setup to see facility cost calculations.</p></div>`;
  }

  return `
    <div class="hub-card mt-4">
      <div class="text-subtitle mb-4">Annual Facility Cost Breakdown</div>
      <table class="cm-grid-table">
        <thead><tr><th>Component</th><th class="cm-num">$/PSF/Yr</th><th class="cm-num">Annual Cost</th></tr></thead>
        <tbody>
          <tr><td>Lease</td><td class="cm-num">${(fr?.lease_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.lease)}</td></tr>
          <tr><td>CAM</td><td class="cm-num">${(fr?.cam_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.cam)}</td></tr>
          <tr><td>Property Tax</td><td class="cm-num">${(fr?.tax_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.tax)}</td></tr>
          <tr><td>Insurance</td><td class="cm-num">${(fr?.insurance_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.insurance)}</td></tr>
          <tr><td>Utilities</td><td class="cm-num">${((ur?.avg_monthly_per_sqft || 0) * 12).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.utility)}</td></tr>
          <tr class="cm-total-row"><td>Total</td><td></td><td class="cm-num">${calc.formatCurrency(bd.total)}</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// SECTION 5: SHIFTS
// ============================================================

function renderShifts() {
  const s = model.shifts || {};
  const opHrs = calc.operatingHours(s);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Shift Configuration</div>
        <div class="cm-section-desc">Define operating schedule. This drives labor hours and FTE calculations.</div>
      </div>
    </div>

    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Shifts Per Day</label>
        <input class="hub-input" type="number" value="${s.shiftsPerDay || 1}" min="1" max="3" step="1" data-field="shifts.shiftsPerDay" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Hours Per Shift</label>
        <input class="hub-input" type="number" value="${s.hoursPerShift || 8}" min="4" max="12" step="0.5" data-field="shifts.hoursPerShift" data-type="number" />
      </div>
    </div>
    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Days Per Week</label>
        <input class="hub-input" type="number" value="${s.daysPerWeek || 5}" min="1" max="7" step="1" data-field="shifts.daysPerWeek" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Weeks Per Year</label>
        <input class="hub-input" type="number" value="${s.weeksPerYear ?? 52}" min="1" max="52" step="1" data-field="shifts.weeksPerYear" data-type="number" />
      </div>
    </div>

    <div class="hub-card mt-4" style="background: linear-gradient(135deg, #0a1628, #0d1f3c); color: #fff; text-align: center;">
      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.6); margin-bottom: 4px;">
        Annual Operating Hours / Person
      </div>
      <div style="font-size: 32px; font-weight: 800;">${opHrs.toLocaleString()}</div>
    </div>

    <div class="cm-form-row mt-4">
      <div class="cm-form-group">
        <label class="cm-form-label">2nd Shift Premium (%)</label>
        <input class="hub-input" type="number" value="${s.shift2Premium || 0}" step="0.5" data-field="shifts.shift2Premium" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">3rd Shift Premium (%)</label>
        <input class="hub-input" type="number" value="${s.shift3Premium || 0}" step="0.5" data-field="shifts.shift3Premium" data-type="number" />
      </div>
    </div>
  `;
}

// ============================================================
// SECTIONS 6-13: Stub renderers (will be fully built out)
// ============================================================

function renderLabor() {
  const lines = model.laborLines || [];
  const opHrs = calc.operatingHours(model.shifts || {});
  const totalDirect = lines.reduce((s, l) => s + calc.directLineAnnualSimple(l), 0);
  const totalIndirect = (model.indirectLaborLines || []).reduce((s, l) => s + calc.indirectLineAnnualSimple(l, opHrs), 0);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Labor</div>
        <div class="cm-section-desc">Direct labor (MOST-driven) and indirect/management labor lines.</div>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-indirect">Auto-Generate Indirect Labor</button>
    </div>

    <div class="text-subtitle mb-2">Direct Labor</div>
    <table class="cm-grid-table">
      <thead>
        <tr><th>Activity</th><th>Equipment/MHE</th><th>Volume</th><th>UPH</th><th>Hrs/Yr</th><th>FTE</th><th>Rate</th><th>Burden%</th><th class="cm-num">Annual Cost</th><th></th></tr>
      </thead>
      <tbody>
        ${lines.map((l, i) => `
          <tr>
            <td><input value="${l.activity_name || ''}" style="width:110px;" data-array="laborLines" data-idx="${i}" data-field="activity_name" /></td>
            <td>
              <select style="width:100px;font-size:11px;" data-array="laborLines" data-idx="${i}" data-field="equipment_type">
                <option value=""${!l.equipment_type ? ' selected' : ''}>None</option>
                <option value="reach_truck"${l.equipment_type === 'reach_truck' ? ' selected' : ''}>Reach Truck</option>
                <option value="sit_down_forklift"${l.equipment_type === 'sit_down_forklift' ? ' selected' : ''}>Sit-Down FL</option>
                <option value="stand_up_forklift"${l.equipment_type === 'stand_up_forklift' ? ' selected' : ''}>Stand-Up FL</option>
                <option value="order_picker"${l.equipment_type === 'order_picker' ? ' selected' : ''}>Order Picker</option>
                <option value="walkie_rider"${l.equipment_type === 'walkie_rider' ? ' selected' : ''}>Walkie Rider</option>
                <option value="pallet_jack"${l.equipment_type === 'pallet_jack' ? ' selected' : ''}>Pallet Jack</option>
                <option value="electric_pallet_jack"${l.equipment_type === 'electric_pallet_jack' ? ' selected' : ''}>Elec Pallet Jack</option>
                <option value="turret_truck"${l.equipment_type === 'turret_truck' ? ' selected' : ''}>Turret Truck</option>
                <option value="amr"${l.equipment_type === 'amr' ? ' selected' : ''}>AMR/Robot</option>
                <option value="conveyor"${l.equipment_type === 'conveyor' ? ' selected' : ''}>Conveyor</option>
                <option value="rf_scanner"${l.equipment_type === 'rf_scanner' ? ' selected' : ''}>RF Scanner</option>
                <option value="voice_pick"${l.equipment_type === 'voice_pick' ? ' selected' : ''}>Voice Pick</option>
                <option value="manual"${l.equipment_type === 'manual' ? ' selected' : ''}>Manual/Walk</option>
              </select>
            </td>
            <td class="cm-num">${(l.volume || 0).toLocaleString()}</td>
            <td><input type="number" value="${l.base_uph || 0}" style="width:55px;" data-array="laborLines" data-idx="${i}" data-field="base_uph" data-type="number" /></td>
            <td class="cm-num">${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})}</td>
            <td class="cm-num">${calc.fte(l, opHrs).toFixed(1)}</td>
            <td><input type="number" value="${l.hourly_rate || 0}" style="width:55px;" step="0.5" data-array="laborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
            <td><input type="number" value="${l.burden_pct || 0}" style="width:45px;" data-array="laborLines" data-idx="${i}" data-field="burden_pct" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.directLineAnnualSimple(l))}</td>
            <td><button class="cm-delete-btn" data-action="delete-labor" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="8">Total Direct Labor</td><td class="cm-num">${calc.formatCurrency(totalDirect)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-labor">+ Add Labor Line</button>

    <div class="text-subtitle mb-2 mt-6">Indirect Labor</div>
    <table class="cm-grid-table">
      <thead>
        <tr><th>Role</th><th>Headcount</th><th>Rate</th><th>Burden%</th><th class="cm-num">Annual Cost</th><th></th></tr>
      </thead>
      <tbody>
        ${(model.indirectLaborLines || []).map((l, i) => `
          <tr>
            <td><input value="${l.role_name || ''}" style="width:140px;" data-array="indirectLaborLines" data-idx="${i}" data-field="role_name" /></td>
            <td><input type="number" value="${l.headcount || 0}" style="width:50px;" data-array="indirectLaborLines" data-idx="${i}" data-field="headcount" data-type="number" /></td>
            <td><input type="number" value="${l.hourly_rate || 0}" style="width:60px;" step="0.5" data-array="indirectLaborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
            <td><input type="number" value="${l.burden_pct || 0}" style="width:50px;" data-array="indirectLaborLines" data-idx="${i}" data-field="burden_pct" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.indirectLineAnnualSimple(l, opHrs))}</td>
            <td><button class="cm-delete-btn" data-action="delete-indirect" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="4">Total Indirect Labor</td><td class="cm-num">${calc.formatCurrency(totalIndirect)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-indirect">+ Add Indirect Line</button>
  `;
}

function renderEquipment() {
  const lines = model.equipmentLines || [];
  const total = calc.totalEquipmentCost(lines);
  const capital = calc.totalEquipmentCapital(lines);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Equipment</div>
        <div class="cm-section-desc">MHE, IT, racking, dock, and infrastructure equipment. Toggle lease vs purchase per line.</div>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-equipment">Auto-Generate Equipment</button>
    </div>

    <table class="cm-grid-table">
      <thead>
        <tr><th>Equipment</th><th>Category</th><th>Qty</th><th>Type</th><th>$/Mo</th><th>Acq Cost</th><th>Maint/Mo</th><th>Amort Yrs</th><th class="cm-num">Annual</th><th></th></tr>
      </thead>
      <tbody>
        ${lines.map((l, i) => `
          <tr>
            <td><input value="${l.equipment_name || ''}" style="width:120px;" data-array="equipmentLines" data-idx="${i}" data-field="equipment_name" /></td>
            <td>
              <select style="width:80px;" data-array="equipmentLines" data-idx="${i}" data-field="category">
                ${['MHE', 'IT', 'Racking', 'Dock', 'Charging', 'Office', 'Security', 'Conveyor'].map(c =>
                  `<option value="${c}"${l.category === c ? ' selected' : ''}>${c}</option>`
                ).join('')}
              </select>
            </td>
            <td><input type="number" value="${l.quantity || 1}" style="width:45px;" data-array="equipmentLines" data-idx="${i}" data-field="quantity" data-type="number" /></td>
            <td>
              <select style="width:80px;" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_type">
                <option value="lease"${(l.acquisition_type || 'lease') === 'lease' ? ' selected' : ''}>Lease</option>
                <option value="purchase"${l.acquisition_type === 'purchase' ? ' selected' : ''}>Purchase</option>
                <option value="service"${l.acquisition_type === 'service' ? ' selected' : ''}>Service</option>
              </select>
            </td>
            <td><input type="number" value="${l.monthly_cost || 0}" style="width:65px;" data-array="equipmentLines" data-idx="${i}" data-field="monthly_cost" data-type="number" /></td>
            <td><input type="number" value="${l.acquisition_cost || 0}" style="width:75px;" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_cost" data-type="number" /></td>
            <td><input type="number" value="${l.monthly_maintenance || 0}" style="width:65px;" data-array="equipmentLines" data-idx="${i}" data-field="monthly_maintenance" data-type="number" /></td>
            <td><input type="number" value="${l.amort_years || 5}" style="width:45px;" data-array="equipmentLines" data-idx="${i}" data-field="amort_years" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.equipLineTableCost(l))}</td>
            <td><button class="cm-delete-btn" data-action="delete-equipment" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="8">Operating Cost</td><td class="cm-num">${calc.formatCurrency(total)}</td><td></td></tr>
        <tr><td colspan="8" style="font-weight:600; color: var(--ies-gray-500);">Capital Investment</td><td class="cm-num" style="font-weight:600;">${calc.formatCurrency(capital)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-equipment">+ Add Equipment Line</button>
  `;
}

function renderOverhead() {
  const lines = model.overheadLines || [];
  const total = calc.totalOverheadCost(lines);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Overhead</div>
        <div class="cm-section-desc">Facility overhead, IT, insurance, and administrative costs.</div>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-overhead">Auto-Generate Overhead</button>
    </div>

    <table class="cm-grid-table">
      <thead><tr><th>Category</th><th>Description</th><th>Cost Type</th><th>Amount</th><th class="cm-num">Annual</th><th></th></tr></thead>
      <tbody>
        ${lines.map((l, i) => `
          <tr>
            <td><input value="${l.category || ''}" style="width:120px;" data-array="overheadLines" data-idx="${i}" data-field="category" /></td>
            <td><input value="${l.description || ''}" style="width:180px;" data-array="overheadLines" data-idx="${i}" data-field="description" /></td>
            <td>
              <select style="width:90px;" data-array="overheadLines" data-idx="${i}" data-field="cost_type">
                <option value="monthly"${l.cost_type === 'monthly' ? ' selected' : ''}>Monthly</option>
                <option value="annual"${l.cost_type === 'annual' ? ' selected' : ''}>Annual</option>
              </select>
            </td>
            <td><input type="number" value="${l.cost_type === 'monthly' ? (l.monthly_cost || 0) : (l.annual_cost || 0)}" style="width:90px;" data-array="overheadLines" data-idx="${i}" data-field="${l.cost_type === 'monthly' ? 'monthly_cost' : 'annual_cost'}" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.overheadLineAnnual(l))}</td>
            <td><button class="cm-delete-btn" data-action="delete-overhead" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="4">Total Overhead</td><td class="cm-num">${calc.formatCurrency(total)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-overhead">+ Add Overhead Line</button>
  `;
}

function renderVas() {
  const lines = model.vasLines || [];
  const total = calc.totalVasCost(lines);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Value-Added Services</div>
        <div class="cm-section-desc">Kitting, labeling, special packaging, and other VAS line items.</div>
      </div>
    </div>
    <table class="cm-grid-table">
      <thead><tr><th>Service</th><th>Rate</th><th>Volume</th><th class="cm-num">Annual Cost</th><th></th></tr></thead>
      <tbody>
        ${lines.map((l, i) => `
          <tr>
            <td><input value="${l.service || ''}" style="width:160px;" data-array="vasLines" data-idx="${i}" data-field="service" /></td>
            <td><input type="number" value="${l.rate || 0}" style="width:70px;" step="0.01" data-array="vasLines" data-idx="${i}" data-field="rate" data-type="number" /></td>
            <td><input type="number" value="${l.volume || 0}" style="width:90px;" data-array="vasLines" data-idx="${i}" data-field="volume" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.vasLineAnnual(l))}</td>
            <td><button class="cm-delete-btn" data-action="delete-vas" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="3">Total VAS</td><td class="cm-num">${calc.formatCurrency(total)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-vas">+ Add VAS Line</button>
  `;
}

function renderFinancial() {
  const f = model.financial || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Financial Parameters</div>
        <div class="cm-section-desc">Margin targets, escalation rates, discount rates, and financial thresholds.</div>
      </div>
    </div>
    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Target Margin (%)</label>
        <input class="hub-input" type="number" value="${f.targetMargin || 12}" step="0.5" data-field="financial.targetMargin" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Volume Growth (%/yr)</label>
        <input class="hub-input" type="number" value="${f.volumeGrowth || 3}" step="0.5" data-field="financial.volumeGrowth" data-type="number" />
      </div>
    </div>
    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Labor Escalation (%/yr)</label>
        <input class="hub-input" type="number" value="${f.laborEscalation || 4}" step="0.5" data-field="financial.laborEscalation" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Cost Escalation (%/yr)</label>
        <input class="hub-input" type="number" value="${f.annualEscalation || 3}" step="0.5" data-field="financial.annualEscalation" data-type="number" />
      </div>
    </div>
    <div class="cm-form-row">
      <div class="cm-form-group">
        <label class="cm-form-label">Discount Rate (%)</label>
        <input class="hub-input" type="number" value="${f.discountRate || 10}" step="0.5" data-field="financial.discountRate" data-type="number" />
      </div>
      <div class="cm-form-group">
        <label class="cm-form-label">Reinvestment Rate (%)</label>
        <input class="hub-input" type="number" value="${f.reinvestRate || 8}" step="0.5" data-field="financial.reinvestRate" data-type="number" />
      </div>
    </div>
  `;
}

function renderStartup() {
  const lines = model.startupLines || [];
  const contractYears = model.projectDetails?.contractTerm || 5;
  const totalCapital = calc.totalStartupCapital(lines);
  const totalAmort = calc.totalStartupAmort(lines, contractYears);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Start-Up / Capital</div>
        <div class="cm-section-desc">One-time implementation costs amortized over the ${contractYears}-year contract term.</div>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-startup">Auto-Generate Start-Up Costs</button>
    </div>

    <table class="cm-grid-table">
      <thead><tr><th>Description</th><th class="cm-num">One-Time Cost</th><th class="cm-num">Annual Amort</th><th class="cm-num">Monthly Amort</th><th></th></tr></thead>
      <tbody>
        ${lines.map((l, i) => {
          const amort = (l.one_time_cost || 0) / Math.max(1, contractYears);
          return `
            <tr>
              <td><input value="${l.description || ''}" style="width:200px;" data-array="startupLines" data-idx="${i}" data-field="description" /></td>
              <td><input type="number" value="${l.one_time_cost || 0}" style="width:100px;" data-array="startupLines" data-idx="${i}" data-field="one_time_cost" data-type="number" /></td>
              <td class="cm-num">${calc.formatCurrency(amort)}</td>
              <td class="cm-num">${calc.formatCurrency(amort / 12)}</td>
              <td><button class="cm-delete-btn" data-action="delete-startup" data-idx="${i}">Del</button></td>
            </tr>
          `;
        }).join('')}
        <tr class="cm-total-row"><td>Total</td><td class="cm-num">${calc.formatCurrency(totalCapital)}</td><td class="cm-num">${calc.formatCurrency(totalAmort)}</td><td class="cm-num">${calc.formatCurrency(totalAmort / 12)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-startup">+ Add Capital Item</button>
  `;
}

function renderPricing() {
  const buckets = model.pricingBuckets || [];
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model.shifts || {});
  const facilityCost = calc.totalFacilityCost(model.facility || {}, fr, ur);
  const contractYears = model.projectDetails?.contractTerm || 5;

  // Prep startup lines with annual_amort
  const startupWithAmort = (model.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears),
  }));

  const bucketCosts = calc.computeBucketCosts({
    buckets,
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost,
    operatingHours: opHrs,
  });

  const marginPct = (model.financial?.targetMargin || 0) / 100;
  const totalCost = Object.entries(bucketCosts).reduce((s, [k, v]) => k !== '_unassigned' ? s + v : s, 0);
  const totalRevenue = totalCost * (1 + marginPct);

  // Find volume driver for each bucket to compute per-unit rate
  const volumeByUom = {};
  for (const vl of (model.volumeLines || [])) {
    const key = vl.uom || 'each';
    volumeByUom[key] = (volumeByUom[key] || 0) + (vl.volume || 0);
  }

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Pricing Schedule</div>
        <div class="cm-section-desc">Cost allocation to pricing buckets. Rates include ${calc.formatPct(model.financial?.targetMargin || 0, 1)} target margin.</div>
      </div>
    </div>

    <table class="cm-grid-table">
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Type</th>
          <th>UOM</th>
          <th class="cm-num">Annual Cost</th>
          <th class="cm-num">Margin-Applied</th>
          <th class="cm-num">Volume</th>
          <th class="cm-num">Rate/Unit</th>
        </tr>
      </thead>
      <tbody>
        ${buckets.map(b => {
          const cost = bucketCosts[b.id] || 0;
          const withMargin = cost * (1 + marginPct);
          const vol = b.type === 'fixed' ? 12 : (volumeByUom[b.uom] || 0);
          const rate = vol > 0 ? withMargin / vol : 0;
          return `
            <tr>
              <td style="font-weight:600;">${b.name}</td>
              <td><span class="hub-badge hub-badge-${b.type === 'fixed' ? 'info' : 'success'}">${b.type}</span></td>
              <td>${b.type === 'fixed' ? '/month' : '/' + b.uom}</td>
              <td class="cm-num">${calc.formatCurrency(cost)}</td>
              <td class="cm-num" style="font-weight:700;">${calc.formatCurrency(withMargin)}</td>
              <td class="cm-num">${vol > 0 ? vol.toLocaleString() : '—'}</td>
              <td class="cm-num" style="font-weight:700; color: var(--ies-blue);">${vol > 0 ? calc.formatCurrency(rate, { decimals: 2 }) : '—'}</td>
            </tr>
          `;
        }).join('')}
        <tr class="cm-total-row">
          <td colspan="3">Total</td>
          <td class="cm-num">${calc.formatCurrency(totalCost)}</td>
          <td class="cm-num">${calc.formatCurrency(totalRevenue)}</td>
          <td></td>
          <td></td>
        </tr>
      </tbody>
    </table>

    ${bucketCosts['_unassigned'] > 0 ? `
      <div class="hub-card mt-4" style="border-left: 3px solid var(--ies-orange); background: rgba(255,193,7,0.06);">
        <div style="font-size:13px; font-weight:600; color: var(--ies-orange);">
          ${calc.formatCurrency(bucketCosts['_unassigned'])} in unassigned costs rolled into Management Fee.
        </div>
        <div style="font-size:12px; color: var(--ies-gray-500); margin-top:4px;">
          Assign pricing buckets to labor, equipment, overhead, and VAS lines to distribute costs accurately.
        </div>
      </div>
    ` : ''}

    <style>
      .hub-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.3px; }
      .hub-badge-info { background:rgba(0,71,171,0.1); color:var(--ies-blue); }
      .hub-badge-success { background:rgba(32,201,151,0.1); color:#0d9668; }
    </style>
  `;
}

function renderSummary() {
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model.shifts || {});
  const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
  const contractYears = model.projectDetails?.contractTerm || 5;
  const fin = model.financial || {};

  const summary = calc.computeSummary({
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: model.startupLines || [],
    facility: model.facility || {},
    shifts: model.shifts || {},
    facilityRate: fr,
    utilityRate: ur,
    contractYears,
    targetMarginPct: fin.targetMargin || 0,
    annualOrders: orders || 1,
  });

  // Build multi-year projections
  const marginFrac = (fin.targetMargin || 0) / 100;
  const projResult = calc.buildYearlyProjections({
    years: contractYears,
    baseLaborCost: summary.laborCost,
    baseFacilityCost: summary.facilityCost,
    baseEquipmentCost: summary.equipmentCost,
    baseOverheadCost: summary.overheadCost,
    baseVasCost: summary.vasCost,
    startupAmort: summary.startupAmort,
    startupCapital: summary.startupCapital,
    baseOrders: orders || 1,
    marginPct: marginFrac,
    volGrowthPct: (fin.volumeGrowth || 0) / 100,
    laborEscPct: (fin.laborEscalation || 0) / 100,
    costEscPct: (fin.annualEscalation || 0) / 100,
    laborLines: model.laborLines || [],
  });
  const projections = projResult.projections || [];

  // Financial metrics
  const metrics = calc.computeFinancialMetrics(projections, {
    startupCapital: summary.startupCapital,
    discountRate: (fin.discountRate || 10) / 100,
    reinvestRate: (fin.reinvestRate || 8) / 100,
    totalFtes: summary.totalFtes,
    fixedCost: summary.facilityCost + summary.overheadCost + summary.startupAmort,
  });

  // Sensitivity data
  const baseCosts = {
    labor: summary.laborCost,
    facility: summary.facilityCost,
    equipment: summary.equipmentCost,
    overhead: summary.overheadCost,
    vas: summary.vasCost,
    startup: summary.startupAmort,
  };
  const sensi = calc.sensitivityTable(baseCosts, orders || 1);

  const pcts = summary.totalCost > 0 ? {
    labor: (summary.laborCost / summary.totalCost * 100).toFixed(0),
    facility: (summary.facilityCost / summary.totalCost * 100).toFixed(0),
    equipment: (summary.equipmentCost / summary.totalCost * 100).toFixed(0),
    overhead: (summary.overheadCost / summary.totalCost * 100).toFixed(0),
    vas: (summary.vasCost / summary.totalCost * 100).toFixed(0),
    startup: (summary.startupAmort / summary.totalCost * 100).toFixed(0),
  } : { labor: 0, facility: 0, equipment: 0, overhead: 0, vas: 0, startup: 0 };

  // Threshold defaults for metric coloring
  const thresholds = fin.thresholds || {
    grossMargin: 10, ebitda: 8, ebit: 5, roic: 15, mirr: 12, payback: contractYears * 12,
  };

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Summary Dashboard</div>
        <div class="cm-section-desc">Cost breakdown, financial metrics, multi-year P&L, and sensitivity analysis.</div>
      </div>
    </div>

    <!-- KPI Bar -->
    <div class="hub-kpi-bar mb-6">
      <div class="hub-kpi-item">
        <div class="hub-kpi-label">Total Cost</div>
        <div class="hub-kpi-value">${calc.formatCurrency(summary.totalCost, {compact: true})}</div>
      </div>
      <div class="hub-kpi-item">
        <div class="hub-kpi-label">Revenue</div>
        <div class="hub-kpi-value">${calc.formatCurrency(summary.totalRevenue, {compact: true})}</div>
      </div>
      <div class="hub-kpi-item">
        <div class="hub-kpi-label">Cost/Order</div>
        <div class="hub-kpi-value">${orders > 0 ? calc.formatCurrency(summary.costPerOrder, {decimals: 2}) : '—'}</div>
      </div>
      <div class="hub-kpi-item">
        <div class="hub-kpi-label">FTEs</div>
        <div class="hub-kpi-value">${summary.totalFtes.toFixed(0)}</div>
      </div>
      <div class="hub-kpi-item">
        <div class="hub-kpi-label">Capital</div>
        <div class="hub-kpi-value">${calc.formatCurrency(summary.equipmentCapital + summary.startupCapital, {compact: true})}</div>
      </div>
    </div>

    <!-- Cost Breakdown -->
    <div class="hub-card mb-4">
      <div class="text-subtitle mb-4">Cost Breakdown</div>
      <div style="display: flex; height: 32px; border-radius: 6px; overflow: hidden; margin-bottom: 16px;">
        <div style="width:${pcts.labor}%; background: #0047AB;" title="Labor ${pcts.labor}%"></div>
        <div style="width:${pcts.facility}%; background: #20c997;" title="Facility ${pcts.facility}%"></div>
        <div style="width:${pcts.equipment}%; background: #ffc107;" title="Equipment ${pcts.equipment}%"></div>
        <div style="width:${pcts.overhead}%; background: #6c757d;" title="Overhead ${pcts.overhead}%"></div>
        <div style="width:${pcts.vas}%; background: #dc3545;" title="VAS ${pcts.vas}%"></div>
        <div style="width:${pcts.startup}%; background: #ff3a00;" title="Start-Up ${pcts.startup}%"></div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
        ${[
          { label: 'Labor', value: summary.laborCost, pct: pcts.labor, color: '#0047AB' },
          { label: 'Facility', value: summary.facilityCost, pct: pcts.facility, color: '#20c997' },
          { label: 'Equipment', value: summary.equipmentCost, pct: pcts.equipment, color: '#ffc107' },
          { label: 'Overhead', value: summary.overheadCost, pct: pcts.overhead, color: '#6c757d' },
          { label: 'VAS', value: summary.vasCost, pct: pcts.vas, color: '#dc3545' },
          { label: 'Start-Up', value: summary.startupAmort, pct: pcts.startup, color: '#ff3a00' },
        ].map(c => `
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="width:12px; height:12px; border-radius:3px; background:${c.color};"></div>
            <div>
              <div style="font-size:11px; font-weight:600; color:var(--ies-gray-500);">${c.label} (${c.pct}%)</div>
              <div style="font-size:14px; font-weight:700;">${calc.formatCurrency(c.value, {compact: true})}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Financial Metrics Dashboard -->
    <div class="hub-card mb-4">
      <div class="text-subtitle mb-4">Financial Metrics</div>
      <div class="cm-metrics-grid">
        ${renderMetricCard('Gross Margin', calc.formatPct(metrics.grossMarginPct), metrics.grossMarginPct >= (thresholds.grossMargin || 10))}
        ${renderMetricCard('EBITDA Margin', calc.formatPct(metrics.ebitdaMarginPct), metrics.ebitdaMarginPct >= (thresholds.ebitda || 8))}
        ${renderMetricCard('EBIT Margin', calc.formatPct(metrics.ebitMarginPct), metrics.ebitMarginPct >= (thresholds.ebit || 5))}
        ${renderMetricCard('ROIC', calc.formatPct(metrics.roicPct), metrics.roicPct >= (thresholds.roic || 15))}
        ${renderMetricCard('MIRR', calc.formatPct(metrics.mirrPct), metrics.mirrPct >= (thresholds.mirr || 12))}
        ${renderMetricCard('NPV', calc.formatCurrency(metrics.npv, {compact: true}), metrics.npv > 0)}
        ${renderMetricCard('Payback', metrics.paybackMonths > 0 ? metrics.paybackMonths + ' mo' : '—', metrics.paybackMonths > 0 && metrics.paybackMonths <= (thresholds.payback || contractYears * 12))}
        ${renderMetricCard('Rev/FTE', calc.formatCurrency(metrics.revenuePerFte, {compact: true}), true)}
        ${renderMetricCard('Contrib/Order', calc.formatCurrency(metrics.contribPerOrder, {decimals: 2}), metrics.contribPerOrder > 0)}
        ${renderMetricCard('Op Leverage', calc.formatPct(metrics.opLeveragePct), true)}
        ${renderMetricCard('Contract Value', calc.formatCurrency(metrics.contractValue, {compact: true}), true)}
        ${renderMetricCard('Total Investment', calc.formatCurrency(metrics.totalInvestment, {compact: true}), true)}
      </div>
    </div>

    <!-- Multi-Year P&L -->
    <div class="hub-card mb-4">
      <div class="text-subtitle mb-4">${contractYears}-Year P&L Projection</div>
      <div style="overflow-x: auto;">
        <table class="cm-grid-table">
          <thead>
            <tr>
              <th></th>
              ${projections.map(p => `<th class="cm-num">Year ${p.year}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr><td style="font-weight:600;">Orders</td>${projections.map(p => `<td class="cm-num">${Math.round(p.orders).toLocaleString()}</td>`).join('')}</tr>
            <tr><td>Labor</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.labor, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Facility</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.facility, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Equipment</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.equipment, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Overhead</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.overhead, {compact: true})}</td>`).join('')}</tr>
            <tr><td>VAS</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.vas, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Start-Up Amort</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.startup, {compact: true})}</td>`).join('')}</tr>
            <tr class="cm-total-row"><td>Total Cost</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.totalCost, {compact: true})}</td>`).join('')}</tr>
            <tr style="background:rgba(0,71,171,0.04);"><td style="font-weight:700; color:var(--ies-blue);">Revenue</td>${projections.map(p => `<td class="cm-num" style="font-weight:700; color:var(--ies-blue);">${calc.formatCurrency(p.revenue, {compact: true})}</td>`).join('')}</tr>
            <tr><td style="font-weight:600;">Gross Profit</td>${projections.map(p => `<td class="cm-num" style="font-weight:600; color:${p.grossProfit >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">${calc.formatCurrency(p.grossProfit, {compact: true})}</td>`).join('')}</tr>
            <tr><td>EBITDA</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.ebitda, {compact: true})}</td>`).join('')}</tr>
            <tr><td>EBIT</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.ebit, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Net Income</td>${projections.map(p => `<td class="cm-num">${calc.formatCurrency(p.netIncome, {compact: true})}</td>`).join('')}</tr>
            <tr style="border-top:2px solid var(--ies-gray-200);"><td>CapEx</td>${projections.map(p => `<td class="cm-num">${p.capex > 0 ? '(' + calc.formatCurrency(p.capex, {compact: true}) + ')' : '—'}</td>`).join('')}</tr>
            <tr><td>Free Cash Flow</td>${projections.map(p => `<td class="cm-num" style="font-weight:600; color:${p.freeCashFlow >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">${calc.formatCurrency(p.freeCashFlow, {compact: true})}</td>`).join('')}</tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sensitivity Analysis -->
    <div class="hub-card mb-4">
      <div class="text-subtitle mb-4">Sensitivity Analysis</div>
      <div style="overflow-x: auto;">
        <table class="cm-grid-table">
          <thead>
            <tr>
              <th>Driver</th>
              ${sensi[0]?.adjustments.map(a => `<th class="cm-num">${a.pct > 0 ? '+' : ''}${a.pct}%</th>`).join('') || ''}
            </tr>
          </thead>
          <tbody>
            ${sensi.map(driver => `
              <tr>
                <td style="font-weight:600;">${driver.label}</td>
                ${driver.adjustments.map(a => `
                  <td class="cm-num" style="color: ${a.delta > 0 ? 'var(--ies-red)' : a.delta < 0 ? 'var(--ies-green)' : 'inherit'};">
                    <div>${calc.formatCurrency(a.totalCost, {compact: true})}</div>
                    <div style="font-size:11px; opacity:0.7;">${a.delta >= 0 ? '+' : ''}${calc.formatCurrency(a.delta, {compact: true})}</div>
                  </td>
                `).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:11px; color:var(--ies-gray-400); margin-top:8px;">
        Base total cost: ${calc.formatCurrency(summary.totalCost, {compact: true})}. Red = cost increase, green = cost decrease.
      </div>
    </div>

    <!-- Design Heuristics -->
    <div class="hub-card mb-4">
      <div class="text-subtitle mb-4">Design Heuristics & Benchmarks</div>
      <div id="cm-heuristics-panel" style="display: grid; grid-template-columns: 1fr; gap: 8px;">
        ${renderHeuristicsPanel(model, summary)}
      </div>
    </div>

    <style>
      .cm-metrics-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }
      .cm-metric-card {
        padding: 12px;
        border-radius: 8px;
        border: 1px solid var(--ies-gray-200);
        text-align: center;
      }
      .cm-metric-card.pass { border-color: rgba(32,201,151,0.4); background: rgba(32,201,151,0.04); }
      .cm-metric-card.fail { border-color: rgba(220,53,69,0.3); background: rgba(220,53,69,0.04); }
      .cm-metric-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ies-gray-500); margin-bottom: 4px; }
      .cm-metric-value { font-size: 18px; font-weight: 800; }
      .cm-metric-card.pass .cm-metric-value { color: #0d9668; }
      .cm-metric-card.fail .cm-metric-value { color: var(--ies-red); }
    </style>
  `;
}

/** Render a single metric card with pass/fail coloring */
function renderMetricCard(label, value, passes) {
  return `
    <div class="cm-metric-card ${passes ? 'pass' : 'fail'}">
      <div class="cm-metric-label">${label}</div>
      <div class="cm-metric-value">${value}</div>
    </div>
  `;
}

/** Render heuristics panel with 10 benchmark checks */
function renderHeuristicsPanel(state, summary) {
  const checks = calc.generateHeuristics(state, summary);
  if (!checks || checks.length === 0) {
    return '<div style="padding: 12px; background: var(--ies-gray-50); border-radius: 6px; font-size: 13px; color: var(--ies-gray-500);">Enter project parameters to see design guidance.</div>';
  }

  return checks.map(check => {
    const icon = check.type === 'ok' ? '✓' : check.type === 'warn' ? '⚠' : 'ℹ';
    const bg = check.type === 'ok' ? 'rgba(32,201,151,0.06)' : check.type === 'warn' ? 'rgba(255,193,7,0.06)' : 'rgba(0,71,171,0.06)';
    const borderColor = check.type === 'ok' ? 'rgba(32,201,151,0.3)' : check.type === 'warn' ? 'rgba(255,193,7,0.3)' : 'rgba(0,71,171,0.3)';
    const color = check.type === 'ok' ? '#0d9668' : check.type === 'warn' ? '#ff9800' : '#0047AB';

    return `
      <div style="padding: 12px; background: ${bg}; border-left: 3px solid ${borderColor}; border-radius: 4px; font-size: 13px;">
        <div style="display: flex; gap: 8px; margin-bottom: 4px;">
          <span style="color: ${color}; font-weight: 700; font-size: 16px;">${icon}</span>
          <div style="font-weight: 600; color: var(--ies-navy); flex: 1;">${check.title}</div>
        </div>
        <div style="font-size: 12px; color: var(--ies-gray-600); margin-left: 24px;">${check.detail}</div>
      </div>
    `;
  }).join('');
}

// ============================================================
// EVENT BINDING — generic data-field system
// ============================================================

function bindSectionEvents(section, container) {
  // Generic input binding: data-field="path.to.field"
  container.querySelectorAll('[data-field]').forEach(input => {
    const event = input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(event, (e) => {
      const field = input.dataset.field;
      const isNum = input.dataset.type === 'number';
      const val = isNum ? parseFloat(input.value) || 0 : input.value;

      // Handle array fields (data-array + data-idx)
      if (input.dataset.array) {
        const arr = model[input.dataset.array];
        const idx = parseInt(input.dataset.idx);
        if (arr && arr[idx] !== undefined) {
          arr[idx][field] = val;
        }
      } else {
        // Dot-path assignment
        setNestedValue(model, field, val);
      }

      isDirty = true;
      if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
      // Re-render if the field affects calculated values
      if (shouldRerender(field)) renderSection();
    });
  });

  // Action buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx);
      handleAction(action, idx);
    });
  });

  // Star buttons (volumes)
  container.querySelectorAll('.cm-star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      model.volumeLines.forEach((l, i) => l.isOutboundPrimary = i === idx);
      renderSection();
    });
  });
}

function shouldRerender(field) {
  return field.includes('shifts.') || field.includes('facility.') ||
         field === 'projectDetails.market' || field === 'projectDetails.contractTerm' ||
         field === 'financial.targetMargin';
}

// ============================================================
// ACTIONS (add/delete rows)
// ============================================================

function handleAction(action, idx) {
  switch (action) {
    case 'add-volume':
      model.volumeLines.push({ name: '', volume: 0, uom: 'each', isOutboundPrimary: false });
      break;
    case 'delete-volume':
      model.volumeLines.splice(idx, 1);
      break;
    case 'add-labor':
      model.laborLines.push({ activity_name: '', volume: 0, base_uph: 0, annual_hours: 0, hourly_rate: 0, burden_pct: 30 });
      break;
    case 'delete-labor':
      model.laborLines.splice(idx, 1);
      break;
    case 'add-indirect':
      model.indirectLaborLines.push({ role_name: '', headcount: 0, hourly_rate: 0, burden_pct: 30 });
      break;
    case 'delete-indirect':
      model.indirectLaborLines.splice(idx, 1);
      break;
    case 'auto-gen-indirect':
      model.indirectLaborLines = calc.autoGenerateIndirectLabor(model);
      break;
    case 'add-equipment':
      model.equipmentLines.push({ equipment_name: '', category: 'MHE', quantity: 1, acquisition_type: 'lease', monthly_cost: 0, monthly_maintenance: 0 });
      break;
    case 'delete-equipment':
      model.equipmentLines.splice(idx, 1);
      break;
    case 'auto-gen-equipment':
      model.equipmentLines = calc.autoGenerateEquipment(model);
      break;
    case 'add-overhead':
      model.overheadLines.push({ category: '', description: '', cost_type: 'monthly', monthly_cost: 0 });
      break;
    case 'delete-overhead':
      model.overheadLines.splice(idx, 1);
      break;
    case 'auto-gen-overhead':
      model.overheadLines = calc.autoGenerateOverhead(model);
      break;
    case 'add-vas':
      model.vasLines.push({ service: '', rate: 0, volume: 0 });
      break;
    case 'delete-vas':
      model.vasLines.splice(idx, 1);
      break;
    case 'add-startup':
      model.startupLines.push({ description: '', one_time_cost: 0 });
      break;
    case 'delete-startup':
      model.startupLines.splice(idx, 1);
      break;
    case 'auto-gen-startup':
      model.startupLines = calc.autoGenerateStartup(model);
      break;
    case 'launch-wsc':
      bus.emit('cm:push-to-wsc', { clearHeight: model.facility?.clearHeight || 0, totalSqft: model.facility?.totalSqft || 0 });
      state.set('nav.tool', 'warehouse-sizing');
      window.location.hash = '#designtools/warehouse-sizing';
      return; // don't re-render
  }
  isDirty = true;
  renderSection();
}

// ============================================================
// TOOLBAR HANDLERS
// ============================================================

async function handleNew() {
  if (isDirty && !confirm('You have unsaved changes. Start a new model?')) return;
  model = createEmptyModel();
  isDirty = false;
  activeSection = 'setup';
  navigateSection('setup');
}

async function handleSave() {
  try {
    if (model.id) {
      await api.updateModel(model.id, model);
    } else {
      const saved = await api.createModel(model);
      model.id = saved.id;
    }
    isDirty = false;
    bus.emit('cm:model-saved', { id: model.id });
  } catch (err) {
    console.error('[CM] Save failed:', err);
    alert('Save failed: ' + err.message);
  }
}

async function handleLoad() {
  try {
    const models = await api.listModels();
    if (models.length === 0) {
      alert('No saved models found.');
      return;
    }
    // Simple selection — will be replaced with proper modal
    const names = models.map((m, i) => `${i + 1}. ${m.name} (${m.client_name || 'No client'})`).join('\n');
    const choice = prompt('Select a model:\n' + names);
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < models.length) {
      const full = await api.getModel(models[idx].id);
      if (full?.project_data) {
        model = { ...createEmptyModel(), ...full.project_data, id: full.id };
        isDirty = false;
        navigateSection('setup');
        bus.emit('cm:model-loaded', { id: model.id });
      }
    }
  } catch (err) {
    console.error('[CM] Load failed:', err);
    alert('Load failed: ' + err.message);
  }
}

// ============================================================
// VALIDATION UI
// ============================================================

function updateValidation() {
  const el = rootEl?.querySelector('#cm-validation');
  if (!el) return;

  // Don't show validation errors until the user starts working
  if (!userHasInteracted) {
    el.innerHTML = '<span style="color: var(--ies-blue); font-weight: 600;">Ready — enter project details to begin</span>';
    return;
  }

  const warnings = calc.validateModel(model);
  if (warnings.length === 0) {
    el.innerHTML = '<span style="color: var(--ies-green); font-weight: 600;">No issues found</span>';
    return;
  }

  const errors = warnings.filter(w => w.level === 'error').length;
  const warns = warnings.filter(w => w.level === 'warning').length;

  el.innerHTML = `
    <div style="color: ${errors > 0 ? 'var(--ies-red)' : 'var(--ies-yellow)'}; font-weight: 600;">
      ${errors > 0 ? `${errors} error${errors > 1 ? 's' : ''}` : ''}
      ${errors > 0 && warns > 0 ? ', ' : ''}
      ${warns > 0 ? `${warns} warning${warns > 1 ? 's' : ''}` : ''}
    </div>
  `;

  // Update section completion checks
  SECTIONS.forEach(s => {
    const check = rootEl?.querySelector(`#cm-check-${s.key}`);
    if (!check) return;
    const hasError = warnings.some(w => w.area === s.key && w.level === 'error');
    const hasData = sectionHasData(s.key);
    check.classList.toggle('complete', hasData && !hasError);
  });
}

function sectionHasData(key) {
  switch (key) {
    case 'setup': return !!(model.projectDetails?.name);
    case 'volumes': return model.volumeLines.length > 0;
    case 'facility': return (model.facility?.totalSqft || 0) > 0;
    case 'shifts': return true; // defaults always valid
    case 'labor': return model.laborLines.length > 0;
    case 'equipment': return model.equipmentLines.length > 0;
    case 'overhead': return model.overheadLines.length > 0;
    case 'financial': return (model.financial?.targetMargin || 0) > 0;
    default: return false;
  }
}

// ============================================================
// MOST → CM INTEGRATION
// ============================================================

/**
 * Handle incoming labor lines from MOST tool.
 * Merges or replaces CM laborLines with MOST-derived data.
 * @param {import('../most-standards/types.js?v=20260417-p4').MostToCmPayload} payload
 */
function handleMostPush(payload) {
  if (!payload?.laborLines?.length) return;

  // Replace any existing MOST-sourced lines (by template_id), keep manual ones
  const manualLines = model.laborLines.filter(l => !l.most_template_id);
  const mostLines = payload.laborLines.map(l => ({
    activity_name: l.activity_name || '',
    process_area: l.process_area || '',
    labor_category: l.labor_category || 'manual',
    volume: l.volume || 0,
    base_uph: l.base_uph || 0,
    annual_hours: l.annual_hours || 0,
    hourly_rate: l.hourly_rate || 0,
    burden_pct: l.burden_pct || 30,
    most_template_id: l.most_template_id || '',
    most_template_name: l.most_template_name || '',
  }));

  model.laborLines = [...manualLines, ...mostLines];
  isDirty = true;

  // Navigate to labor section to show the result
  navigateSection('labor');
  updateValidation();

  bus.emit('cm:labor-updated', { source: 'most', lineCount: mostLines.length });
  console.log(`[CM] Received ${mostLines.length} labor lines from MOST`);
}

// ============================================================
// WSC → CM INTEGRATION
// ============================================================

/**
 * Handle incoming facility data from Warehouse Sizing Calculator.
 * Populates CM facility section fields.
 * @param {import('../warehouse-sizing/types.js?v=20260417-p4').WscToCmPayload} payload
 */
function handleWscPush(payload) {
  if (!payload) return;

  model.facility = model.facility || {};
  if (payload.totalSqft) model.facility.totalSqft = payload.totalSqft;
  if (payload.clearHeight) model.facility.clearHeight = payload.clearHeight;
  if (payload.dockDoors) model.facility.dockDoors = payload.dockDoors;

  isDirty = true;
  navigateSection('facility');
  updateValidation();

  bus.emit('cm:facility-updated', { source: 'wsc' });
  console.log('[CM] Received facility data from WSC:', payload);
}

// ============================================================
// HELPERS
// ============================================================

function createEmptyModel() {
  return {
    id: null,
    projectDetails: { name: '', clientName: '', market: '', environment: '', facilityLocation: '', contractTerm: 5 },
    volumeLines: [
      { name: 'Receiving (Pallets)', volume: 0, uom: 'pallets', isOutboundPrimary: false },
      { name: 'Put-Away', volume: 0, uom: 'pallets', isOutboundPrimary: false },
      { name: 'Orders Shipped', volume: 0, uom: 'orders', isOutboundPrimary: true },
      { name: 'Each Picks', volume: 0, uom: 'eaches', isOutboundPrimary: false },
      { name: 'Case Picks', volume: 0, uom: 'cases', isOutboundPrimary: false },
    ],
    orderProfile: {},
    facility: { totalSqft: 0 },
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    laborLines: [
      { activity_name: 'Receiving', process_area: 'Inbound', labor_category: 'direct', volume: 0, base_uph: 200, annual_hours: 0, hourly_rate: 18.00, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Put-Away', process_area: 'Inbound', labor_category: 'direct', volume: 0, base_uph: 180, annual_hours: 0, hourly_rate: 18.00, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Picking', process_area: 'Outbound', labor_category: 'direct', volume: 0, base_uph: 120, annual_hours: 0, hourly_rate: 17.50, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Packing', process_area: 'Outbound', labor_category: 'direct', volume: 0, base_uph: 60, annual_hours: 0, hourly_rate: 16.50, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Shipping', process_area: 'Outbound', labor_category: 'direct', volume: 0, base_uph: 150, annual_hours: 0, hourly_rate: 17.00, burden_pct: 30, most_template_id: '', most_template_name: '' },
    ],
    indirectLaborLines: [
      { role: 'Supervisor', hourly_rate: 28.00, ratio_to_direct: 12, burden_pct: 35 },
      { role: 'Quality Lead', hourly_rate: 22.00, ratio_to_direct: 5, burden_pct: 35 },
    ],
    equipmentLines: [
      { equipment_name: 'Reach Truck', category: 'MHE', quantity: 0, acquisition_type: 'lease', monthly_lease: 0, acquisition_cost: 0, annual_maintenance: 0, amortization_years: 7, notes: '' },
      { equipment_name: 'RF Scanners', category: 'IT', quantity: 0, acquisition_type: 'lease', monthly_lease: 0, acquisition_cost: 0, annual_maintenance: 0, amortization_years: 5, notes: '' },
      { equipment_name: 'Selective Pallet Racking', category: 'Racking', quantity: 0, acquisition_type: 'purchase', monthly_lease: 0, acquisition_cost: 0, annual_maintenance: 0, amortization_years: 15, notes: '' },
      { equipment_name: 'Dock Levelers', category: 'Dock', quantity: 0, acquisition_type: 'purchase', monthly_lease: 0, acquisition_cost: 0, annual_maintenance: 0, amortization_years: 10, notes: '' },
      { equipment_name: 'WMS License', category: 'IT', quantity: 1, acquisition_type: 'service', monthly_lease: 0, acquisition_cost: 0, annual_maintenance: 0, amortization_years: 5, notes: 'Annual SaaS license' },
    ],
    overheadLines: [
      { category: 'Utilities', annual_cost: 0, driver: 'sqft', notes: 'Electric + gas' },
      { category: 'Insurance', annual_cost: 0, driver: 'fixed', notes: '' },
      { category: 'Maintenance', annual_cost: 0, driver: 'equipment value', notes: '' },
      { category: 'Supplies', annual_cost: 0, driver: 'per unit shipped', notes: 'Labels, tape, stretch wrap' },
    ],
    vasLines: [],
    financial: { targetMargin: 12, volumeGrowth: 3, laborEscalation: 4, annualEscalation: 3, discountRate: 10, reinvestRate: 8 },
    startupLines: [],
    pricingBuckets: [
      { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed', uom: 'month' },
      { id: 'storage', name: 'Storage', type: 'variable', uom: 'pallet' },
      { id: 'inbound', name: 'Inbound Handling', type: 'variable', uom: 'pallet' },
      { id: 'pick_pack', name: 'Pick & Pack', type: 'variable', uom: 'order' },
      { id: 'each_pick', name: 'Each Pick', type: 'variable', uom: 'each' },
      { id: 'outbound', name: 'Outbound Handling', type: 'variable', uom: 'order' },
      { id: 'vas', name: 'VAS', type: 'variable', uom: 'each' },
      { id: 'case_pick', name: 'Case Pick', type: 'variable', uom: 'case' },
    ],
  };
}

function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
