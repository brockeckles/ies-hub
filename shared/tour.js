/**
 * IES Hub v3 — Tour Engine
 *
 * Non-blocking guided tours. Highlights target elements with a tooltip/
 * popover; the rest of the page stays fully interactive (no modal overlay).
 *
 * Usage:
 *   import { tour } from './shared/tour.js?v=20260418-s4';
 *   tour.start('overview');   // start a named tour
 *   tour.next();              // advance manually (normally user clicks)
 *   tour.stop();              // end immediately
 *
 * Or via URL: add ?tour=overview to auto-start on load.
 *
 * Tours are defined below in TOURS. Each tour is an array of steps; a step
 * has { selector, title, body, placement? }. If selector is missing or not
 * found at runtime, the step is skipped (helps when v3 DOM differs from what
 * the tour was authored against).
 *
 * @module shared/tour
 */

import { bus } from './event-bus.js?v=20260418-s4';

// ---------------------------------------------------------------------------
// Tour definitions — 10 section tours for v3.
// ---------------------------------------------------------------------------

/** @typedef {{ selector?: string, route?: string, title: string, body: string, placement?: 'top'|'bottom'|'left'|'right' }} TourStep */

/** @type {Record<string, TourStep[]>} */
const TOURS = {
  // 1. First-time visitor orientation
  welcome: [
    { route: 'overview', title: 'Welcome to the IES Hub',
      body: 'This 90-second tour covers the six things you should know on day one. Press → or click Next.' },
    { selector: '.hub-sidebar-nav', placement: 'right', title: 'Navigation',
      body: 'Left rail groups everything by function — Intelligence (market data), Work (deals + tools), Resources (wiki + feedback), and Admin.' },
    { selector: '.hub-search-input', placement: 'right', title: 'Global search (Ctrl + K)',
      body: 'Searches everything — deals, cost models, wiki articles, master tables. Fastest way to navigate once you know the hub.' },
    { selector: '[data-route="overview"]', placement: 'right', title: 'Command Center',
      body: 'Your landing page — alerts, KPIs, RFP signals, steel prices, wage trends. Start the day here.' },
    { selector: '[data-route="designtools"]', placement: 'right', title: 'Design Tools',
      body: 'Seven tools for sizing, pricing, and network analysis. Each saves scenarios to Supabase so your team can pick up where you left off.' },
    { selector: '[data-route="deals"]', placement: 'right', title: 'Deal Management',
      body: 'Pipeline across the six GXO DOS stages. Deal detail pages carry DOS templates, artifacts, hours, and weekly updates.' },
  ],
  // 2. Command Center
  overview: [
    { route: 'overview', selector: '.hub-kpi-strip', placement: 'bottom', title: 'KPI strip',
      body: 'Leading indicators refreshed nightly by Supabase ingesters. Hover any tile for source + last-refresh time.' },
    { selector: '.hub-alerts', placement: 'bottom', title: 'Inline alerts',
      body: 'Live feed from hub_alerts (severity: critical / high / medium). Click any alert to open the source article.' },
    { selector: '.hub-rfp-tile', placement: 'top', title: 'Active RFP Signals',
      body: 'rfp_signals table — 3PL RFPs surfaced from public filings + vendor channels. Updated by ingest-rfp-signals cron.' },
    { selector: '.hub-wage-chart', placement: 'top', title: 'Wage trend chart',
      body: 'BLS wages for 5 key 3PL markets with city-specific growth rates. Shows directional spread, not absolute comparison.' },
  ],
  // 3. Deal Management
  deals: [
    { route: 'deals', selector: '.hub-deal-kanban', placement: 'top', title: 'DOS pipeline',
      body: 'Six stages: Pre-Sales Engagement → Deal Qualification → Kick-Off & Solution Design → Operations Review → Executive Review → Delivery Handover.' },
    { selector: '.hub-deal-card', placement: 'right', title: 'Deal cards',
      body: 'Click any card for the 5-tab detail view: Overview / Activities / Artifacts / Hours / Updates.' },
    { selector: '[data-action="new-deal"]', placement: 'left', title: 'Create a deal',
      body: 'New deals start in Pre-Sales Engagement. Stage templates populate automatically from stage_element_templates.' },
  ],
  // 4. Design Tools landing
  designtools: [
    { route: 'designtools', selector: '.hub-dt-categories', placement: 'bottom', title: 'Tool categories',
      body: 'Three groupings: Solutions (Cost Model, Deal Manager), Engineering (WSC, MOST), Logistics (NetOpt, Fleet, COG).' },
    { selector: '.hub-dt-card', placement: 'top', title: 'Tool cards',
      body: 'Each card opens the tool landing page with saved scenarios. Click card body to open; use filter tabs above to narrow.' },
  ],
  // 5. Cost Model Builder
  'cost-model': [
    { route: 'designtools/cost-model', selector: '.cm-nav', placement: 'right', title: 'Cost model sections',
      body: 'Thirteen sections build up the P&L: Setup → Volumes → Labor → Equipment → Facility → Startup → Overhead → Pricing → Summary.' },
    { selector: '.cm-summary-kpis', placement: 'bottom', title: 'Live KPIs',
      body: 'EBITDA %, gross margin, pricing mix — all computed reactively as you edit upstream sections.' },
  ],
  // 6. Warehouse Sizing
  wsc: [
    { route: 'designtools/warehouse-sizing', selector: '.wsc-view-toggle', placement: 'bottom', title: 'Three views',
      body: 'Dashboard (KPIs + recs), Elevation (side view of rack structure), 3D (Three.js interactive walkthrough), 2D Plan (top-down floorplan).' },
    { selector: '.wsc-inputs', placement: 'right', title: 'Inputs',
      body: 'Enter peak pallets, SKU count, turn rate, clearance height. Storage type blend, dock config, and DIOH refine the calc.' },
  ],
  // 7. Network Optimizer
  netopt: [
    { route: 'designtools/network-opt', selector: '.netopt-map', placement: 'right', title: 'Network map',
      body: 'Leaflet map with facility pins, demand heatmap overlay, flow polylines (color-coded by mode), and service zone circles (SLA radii).' },
    { selector: '.netopt-solver', placement: 'bottom', title: 'Exact solver',
      body: 'GLPK.js solves the TL/LTL/Parcel mix for the given facility set. Elbow chart suggests optimal DC count.' },
  ],
  // 8. MOST Standards
  most: [
    { route: 'designtools/most-standards', selector: '.most-library', placement: 'right', title: 'Template library',
      body: 'Reference templates (activity → UPH) stored in ref_most_templates. Edit templates here, then push rows to Cost Model labor.' },
  ],
  // 9. Training Wiki
  wiki: [
    { route: 'training', selector: '.wiki-sidebar', placement: 'right', title: 'Sidebar nav',
      body: 'Articles grouped into six sections (Robotics, Storage & Retrieval, Transportation, Operations, Systems, Reference). Breadcrumb at top.' },
    { selector: '.wiki-search', placement: 'bottom', title: 'Search',
      body: 'Relevance-scored search across all 41 articles. Tries title, tags, and body content.' },
  ],
  // 10. Admin
  admin: [
    { route: 'admin', selector: '.admin-tables', placement: 'bottom', title: 'Master tables',
      body: 'CRUD for reference data: escalation rules, cost buckets, vehicle types, DOS templates, SCCs, accounts, competitors, markets, verticals.' },
  ],
};

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

