/**
 * IES Hub v3 — Feedback System UI
 * User feedback board with filtering, voting and detail view.
 *
 * Voting (2026-07-23): one toggleable upvote per user per item, backed by
 * the feedback_votes table (migration 20260723150000). The pill flips
 * optimistically and is updated surgically (no board re-render); a failed
 * write reverts the flip with a toast.
 *
 * @module hub/feedback/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import * as calc from './calc.js?v=20260722-s4e';
import * as api from './api.js?v=20260723-s5d';
import { showToast } from '../../shared/toast.js?v=20260705-u1a';
import { escapeHtml as _h, escapeAttr as _a } from '../../shared/escape.js?v=20260702-sec2';
import { icon } from '../../shared/icons.js?v=20260710-r2';

/** U4b: emoji-as-iconography -> shared icons (ui-layer map; calc.typeIcon untouched — engines frozen). */
function _typeIcon(type, size = 14) {
  const names = { bug: 'bug', feature: 'sparkle', improvement: 'wrench', question: 'info' };
  return icon(names[type] || 'doc', { size });
}

/** @type {HTMLElement|null} */
let rootEl = null;
let activeView = 'board'; // board | detail
let activeItem = null;
let typeFilter = 'all';
let statusFilter = 'all';
let sortBy = 'date';
let items = [];

export async function mount(el) {
  rootEl = el;
  activeView = 'board';
  activeItem = null;
  typeFilter = 'all';
  statusFilter = 'all';
  sortBy = 'date';
  // Render shell first (with a loading state) so the user sees something.
  render();
  bindDelegatedEvents();
  // Load live rows from hub_feedback (RLS: authenticated SELECT).
  try {
    items = await api.listFeedback();
  } catch (err) {
    console.error('[feedback] listFeedback failed:', err);
    showToast('Could not load feedback list. Showing empty board.', 'warning');
    items = [];
  }
  render();
}

function bindDelegatedEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    const typeBtn = target.closest('[data-type-filter]');
    if (typeBtn) { typeFilter = /** @type {HTMLElement} */ (typeBtn).dataset.typeFilter; const el = rootEl.querySelector('#fb-content'); if (el) renderBoard(el); return; }

    const statusBtn = target.closest('[data-status-filter]');
    if (statusBtn) { statusFilter = /** @type {HTMLElement} */ (statusBtn).dataset.statusFilter; const el = rootEl.querySelector('#fb-content'); if (el) renderBoard(el); return; }

    // Vote pill — MUST be checked before the [data-item] card branch: the
    // pill carries data-item too, and a vote click must not open the detail.
    const voteBtn = target.closest('[data-action="toggle-vote"]');
    if (voteBtn) { handleToggleVote(/** @type {HTMLElement} */ (voteBtn).dataset.item); return; }

    const itemCard = target.closest('[data-item]');
    if (itemCard) { activeItem = items.find(i => i.id === /** @type {HTMLElement} */ (itemCard).dataset.item); activeView = 'detail'; render(); return; }

    if (target.closest('#fb-back')) { activeView = 'board'; activeItem = null; render(); return; }
  });

  rootEl.addEventListener('change', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('#fb-sort')) { sortBy = /** @type {HTMLSelectElement} */ (target).value; const el = rootEl.querySelector('#fb-content'); if (el) renderBoard(el); }
  });
}

export function unmount() { rootEl = null;  }

// ============================================================
// VOTING — optimistic toggle + surgical pill refresh
// ============================================================

/** Render the vote pill for an item (board card meta row + detail header). */
function votePill(item) {
  const voted = !!item.hasMyVote;
  const count = item.upvotes ?? 0;
  const border = voted ? 'var(--ies-blue)' : 'var(--ies-gray-200)';
  const bg = voted ? 'var(--ies-blue)' : 'transparent';
  const fg = voted ? '#fff' : 'var(--ies-gray-400)';
  return `<button type="button" data-action="toggle-vote" data-item="${_a(item.id)}" aria-pressed="${voted ? 'true' : 'false'}" title="${voted ? 'Remove your vote' : 'Upvote this feedback'}" style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;border:1px solid ${border};background:${bg};color:${fg};">▲ ${count}</button>`;
}

