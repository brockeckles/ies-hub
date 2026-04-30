/**
 * IES Hub v3 — Deal Management UI
 * Pipeline view, list view, and deal detail with DOS stage elements.
 * Full event delegation to survive innerHTML re-renders.
 *
 * @module hub/deal-management/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import * as api from './api.js?v=20260429-demo-s4';
import { showToast } from '../../shared/toast.js?v=20260418-sK';

/** @type {HTMLElement|null} */
let rootEl = null;
let viewMode = 'pipeline'; // pipeline | list | customers | hours | detail
let selectedDeal = null;
let detailTab = 'overview'; // overview | sites | dos | financials | documents | strategy
let dealSearch = '';
let customerFilter = ''; // empty = all

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

/**
 * Live deals from deal_deals (real DB rows) get spliced into this list at
 * mount via loadRealDealsAndMerge(). Hardcoded demo deals retired 2026-04-27
 * — `+ New Opportunity` now persists to deal_deals via api.createDeal().
 */
const DEALS = [];

export function mount(el) {
  rootEl = el;
  viewMode = 'pipeline';
  selectedDeal = null;
  detailTab = 'overview';
  render();
  bindDelegatedEvents();
  bus.emit('deal-management:mounted');

  // Pull live activity templates from stage_element_templates. Falls back to
  // the hardcoded DOS_TEMPLATES if the fetch fails (e.g., offline).
  loadLiveTemplates();

  // 2026-04-27: load real deals from deal_deals + cost_model_projects join.
  // Real deals get merged ahead of the hardcoded DEALS demo set so the user
  // sees their live work first. Deal detail (artifacts / financials / open-cm
  // routing) branches on `selectedDeal.isReal`.
  loadRealDealsAndMerge();
}

const _realDealIds = new Set();
async function loadRealDealsAndMerge() {
  try {
    const live = await api.listRealDeals();
    if (!Array.isArray(live) || live.length === 0) return;
    // Idempotent: drop any previously merged real deals before merging again
    if (_realDealIds.size > 0) {
      for (let i = DEALS.length - 1; i >= 0; i--) {
        if (_realDealIds.has(DEALS[i].id)) DEALS.splice(i, 1);
      }
      _realDealIds.clear();
    }
    // 2026-04-27: invalidate per-deal artifacts cache so the freshly loaded
    // models (could be different than last render) get picked up on next read.
    _artifactsByDeal.clear();
    // Splice real deals at the top
    DEALS.unshift(...live);
    for (const d of live) _realDealIds.add(d.id);
    bus.emit('deal-management:real-deals-loaded', { count: live.length });
    // Re-render if visible
    if (viewMode === 'detail' && selectedDeal) {
      const refreshed = DEALS.find(x => x.id === selectedDeal.id);
      if (refreshed) selectedDeal = refreshed;
      renderDetailContent();
    } else {
      render();
    }
  } catch (err) {
    console.warn('[deal-mgmt] loadRealDealsAndMerge failed', err);
  }
}