let activeTour = null;  // { name, steps, idx }
let popover = null;

/** @param {string} name */
function start(name) {
  stop();
  const steps = TOURS[name];
  if (!steps || !steps.length) {
    console.warn(`[tour] unknown tour: ${name}`);
    return;
  }
  activeTour = { name, steps, idx: 0 };
  bus.emit('tour:started', { name });
  advance(0);
}

function stop() {
  if (popover) { popover.remove(); popover = null; }
  if (activeTour) {
    bus.emit('tour:stopped', { name: activeTour.name });
    activeTour = null;
  }
}

function next() {
  if (!activeTour) return;
  advance(activeTour.idx + 1);
}

function prev() {
  if (!activeTour) return;
  advance(activeTour.idx - 1);
}

async function advance(targetIdx) {
  if (!activeTour) return;
  if (targetIdx < 0) targetIdx = 0;
  if (targetIdx >= activeTour.steps.length) { stop(); return; }

  activeTour.idx = targetIdx;
  const step = activeTour.steps[targetIdx];

  // If step has a route, navigate first and wait a tick for DOM.
  if (step.route && typeof window !== 'undefined') {
    const currentHash = window.location.hash.slice(1);
    if (currentHash !== step.route) {
      window.location.hash = step.route;
      await new Promise(r => setTimeout(r, 350));
    }
  }

  const target = step.selector ? document.querySelector(step.selector) : null;
  renderPopover(step, target);
}

