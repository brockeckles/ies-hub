/**
 * IES Hub v3 — Deal Management UI
 * Pipeline view, list view, and deal detail with DOS stage elements.
 * Full event delegation to survive innerHTML re-renders.
 *
 * @module hub/deal-management/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260417-mB';

/** @type {HTMLElement|null} */
let rootEl = null;
let viewMode = 'pipeline'; // pipeline | list | detail
let selectedDeal = null;
let detailTab = 'overview'; // overview | sites | dos | financials | documents

/** DOS stage definitions — GXO Deal Operating System 6-stage framework
 *  (canonical names from public.stages table). */
const DOS_STAGES = [
  { id: 1, name: 'Pre-Sales Engagement',       color: '#6b7280' },
  { id: 2, name: 'Deal Qualification',         color: '#2563eb' },
  { id: 3, name: 'Kick-Off & Solution Design', color: '#7c3aed' },
  { id: 4, name: 'Operations Review',          color: '#d97706' },
  { id: 5, name: 'Executive Review',           color: '#ea580c' },
  { id: 6, name: 'Delivery Handover',          color: '#16a34a' },
];

/** DOS templates per stage — from v2 38 templates */
const DOS_TEMPLATES = {
  1: [
    { id: 't1-1', name: 'Credit Check', status: 'complete', required: true },
    { id: 't1-2', name: 'NDA Execution', status: 'complete', required: true },
    { id: 't1-3', name: 'SCAN Document', status: 'complete', required: true },
    { id: 't1-4', name: 'Opportunity Qualification', status: 'complete', required: true },
    { id: 't1-5', name: 'Initial Data Request', status: 'complete', required: false },
  ],
  2: [
    { id: 't2-1', name: 'Solution Lead Assignment', status: 'complete', required: true },
    { id: 't2-2', name: 'Qualification Meeting', status: 'complete', required: true },
    { id: 't2-3', name: 'Site Visit Scheduling', status: 'in-progress', required: true },
    { id: 't2-4', name: 'Data Collection Package', status: 'in-progress', required: true },
    { id: 't2-5', name: 'Preliminary Scope Document', status: 'pending', required: false },
    { id: 't2-6', name: 'Competitive Intelligence', status: 'pending', required: false },
  ],
  3: [
    { id: 't3-1', name: 'Kick-Off Meeting', status: 'complete', required: true },
    { id: 't3-2', name: 'Data Analysis & Validation', status: 'in-progress', required: true },
    { id: 't3-3', name: 'Engineering Workbook', status: 'in-progress', required: true },
    { id: 't3-4', name: 'Cost Model Build', status: 'pending', required: true },
    { id: 't3-5', name: 'Warehouse Sizing / Layout', status: 'pending', required: true },
    { id: 't3-6', name: 'Labor Standards (MOST)', status: 'pending', required: true },
    { id: 't3-7', name: 'Technology Assessment', status: 'pending', required: true },
    { id: 't3-8', name: 'Transportation Analysis', status: 'pending', required: false },
    { id: 't3-9', name: 'Automation Feasibility', status: 'pending', required: false },
    { id: 't3-10', name: 'Risk Assessment', status: 'pending', required: true },
    { id: 't3-11', name: 'Start-Up Plan', status: 'pending', required: false },
    { id: 't3-12', name: 'Org Chart & Staffing Plan', status: 'pending', required: true },
    { id: 't3-13', name: 'IT/WMS Requirements', status: 'pending', required: true },
    { id: 't3-14', name: 'SCC Mapping', status: 'pending', required: false },
    { id: 't3-15', name: 'Site Assessment Checklist', status: 'complete', required: true },
  ],
  4: [
    { id: 't4-1', name: 'Operations Review Deck', status: 'pending', required: true },
    { id: 't4-2', name: 'Pricing Presentation', status: 'pending', required: true },
    { id: 't4-3', name: 'P&L Review', status: 'pending', required: true },
    { id: 't4-4', name: 'Peer Review Sign-off', status: 'pending', required: true },
  ],
  5: [
    { id: 't5-1', name: 'ELT Approval Package', status: 'pending', required: true },
    { id: 't5-2', name: 'Customer Presentation', status: 'pending', required: true },
    { id: 't5-3', name: 'Negotiation Strategy', status: 'pending', required: true },
    { id: 't5-4', name: 'Final Pricing', status: 'pending', required: true },
  ],
  6: [
    { id: 't6-1', name: 'Legal Review', status: 'pending', required: true },
    { id: 't6-2', name: 'Implementation Plan (IPS)', status: 'pending', required: true },
    { id: 't6-3', name: 'Joint Project Schedule (JPS)', status: 'pending', required: true },
    { id: 't6-4', name: 'Letter of Intent (LOI)', status: 'pending', required: true },
    { id: 't6-5', name: 'PAF Submission', status: 'pending', required: true },
    { id: 't6-6', name: 'Certificate of Delivery', status: 'pending', required: true },
  ],
};