async function loadLiveTemplates() {
  try {
    const live = await api.fetchActivityTemplates();
    if (!live || !Object.keys(live).length) return;
    // Preserve any progress already made in the hardcoded DOS_TEMPLATES —
    // if a user checked off something during the session we don't want to
    // clobber it. Match by trimmed name.
    const nameMap = new Map();
    for (const [stage, tpls] of Object.entries(DOS_TEMPLATES)) {
      for (const t of tpls) {
        nameMap.set(`${stage}|${(t.name || '').trim().toLowerCase()}`, t.status);
      }
    }
    for (const stageNum of Object.keys(live)) {
      for (const t of live[stageNum]) {
        const key = `${stageNum}|${(t.name || '').trim().toLowerCase()}`;
        t.status = nameMap.get(key) || 'pending';
      }
    }
    // Overwrite in place so existing references pick up new data.
    for (const k of Object.keys(DOS_TEMPLATES)) delete DOS_TEMPLATES[k];
    Object.assign(DOS_TEMPLATES, live);
    // Re-render if we're currently showing DOS data.
    if (viewMode === 'detail' && detailTab === 'dos') renderDetailContent();
    else if (viewMode !== 'detail') render();
    bus.emit('deal-management:templates-loaded', { counts: Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v.length])) });
  } catch (err) {
    console.warn('[deal-mgmt] live template load failed', err);
  }
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
            <input id="opp-owner" class="hub-input" placeholder="Your name" style="width:100%;">
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
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Contract Term (yrs)</label>
            <input id="opp-term" class="hub-input" type="number" step="1" placeholder="5" value="5" style="width:100%;">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Site Count</label>
            <input id="opp-sites" class="hub-input" type="number" step="1" placeholder="1" value="1" style="width:100%;">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Target Go-Live</label>
            <input id="opp-golive" class="hub-input" type="date" style="width:100%;">
          </div>
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-bottom:4px;">Industry / Vertical</label>
          <select id="opp-vertical" class="hub-select" style="width:100%;">
            <option value="">— Select —</option>
            <option value="Retail">Retail</option>
            <option value="E-commerce">E-commerce</option>
            <option value="Omnichannel Retail">Omnichannel Retail</option>
            <option value="Food & Beverage">Food &amp; Beverage</option>
            <option value="Industrial">Industrial</option>
            <option value="Pharmaceutical">Pharmaceutical</option>
            <option value="Automotive">Automotive</option>
            <option value="Consumer Goods">Consumer Goods</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
        <button id="opp-cancel" class="hub-btn hub-btn-sm hub-btn-secondary">Cancel</button>
        <button id="opp-create" class="hub-btn hub-btn-sm hub-btn-primary">Create Deal</button>
      </div>
    </div>
  `;
  rootEl.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#opp-cancel')?.addEventListener('click', close);
  modal.querySelector('#opp-create')?.addEventListener('click', async () => {
    const name   = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-name')).value.trim();
    const client = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-client')).value.trim();
    if (!name || !client) {
      showToast('Deal name and client are required.', 'error');
      return;
    }
    const owner = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-owner')).value.trim() || null;
    const createBtn = /** @type {HTMLButtonElement} */ (modal.querySelector('#opp-create'));
    if (createBtn) { createBtn.disabled = true; createBtn.textContent = 'Creating...'; }
    try {
      const stageVal     = /** @type {HTMLSelectElement} */ (modal.querySelector('#opp-stage')).value;
      const revenueVal   = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-revenue')).value;
      const marginVal    = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-margin')).value;
      const termVal      = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-term'))?.value;
      const sitesVal     = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-sites'))?.value;
      const goliveVal    = /** @type {HTMLInputElement} */ (modal.querySelector('#opp-golive'))?.value;
      const verticalVal  = /** @type {HTMLSelectElement} */ (modal.querySelector('#opp-vertical'))?.value;
      const inserted = await api.createDeal({
        deal_name: name,
        client_name: client,
        deal_owner: owner,
        current_stage_id: stageVal ? Number(stageVal) : null,
        est_annual_revenue: revenueVal,
        target_margin_pct: marginVal,
        contract_term_years: termVal,
        site_count: sitesVal,
        target_go_live: goliveVal || null,
        industry_vertical: verticalVal || null,
      });
      close();
      // Refresh real deals so the new row appears + select it for the user.
      await loadRealDealsAndMerge();
      const created = DEALS.find(x => x.id === inserted?.id);
      if (created) {
        selectedDeal = created;
        viewMode = 'detail';
        detailTab = 'overview';
        render();
        _hydrateDealDetail(created.id);
      } else {
        render();
      }
      bus.emit('deal-management:deal-created', { id: inserted?.id });
    } catch (err) {
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create Deal'; }
      showToast('Failed to create deal: ' + (err?.message || err), 'error');
    }
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

    // Clear filters
    if (target.closest('[data-action="clear-filters"]')) {
      dealSearch = '';
      customerFilter = '';
      render();
      return;
    }

    // Customer row click -> filter to that customer and switch to list view
    const custRow = target.closest('[data-customer]');
    if (custRow) {
      customerFilter = /** @type {HTMLElement} */ (custRow).dataset.customer;
      viewMode = 'list';
      render();
      return;
    }

    // Deal card click -> detail view
    const deal = target.closest('[data-deal]');
    if (deal) {
      const id = /** @type {HTMLElement} */ (deal).dataset.deal;
      selectedDeal = DEALS.find(d => d.id === id) || null;
      if (selectedDeal) {
        viewMode = 'detail';
        detailTab = 'overview';
        render();
        // Async hydrate for real deals (strategy + artifacts + DOS status).
        _hydrateDealDetail(selectedDeal.id);
      }
      return;
    }

    // Back button
    if (target.closest('[data-action="back"]')) { viewMode = 'pipeline'; selectedDeal = null; render(); return; }

    // Detail tabs. Tab bar is rendered once in renderDetail() and never
    // re-rendered on click (only the content pane is), so we have to toggle
    // the `active` class on the tab buttons directly. Without this, the
    // clicked tab's text switches but the blue pill stays on "Overview".
    const dtab = target.closest('[data-detail-tab]');
    if (dtab) {
      detailTab = /** @type {HTMLElement} */ (dtab).dataset.detailTab;
      rootEl?.querySelectorAll('[data-detail-tab]').forEach(btn => {
        btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.detailTab === detailTab);
      });
      renderDetailContent();
      return;
    }

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

    // Smart cost-model actions (real deals only — wired by renderCostModelButton/renderCostBreakdownCard)
    const openCmId = target.closest('[data-action="open-cost-model-id"]');
    if (openCmId) {
      const mid = /** @type {HTMLElement} */ (openCmId).dataset.modelId;
      if (mid) openCostModelById(mid);
      return;
    }
    const chooseCm = target.closest('[data-action="choose-cost-model"]');
    if (chooseCm) {
      const did = /** @type {HTMLElement} */ (chooseCm).dataset.dealId;
      if (did) openCostModelChooser(did);
      return;
    }
    const createCm = target.closest('[data-action="create-cost-model"]');
    if (createCm) {
      const did = /** @type {HTMLElement} */ (createCm).dataset.dealId;
      if (did) createCostModelForDeal(did);
      return;
    }

    // Deck generation buttons
    const deckBtn = target.closest('[data-deck]');
    if (deckBtn) {
      const deckType = /** @type {HTMLElement} */ (deckBtn).dataset.deck;
      handleDeckGenClick(deckType);
      return;
    }

    // Stage auto-advance
    if (target.closest('[data-action="advance-stage"]')) {
      if (selectedDeal && selectedDeal.stage < 6) {
        selectedDeal.stage += 1;
        selectedDeal.daysInStage = 0;
        renderDetail();
        bus.emit('toast:show', { message: `Advanced to Stage ${selectedDeal.stage}: ${DOS_STAGES.find(s => s.id === selectedDeal.stage)?.name || ''}`, level: 'success' });
        bus.emit('deal:stage-advanced', { id: selectedDeal.id, stage: selectedDeal.stage });
      }
      return;
    }

    // Add artifact modal
    if (target.closest('[data-action="add-artifact"]')) {
      openAddArtifactModal();
      return;
    }
    // Open artifact
    const openArt = target.closest('[data-artifact-open]');
    if (openArt) {
      const route = /** @type {HTMLElement} */ (openArt).dataset.artifactOpen;
      if (route) window.location.hash = route;
      return;
    }
    // Unlink artifact
    const unlinkArt = target.closest('[data-artifact-unlink]');
    if (unlinkArt) {
      const artId = /** @type {HTMLElement} */ (unlinkArt).dataset.artifactUnlink;
      if (selectedDeal) {
        const list = getArtifacts(selectedDeal.id);
        const idx = list.findIndex(a => String(a.id) === String(artId));
        if (idx >= 0) {
          const removed = list[idx];
          list.splice(idx, 1);
          renderDetailContent();
          // Persist for real deals; local-only for demo. Restore on failure.
          if (_isRealDealId(selectedDeal.id) && typeof removed.id === 'number') {
            api.deleteArtifact(removed.id).then(() => {
              bus.emit('toast:show', { message: 'Artifact unlinked', level: 'success' });
            }).catch(err => {
              list.splice(idx, 0, removed);
              renderDetailContent();
              bus.emit('toast:show', { message: 'Unlink failed: ' + (err.message || err), level: 'error' });
            });
          } else {
            bus.emit('toast:show', { message: 'Artifact unlinked', level: 'success' });
          }
        }
      }
      return;
    }

    // Strategy list add
    const addBtn = target.closest('[data-strategy-add]');
    if (addBtn) {
      const key = /** @type {HTMLElement} */ (addBtn).dataset.strategyAdd;
      if (selectedDeal) {
        const s = getStrategy(selectedDeal.id);
        if (Array.isArray(s[key])) {
          s[key].push('');
          renderDetailContent();
          _scheduleStrategySave(selectedDeal.id);
        }
      }
      return;
    }
  });

  // Strategy inputs — debounced upsert via _scheduleStrategySave
  rootEl.addEventListener('input', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!selectedDeal) return;
    let edited = false;
    if (t.matches('[data-strategy-field]')) {
      const s = getStrategy(selectedDeal.id);
      s[t.dataset.strategyField] = /** @type {HTMLInputElement} */ (t).value;
      edited = true;
    } else if (t.matches('[data-strategy-list]')) {
      const s = getStrategy(selectedDeal.id);
      const list = s[t.dataset.strategyList];
      const idx = parseInt(t.dataset.strategyIdx, 10);
      if (Array.isArray(list) && !isNaN(idx)) {
        list[idx] = /** @type {HTMLInputElement} */ (t).value;
        edited = true;
      }
    }
    if (edited) _scheduleStrategySave(selectedDeal.id);
  });
}

/** Simple modal for linking a new artifact to the current deal. */
function openAddArtifactModal() {
  if (!selectedDeal) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:9990;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;width:440px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div style="font-size:15px;font-weight:800;margin-bottom:12px;">Link artifact to ${escapeAttr(selectedDeal.name)}</div>
      <label style="display:block;font-size:12px;font-weight:700;color:var(--ies-gray-500);margin-bottom:4px;">Type</label>
      <select id="art-kind" style="width:100%;padding:6px 10px;border:1px solid var(--ies-gray-300);border-radius:6px;font-size:13px;margin-bottom:10px;background:#fff;">
        ${Object.entries(ARTIFACT_KINDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
      </select>
      <label style="display:block;font-size:12px;font-weight:700;color:var(--ies-gray-500);margin-bottom:4px;">Name</label>
      <input type="text" id="art-name" placeholder="e.g. Wayfair Midwest base case" style="width:100%;padding:6px 10px;border:1px solid var(--ies-gray-300);border-radius:6px;font-size:13px;margin-bottom:10px;"/>
      <label style="display:block;font-size:12px;font-weight:700;color:var(--ies-gray-500);margin-bottom:4px;">Reference (e.g. cm:7)</label>
      <input type="text" id="art-ref" placeholder="cm:7 · wsc:11 · fleet:3" style="width:100%;padding:6px 10px;border:1px solid var(--ies-gray-300);border-radius:6px;font-size:13px;margin-bottom:14px;font-family:monospace;"/>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="art-cancel">Cancel</button>
        <button class="hub-btn hub-btn-sm hub-btn-primary" id="art-save">Link</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#art-cancel').addEventListener('click', close);
  overlay.querySelector('#art-save').addEventListener('click', async () => {
    const kind = overlay.querySelector('#art-kind').value;
    const name = overlay.querySelector('#art-name').value.trim();
    const ref = overlay.querySelector('#art-ref').value.trim();
    if (!name) { bus.emit('toast:show', { message: 'Name is required', level: 'error' }); return; }
    const list = getArtifacts(selectedDeal.id);
    if (_isRealDealId(selectedDeal.id)) {
      // Real deal — persist to Supabase. Local cache updates on success.
      try {
        const row = await api.createArtifact(selectedDeal.id, { kind, name, ref, model_id: null });
        list.push({
          id: row.id, kind: row.kind, name: row.name, ref: row.ref || '',
          updated: row.updated_at ? String(row.updated_at).slice(0, 10) : new Date().toISOString().slice(0, 10),
        });
      } catch (err) {
        bus.emit('toast:show', { message: 'Save failed: ' + (err.message || err), level: 'error' });
        return;
      }
    } else {
      // Demo deal — local-only.
      list.push({ id: 'a' + Date.now().toString(36), kind, name, ref, updated: new Date().toISOString().slice(0, 10) });
    }
    close();
    renderDetailContent();
    bus.emit('toast:show', { message: `${ARTIFACT_KINDS[kind]?.label || kind} linked`, level: 'success' });
  });
  overlay.querySelector('#art-name').focus();
}

function toggleDosElement(elemId) {
  // Per-deal status overlay — does NOT mutate the global DOS_TEMPLATES catalog.
  // Cycle: pending -> in-progress -> complete -> in-progress (matches old
  // behavior where the catalog default was the seed).
  if (!selectedDeal) return;
  // Locate template by id to confirm it exists (defensive — stale clicks etc.)
  let found = null;
  for (const stageTemplates of Object.values(DOS_TEMPLATES)) {
    const tpl = stageTemplates.find(t => t.id === elemId);
    if (tpl) { found = tpl; break; }
  }
  if (!found) return;
  const dealId = selectedDeal.id;
  const overlay = _dosOverlay(dealId);
  const current = overlay.has(elemId) ? overlay.get(elemId) : (found.status || 'pending');
  let next;
  if (current === 'complete')          next = 'in-progress';
  else if (current === 'in-progress')  next = 'complete';
  else                                 next = 'in-progress';
  overlay.set(elemId, next);
  renderDetailContent();
  // Persist for real deals; demo deals stay in-memory.
  if (_isRealDealId(dealId)) {
    api.setDosElementStatus(dealId, elemId, next).catch(err => {
      // Roll back overlay on persist failure to keep UI honest with DB.
      overlay.set(elemId, current);
      renderDetailContent();
      bus.emit('toast:show', { message: 'DOS save failed: ' + (err.message || err), level: 'error' });
    });
  }
}

// ============================================================
// RENDER
// ============================================================

function render() {
  if (!rootEl) return;

  if (viewMode === 'detail' && selectedDeal) { renderDetail(); return; }

  const totalRevenue = DEALS.reduce((s, d) => s + d.revenue, 0);
  const marginRows = DEALS.filter(d => d.margin > 0);
  const avgMargin = marginRows.length ? (marginRows.reduce((s, d) => s + d.margin, 0) / marginRows.length) : 0;
  const totalSites = DEALS.reduce((s, d) => s + (Array.isArray(d.sites) ? d.sites.length : d.sites), 0);

  // Distinct customers for the filter dropdown.
  const customers = Array.from(new Set(DEALS.map(d => d.client))).sort();

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
        <h2 class="text-page">Deal Management</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="hub-btn hub-btn-sm ${viewMode === 'pipeline' ? '' : 'hub-btn-secondary'}" data-view="pipeline">Pipeline</button>
          <button class="hub-btn hub-btn-sm ${viewMode === 'list' ? '' : 'hub-btn-secondary'}" data-view="list">List</button>
          <button class="hub-btn hub-btn-sm ${viewMode === 'customers' ? '' : 'hub-btn-secondary'}" data-view="customers">Customers</button>
          <button class="hub-btn hub-btn-sm ${viewMode === 'hours' ? '' : 'hub-btn-secondary'}" data-view="hours">My Hours</button>
          <button class="hub-btn hub-btn-sm hub-btn-primary" data-action="new-opp" style="margin-left:8px;">+ New Opportunity</button>
        </div>
      </div>

      <!-- Search + Customer filter (hidden on customers/hours views) -->
      ${(viewMode === 'pipeline' || viewMode === 'list') ? `
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
        <div style="position:relative;flex:1;min-width:240px;max-width:380px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ies-gray-400)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="hub-input" type="text" id="dm-search" placeholder="Search deals by name, customer, or owner…" value="${escapeAttr(dealSearch)}"
            style="padding-left:38px;"/>
        </div>
        <select class="hub-select" id="dm-customer-filter" style="width:auto;min-width:180px;">
          <option value="">All Customers</option>
          ${customers.map(c => `<option value="${escapeAttr(c)}" ${c === customerFilter ? 'selected' : ''}>${escapeAttr(c)}</option>`).join('')}
        </select>
        ${(dealSearch || customerFilter) ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="clear-filters">Clear filters</button>` : ''}
        <span style="font-size:11px;color:var(--ies-gray-500);margin-left:auto;">${filteredDeals().length} of ${DEALS.length} deals</span>
      </div>
      ` : ''}

      <!-- KPI Bar -->
      <div class="hub-kpi-strip" style="margin-bottom:20px;">
        ${kpi('Active Deals', DEALS.length)}
        ${kpi('Total Pipeline', '$' + (totalRevenue / 1e6).toFixed(1) + 'M')}
        ${kpi('Avg Margin', avgMargin.toFixed(1) + '%')}
        ${kpi('Total Sites', totalSites)}
      </div>

      <div id="dm-content"></div>
    </div>
  `;

  const content = rootEl.querySelector('#dm-content');
  if (viewMode === 'pipeline') renderPipeline(content);
  else if (viewMode === 'list') renderList(content);
  else if (viewMode === 'customers') renderCustomers(content);
  else if (viewMode === 'hours') renderMyHours(content);

  // Wire search + filter inputs after render.
  const searchInput = rootEl.querySelector('#dm-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      dealSearch = e.target.value;
      const c = rootEl.querySelector('#dm-content');
      if (viewMode === 'pipeline') renderPipeline(c);
      else if (viewMode === 'list') renderList(c);
      // Update count without full re-render.
      const counter = rootEl.querySelector('span[style*="margin-left:auto"]');
      if (counter) counter.textContent = `${filteredDeals().length} of ${DEALS.length} deals`;
    });
  }
  const filterSelect = rootEl.querySelector('#dm-customer-filter');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      customerFilter = e.target.value;
      render();
    });
  }
}

/** Apply current search + customer filter. */
function filteredDeals() {
  const q = (dealSearch || '').trim().toLowerCase();
  return DEALS.filter(d => {
    if (customerFilter && d.client !== customerFilter) return false;
    if (!q) return true;
    return (
      (d.name || '').toLowerCase().includes(q) ||
      (d.client || '').toLowerCase().includes(q) ||
      (d.owner || '').toLowerCase().includes(q)
    );
  });
}

function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPipeline(el) {
  const visible = filteredDeals();
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(${DOS_STAGES.length},1fr);gap:10px;overflow-x:auto;">
      ${DOS_STAGES.map(stage => {
        const stageDeals = visible.filter(d => d.stage === stage.id);
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
  const visible = filteredDeals();
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
          ${visible.length === 0 ? '<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--ies-gray-400);font-size:13px;">No deals match the current filters.</td></tr>' : ''}
          ${visible.map(d => {
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
// CUSTOMERS VIEW — customer-level rollup
// ============================================================

function renderCustomers(el) {
  const byCustomer = new Map();
  for (const d of DEALS) {
    const key = d.client || 'Unknown';
    const entry = byCustomer.get(key) || { client: key, deals: [], revenue: 0, sites: 0, hoursActual: 0, hoursForecast: 0 };
    entry.deals.push(d);
    entry.revenue += d.revenue || 0;
    entry.sites += Array.isArray(d.sites) ? d.sites.length : (d.sites || 0);
    entry.hoursActual += d.hoursActual || 0;
    entry.hoursForecast += d.hoursForecast || 0;
    byCustomer.set(key, entry);
  }
  const rows = Array.from(byCustomer.values()).sort((a, b) => b.revenue - a.revenue);
  el.innerHTML = `
    <div class="hub-card" style="padding:0;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Customer</th>
            <th style="text-align:center;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Deals</th>
            <th style="text-align:center;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Sites</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Total Pipeline</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Deal Names</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="border-bottom:1px solid var(--ies-gray-100);cursor:pointer;" data-customer="${escapeAttr(r.client)}" onmouseover="this.style.background='var(--ies-gray-50)'" onmouseout="this.style.background='transparent'">
              <td style="padding:10px 12px;font-weight:700;">${escapeAttr(r.client)}</td>
              <td style="padding:10px 12px;text-align:center;">${r.deals.length}</td>
              <td style="padding:10px 12px;text-align:center;">${r.sites}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:600;">$${(r.revenue / 1e6).toFixed(1)}M</td>
              <td style="padding:10px 12px;color:var(--ies-gray-500);font-size:11px;">${r.deals.map(d => escapeAttr(d.name)).join(' · ')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// MY HOURS VIEW — forecast vs actual per deal (clearly delineated)
// ============================================================

function renderMyHours(el) {
  // Synth per-deal hours if the deal objects don't carry them yet.
  // Forecast = f(stage, revenue), Actual = partial of forecast.
  const forecastFor = (d) => Math.round(((d.revenue || 0) / 1e6) * 12 + (d.stage || 1) * 8);
  const actualFor = (d) => Math.round(forecastFor(d) * (0.1 + (d.stage || 1) * 0.12));
  const rows = DEALS.map(d => ({
    id: d.id, name: d.name, client: d.client, stage: d.stage, owner: d.owner,
    forecast: d.hoursForecast != null ? d.hoursForecast : forecastFor(d),
    actual:   d.hoursActual   != null ? d.hoursActual   : actualFor(d),
  }));
  const totalForecast = rows.reduce((s, r) => s + r.forecast, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const pct = totalForecast > 0 ? (totalActual / totalForecast) * 100 : 0;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
      <div class="hub-card" style="padding:14px;">
        <div style="font-size:11px;color:var(--ies-gray-500);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Forecast Hours</div>
        <div style="font-size:26px;font-weight:800;color:#2563eb;margin-top:6px;">${totalForecast.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">planned across ${rows.length} deal${rows.length === 1 ? '' : 's'}</div>
      </div>
      <div class="hub-card" style="padding:14px;">
        <div style="font-size:11px;color:var(--ies-gray-500);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Actual Hours</div>
        <div style="font-size:26px;font-weight:800;color:#16a34a;margin-top:6px;">${totalActual.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">logged to date</div>
      </div>
      <div class="hub-card" style="padding:14px;">
        <div style="font-size:11px;color:var(--ies-gray-500);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Consumption</div>
        <div style="font-size:26px;font-weight:800;color:${pct < 100 ? '#7c3aed' : '#dc2626'};margin-top:6px;">${pct.toFixed(0)}%</div>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">actual / forecast</div>
      </div>
    </div>

    <div class="hub-card" style="padding:0;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Deal</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Customer</th>
            <th style="text-align:center;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Stage</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:#2563eb;">Forecast</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:#16a34a;">Actual</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Δ</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const delta = r.actual - r.forecast;
            const stage = DOS_STAGES.find(s => s.id === r.stage);
            return `
              <tr style="border-bottom:1px solid var(--ies-gray-100);cursor:pointer;" data-deal="${r.id}" onmouseover="this.style.background='var(--ies-gray-50)'" onmouseout="this.style.background='transparent'">
                <td style="padding:10px 12px;font-weight:600;">${escapeAttr(r.name)}</td>
                <td style="padding:10px 12px;color:var(--ies-gray-500);">${escapeAttr(r.client)}</td>
                <td style="padding:10px 12px;text-align:center;"><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;color:#fff;background:${stage?.color || '#6b7280'};">${stage?.name || ''}</span></td>
                <td style="padding:10px 12px;text-align:right;color:#2563eb;font-weight:600;">${r.forecast.toLocaleString()}h</td>
                <td style="padding:10px 12px;text-align:right;color:#16a34a;font-weight:600;">${r.actual.toLocaleString()}h</td>
                <td style="padding:10px 12px;text-align:right;font-weight:700;color:${delta < 0 ? '#16a34a' : delta > 0 ? '#dc2626' : 'var(--ies-gray-400)'};">${delta > 0 ? '+' : ''}${delta.toLocaleString()}h</td>
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

  // Calculate DOS completion (applies per-deal overlay so real deals show
  // their persisted progress, not the global catalog default).
  let totalElements = 0, completedElements = 0;
  for (let s = 1; s <= d.stage; s++) {
    const templates = DOS_TEMPLATES[s] || [];
    totalElements += templates.length;
    completedElements += templates.filter(t => _dosStatusFor(d.id, t) === 'complete').length;
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

      <!-- Quick Action chip group — surfaces most-used workflow actions without
           burying them in tabs. All chips reuse existing handlers (advance-stage,
           add-artifact, open-cost-model, open-multi-site). -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;padding:10px 14px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);border-radius:10px;">
        <span style="font-size:11px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.04em;margin-right:4px;">Quick actions</span>
        ${d.stage < 6
          ? `<button class="hub-btn hub-btn-sm hub-btn-primary" data-action="advance-stage" title="Move this deal to Stage ${d.stage + 1}">Advance to Stage ${d.stage + 1} →</button>`
          : `<span class="hub-chip" style="font-size:11px;color:var(--ies-gray-500);background:var(--ies-gray-100);padding:4px 10px;border-radius:16px;">Final stage reached</span>`}
        ${renderCostModelButton(d)}
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="add-artifact" title="Link a cost model, design scenario, deck, or external file">+ Link Artifact</button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="open-multi-site" title="Open the Multi-Site Analyzer with this deal">Multi-Site →</button>
      </div>

      <!-- Quick Stats — 5-tile strip overrides hub-kpi-strip\'s 4-column default -->
      <div class="hub-kpi-strip" style="grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:20px;">
        ${kpi('Revenue', '$' + (d.revenue / 1e6).toFixed(1) + 'M')}
        ${kpi('Margin', d.margin > 0 ? d.margin + '%' : 'TBD', d.margin > 0 && d.margin < 10 ? 'var(--ies-orange)' : null)}
        ${kpi('Total sqft', totalSqft > 0 ? (totalSqft / 1000).toFixed(0) + 'K' : '—')}
        ${kpi('Days in Stage', d.daysInStage, d.daysInStage > 14 ? 'var(--ies-red)' : null)}
        ${kpi('DOS Completion', dosCompletion + '%', totalElements === 0 ? 'var(--ies-gray-300)' : dosCompletion < 50 ? 'var(--ies-red)' : dosCompletion < 75 ? 'var(--ies-orange)' : null)}
      </div>

      <!-- Detail Tabs -->
      <div class="hub-tab-bar" style="margin-bottom:16px;">
        <button class="hub-tab ${detailTab === 'overview' ? 'active' : ''}" data-detail-tab="overview">Overview</button>
        <button class="hub-tab ${detailTab === 'sites' ? 'active' : ''}" data-detail-tab="sites">Site Details</button>
        <button class="hub-tab ${detailTab === 'dos' ? 'active' : ''}" data-detail-tab="dos">DOS Elements</button>
        <button class="hub-tab ${detailTab === 'financials' ? 'active' : ''}" data-detail-tab="financials">Financials</button>
        <button class="hub-tab ${detailTab === 'strategy' ? 'active' : ''}" data-detail-tab="strategy">Win Strategy</button>
        <button class="hub-tab ${detailTab === 'artifacts' ? 'active' : ''}" data-detail-tab="artifacts">Artifacts</button>
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
    case 'strategy': el.innerHTML = renderDealWinStrategy(); break;
    case 'artifacts': el.innerHTML = renderDealArtifacts(); break;
  }
}

// ============================================================
// WIN STRATEGY TAB
// ============================================================

/** Per-deal strategy persisted in-memory; in production this lives in
 *  deal_strategy table.  */
const _strategyByDeal = new Map();

function getStrategy(dealId) {
  if (_strategyByDeal.has(dealId)) return _strategyByDeal.get(dealId);
  // Default seed
  const d = DEALS.find(x => x.id === dealId);
  const seeded = {
    valueProp: d ? `Why GXO wins ${d.client}: scale + automation maturity + DOS rigor.` : '',
    risks: ['Customer pricing pressure', 'Implementation timeline tight', 'Internal resource constraint'],
    asks: ['Customer to share 12-mo demand forecast', 'Internal: confirm equipment lead times'],
    differentiators: ['Locus cobot template ready', 'BY WMS reference deployment', 'Tier-1 carrier rate card'],
    competitorThreats: 'DHL SC, Ryder',
  };
  _strategyByDeal.set(dealId, seeded);
  return seeded;
}

function renderDealWinStrategy() {
  const d = selectedDeal;
  if (!d) return '';
  const s = getStrategy(d.id);
  return `
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;">
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Value Proposition</div>
        <textarea data-strategy-field="valueProp" rows="4" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-family:Montserrat,sans-serif;font-size:13px;line-height:1.5;resize:vertical;">${escapeAttr(s.valueProp)}</textarea>

        <div style="font-size:13px;font-weight:700;margin:18px 0 10px;">Differentiators</div>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--ies-gray-700);line-height:1.7;">
          ${s.differentiators.map((x, i) => `<li><input type="text" data-strategy-list="differentiators" data-strategy-idx="${i}" value="${escapeAttr(x)}" style="width:100%;border:none;padding:2px 0;font-family:Montserrat,sans-serif;font-size:13px;background:transparent;"/></li>`).join('')}
        </ul>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-strategy-add="differentiators" style="font-size:11px;margin-top:6px;">+ Add differentiator</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:#dc2626;">Risks</div>
          <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--ies-gray-700);line-height:1.7;">
            ${s.risks.map((x, i) => `<li><input type="text" data-strategy-list="risks" data-strategy-idx="${i}" value="${escapeAttr(x)}" style="width:100%;border:none;padding:2px 0;font-family:Montserrat,sans-serif;font-size:13px;background:transparent;"/></li>`).join('')}
          </ul>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-strategy-add="risks" style="font-size:11px;margin-top:6px;">+ Add risk</button>
        </div>

        <div class="hub-card" style="padding:16px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:#d97706;">Open Asks</div>
          <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--ies-gray-700);line-height:1.7;">
            ${s.asks.map((x, i) => `<li><input type="text" data-strategy-list="asks" data-strategy-idx="${i}" value="${escapeAttr(x)}" style="width:100%;border:none;padding:2px 0;font-family:Montserrat,sans-serif;font-size:13px;background:transparent;"/></li>`).join('')}
          </ul>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-strategy-add="asks" style="font-size:11px;margin-top:6px;">+ Add ask</button>
        </div>

        <div class="hub-card" style="padding:16px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">Competitor Threats</div>
          <input type="text" data-strategy-field="competitorThreats" value="${escapeAttr(s.competitorThreats)}" style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-family:Montserrat,sans-serif;font-size:13px;"/>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// ARTIFACTS TAB — link CM/WSC/Fleet/NetOpt scenarios to a deal
// ============================================================

const _artifactsByDeal = new Map();

function getArtifacts(dealId) {
  if (_artifactsByDeal.has(dealId)) return _artifactsByDeal.get(dealId);
  // 2026-04-27: real deals (uuid id, isReal:true on the DEAL object) get
  // their cost models surfaced as Linked Artifacts directly. Demo deals
  // keep the original seeded list so the demo flow still works.
  const dealObj = DEALS.find(x => x.id === dealId);
  let seeded;
  if (dealObj?.isReal && Array.isArray(dealObj.models) && dealObj.models.length) {
    seeded = dealObj.models.map(m => ({
      id: 'cm-' + m.id,
      kind: 'cost_model',
      name: `${m.name || 'Untitled'}${m.scenario_label ? ' — ' + m.scenario_label : ''}`,
      ref: 'cm:' + m.id,
      updated: m.updated_at ? String(m.updated_at).slice(0, 10) : '—',
      modelId: m.id,
    }));
  } else {
    seeded = [
      { id: 'a1', kind: 'cost_model',       name: 'Wayfair Midwest base case',  ref: 'cm:7',   updated: '2026-04-12' },
      { id: 'a2', kind: 'warehouse_sizing', name: 'Chicago DC sizing v2',       ref: 'wsc:11', updated: '2026-04-15' },
    ];
  }
  _artifactsByDeal.set(dealId, seeded);
  return seeded;
}

// =============================================================
// 2026-04-29 — DM persistence helpers (uuid check / hydrate / debounced save)
// =============================================================
// These functions were referenced by the DM persistence wiring but accidentally
// omitted from commit 864411b. Adding them here closes the circuit:
//   - _isRealDealId: real deals have uuid ids and get registered in
//     `_realDealIds` whenever loadRealDealsAndMerge runs. Demo deals use
//     short string ids ('d1', 'd2', ...) and are never registered.
//   - _hydrateDealDetail: pulls strategy + artifacts + DOS status from
//     Supabase on detail-view entry. Merges into the per-deal Maps so
//     subsequent edits flow through the existing UI paths.
//   - _scheduleStrategySave: debounced upsert (600ms) — the strategy
//     textarea/input handlers fire every keystroke, so we coalesce.
// DOS status overrides live in `_dosStatusByDeal` so we can render per-deal
// progress without mutating the global DOS_TEMPLATES catalog.

/** Map<dealId, Map<elementId, status>> — per-deal overrides on top of
 *  DOS_TEMPLATES defaults. Persisted to deal_dos_status for real deals. */
const _dosStatusByDeal = new Map();

/** Set of dealIds that have already been hydrated, so we don't re-fetch
 *  on every detail-tab switch. Keyed by deal_deals.id (uuid). */
const _hydratedDeals = new Set();

/** True when this deal_id has been merged from deal_deals (real DB row). */
function _isRealDealId(dealId) {
  return _realDealIds.has(dealId);
}

/** Get (creating if needed) the per-deal DOS status overlay map. */
function _dosOverlay(dealId) {
  let m = _dosStatusByDeal.get(dealId);
  if (!m) { m = new Map(); _dosStatusByDeal.set(dealId, m); }
  return m;
}

/** Read a DOS template's effective status for a deal, applying overlay. */
function _dosStatusFor(dealId, tpl) {
  const overlay = _dosStatusByDeal.get(dealId);
  if (overlay && overlay.has(tpl.id)) return overlay.get(tpl.id);
  return tpl.status || 'pending';
}

/** Async hydrate strategy + artifacts + DOS status for a real deal. Demo
 *  deals are no-op (their state lives in the seeded Maps already). Idempotent
 *  — second call for the same deal is a quick `_hydratedDeals` membership
 *  check. */
async function _hydrateDealDetail(dealId) {
  if (!dealId) return;
  if (!_isRealDealId(dealId)) return;
  if (_hydratedDeals.has(dealId)) return;
  _hydratedDeals.add(dealId);
  try {
    const [strategy, artifacts, dosStatus] = await Promise.all([
      api.loadStrategy(dealId),
      api.listArtifactsByDeal(dealId),
      api.loadDosStatusByDeal(dealId),
    ]);

    // Strategy: merge over the seeded defaults so any null-valued columns
    // fall back to the seed; non-null DB values win.
    if (strategy) {
      const seed = getStrategy(dealId); // creates seed if absent
      if (typeof strategy.value_prop === 'string')        seed.valueProp = strategy.value_prop;
      if (Array.isArray(strategy.risks))                   seed.risks = strategy.risks;
      if (Array.isArray(strategy.asks))                    seed.asks = strategy.asks;
      if (Array.isArray(strategy.differentiators))         seed.differentiators = strategy.differentiators;
      if (typeof strategy.competitor_threats === 'string') seed.competitorThreats = strategy.competitor_threats;
    }

    // Artifacts: prefer DB rows when present. Otherwise leave the
    // model-derived seed (real deals seed from cost-model rows in
    // getArtifacts()) so the user still sees their attached scenarios.
    if (Array.isArray(artifacts) && artifacts.length > 0) {
      const list = artifacts.map(r => ({
        id: r.id, kind: r.kind, name: r.name, ref: r.ref || '',
        modelId: r.model_id ?? null,
        updated: r.updated_at ? String(r.updated_at).slice(0, 10) : '—',
      }));
      _artifactsByDeal.set(dealId, list);
    }

    // DOS status: load overlay map.
    const overlay = _dosOverlay(dealId);
    overlay.clear();
    for (const [elemId, status] of Object.entries(dosStatus || {})) {
      overlay.set(elemId, status);
    }

    // Re-render currently visible detail content if we're still on this deal.
    if (viewMode === 'detail' && selectedDeal && selectedDeal.id === dealId) {
      renderDetailContent();
    }
  } catch (err) {
    console.warn('[deal-mgmt] _hydrateDealDetail failed', err);
    // Allow retry on next entry by clearing the membership
    _hydratedDeals.delete(dealId);
  }
}

/** Debounced strategy upsert — 600ms quiet window. One timer per deal so
 *  switching between deals doesn't drop pending writes. */
const _strategySaveTimers = new Map();
function _scheduleStrategySave(dealId) {
  if (!dealId || !_isRealDealId(dealId)) return;
  const existing = _strategySaveTimers.get(dealId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(async () => {
    _strategySaveTimers.delete(dealId);
    try {
      const s = getStrategy(dealId);
      await api.saveStrategy(dealId, {
        valueProp:         s.valueProp,
        risks:             s.risks,
        asks:              s.asks,
        differentiators:   s.differentiators,
        competitorThreats: s.competitorThreats,
      });
    } catch (err) {
      console.warn('[deal-mgmt] strategy save failed', err);
      bus.emit('toast:show', { message: 'Strategy save failed: ' + (err.message || err), level: 'error' });
    }
  }, 600);
  _strategySaveTimers.set(dealId, t);
}

// =============================================================
// 2026-04-27 — Smart cost-model routing: 0/1/N
// =============================================================

/**
 * Render the Quick Actions "Open Cost Model Builder" button. For real deals
 * with attached cost models, switches the affordance based on count:
 *   0 → "Create cost model" (linked to this deal)
 *   1 → "Open <scenario_label>" (jumps straight into that model)
 *   N → "Compare N scenarios" (opens an in-page chooser modal)
 *
 * Demo deals keep the legacy "Open Cost Model Builder →" behavior so existing
 * demo flows aren't disrupted.
 */
function renderCostModelButton(d) {
  if (!d?.isReal || !Array.isArray(d.models) || d.models.length === 0) {
    if (d?.isReal) {
      return `<button class="hub-btn hub-btn-sm hub-btn-primary" data-action="create-cost-model" data-deal-id="${escapeAttr(d.id)}" style="text-align:left;">+ Create cost model for this deal</button>`;
    }
    return `<button class="hub-btn hub-btn-sm" data-action="open-cost-model" style="text-align:left;">Open Cost Model Builder →</button>`;
  }
  if (d.models.length === 1) {
    const m = d.models[0];
    const lbl = m.scenario_label ? `${m.name || 'Cost model'} — ${m.scenario_label}` : (m.name || 'Cost model');
    return `<button class="hub-btn hub-btn-sm hub-btn-primary" data-action="open-cost-model-id" data-model-id="${m.id}" style="text-align:left;">Open ${escapeAttr(lbl)} →</button>`;
  }
  return `<button class="hub-btn hub-btn-sm hub-btn-primary" data-action="choose-cost-model" data-deal-id="${escapeAttr(d.id)}" style="text-align:left;">Choose from ${d.models.length} cost-model scenarios →</button>`;
}

/**
 * Replacement for the legacy "Cost Breakdown (Placeholder)" card. For real
 * deals, surfaces a small summary of attached models + a smart-routed button
 * (same logic as the Quick Actions button). For demo deals, keeps the legacy
 * placeholder + Open Cost Model Builder behavior so there's no regression.
 */
function renderCostBreakdownCard(d) {
  if (!d?.isReal) {
    return `
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Cost Breakdown (Placeholder)</div>
        <div style="text-align:center;padding:20px;color:var(--ies-gray-400);">
          <div style="font-size:12px;margin-bottom:8px;">Build a cost model to see detailed cost breakdown.</div>
          <button class="hub-btn hub-btn-sm" data-action="open-cost-model">Open Cost Model Builder</button>
        </div>
      </div>
    `;
  }
  const ms = d.models || [];
  const total = ms.length;
  const headerLabel = total === 0 ? 'Cost Models' : `Cost Models · ${total}`;
  if (total === 0) {
    return `
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">${headerLabel}</div>
        <div style="text-align:center;padding:20px;color:var(--ies-gray-400);">
          <div style="font-size:12px;margin-bottom:8px;">No cost models linked to this deal yet.</div>
          <button class="hub-btn hub-btn-sm hub-btn-primary" data-action="create-cost-model" data-deal-id="${escapeAttr(d.id)}">+ Create cost model</button>
        </div>
      </div>
    `;
  }
  const rows = ms.map(m => {
    const sqftN = Number(m.facility_sqft);
    const sqft = Number.isFinite(sqftN) && sqftN > 0
      ? (sqftN >= 1000 ? `${(sqftN/1000).toLocaleString(undefined,{maximumFractionDigits:0})}K SF` : sqftN.toLocaleString() + ' SF')
      : '—';
    const marginN = Number(m.target_margin_pct);
    const margin = Number.isFinite(marginN) && marginN > 0 ? `${marginN.toFixed(1)}%` : '—';
    const lbl = m.scenario_label || 'Baseline';
    return `
      <tr style="border-bottom:1px solid var(--ies-gray-100);">
        <td style="padding:8px 6px;font-weight:600;">${escapeAttr(lbl)}</td>
        <td style="padding:8px 6px;color:var(--ies-gray-500);">${sqft}</td>
        <td style="padding:8px 6px;color:var(--ies-gray-500);">${margin}</td>
        <td style="padding:8px 6px;text-align:right;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="open-cost-model-id" data-model-id="${m.id}" style="font-size:11px;">Open →</button>
        </td>
      </tr>
    `;
  }).join('');
  return `
    <div class="hub-card" style="padding:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;">${headerLabel}</div>
        ${total > 1 ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="choose-cost-model" data-deal-id="${escapeAttr(d.id)}" style="font-size:11px;">Compare ${total} scenarios →</button>` : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--ies-gray-50);color:var(--ies-gray-400);font-size:10px;font-weight:700;">
          <th style="text-align:left;padding:6px;">Scenario</th>
          <th style="text-align:left;padding:6px;">Facility</th>
          <th style="text-align:left;padding:6px;">Target Margin</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/**
 * Open a specific cost model by id. Uses sessionStorage handoff so the CM
 * mount() can pick it up and skip the landing page.
 */
function openCostModelById(modelId) {
  try {
    sessionStorage.setItem('cm_pending_open', JSON.stringify({ id: Number(modelId), at: Date.now() }));
  } catch {}
  window.location.hash = 'designtools/cost-model';
}

/**
 * Pop a chooser modal listing all attached scenarios so the user picks one.
 */
function openCostModelChooser(dealId) {
  if (!rootEl) return;
  const d = DEALS.find(x => x.id === dealId);
  if (!d || !Array.isArray(d.models) || d.models.length === 0) return;
  rootEl.querySelector('#dm-cm-chooser')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'dm-cm-chooser';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:8px;padding:20px;width:560px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">Pick a cost-model scenario</div>
      <div style="font-size:12px;color:var(--ies-gray-400);margin-bottom:14px;">${escapeAttr(d.name)} · ${d.models.length} scenarios linked.</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto;">
        ${d.models.map(m => {
          const sqftN = Number(m.facility_sqft);
          const sqft = Number.isFinite(sqftN) && sqftN > 0
            ? (sqftN >= 1000 ? `${(sqftN/1000).toLocaleString(undefined,{maximumFractionDigits:0})}K SF` : sqftN.toLocaleString() + ' SF')
            : '—';
          const marginN = Number(m.target_margin_pct);
          const margin = Number.isFinite(marginN) && marginN > 0 ? `${marginN.toFixed(1)}%` : '—';
          const lbl = m.scenario_label || 'Baseline';
          return `
            <button data-pick-model-id="${m.id}" style="text-align:left;padding:12px 14px;border:1px solid var(--ies-gray-200);border-radius:6px;background:#fff;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <div>
                <div style="font-weight:700;color:var(--ies-navy);">${escapeAttr(lbl)}</div>
                <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">${escapeAttr(m.name || '')}</div>
              </div>
              <div style="font-size:11px;color:var(--ies-gray-500);text-align:right;">
                <div>${sqft}</div>
                <div>Margin ${margin}</div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-cm-chooser-cancel>Cancel</button>
      </div>
    </div>
  `;
  rootEl.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
    const t = e.target.closest?.('[data-pick-model-id]');
    if (t) { const id = t.getAttribute('data-pick-model-id'); overlay.remove(); openCostModelById(id); return; }
    if (e.target.closest?.('[data-cm-chooser-cancel]')) overlay.remove();
  });
}

/**
 * Create a new cost model linked to the given deal. Pre-stash the deal id
 * via sessionStorage so the new model picks it up on save.
 */
function createCostModelForDeal(dealId) {
  try {
    sessionStorage.setItem('cm_pending_new_for_deal', JSON.stringify({ dealId, at: Date.now() }));
  } catch {}
  window.location.hash = 'designtools/cost-model';
}

const ARTIFACT_KINDS = {
  cost_model:        { label: 'Cost Model',        color: '#ff3a00', route: 'designtools/cost-model' },
  warehouse_sizing:  { label: 'Warehouse Sizing',  color: '#0047AB', route: 'designtools/warehouse-sizing' },
  fleet_modeler:     { label: 'Fleet Modeler',     color: '#20c997', route: 'designtools/fleet-modeler' },
  network_opt:       { label: 'Network Opt',       color: '#20c997', route: 'designtools/network-opt' },
  most_standards:    { label: 'MOST Standards',    color: '#0047AB', route: 'designtools/most-standards' },
  deck:              { label: 'Generated Deck',    color: '#7c3aed', route: 'deals' },
};

function renderDealArtifacts() {
  const d = selectedDeal;
  if (!d) return '';
  const list = getArtifacts(d.id);
  return `
    <div class="hub-card" style="padding:0;overflow-x:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--ies-gray-100);">
        <div style="font-size:13px;font-weight:700;">Linked Artifacts</div>
        <button class="hub-btn hub-btn-sm hub-btn-primary" data-action="add-artifact" style="font-size:11px;">+ Link Artifact</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            <th style="text-align:left;padding:10px 16px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Type</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Name</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Reference</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Updated</th>
            <th style="text-align:right;padding:10px 16px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${list.length === 0 ? '<tr><td colspan="5" style="padding:18px;text-align:center;color:var(--ies-gray-400);font-size:13px;">No artifacts linked yet. Click <strong>+ Link Artifact</strong> above.</td></tr>' : ''}
          ${list.map(a => {
            const kind = ARTIFACT_KINDS[a.kind] || { label: a.kind, color: '#6b7280', route: '' };
            return `
              <tr style="border-bottom:1px solid var(--ies-gray-100);">
                <td style="padding:10px 16px;"><span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:700;color:#fff;background:${kind.color};">${kind.label}</span></td>
                <td style="padding:10px 12px;font-weight:600;">${escapeAttr(a.name)}</td>
                <td style="padding:10px 12px;color:var(--ies-gray-500);font-family:monospace;font-size:11px;">${escapeAttr(a.ref)}</td>
                <td style="padding:10px 12px;color:var(--ies-gray-500);">${escapeAttr(a.updated)}</td>
                <td style="padding:10px 16px;text-align:right;">
                  ${a.kind === 'cost_model' && a.modelId
                    ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="open-cost-model-id" data-model-id="${a.modelId}" style="font-size:11px;">Open →</button>`
                    : (a.kind === 'cost_model'
                        ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-artifact-open="${escapeAttr(kind.route)}" style="font-size:11px;" title="Demo artifact — opens Cost Model landing">Open →</button>`
                        : `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-artifact-open="${escapeAttr(kind.route)}" style="font-size:11px;">Open →</button>`)}
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-artifact-unlink="${a.id}" style="font-size:11px;color:#dc2626;">Unlink</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
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
          ${renderCostModelButton(d)}
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
    const engine = await import('../deck-generator/engine.js?v=20260418-sK');
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

  // Compute stage-advance eligibility: current stage's REQUIRED templates must
  // all be complete and we must not be on the final stage.
  const currentTemplates = DOS_TEMPLATES[d.stage] || [];
  const requiredOpen = currentTemplates.filter(t => t.required && _dosStatusFor(d.id, t) !== 'complete').length;
  const canAdvance = d.stage < 6 && requiredOpen === 0;
  const advanceBanner = canAdvance ? `
    <div class="hub-card" style="padding:14px 16px;background:#f0fdf4;border:1px solid #86efac;display:flex;align-items:center;gap:12px;">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#16a34a;color:#fff;font-weight:800;">✓</span>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:#166534;">Stage ${d.stage} requirements met</div>
        <div style="font-size:11px;color:#15803d;">All required activities for this stage are complete. You can advance to Stage ${d.stage + 1}.</div>
      </div>
      <button class="hub-btn hub-btn-sm hub-btn-primary" data-action="advance-stage" style="font-size:12px;">Advance to Stage ${d.stage + 1} →</button>
    </div>
  ` : (d.stage < 6 ? `
    <div style="font-size:11px;color:var(--ies-gray-500);background:var(--ies-gray-50);padding:8px 12px;border-radius:6px;">${requiredOpen} required activit${requiredOpen === 1 ? 'y' : 'ies'} still open in Stage ${d.stage} — finish to unlock auto-advance.</div>
  ` : '');

  return `
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${advanceBanner}
      ${DOS_STAGES.filter(s => s.id <= d.stage).map(stage => {
        const templates = DOS_TEMPLATES[stage.id] || [];
        const completed = templates.filter(t => _dosStatusFor(d.id, t) === 'complete').length;
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
              const status = _dosStatusFor(d.id, t);
              const statusIcon = status === 'complete' ? '✅' : status === 'in-progress' ? '🔄' : '⬜';
              const statusColor = status === 'complete' ? '#16a34a' : status === 'in-progress' ? '#d97706' : 'var(--ies-gray-300)';
              return `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--ies-gray-50);cursor:pointer;" data-dos-toggle="${t.id}">
                  <span style="font-size:14px;">${statusIcon}</span>
                  <span style="font-size:13px;flex:1;${status === 'complete' ? 'text-decoration:line-through;color:var(--ies-gray-400);' : ''}">${t.name}</span>
                  ${t.required ? '<span style="font-size:9px;font-weight:700;color:#dc2626;padding:1px 6px;border-radius:10px;border:1px solid #dc2626;">REQ</span>' : ''}
                  <span style="font-size:11px;font-weight:600;color:${statusColor};">${status}</span>
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

      ${renderCostBreakdownCard(d)}
    </div>
  `;
}

// ============================================================
// HELPERS
// ============================================================

function kpi(label, value, color) {
  // 2026-04-29 polish — emit hub-kpi-tile so DM matches the design-tools
  // visual language (label uppercase + accent value). The optional color
  // argument is kept for threshold semantics (e.g. red when days-in-stage
  // exceeds 14) — when omitted, value inherits --ies-navy from the primitive.
  const valueStyle = color ? ` style="color:${color};"` : '';
  return `
    <div class="hub-kpi-tile">
      <div class="hub-kpi-tile__label">${label}</div>
      <div class="hub-kpi-tile__value"${valueStyle}>${value}</div>
    </div>
  `;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    // 2026-04-29 (#11): a YYYY-MM-DD string parsed by `new Date()` is treated
    // as UTC midnight, which renders one day earlier in any negative-offset
    // local timezone (e.g., US Pacific). Detect bare date and parse as local.
    const dateOnlyMatch = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.exec(dateStr);
    const d = dateOnlyMatch
      ? new Date(Number(dateOnlyMatch.input.slice(0, 4)),
                 Number(dateOnlyMatch.input.slice(5, 7)) - 1,
                 Number(dateOnlyMatch.input.slice(8, 10)))
      : new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return dateStr; }
}
