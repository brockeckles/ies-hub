/**
 * IES Hub v3 — Tour Engine
 *
 * Non-blocking guided tours. Highlights target elements with a tooltip/
 * popover; the rest of the page stays fully interactive (no modal overlay).
 *
 * Usage:
 *   import { tour } from './shared/tour.js?v=20260722-s4e';
 *   tour.start('welcome');    // start a named tour (unknown names → 'welcome')
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

import { bus } from './event-bus.js?v=20260418-sK';

// ---------------------------------------------------------------------------
// Tour definitions — C3 rewrite (2026-07-22): ONE honest orientation tour
// that narrates the current hub (rail nav, Command Center pipeline card,
// Deal Management deals→sites→scenarios with ★/Σ★, Design Tools scenario
// landings, deal-context launching). The old per-section tours described
// pre-revamp screens (kanban classes, cm-nav, NetOpt, wiki search) that no
// longer exist. Any unknown tour name — the header button still passes
// section names like 'cost-model' or 'netopt' — falls back to 'welcome'.
// ---------------------------------------------------------------------------

/** @typedef {{ selector?: string, route?: string, title: string, body: string, placement?: 'top'|'bottom'|'left'|'right' }} TourStep */

/** @type {Record<string, TourStep[]>} */
const TOURS = {
  welcome: [
    { route: 'overview', title: 'Welcome to the IES Hub',
      body: 'A 90-second orientation — the rail, the deal pipeline, and the design tools. Press → or click Next; Esc exits anytime.' },
    { selector: '.hub-sidebar-nav', placement: 'right', title: 'Navigation rail',
      body: 'Everything lives here. Intelligence: Command Center and Market Explorer. Work: Deal Management and Design Tools — Cost Model Builder, Warehouse Sizing, MOST Labor Standards, Center of Gravity, Fleet Modeler. Plus Ideas & Feedback.' },
    { selector: '.hub-search-input', placement: 'right', title: 'Quick nav (Ctrl + K)',
      body: 'Jump to any page or tool by name — press Ctrl+K from anywhere and type "cost model", "deals", or "fleet".' },
    { route: 'overview', selector: 'a.hub-card[href="#deals"]', placement: 'left', title: 'Pipeline Snapshot',
      body: 'Active deals, pipeline $, Sites, and grade mix at a glance. "★ n/m covered" counts deals with a starred scenario on every active site. An amber est badge means the total includes estimated Σ★ roll-ups.' },
    { route: 'deals', selector: '#dm-content', placement: 'top', title: 'Deal Management',
      body: 'Deals move through the six DOS stages — switch between Pipeline, List, Customers, and My Hours views. Each Deal holds Sites; each Site holds design Scenarios. Click any deal card to open it.' },
    { title: 'Starred designs (★ and Σ★)',
      body: 'Inside a deal, star the Cost Model scenario that is in the bid for each Site. Deal revenue is the Σ★ roll-up across starred sites — badged est while coverage is partial or a ★ scenario is heuristic-priced.' },
    { route: 'designtools', selector: '.hub-dt-categories', placement: 'top', title: 'Design Tools',
      body: 'Five production tools: Cost Model Builder (Solutions); Warehouse Sizing and MOST Labor Standards (Engineering); Center of Gravity and Fleet Modeler (Logistics). Every scenario saves to Supabase.' },
    { selector: '.hub-dt-card', placement: 'bottom', title: 'Scenario-first tools',
      body: 'Each tool opens on its scenario landing — your saved Scenarios with linkage chips (stand-alone vs linked to a Cost Model or Deal) and a + New Scenario button. No cold-start blank forms.' },
    { title: 'Work in deal context',
      body: 'Launch a tool from a Deal ("Start cost model") and new scenarios stamp to that deal — the landing shows a "Working in deal" chip and floats that deal\'s scenarios to the top. Re-run this tour anytime from the compass button in the header.' },
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
  // C3 (2026-07-22): the header tour button still passes legacy section
  // names ('cost-model', 'netopt', ...). Unknown names fall back to the
  // single 'welcome' orientation tour instead of silently doing nothing.
  let steps = TOURS[name];
  if (!steps || !steps.length) {
    console.info(`[tour] no tour named "${name}" — starting 'welcome'`);
    name = 'welcome';
    steps = TOURS[name];
  }
  if (!steps || !steps.length) return;
  activeTour = { name, steps, idx: 0 };
  advance(0);
}

function stop() {
  if (popover) { popover.remove(); popover = null; }
  if (activeTour) {
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

// Monotonic token so an in-flight advance() (route settle / selector poll)
// aborts cleanly when the user advances again or stops the tour.
let advanceSeq = 0;

async function advance(targetIdx) {
  if (!activeTour) return;
  if (targetIdx < 0) targetIdx = 0;
  if (targetIdx >= activeTour.steps.length) { stop(); return; }

  activeTour.idx = targetIdx;
  const step = activeTour.steps[targetIdx];
  const seq = ++advanceSeq;
  const stale = () => !activeTour || activeTour.idx !== targetIdx || seq !== advanceSeq;

  // If step has a route, navigate first and wait a tick for DOM.
  if (step.route && typeof window !== 'undefined') {
    const currentHash = window.location.hash.slice(1);
    if (currentHash !== step.route) {
      window.location.hash = step.route;
      await new Promise(r => setTimeout(r, 350));
      if (stale()) return;
    }
  }

  // Views mount async (router lazy-loads + fetches) — poll briefly for the
  // target instead of giving up on the first miss. Falls back to a centered
  // popover if the selector never appears (C3, 2026-07-22).
  let target = step.selector ? document.querySelector(step.selector) : null;
  if (step.selector && !target) {
    const deadline = Date.now() + 2500;
    while (!target && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      if (stale()) return;
      target = document.querySelector(step.selector);
    }
  }
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
    'font-family:var(--font-ui)',
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
        style="background:var(--ies-orange);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:700;">
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
    'border:2px solid var(--ies-orange)',
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