/** Demo deals — enriched with site data and DOS elements */
const DEALS = [
  { id: 'd1', name: 'Wayfair Midwest Expansion', client: 'Wayfair', stage: 4, sites: [
      { name: 'Chicago DC', market: 'Chicago, IL', sqft: 450000, type: 'E-Commerce Fulfillment' },
      { name: 'Indianapolis FC', market: 'Indianapolis, IN', sqft: 380000, type: 'Returns Processing' },
      { name: 'Columbus Hub', market: 'Columbus, OH', sqft: 250000, type: 'Cross-Dock' },
    ], revenue: 18500000, margin: 11.2, owner: 'Brock Eckles', daysInStage: 8, score: 'A', startDate: '2026-02-15', targetClose: '2026-06-30' },
  { id: 'd2', name: 'Amazon Last Mile Southeast', client: 'Amazon', stage: 3, sites: [
      { name: 'Atlanta Sort', market: 'Atlanta, GA', sqft: 600000, type: 'Sortation Center' },
      { name: 'Savannah FC', market: 'Savannah, GA', sqft: 500000, type: 'Fulfillment Center' },
      { name: 'Charlotte Last Mile', market: 'Charlotte, NC', sqft: 200000, type: 'Last Mile Hub' },
      { name: 'Nashville Sort', market: 'Nashville, TN', sqft: 350000, type: 'Sortation Center' },
      { name: 'Memphis FC', market: 'Memphis, TN', sqft: 450000, type: 'Fulfillment Center' },
    ], revenue: 42000000, margin: 9.8, owner: 'Design Engineer 1', daysInStage: 14, score: 'B+', startDate: '2026-01-20', targetClose: '2026-08-15' },
  { id: 'd3', name: 'Target Returns Processing', client: 'Target', stage: 2, sites: [
      { name: 'Dallas Returns', market: 'Dallas-Fort Worth, TX', sqft: 280000, type: 'Returns Processing' },
      { name: 'Phoenix Returns', market: 'Phoenix, AZ', sqft: 220000, type: 'Returns Processing' },
    ], revenue: 8200000, margin: 13.5, owner: 'Design Engineer 2', daysInStage: 5, score: 'A-', startDate: '2026-03-10', targetClose: '2026-07-15' },
  { id: 'd4', name: 'Home Depot Regional DC', client: 'Home Depot', stage: 5, sites: [
      { name: 'Houston DC', market: 'Houston, TX', sqft: 550000, type: 'Regional Distribution' },
    ], revenue: 12000000, margin: 10.1, owner: 'Brock Eckles', daysInStage: 21, score: 'B', startDate: '2026-01-05', targetClose: '2026-05-30' },
  { id: 'd5', name: 'Costco Cold Chain West', client: 'Costco', stage: 1, sites: [
      { name: 'LA Cold Storage', market: 'Los Angeles, CA', sqft: 300000, type: 'Cold Chain' },
      { name: 'Reno DC', market: 'Reno, NV', sqft: 400000, type: 'Distribution Center' },
    ], revenue: 15000000, margin: 0, owner: 'Design Engineer 1', daysInStage: 3, score: '—', startDate: '2026-04-10', targetClose: '2026-10-30' },
  { id: 'd6', name: 'Nike DTC Fulfillment', client: 'Nike', stage: 3, sites: [
      { name: 'Memphis FC', market: 'Memphis, TN', sqft: 500000, type: 'DTC Fulfillment' },
      { name: 'Lehigh Valley FC', market: 'Lehigh Valley, PA', sqft: 400000, type: 'DTC Fulfillment' },
      { name: 'Dallas FC', market: 'Dallas-Fort Worth, TX', sqft: 350000, type: 'DTC Fulfillment' },
      { name: 'Seattle FC', market: 'Seattle-Tacoma, WA', sqft: 280000, type: 'DTC Fulfillment' },
    ], revenue: 28000000, margin: 10.5, owner: 'Brock Eckles', daysInStage: 10, score: 'A-', startDate: '2026-02-01', targetClose: '2026-07-31' },
  { id: 'd7', name: 'Kroger Fresh Network', client: 'Kroger', stage: 6, sites: [
      { name: 'Cincinnati Fresh', market: 'Cincinnati, OH', sqft: 200000, type: 'Fresh Distribution' },
      { name: 'Indianapolis Fresh', market: 'Indianapolis, IN', sqft: 180000, type: 'Fresh Distribution' },
      { name: 'Louisville Fresh', market: 'Louisville, KY', sqft: 160000, type: 'Fresh Distribution' },
    ], revenue: 22000000, margin: 12.0, owner: 'Design Engineer 2', daysInStage: 30, score: 'A', startDate: '2025-11-15', targetClose: '2026-05-15' },
  { id: 'd8', name: 'PepsiCo Secondary Dist', client: 'PepsiCo', stage: 2, sites: [
      { name: 'Kansas City DC', market: 'Kansas City, MO', sqft: 350000, type: 'Secondary Distribution' },
    ], revenue: 6500000, margin: 0, owner: 'Design Engineer 1', daysInStage: 7, score: '—', startDate: '2026-04-01', targetClose: '2026-09-30' },
  { id: 'd9', name: 'Walmart E-Commerce Hub', client: 'Walmart', stage: 4, sites: [
      { name: 'Inland Empire EC', market: 'Riverside / Inland Empire, CA', sqft: 700000, type: 'E-Commerce Hub' },
      { name: 'NJ Metro EC', market: 'Northern NJ / NYC Metro', sqft: 500000, type: 'E-Commerce Hub' },
    ], revenue: 31000000, margin: 9.2, owner: 'Brock Eckles', daysInStage: 12, score: 'B+', startDate: '2026-02-20', targetClose: '2026-07-15' },
  { id: 'd10', name: 'IKEA Assembly & Delivery', client: 'IKEA', stage: 1, sites: [
      { name: 'Chicago A&D', market: 'Chicago, IL', sqft: 150000, type: 'Assembly & Delivery' },
    ], revenue: 9000000, margin: 0, owner: 'Design Engineer 2', daysInStage: 1, score: '—', startDate: '2026-04-15', targetClose: '2026-11-30' },
];

