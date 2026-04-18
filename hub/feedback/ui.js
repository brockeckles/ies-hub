/**
 * IES Hub v3 — Feedback System UI
 * User feedback board with voting, filtering, and detail view.
 *
 * @module hub/feedback/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-s1';
import * as calc from './calc.js?v=20260418-s1';

/** @type {HTMLElement|null} */
let rootEl = null;
let activeView = 'board'; // board | detail
let activeItem = null;
let typeFilter = 'all';
let statusFilter = 'all';
let sortBy = 'upvotes';
let items = calc.DEMO_FEEDBACK.map(i => ({ ...i }));

export async function mount(el) {
  rootEl = el;
  activeView = 'board';
  activeItem = null;
  typeFilter = 'all';
  statusFilter = 'all';
  sortBy = 'upvotes';
  render();
  bindDelegatedEvents();
  bus.emit('feedback:mounted');
}

function bindDelegatedEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    const typeBtn = target.closest('[data-type-filter]');
    if (typeBtn) { typeFilter = /** @type {HTMLElement} */ (typeBtn).dataset.typeFilter; const el = rootEl.querySelector('#fb-content'); if (el) renderBoard(el); return; }

    const statusBtn = target.closest('[data-status-filter]');
    if (statusBtn) { statusFilter = /** @type {HTMLElement} */ (statusBtn).dataset.statusFilter; const el = rootEl.querySelector('#fb-content'); if (el) renderBoard(el); return; }

    const itemCard = target.closest('[data-item]');
    if (itemCard) { activeItem = items.find(i => i.id === /** @type {HTMLElement} */ (itemCard).dataset.item); activeView = 'detail'; render(); return; }

    if (target.closest('#fb-back')) { activeView = 'board'; activeItem = null; render(); return; }
  });

  rootEl.addEventListener('change', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('#fb-sort')) { sortBy = /** @type {HTMLSelectElement} */ (target).value; const el = rootEl.querySelector('#fb-content'); if (el) renderBoard(el); }
  });
}

export function unmount() { rootEl = null; bus.emit('feedback:unmounted'); }

function render() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 class="text-page" style="margin:0;">Feedback Board</h2>
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
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
      ${kpi('Total', stats.totalItems, '#2563eb')}
      ${kpi('Open', stats.openItems, '#d97706')}
      ${kpi('Completed', stats.completedItems, '#16a34a')}
      ${kpi('Resolution Rate', rate + '%', rate >= 50 ? '#16a34a' : '#d97706')}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:700;color:var(--ies-gray-400);">Type:</span>
      ${['all', 'bug', 'feature', 'improvement', 'question'].map(t => `
        <button class="hub-btn hub-btn-sm ${t === typeFilter ? '' : 'hub-btn-secondary'}" data-type-filter="${t}">${t === 'all' ? 'All' : calc.typeIcon(t) + ' ' + t}</button>
      `).join('')}
      <span style="margin-left:12px;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Status:</span>
      ${['all', 'open', 'in-progress', 'completed'].map(s => `
        <button class="hub-btn hub-btn-sm ${s === statusFilter ? '' : 'hub-btn-secondary'}" data-status-filter="${s}">${s === 'all' ? 'All' : s}</button>
      `).join('')}
      <span style="margin-left:auto;font-size:11px;color:var(--ies-gray-400);">Sort by:</span>
      <select id="fb-sort" style="font-size:12px;padding:4px 8px;border:1px solid var(--ies-gray-200);border-radius:4px;">
        <option value="upvotes" ${sortBy === 'upvotes' ? 'selected' : ''}>Most Voted</option>
        <option value="date" ${sortBy === 'date' ? 'selected' : ''}>Newest</option>
        <option value="priority" ${sortBy === 'priority' ? 'selected' : ''}>Priority</option>
      </select>
    </div>
    ${sorted.length === 0 ? '<div class="hub-card"><p class="text-body text-muted">No feedback items found.</p></div>' :
      sorted.map(item => `
        <div class="hub-card" style="margin-bottom:10px;padding:14px;cursor:pointer;" data-item="${item.id}">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="display:flex;flex-direction:column;align-items:center;min-width:40px;">
              <span style="font-size:16px;font-weight:800;color:${item.upvotes >= 8 ? '#2563eb' : 'var(--ies-gray-400)'};">${item.upvotes}</span>
              <span style="font-size:9px;color:var(--ies-gray-400);">votes</span>
            </div>
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span style="font-size:14px;">${calc.typeIcon(item.type)}</span>
                <span style="font-size:14px;font-weight:700;">${item.title}</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;color:#fff;background:${calc.typeBadgeColor(item.type)};">${item.type}</span>
                <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;color:#fff;background:${calc.statusBadgeColor(item.status)};">${item.status}</span>
                ${item.tool ? `<span style="font-size:11px;color:var(--ies-gray-400);">${item.tool}</span>` : ''}
                <span style="font-size:11px;color:var(--ies-gray-300);margin-left:auto;">${calc.formatDate(item.submittedDate)} • ${item.comments.length} comment${item.comments.length !== 1 ? 's' : ''}</span>
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
        <span style="font-size:18px;">${calc.typeIcon(item.type)}</span>
        <h3 style="font-size:18px;font-weight:800;margin:0;flex:1;">${item.title}</h3>
        <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${calc.statusBadgeColor(item.status)};">${item.status}</span>
      </div>
      <div style="font-size:13px;color:var(--ies-gray-500);line-height:1.6;margin-bottom:16px;">${item.description}</div>
      <div style="display:flex;gap:16px;font-size:12px;color:var(--ies-gray-400);margin-bottom:12px;">
        <span>By: ${item.submittedBy}</span>
        <span>${calc.formatDate(item.submittedDate)}</span>
        <span>Tool: ${item.tool || 'General'}</span>
        <span style="font-weight:700;color:${calc.priorityBadgeColor(item.priority)};">${item.priority} priority</span>
        <span style="margin-left:auto;font-weight:700;color:#2563eb;">▲ ${item.upvotes} votes</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${(item.tags || []).map(t => `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#f3f4f6;color:#6b7280;">${t}</span>`).join('')}
      </div>
    </div>
    <div class="hub-card" style="padding:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Comments (${item.comments.length})</div>
      ${item.comments.length === 0 ? '<div style="font-size:12px;color:var(--ies-gray-400);">No comments yet.</div>' :
        item.comments.map(c => `
          <div style="padding:10px 0;border-bottom:1px solid var(--ies-gray-100);">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:700;">${c.author}</span>
              <span style="font-size:11px;color:var(--ies-gray-400);">${new Date(c.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </div>
            <div style="font-size:13px;color:var(--ies-gray-500);">${c.content}</div>
          </div>
        `).join('')}
    </div>
  `;

  // Back button handled by delegated events at root level
}

function kpi(label, value, color) {
  return `
    <div class="hub-card" style="padding:12px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${label}</div>
    </div>
  `;
}