/**
 * Surgical refresh of every rendered pill for one item (board + detail can
 * both be showing it) — outerHTML swap keeps the root-level delegation
 * working and avoids a full board re-render (scroll/filter state survives).
 * @param {string} id
 */
function updateVotePill(id) {
  if (!rootEl) return;
  const item = items.find(i => i.id === id);
  if (!item) return;
  const sel = `[data-action="toggle-vote"][data-item="${CSS.escape(id)}"]`;
  rootEl.querySelectorAll(sel).forEach(el => { el.outerHTML = votePill(item); });
}

/**
 * Optimistic toggle: flip the pill immediately, then persist via
 * api.toggleVote; revert the flip with a toast if the write fails
 * (signed-out gets the specific 'Sign in to vote.' message).
 * @param {string} id
 */
async function handleToggleVote(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const wasVoted = !!item.hasMyVote;
  const prevCount = item.upvotes ?? 0;
  item.hasMyVote = !wasVoted;
  item.upvotes = Math.max(0, prevCount + (wasVoted ? -1 : 1));
  updateVotePill(id);
  const res = await api.toggleVote(id);
  if (!res.ok) {
    // Revert the optimistic flip.
    item.hasMyVote = wasVoted;
    item.upvotes = prevCount;
    updateVotePill(id);
    if (res.error === 'not_signed_in') showToast('Sign in to vote.', 'warning');
    else showToast('Could not save your vote. Try again.', 'error');
  }
}