export function mount(el) {
  rootEl = el;
  viewMode = 'pipeline';
  selectedDeal = null;
  detailTab = 'overview';
  render();
  bindDelegatedEvents();
  bus.emit('deal-management:mounted');
}

// ============================================================
// NEW OPPORTUNITY MODAL
// ============================================================

function openNewOppModal() {
  if (!rootEl) return;
  // Remove any existing modal
  rootEl.querySelector('#dm-new-opp-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'dm-new-opp-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:8px;padding:24px;width:480px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">New Opportunity</div>
      <div style="font-size:12px;color:var(--ies-gray-400);margin-bottom:20px;">Start tracking a new deal in the pipeline.</div>

      <div style="display:flex;flex-direction:column;gap:14px;">
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Deal Name *</label>
          <input id="opp-name" class="hub-input" placeholder="e.g., Acme Midwest Expansion" style="width:100%;">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Client *</label>
          <input id="opp-client" class="hub-input" placeholder="e.g., Acme Corp" style="width:100%;">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Initial Stage</label>
            <select id="opp-stage" class="hub-select" style="width:100%;">
              ${DOS_STAGES.map(s => `<option value="${s.id}"${s.id === 1 ? ' selected' : ''}>${s.id}. ${s.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Owner</label>
            <input id="opp-owner" class="hub-input" placeholder="Your name" style="width:100%;" value="Brock Eckles">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Est. Annual Revenue ($M)</label>
            <input id="opp-revenue" class="hub-input" type="number" step="0.1" placeholder="e.g., 12.5" style="width:100%;">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Target Margin (%)</label>
            <input id="opp-margin" class="hub-input" type="number" step="0.1" placeholder="e.g., 11" style="width:100%;">
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
        <button id="opp-cancel" class="hub-btn hub-btn-sm hub-btn-secondary">Cancel</button>
        <button id="opp-create" class="hub-btn hub-btn-sm hub-btn-primary">Create Opportunity</button>
      </div>
    </div>
  `;
  rootEl.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#opp-cancel')?.addEventListener('click', close);
  modal.querySelector('#opp-create')?.addEventListener('click', () => {
    const name   = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-name')).value.trim();
    const client = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-client')).value.trim();
    if (!name || !client) {
      alert('Deal name and client are required.');
      return;
    }
    const stage   = parseInt(/** @type {HTMLSelectElement} */ (modal.querySelector('#opp-stage')).value, 10) || 1;
    const owner   = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-owner')).value.trim() || 'Unassigned';
    const revenue = parseFloat(/** @type {HTMLInputElement} */ (modal.querySelector('#opp-revenue')).value) || 0;
    const margin  = parseFloat(/** @type {HTMLInputElement} */ (modal.querySelector('#opp-margin')).value) || 0;

    const newDeal = {
      id: 'd' + (DEALS.length + 1) + '-' + Date.now().toString(36),
      name,
      client,
      stage,
      sites: [],
      revenue: Math.round(revenue * 1e6),
      margin,
      owner,
      daysInStage: 0,
      score: '—',
      startDate: new Date().toISOString().slice(0, 10),
      targetClose: null,
    };
    DEALS.push(newDeal);
    close();
    render(); // re-render pipeline with new deal
    bus.emit('deal-management:deal-created', { id: newDeal.id });
  });

  // Focus first field
  modal.querySelector('#opp-name')?.focus();
}

export function unmount() { rootEl = null; bus.emit('deal-management:unmounted'); }

// ============================================================
// EVENT DELEGATION
// ============================================================

function bindDelegatedEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // View toggle
    const viewBtn = target.closest('[data-view]');
    if (viewBtn) { viewMode = /** @type {HTMLElement} */ (viewBtn).dataset.view; selectedDeal = null; render(); return; }

    // Deal card click -> detail view
    const deal = target.closest('[data-deal]');
    if (deal) {
      const id = /** @type {HTMLElement} */ (deal).dataset.deal;
      selectedDeal = DEALS.find(d => d.id === id) || null;
      if (selectedDeal) { viewMode = 'detail'; detailTab = 'overview'; render(); }
      return;
    }

    // Back button
    if (target.closest('[data-action="back"]')) { viewMode = 'pipeline'; selectedDeal = null; render(); return; }

    // Detail tabs
    const dtab = target.closest('[data-detail-tab]');
    if (dtab) { detailTab = /** @type {HTMLElement} */ (dtab).dataset.detailTab; renderDetailContent(); return; }

    // DOS element toggle
    const dosEl = target.closest('[data-dos-toggle]');
    if (dosEl) {
      const elemId = /** @type {HTMLElement} */ (dosEl).dataset.dosToggle;
      toggleDosElement(elemId);
      return;
    }

    // New Opportunity button
    if (target.closest('[data-action="new-opp"]')) {
      openNewOppModal();
      return;
    }

    // Open in design tool
    if (target.closest('[data-action="open-cost-model"]')) { window.location.hash = 'designtools/cost-model'; return; }
    if (target.closest('[data-action="open-multi-site"]')) { window.location.hash = 'designtools/deal-manager'; return; }

    // Deck generation buttons
    const deckBtn = target.closest('[data-deck]');
    if (deckBtn) {
      const deckType = /** @type {HTMLElement} */ (deckBtn).dataset.deck;
      handleDeckGenClick(deckType);
      return;
    }
  });
}

