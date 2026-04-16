/**
 * IES Hub v3 — Deal Management UI
 * Pipeline view showing all deals across DOS stages with quick-access cards.
 * Links to the Design Tools > Multi-Site Analyzer for deep-dive.
 *
 * @module hub/deal-management/ui
 */

import { bus } from '../../shared/event-bus.js';

/** @type {HTMLElement|null} */
let rootEl = null;
let viewMode = 'pipeline'; // pipeline | list

/** DOS stage definitions */
const DOS_STAGES = [
  { id: 1, name: 'Qualification', color: '#6b7280' },
  { id: 2, name: 'Discovery', color: '#2563eb' },
  { id: 3, name: 'Solution Design', color: '#7c3aed' },
  { id: 4, name: 'Proposal', color: '#d97706' },
  { id: 5, name: 'Negotiation', color: '#ea580c' },
  { id: 6, name: 'Implementation', color: '#16a34a' },
];

/** Demo deals */
const DEALS = [
  { id: 'd1', name: 'Wayfair Midwest Expansion', client: 'Wayfair', stage: 4, sites: 3, revenue: 18500000, margin: 11.2, owner: 'Brock Eckles', daysInStage: 8, score: 'A' },
  { id: 'd2', name: 'Amazon Last Mile Southeast', client: 'Amazon', stage: 3, sites: 5, revenue: 42000000, margin: 9.8, owner: 'Design Engineer 1', daysInStage: 14, score: 'B+' },
  { id: 'd3', name: 'Target Returns Processing', client: 'Target', stage: 2, sites: 2, revenue: 8200000, margin: 13.5, owner: 'Design Engineer 2', daysInStage: 5, score: 'A-' },
  { id: 'd4', name: 'Home Depot Regional DC', client: 'Home Depot', stage: 5, sites: 1, revenue: 12000000, margin: 10.1, owner: 'Brock Eckles', daysInStage: 21, score: 'B' },
  { id: 'd5', name: 'Costco Cold Chain West', client: 'Costco', stage: 1, sites: 2, revenue: 15000000, margin: 0, owner: 'Design Engineer 1', daysInStage: 3, score: '—' },
  { id: 'd6', name: 'Nike DTC Fulfillment', client: 'Nike', stage: 3, sites: 4, revenue: 28000000, margin: 10.5, owner: 'Brock Eckles', daysInStage: 10, score: 'A-' },
  { id: 'd7', name: 'Kroger Fresh Network', client: 'Kroger', stage: 6, sites: 3, revenue: 22000000, margin: 12.0, owner: 'Design Engineer 2', daysInStage: 30, score: 'A' },
  { id: 'd8', name: 'PepsiCo Secondary Dist', client: 'PepsiCo', stage: 2, sites: 1, revenue: 6500000, margin: 0, owner: 'Design Engineer 1', daysInStage: 7, score: '—' },
  { id: 'd9', name: 'Walmart E-Commerce Hub', client: 'Walmart', stage: 4, sites: 2, revenue: 31000000, margin: 9.2, owner: 'Brock Eckles', daysInStage: 12, score: 'B+' },
  { id: 'd10', name: 'IKEA Assembly & Delivery', client: 'IKEA', stage: 1, sites: 1, revenue: 9000000, margin: 0, owner: 'Design Engineer 2', daysInStage: 1, score: '—' },
];

export function mount(el) {
  rootEl = el;
  viewMode = 'pipeline';
  render();
  bus.emit('deal-management:mounted');
}

export function unmount() { rootEl = null; bus.emit('deal-management:unmounted'); }

function render() {
  if (!rootEl) return;

  const totalRevenue = DEALS.reduce((s, d) => s + d.revenue, 0);
  const avgMargin = DEALS.filter(d => d.margin > 0).reduce((s, d) => s + d.margin, 0) / DEALS.filter(d => d.margin > 0).length;
  const totalSites = DEALS.reduce((s, d) => s + d.sites, 0);

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 class="text-page" style="margin:0;">Deal Management</h2>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm ${viewMode === 'pipeline' ? '' : 'hub-btn-secondary'}" data-view="pipeline">Pipeline</button>
          <button class="hub-btn hub-btn-sm ${viewMode === 'list' ? '' : 'hub-btn-secondary'}" data-view="list">List</button>
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

  rootEl.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => { viewMode = /** @type {HTMLElement} */ (btn).dataset.view; render(); });
  });

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
            ${stageDeals.map(deal => `
              <div class="hub-card" style="padding:10px;margin-bottom:8px;cursor:pointer;border-left:3px solid ${stage.color};" data-deal="${deal.id}">
                <div style="font-size:12px;font-weight:700;margin-bottom:4px;">${deal.name}</div>
                <div style="font-size:11px;color:var(--ies-gray-400);margin-bottom:4px;">${deal.client} — ${deal.sites} site${deal.sites > 1 ? 's' : ''}</div>
                <div style="display:flex;justify-content:space-between;font-size:10px;">
                  <span style="color:var(--ies-gray-400);">$${(deal.revenue / 1e6).toFixed(1)}M</span>
                  ${deal.margin > 0 ? `<span style="font-weight:700;color:${deal.margin >= 10 ? '#16a34a' : '#d97706'};">${deal.margin}%</span>` : ''}
                  ${deal.score !== '—' ? `<span style="font-weight:800;color:${deal.score.startsWith('A') ? '#16a34a' : '#2563eb'};">${deal.score}</span>` : ''}
                </div>
                <div style="font-size:9px;color:var(--ies-gray-300);margin-top:4px;">${deal.daysInStage}d in stage — ${deal.owner.split(' ')[0]}</div>
              </div>
            `).join('') || '<div style="font-size:11px;color:var(--ies-gray-300);padding:8px;">No deals</div>'}
          </div>
        `;
      }).join('')}
    </div>
  `;

  el.querySelectorAll('[data-deal]').forEach(card => {
    card.addEventListener('click', () => {
      window.location.hash = 'designtools/deal-manager';
    });
  });
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
            return `
              <tr style="border-bottom:1px solid var(--ies-gray-100);cursor:pointer;" data-deal="${d.id}" onmouseover="this.style.background='var(--ies-gray-50)'" onmouseout="this.style.background='transparent'">
                <td style="padding:10px 12px;font-weight:600;">${d.name}</td>
                <td style="padding:10px 12px;color:var(--ies-gray-500);">${d.client}</td>
                <td style="padding:10px 12px;text-align:center;">
                  <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${stage.color};">${stage.name}</span>
                </td>
                <td style="padding:10px 12px;text-align:center;">${d.sites}</td>
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

  el.querySelectorAll('[data-deal]').forEach(row => {
    row.addEventListener('click', () => {
      window.location.hash = 'designtools/deal-manager';
    });
  });
}

function kpi(label, value, color) {
  return `
    <div class="hub-card" style="padding:12px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${label}</div>
    </div>
  `;
}