function render() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 class="text-page">Feedback Board</h2>
      </div>
      <div id="fb-content"></div>
    </div>
  `;
  const el = rootEl.querySelector('#fb-content');
  if (!el) return;
  if (activeView === 'detail' && activeItem) renderDetail(el);
  else renderBoard(el);
}

function renderBoard(el) {
  const stats = calc.computeStats(items);
  const rate = calc.resolutionRate(items);
  let filtered = calc.filterByType(items, typeFilter);
  filtered = calc.filterByStatus(filtered, statusFilter);
  const sorted = calc.sortFeedback(filtered, sortBy, 'desc');

  el.innerHTML = `
    <div class="hub-kpi-strip" style="margin-bottom:20px;">
      ${kpi('Total', stats.totalItems)}
      ${kpi('Open', stats.openItems, stats.openItems > 0 ? 'var(--ies-orange)' : null)}
      ${kpi('Completed', stats.completedItems, 'var(--ies-green)')}
      ${kpi('Resolution Rate', rate + '%', rate < 50 ? 'var(--ies-orange)' : 'var(--ies-green)')}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:700;color:var(--ies-gray-400);">Type:</span>
      ${['all', 'bug', 'feature', 'improvement', 'question'].map(t => `
        <button class="hub-btn hub-btn-sm ${t === typeFilter ? '' : 'hub-btn-secondary'}" data-type-filter="${t}">${t === 'all' ? 'All' : _typeIcon(t) + ' ' + t}</button>
      `).join('')}
      <span style="margin-left:12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Status:</span>
      ${['all', 'open', 'in-review', 'in-progress', 'completed', 'declined'].map(s => `
        <button class="hub-btn hub-btn-sm ${s === statusFilter ? '' : 'hub-btn-secondary'}" data-status-filter="${s}">${s === 'all' ? 'All' : s}</button>
      `).join('')}
      <span style="margin-left:auto;font-size:11px;color:var(--ies-gray-400);">Sort by:</span>
      <select id="fb-sort" class="hub-select" style="width:auto;height:auto;padding:4px 26px 4px 10px;font-size:12px;">
        <option value="date" ${sortBy === 'date' ? 'selected' : ''}>Newest</option>
        <option value="upvotes" ${sortBy === 'upvotes' ? 'selected' : ''}>Votes</option>
        <option value="priority" ${sortBy === 'priority' ? 'selected' : ''}>Priority</option>
      </select>
    </div>
    ${sorted.length === 0 ? '<div class="hub-card"><p class="text-body text-muted">No feedback items found.</p></div>' :
      sorted.map(item => `
        <div class="hub-card" style="margin-bottom:10px;padding:14px;cursor:pointer;" data-item="${_a(item.id)}">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span style="display:inline-flex;">${_typeIcon(item.type)}</span>
                <span style="font-size:14px;font-weight:700;">${_h(item.title)}</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;color:#fff;background:${calc.typeBadgeColor(item.type)};">${_h(item.type)}</span>
                <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;color:#fff;background:${calc.statusBadgeColor(item.status)};">${_h(item.status)}</span>
                ${item.tool ? `<span class="u-cap u-faint">${_h(item.tool)}</span>` : ''}
                <span style="font-size:11px;color:var(--ies-gray-300);margin-left:auto;">${calc.formatDate(item.submittedDate)} • ${item.comments.length} comment${item.comments.length !== 1 ? 's' : ''}</span>
                ${votePill(item)}
              </div>
            </div>
          </div>
        </div>
      `).join('')}
  `;

  // All event handlers are managed via delegated events at root level
}

function renderDetail(el) {
  const item = activeItem;
  if (!item) return;

  el.innerHTML = `
    <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fb-back" style="margin-bottom:16px;">← Back to Board</button>
    <div class="hub-card" style="padding:20px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="display:inline-flex;">${_typeIcon(item.type, 18)}</span>
        <h3 style="font-size:18px;font-weight:800;margin:0;flex:1;">${_h(item.title)}</h3>
        ${votePill(item)}
        <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${calc.statusBadgeColor(item.status)};">${_h(item.status)}</span>
      </div>
      <div style="font-size:13px;color:var(--ies-gray-500);line-height:1.6;margin-bottom:16px;">${_h(item.description)}</div>
      <div style="display:flex;gap:16px;font-size:12px;color:var(--ies-gray-400);margin-bottom:12px;">
        <span>By: ${_h(item.submittedBy)}</span>
        <span>${calc.formatDate(item.submittedDate)}</span>
        <span>Tool: ${_h(item.tool || 'General')}</span>
        <span style="font-weight:700;color:${calc.priorityBadgeColor(item.priority)};">${_h(item.priority)} priority</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${(item.tags || []).map(t => `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#f3f4f6;color:var(--c-muted);">${_h(t)}</span>`).join('')}
      </div>
    </div>
    <div class="hub-card u-p-4">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Comments (${item.comments.length})</div>
      ${item.comments.length === 0 ? '<div style="font-size:12px;color:var(--ies-gray-400);">No comments yet.</div>' :
        item.comments.map(c => `
          <div style="padding:10px 0;border-bottom:1px solid var(--ies-gray-100);">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:700;">${_h(c.author)}</span>
              <span class="u-cap u-faint">${new Date(c.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </div>
            <div style="font-size:13px;color:var(--ies-gray-500);">${_h(c.content)}</div>
          </div>
        `).join('')}
    </div>
  `;

  // Back button handled by delegated events at root level
}

function kpi(label, value, color) {
  // 2026-04-29 polish — emit hub-kpi-tile so the strip aligns with the rest
  // of the hub. Optional color is preserved for threshold semantics.
  const valueStyle = color ? ` style="color:${color};"` : '';
  return `
    <div class="hub-kpi-tile">
      <div class="hub-kpi-tile__label">${label}</div>
      <div class="hub-kpi-tile__value"${valueStyle}>${value}</div>
    </div>
  `;
}