function renderPopover(step, target) {
  if (popover) popover.remove();
  popover = document.createElement('div');
  popover.className = 'hub-tour-popover';
  popover.style.cssText = [
    'position:fixed',
    'z-index:10000',
    'max-width:340px',
    'background:#1a1f2e',
    'color:#fff',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,.35)',
    'padding:16px 18px',
    'font-size:13px',
    'line-height:1.5',
    'font-family:Montserrat,sans-serif',
    'pointer-events:auto',
    'border:1px solid rgba(255,255,255,.08)',
  ].join(';');

  const idxOf = activeTour.idx + 1;
  const total = activeTour.steps.length;
  popover.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
        ${escapeHtml(activeTour.name)} · ${idxOf} / ${total}
      </div>
      <button type="button" data-tour-action="stop" aria-label="End tour"
        style="background:none;border:none;color:rgba(255,255,255,.5);font-size:18px;cursor:pointer;line-height:1;">×</button>
    </div>
    <div style="font-weight:700;font-size:14px;color:#ff7a45;margin-bottom:6px;">${escapeHtml(step.title)}</div>
    <div style="color:rgba(255,255,255,.85);">${escapeHtml(step.body)}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
      <button type="button" data-tour-action="prev"
        style="background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600;"
        ${idxOf === 1 ? 'disabled' : ''}>Back</button>
      <button type="button" data-tour-action="next"
        style="background:#ff3a00;border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:700;">
        ${idxOf === total ? 'Done' : 'Next →'}
      </button>
    </div>
  `;

  popover.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tour-action]');
    if (!btn) return;
    const action = btn.dataset.tourAction;
    if (action === 'next') next();
    else if (action === 'prev') prev();
    else if (action === 'stop') stop();
  });

  document.body.appendChild(popover);
  positionPopover(popover, target, step.placement || 'bottom');
  highlightTarget(target);
}

function positionPopover(el, target, placement) {
  const margin = 12;
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  let top, left;

  if (target) {
    const r = target.getBoundingClientRect();
    switch (placement) {
      case 'top':
        top = r.top - ph - margin; left = r.left + r.width / 2 - pw / 2; break;
      case 'left':
        top = r.top + r.height / 2 - ph / 2; left = r.left - pw - margin; break;
      case 'right':
        top = r.top + r.height / 2 - ph / 2; left = r.right + margin; break;
      case 'bottom':
      default:
        top = r.bottom + margin; left = r.left + r.width / 2 - pw / 2; break;
    }
  } else {
    // No target — center on screen.
    top = window.innerHeight / 2 - ph / 2;
    left = window.innerWidth / 2 - pw / 2;
  }

  // Clamp to viewport.
  const vpw = window.innerWidth;
  const vph = window.innerHeight;
  left = Math.max(margin, Math.min(left, vpw - pw - margin));
  top = Math.max(margin, Math.min(top, vph - ph - margin));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

let highlightEl = null;
function highlightTarget(target) {
  if (highlightEl) { highlightEl.remove(); highlightEl = null; }
  if (!target) return;
  const r = target.getBoundingClientRect();
  highlightEl = document.createElement('div');
  highlightEl.style.cssText = [
    'position:fixed',
    `top:${r.top - 4}px`,
    `left:${r.left - 4}px`,
    `width:${r.width + 8}px`,
    `height:${r.height + 8}px`,
    'border:2px solid #ff3a00',
    'border-radius:8px',
    'pointer-events:none',
    'z-index:9998',
    'box-shadow:0 0 0 4px rgba(255,58,0,.18)',
    'transition:all .2s ease',
  ].join(';');
  document.body.appendChild(highlightEl);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Keyboard support.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (!activeTour) return;
    if (e.key === 'Escape') { stop(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
  });
}

// Auto-start via ?tour=<name> query param.
function autoStart() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const name = params.get('tour');
  if (name && TOURS[name]) {
    setTimeout(() => start(name), 500);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  } else {
    autoStart();
  }
}

/** Returns the list of available tour names. */
function list() { return Object.keys(TOURS); }

export const tour = { start, stop, next, prev, list };
export default tour;