function toggleDosElement(elemId) {
  // Find and toggle the element in our template data
  for (const stageTemplates of Object.values(DOS_TEMPLATES)) {
    const tpl = stageTemplates.find(t => t.id === elemId);
    if (tpl) {
      if (tpl.status === 'complete') tpl.status = 'in-progress';
      else if (tpl.status === 'in-progress') tpl.status = 'complete';
      else tpl.status = 'in-progress';
      renderDetailContent();
      return;
    }
  }
}

// ============================================================
// RENDER
// ============================================================

function render() {
  if (!rootEl) return;

  if (viewMode === 'detail' && selectedDeal) { renderDetail(); return; }

  const totalRevenue = DEALS.reduce((s, d) => s + d.revenue, 0);
  const avgMargin = DEALS.filter(d => d.margin > 0).reduce((s, d) => s + d.margin, 0) / DEALS.filter(d => d.margin > 0).length;
  const totalSites = DEALS.reduce((s, d) => s + (Array.isArray(d.sites) ? d.sites.length : d.sites), 0);

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 class="text-page" style="margin:0;">Deal Management</h2>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm ${viewMode === 'pipeline' ? '' : 'hub-btn-secondary'}" data-view="pipeline">Pipeline</button>
          <button class="hub-btn hub-btn-sm ${viewMode === 'list' ? '' : 'hub-btn-secondary'}" data-view="list">List</button>
          <button class="hub-btn hub-btn-sm hub-btn-primary" data-action="new-opp" style="margin-left:8px;">+ New Opportunity</button>
        </div>
      </div>

      <!-- KPI Bar -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        ${kpi('Active Deals', DEALS.length, '#2563eb')}
        ${kpi('Total Pipeline', '$' + (totalRevenue / 1e6).toFixed(1) + 'M', '#16a34a')}
        ${kpi('Avg Margin', avgMargin.toFixed(1) + '%', '#7c3aed')}
        ${kpi('Total Sites', totalSites, '#d97706')}
      </div>

      <div id="dm-content"></div>
    </div>
  `;

  const content = rootEl.querySelector('#dm-content');
  if (viewMode === 'pipeline') renderPipeline(content);
  else renderList(content);
}

function renderPipeline(el) {
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(${DOS_STAGES.length},1fr);gap:10px;overflow-x:auto;">
      ${DOS_STAGES.map(stage => {
        const stageDeals = DEALS.filter(d => d.stage === stage.id);
        const stageRevenue = stageDeals.reduce((s, d) => s + d.revenue, 0);
        return `
          <div style="min-width:180px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding-bottom:8px;border-bottom:3px solid ${stage.color};">
              <span style="font-size:12px;font-weight:800;color:${stage.color};">${stage.id}</span>
              <span style="font-size:12px;font-weight:700;flex:1;">${stage.name}</span>
              <span style="font-size:11px;font-weight:700;color:var(--ies-gray-400);">${stageDeals.length}</span>
            </div>
            <div style="font-size:10px;color:var(--ies-gray-400);margin-bottom:8px;">$${(stageRevenue / 1e6).toFixed(1)}M pipeline</div>
            ${stageDeals.map(deal => {
              const siteCount = Array.isArray(deal.sites) ? deal.sites.length : deal.sites;
              return `
              <div class="hub-card" style="padding:10px;margin-bottom:8px;cursor:pointer;border-left:3px solid ${stage.color};" data-deal="${deal.id}">
                <div style="font-size:12px;font-weight:700;margin-bottom:4px;">${deal.name}</div>
                <div style="font-size:11px;color:var(--ies-gray-400);margin-bottom:4px;">${deal.client} — ${siteCount} site${siteCount > 1 ? 's' : ''}</div>
                <div style="display:flex;justify-content:space-between;font-size:10px;">
                  <span style="color:var(--ies-gray-400);">$${(deal.revenue / 1e6).toFixed(1)}M</span>
                  ${deal.margin > 0 ? `<span style="font-weight:700;color:${deal.margin >= 10 ? '#16a34a' : '#d97706'};">${deal.margin}%</span>` : ''}
                  ${deal.score !== '—' ? `<span style="font-weight:800;color:${deal.score.startsWith('A') ? '#16a34a' : '#2563eb'};">${deal.score}</span>` : ''}
                </div>
                <div style="font-size:9px;color:var(--ies-gray-300);margin-top:4px;">${deal.daysInStage}d in stage — ${deal.owner.split(' ')[0]}</div>
              </div>
            `}).join('') || '<div style="font-size:11px;color:var(--ies-gray-300);padding:8px;">No deals</div>'}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderList(el) {
  el.innerHTML = `
    <div class="hub-card" style="padding:0;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Deal</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Client</th>
            <th style="text-align:center;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Stage</th>
            <th style="text-align:center;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Sites</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Revenue</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Margin</th>
            <th style="text-align:center;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Score</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Owner</th>
          </tr>
        </thead>
        <tbody>
          ${DEALS.map(d => {
            const stage = DOS_STAGES.find(s => s.id === d.stage);
            const siteCount = Array.isArray(d.sites) ? d.sites.length : d.sites;
            return `
              <tr style="border-bottom:1px solid var(--ies-gray-100);cursor:pointer;" data-deal="${d.id}" onmouseover="this.style.background='var(--ies-gray-50)'" onmouseout="this.style.background='transparent'">
                <td style="padding:10px 12px;font-weight:600;">${d.name}</td>
                <td style="padding:10px 12px;color:var(--ies-gray-500);">${d.client}</td>
                <td style="padding:10px 12px;text-align:center;">
                  <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${stage.color};">${stage.name}</span>
                </td>
                <td style="padding:10px 12px;text-align:center;">${siteCount}</td>
                <td style="padding:10px 12px;text-align:right;font-weight:600;">$${(d.revenue / 1e6).toFixed(1)}M</td>
                <td style="padding:10px 12px;text-align:right;font-weight:700;color:${d.margin >= 10 ? '#16a34a' : d.margin > 0 ? '#d97706' : 'var(--ies-gray-300)'};">${d.margin > 0 ? d.margin + '%' : '—'}</td>
                <td style="padding:10px 12px;text-align:center;font-weight:800;color:${d.score.startsWith('A') ? '#16a34a' : d.score !== '—' ? '#2563eb' : 'var(--ies-gray-300)'};">${d.score}</td>
                <td style="padding:10px 12px;color:var(--ies-gray-500);">${d.owner}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// DEAL DETAIL VIEW
// ============================================================

function renderDetail() {
  if (!rootEl || !selectedDeal) return;
  const d = selectedDeal;
  const stage = DOS_STAGES.find(s => s.id === d.stage);
  const siteCount = Array.isArray(d.sites) ? d.sites.length : d.sites;
  const totalSqft = Array.isArray(d.sites) ? d.sites.reduce((s, site) => s + (site.sqft || 0), 0) : 0;

  // Calculate DOS completion
  let totalElements = 0, completedElements = 0;
  for (let s = 1; s <= d.stage; s++) {
    const templates = DOS_TEMPLATES[s] || [];
    totalElements += templates.length;
    completedElements += templates.filter(t => t.status === 'complete').length;
  }
  const dosCompletion = totalElements > 0 ? Math.round((completedElements / totalElements) * 100) : 0;

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <!-- Back + Header -->
      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="back" style="margin-bottom:16px;">← Back to Pipeline</button>

      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
        <div style="flex:1;">
          <h2 style="font-size:20px;font-weight:800;margin:0 0 4px 0;">${d.name}</h2>
          <div style="display:flex;gap:12px;font-size:12px;color:var(--ies-gray-400);">
            <span>${d.client}</span>
            <span>•</span>
            <span>${siteCount} site${siteCount > 1 ? 's' : ''}</span>
            <span>•</span>
            <span>Owner: ${d.owner}</span>
          </div>
        </div>
        <span style="display:inline-block;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${stage.color};">Stage ${d.stage}: ${stage.name}</span>
        ${d.score !== '—' ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;font-size:16px;font-weight:800;color:#fff;background:${d.score.startsWith('A') ? '#16a34a' : '#2563eb'};">${d.score}</span>` : ''}
      </div>

      <!-- Quick Stats -->
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px;">
        ${kpi('Revenue', '$' + (d.revenue / 1e6).toFixed(1) + 'M', '#16a34a')}
        ${kpi('Margin', d.margin > 0 ? d.margin + '%' : 'TBD', d.margin >= 10 ? '#16a34a' : '#d97706')}
        ${kpi('Total sqft', totalSqft > 0 ? (totalSqft / 1000).toFixed(0) + 'K' : '—', '#2563eb')}
        ${kpi('Days in Stage', d.daysInStage, d.daysInStage > 14 ? '#dc2626' : '#16a34a')}
        ${kpi('DOS Completion', dosCompletion + '%', dosCompletion >= 75 ? '#16a34a' : dosCompletion >= 50 ? '#d97706' : '#dc2626')}
      </div>

      <!-- Detail Tabs -->
      <div class="hub-tab-bar" style="margin-bottom:16px;">
        <button class="hub-tab ${detailTab === 'overview' ? 'active' : ''}" data-detail-tab="overview">Overview</button>
        <button class="hub-tab ${detailTab === 'sites' ? 'active' : ''}" data-detail-tab="sites">Site Details</button>
        <button class="hub-tab ${detailTab === 'dos' ? 'active' : ''}" data-detail-tab="dos">DOS Elements</button>
        <button class="hub-tab ${detailTab === 'financials' ? 'active' : ''}" data-detail-tab="financials">Financials</button>
        <button class="hub-tab ${detailTab === 'documents' ? 'active' : ''}" data-detail-tab="documents">Documents</button>
      </div>

      <div id="deal-detail-content"></div>
    </div>
  `;

  renderDetailContent();
}

function renderDetailContent() {
  const el = rootEl?.querySelector('#deal-detail-content');
  if (!el || !selectedDeal) return;

  switch (detailTab) {
    case 'overview': el.innerHTML = renderDealOverview(); break;
    case 'sites': el.innerHTML = renderDealSites(); break;
    case 'dos': el.innerHTML = renderDealDos(); break;
    case 'financials': el.innerHTML = renderDealFinancials(); break;
    case 'documents': el.innerHTML = renderDealDocuments(); break;
  }
}

function renderDealOverview() {
  const d = selectedDeal;
  const stage = DOS_STAGES.find(s => s.id === d.stage);

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <!-- Timeline -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Deal Timeline</div>
        <div style="display:flex;gap:4px;margin-bottom:12px;">
          ${DOS_STAGES.map(s => `
            <div style="flex:1;height:8px;border-radius:4px;background:${s.id <= d.stage ? s.color : 'var(--ies-gray-100)'};"></div>
          `).join('')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
          <div><span style="color:var(--ies-gray-400);">Started:</span> ${formatDate(d.startDate)}</div>
          <div><span style="color:var(--ies-gray-400);">Target Close:</span> ${formatDate(d.targetClose)}</div>
          <div><span style="color:var(--ies-gray-400);">Current Stage:</span> <span style="font-weight:700;color:${stage.color};">${stage.name}</span></div>
          <div><span style="color:var(--ies-gray-400);">Days in Stage:</span> <span style="font-weight:700;">${d.daysInStage}</span></div>
        </div>
      </div>

      <!-- Actions -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Quick Actions</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button class="hub-btn hub-btn-sm" data-action="open-cost-model" style="text-align:left;">Open Cost Model Builder →</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="open-multi-site" style="text-align:left;">Open Multi-Site Analyzer →</button>
        </div>
      </div>
    </div>

    <!-- Deck Generation (re-enabled 2026-04-17 PM) -->
    <div class="hub-card" style="padding:16px;margin-top:16px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:700;">Generate Decks</div>
        <span style="font-size:11px;color:var(--ies-gray-400);">— auto-build GXO-branded PPTX from this deal's data</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-deck="qualification" style="text-align:left;font-size:12px;">
          <div style="font-weight:700;">Qualification</div>
          <div style="font-size:10px;color:var(--ies-gray-400);">Stage 2</div>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-deck="ops_review" style="text-align:left;font-size:12px;">
          <div style="font-weight:700;">Ops Review</div>
          <div style="font-size:10px;color:var(--ies-gray-400);">Stage 4</div>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-deck="elt_approval" style="text-align:left;font-size:12px;">
          <div style="font-weight:700;">ELT Approval</div>
          <div style="font-size:10px;color:var(--ies-gray-400);">Stage 5</div>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-deck="customer_presentation" style="text-align:left;font-size:12px;">
          <div style="font-weight:700;">Customer Presentation</div>
          <div style="font-size:10px;color:var(--ies-gray-400);">Stage 5</div>
        </button>
      </div>
      <div id="deck-gen-status" style="margin-top:10px;font-size:12px;color:var(--ies-gray-400);min-height:16px;"></div>
    </div>
  `;
}

async function handleDeckGenClick(deckType) {
  const statusEl = rootEl?.querySelector('#deck-gen-status');
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--ies-blue);">Generating ${deckType} deck…</span>`;
  try {
    const engine = await import('../deck-generator/engine.js?v=20260417-mB');
    if (!window.PptxGenJS) throw new Error('PptxGenJS not loaded — check CDN in index.html');
    // Pass demo deal data directly (these demo deals have integer stage + hardcoded fields,
    // not persisted UUIDs). The engine accepts either a dealId (uuid) or a prebuilt data obj.
    const d = selectedDeal;
    const totalSqft = Array.isArray(d?.sites)
      ? d.sites.reduce((s, site) => s + (site.sqft || 0), 0)
      : 0;
    const totalCost = d?.revenue && d?.margin
      ? d.revenue * (1 - d.margin / 100)
      : null;
    const data = {
      customerName: d?.client || d?.name || '[Customer]',
      location: Array.isArray(d?.sites) && d.sites[0]?.market ? d.sites[0].market : '[Location TBD]',
      sqft: totalSqft ? totalSqft.toLocaleString() : '—',
      headcount: '—',
      palletsPerDay: '—',
      palletsPerYear: '—',
      annualRevenue: d?.revenue ? `$${(d.revenue / 1e6).toFixed(1)}M` : '—',
      totalCost: totalCost ? `$${(totalCost / 1e6).toFixed(1)}M` : '—',
      ebitda: d?.revenue && d?.margin ? `$${((d.revenue * d.margin / 100) / 1e6).toFixed(1)}M` : '—',
      margin: d?.margin ? `${d.margin}%` : '—',
      ebidtaPercent: d?.margin ? `${d.margin}%` : '—',
      contractYears: '5',
      inboundRate: '—',
      storageRate: '—',
      pickPackRate: '—',
      outboundRate: '—'
    };
    await engine.generateDeck(deckType, data);
    if (statusEl) statusEl.innerHTML = `<span style="color:#16a34a;font-weight:600;">✓ Deck downloaded. Check your browser downloads.</span>`;
  } catch (err) {
    console.error('[DealMgmt] Deck generation failed:', err);
    if (statusEl) statusEl.innerHTML = `<span style="color:#dc2626;">Deck failed: ${err.message}</span>`;
  }
}

function renderDealSites() {
  const d = selectedDeal;
  const sites = Array.isArray(d.sites) ? d.sites : [];

  return `
    <div class="hub-card" style="padding:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Site Details (${sites.length})</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid var(--ies-gray-200);">
            <th style="text-align:left;padding:8px;">Site Name</th>
            <th style="text-align:left;padding:8px;">Market</th>
            <th style="text-align:right;padding:8px;">Sq Ft</th>
            <th style="text-align:left;padding:8px;">Type</th>
          </tr>
        </thead>
        <tbody>
          ${sites.map(s => `
            <tr style="border-bottom:1px solid var(--ies-gray-100);">
              <td style="padding:8px;font-weight:600;">${s.name}</td>
              <td style="padding:8px;color:var(--ies-gray-500);">${s.market}</td>
              <td style="padding:8px;text-align:right;font-weight:600;">${(s.sqft || 0).toLocaleString()}</td>
              <td style="padding:8px;"><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;background:var(--ies-gray-100);color:var(--ies-gray-600);">${s.type}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--ies-gray-100);font-size:12px;color:var(--ies-gray-400);">
        Total: ${sites.reduce((s, site) => s + (site.sqft || 0), 0).toLocaleString()} sq ft across ${sites.length} sites
      </div>
    </div>
  `;
}

function renderDealDos() {
  const d = selectedDeal;

  return `
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${DOS_STAGES.filter(s => s.id <= d.stage).map(stage => {
        const templates = DOS_TEMPLATES[stage.id] || [];
        const completed = templates.filter(t => t.status === 'complete').length;
        const pct = templates.length > 0 ? Math.round((completed / templates.length) * 100) : 0;

        return `
          <div class="hub-card" style="padding:16px;border-left:3px solid ${stage.color};">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="font-size:13px;font-weight:700;flex:1;">Stage ${stage.id}: ${stage.name}</span>
              <span style="font-size:12px;font-weight:700;color:${pct === 100 ? '#16a34a' : '#d97706'};">${completed}/${templates.length} (${pct}%)</span>
            </div>
            <div style="height:4px;background:var(--ies-gray-100);border-radius:2px;margin-bottom:10px;overflow:hidden;">
              <div style="width:${pct}%;height:100%;background:${stage.color};border-radius:2px;"></div>
            </div>
            ${templates.map(t => {
              const statusIcon = t.status === 'complete' ? '✅' : t.status === 'in-progress' ? '🔄' : '⬜';
              const statusColor = t.status === 'complete' ? '#16a34a' : t.status === 'in-progress' ? '#d97706' : 'var(--ies-gray-300)';
              return `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--ies-gray-50);cursor:pointer;" data-dos-toggle="${t.id}">
                  <span style="font-size:14px;">${statusIcon}</span>
                  <span style="font-size:13px;flex:1;${t.status === 'complete' ? 'text-decoration:line-through;color:var(--ies-gray-400);' : ''}">${t.name}</span>
                  ${t.required ? '<span style="font-size:9px;font-weight:700;color:#dc2626;padding:1px 6px;border-radius:10px;border:1px solid #dc2626;">REQ</span>' : ''}
                  <span style="font-size:11px;font-weight:600;color:${statusColor};">${t.status}</span>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }).join('')}
      ${d.stage < 6 ? `
        <div class="hub-card" style="padding:16px;background:var(--ies-gray-50);text-align:center;">
          <div style="font-size:12px;color:var(--ies-gray-400);">Stages ${d.stage + 1}–6 will be unlocked as the deal progresses</div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderDealFinancials() {
  const d = selectedDeal;

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Financial Summary</div>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--ies-gray-100);">
            <span style="color:var(--ies-gray-400);">Annual Revenue</span>
            <span style="font-weight:700;">$${(d.revenue / 1e6).toFixed(1)}M</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--ies-gray-100);">
            <span style="color:var(--ies-gray-400);">Target Margin</span>
            <span style="font-weight:700;color:${d.margin >= 10 ? '#16a34a' : '#d97706'};">${d.margin > 0 ? d.margin + '%' : 'TBD'}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--ies-gray-100);">
            <span style="color:var(--ies-gray-400);">Annual Profit (est.)</span>
            <span style="font-weight:700;">${d.margin > 0 ? '$' + ((d.revenue * d.margin / 100) / 1e6).toFixed(2) + 'M' : 'TBD'}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--ies-gray-100);">
            <span style="color:var(--ies-gray-400);">Contract Term (est.)</span>
            <span style="font-weight:700;">5 years</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;">
            <span style="color:var(--ies-gray-400);">Lifetime Value (est.)</span>
            <span style="font-weight:700;color:#2563eb;">$${(d.revenue * 5 / 1e6).toFixed(0)}M</span>
          </div>
        </div>
      </div>

      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Cost Breakdown (Placeholder)</div>
        <div style="text-align:center;padding:20px;color:var(--ies-gray-400);">
          <div style="font-size:12px;margin-bottom:8px;">Build a cost model to see detailed cost breakdown.</div>
          <button class="hub-btn hub-btn-sm" data-action="open-cost-model">Open Cost Model Builder</button>
        </div>
      </div>
    </div>
  `;
}

function renderDealDocuments() {
  const docs = [
    { name: 'NDA — ' + selectedDeal.client, type: 'Legal', date: '2026-02-10', status: 'Executed' },
    { name: 'Credit Check Report', type: 'Finance', date: '2026-02-12', status: 'Complete' },
    { name: 'SCAN Document', type: 'Qualification', date: '2026-02-15', status: 'Complete' },
    { name: 'Data Request Package', type: 'Engineering', date: '2026-03-01', status: 'Sent' },
    { name: 'Site Visit Photos', type: 'Engineering', date: '2026-03-15', status: 'Uploaded' },
  ];

  return `
    <div class="hub-card" style="padding:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Deal Documents</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid var(--ies-gray-200);">
            <th style="text-align:left;padding:8px;">Document</th>
            <th style="text-align:left;padding:8px;">Type</th>
            <th style="text-align:left;padding:8px;">Date</th>
            <th style="text-align:left;padding:8px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${docs.map(d => `
            <tr style="border-bottom:1px solid var(--ies-gray-100);">
              <td style="padding:8px;font-weight:600;">${d.name}</td>
              <td style="padding:8px;"><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;background:var(--ies-gray-100);color:var(--ies-gray-600);">${d.type}</span></td>
              <td style="padding:8px;color:var(--ies-gray-400);">${formatDate(d.date)}</td>
              <td style="padding:8px;font-weight:600;color:#16a34a;">${d.status}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// HELPERS
// ============================================================

function kpi(label, value, color) {
  return `
    <div class="hub-card" style="padding:12px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${label}</div>
    </div>
  `;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return dateStr; }
}
