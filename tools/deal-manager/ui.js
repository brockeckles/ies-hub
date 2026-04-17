/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) UI
 * Analyzer-pattern layout: landing view (Kanban/List), then per-deal detail views.
 * Tabs: Summary, Sites, Financials, Pipeline, Hours, Tasks, Updates.
 *
 * @module tools/deal-manager/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260417-mB';
import { state } from '../../shared/state.js?v=20260417-mB';
import * as calc from './calc.js?v=20260417-mB';
import * as api from './api.js?v=20260417-mB';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'list' | 'kanban' | 'summary' | 'sites' | 'financials' | 'pipeline' | 'hours' | 'tasks' | 'updates'} */
let activeTab = 'list';

/** @type {'kanban' | 'table'} */
let landingViewMode = 'kanban';

/** @type {import('./types.js?v=20260417-mB').Deal|null} */
let activeDeal = null;

/** @type {import('./types.js?v=20260417-mB').Site[]} */
let sites = [];

/** @type {import('./types.js?v=20260417-mB').DealFinancials|null} */
let financials = null;

/** @type {import('./types.js?v=20260417-mB').DosStage[]} */
let dosStages = [];

/** @type {import('./types.js?v=20260417-mB').Deal[]} */
let allDeals = [];

/** @type {import('./types.js?v=20260417-mB').HoursEntry[]} */
let hoursEntries = [];

/** @type {import('./types.js?v=20260417-mB').Task[]} */
let tasks = [];

/** @type {import('./types.js?v=20260417-mB').WeeklyUpdate[]} */
let updates = [];

// DOS stages reference (6 stages: Pre-Sales → Delivery)
const DOS_STAGE_LABELS = [
  { number: 1, name: 'Pre-Sales Engagement' },
  { number: 2, name: 'Deal Qualification' },
  { number: 3, name: 'Kick-Off & Solution Design' },
  { number: 4, name: 'Operations Review' },
  { number: 5, name: 'Executive Review' },
  { number: 6, name: 'Delivery Handover' },
];

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Deal Manager.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeTab = 'list';
  activeDeal = null;
  sites = [];
  financials = null;
  dosStages = [];
  allDeals = [];

  // Use demo data
  allDeals = [{ ...calc.DEMO_DEAL, id: 'demo-deal-1' }];
  el.innerHTML = renderShell();
  bindShellEvents();
  renderContent();

  bus.emit('deal:mounted');
}

/**
 * Cleanup.
 */
export function unmount() {
  rootEl = null;
  bus.emit('deal:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:16px;padding:16px 24px 0 24px;flex-shrink:0;">
        <h2 class="text-page" style="margin:0;">Multi-Site Analyzer</h2>
        <div style="display:flex;gap:8px;margin-left:auto;" id="dm-tabs"></div>
      </div>
      <div id="dm-content" style="flex:1;overflow-y:auto;padding:24px;"></div>
    </div>
  `;
}

function renderTabs() {
  const tabBar = rootEl?.querySelector('#dm-tabs');
  if (!tabBar) return;

  if (activeTab === 'list' || activeTab === 'kanban') {
    tabBar.innerHTML = `
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-toggle-view" style="margin-right:8px;">📋 List View</button>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-new-deal">+ New Deal</button>
    `;
    tabBar.querySelector('#dm-toggle-view')?.addEventListener('click', () => {
      landingViewMode = landingViewMode === 'kanban' ? 'table' : 'kanban';
      activeTab = /** @type {any} */ (landingViewMode === 'kanban' ? 'kanban' : 'list');
      renderTabs();
      renderContent();
    });
    tabBar.querySelector('#dm-new-deal')?.addEventListener('click', () => createNewDeal());
    return;
  }

  const tabs = [
    { key: 'summary', label: 'Summary' },
    { key: 'sites', label: 'Sites' },
    { key: 'financials', label: 'Financials' },
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'hours', label: 'Hours' },
    { key: 'tasks', label: 'Tasks' },
    { key: 'updates', label: 'Updates' },
  ];

  tabBar.innerHTML = `
    <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-back" style="margin-right:8px;">← All Deals</button>
    ${tabs.map(t => `
      <button class="hub-btn hub-btn-sm ${t.key === activeTab ? 'hub-btn-primary' : 'hub-btn-secondary'}"
              data-tab="${t.key}">${t.label}</button>
    `).join('')}
  `;

  tabBar.querySelector('#dm-back')?.addEventListener('click', () => {
    activeTab = landingViewMode === 'kanban' ? 'kanban' : 'list';
    activeDeal = null;
    renderTabs();
    renderContent();
  });

  tabBar.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = /** @type {any} */ (/** @type {HTMLElement} */ (btn).dataset.tab);
      tabBar.querySelectorAll('[data-tab]').forEach(b => {
        b.className = `hub-btn hub-btn-sm ${b.dataset.tab === activeTab ? 'hub-btn-primary' : 'hub-btn-secondary'}`;
      });
      renderContent();
    });
  });
}

function bindShellEvents() {
  renderTabs();
}

function renderContent() {
  const el = rootEl?.querySelector('#dm-content');
  if (!el) return;

  switch (activeTab) {
    case 'kanban': renderKanban(el); break;
    case 'list': renderDealList(el); break;
    case 'summary': renderSummary(el); break;
    case 'sites': renderSites(el); break;
    case 'financials': renderFinancials(el); break;
    case 'pipeline': renderPipeline(el); break;
    case 'hours': renderHours(el); break;
    case 'tasks': renderTasksTab(el); break;
    case 'updates': renderUpdatesTab(el); break;
  }
}

// ============================================================
// KANBAN VIEW (LANDING)
// ============================================================

function renderKanban(el) {
  const stages = [
    { number: 1, name: 'Pre-Sales Engagement' },
    { number: 2, name: 'Deal Qualification' },
    { number: 3, name: 'Kick-Off & Solution Design' },
    { number: 4, name: 'Operations Review' },
    { number: 5, name: 'Executive Review' },
    { number: 6, name: 'Delivery Handover' },
  ];

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;overflow-x:auto;padding:4px;">
      ${stages.map(stage => {
        const dealsInStage = allDeals.filter(d => {
          // Map deal status to DOS stage for display purposes
          const stageMap = { draft: 1, in_progress: 3, proposal_sent: 5, won: 6, lost: 0 };
          return stageMap[d.status] === stage.number;
        });

        return `
          <div style="flex:0 0 280px;display:flex;flex-direction:column;background:var(--ies-gray-50);border-radius:8px;padding:12px;border:1px solid var(--ies-gray-200);">
            <div style="font-size:13px;font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--ies-gray-200);display:flex;justify-content:space-between;align-items:center;">
              <span>${stage.name}</span>
              <span style="font-size:11px;font-weight:700;background:var(--ies-blue);color:#fff;padding:2px 8px;border-radius:12px;">${dealsInStage.length}</span>
            </div>
            ${dealsInStage.length === 0 ? `
              <div style="text-align:center;padding:20px 0;color:var(--ies-gray-400);font-size:12px;">No deals</div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${dealsInStage.map(d => {
                  const badge = calc.statusBadge(d.status);
                  return `
                    <div class="hub-card" style="cursor:pointer;padding:12px;border:1px solid var(--ies-gray-200);" data-deal-id="${d.id}">
                      <div style="font-size:12px;font-weight:700;margin-bottom:4px;color:var(--ies-navy);">${d.dealName}</div>
                      <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:6px;">${d.clientName}</div>
                      <div style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</div>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>
        `;
      }).join('')}
    </div>
  `;

  el.querySelectorAll('[data-deal-id]').forEach(card => {
    card.addEventListener('click', async () => {
      await openDeal(/** @type {HTMLElement} */ (card).dataset.dealId);
    });
  });
}

// ============================================================
// DEAL LIST (TABLE VIEW — LANDING)
// ============================================================

function renderDealList(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      ${allDeals.length === 0 ? `
        <div class="hub-card" style="text-align:center;padding:40px;">
          <div style="font-size:20px;font-weight:700;margin-bottom:8px;">No Deals Yet</div>
          <p class="text-body text-muted">Create a deal to group multiple site cost models into a unified analysis.</p>
          <button class="hub-btn hub-btn-primary" id="dm-first-deal" style="margin-top:16px;">+ Create First Deal</button>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
          ${allDeals.map(d => {
            const badge = calc.statusBadge(d.status);
            return `
              <div class="hub-card" style="cursor:pointer;" data-deal-id="${d.id}">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                  <span style="font-size:14px;font-weight:700;">${d.dealName}</span>
                  <span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</span>
                </div>
                <div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:8px;">${d.clientName}</div>
                <div style="display:flex;gap:16px;font-size:11px;color:var(--ies-gray-400);">
                  <span>Owner: ${d.dealOwner || '—'}</span>
                  ${d.contractTermYears ? `<span>${d.contractTermYears}yr term</span>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  el.querySelectorAll('[data-deal-id]').forEach(card => {
    card.addEventListener('click', async () => {
      await openDeal(/** @type {HTMLElement} */ (card).dataset.dealId);
    });
  });

  el.querySelector('#dm-first-deal')?.addEventListener('click', () => createNewDeal());
}

function createNewDeal() {
  const id = 'deal-' + Date.now();
  const newDeal = { id, dealName: 'New Deal', clientName: '', dealOwner: '', status: /** @type {const} */ ('draft'), contractTermYears: 5 };
  allDeals.push(newDeal);
  openDeal(id);
}

async function openDeal(id) {
  activeDeal = allDeals.find(d => d.id === id) || null;
  if (!activeDeal) return;

  // Load demo sites for the demo deal
  if (id === 'demo-deal-1') {
    sites = calc.DEMO_SITES.map(s => ({ ...s }));
  } else {
    sites = [];
  }

  financials = calc.computeDealFinancials(sites, activeDeal.contractTermYears || 5);

  // Build demo DOS stages
  dosStages = calc.DOS_STAGES.map(s => ({
    stageNumber: s.number,
    stageName: s.name,
    elements: Array.from({ length: s.elementCount }, (_, i) => ({
      id: `el-${s.number}-${i}`,
      name: `Element ${i + 1}`,
      elementType: 'deliverable',
      workstream: 'solutions',
      status: /** @type {const} */ (i < Math.floor(s.elementCount * 0.6) ? 'complete' : i < Math.floor(s.elementCount * 0.8) ? 'in_progress' : 'not_started'),
    })),
  }));

  // Load hours, tasks, updates
  hoursEntries = await api.fetchHours(activeDeal.id);
  tasks = await api.fetchTasks(activeDeal.id);
  updates = await api.fetchUpdates(activeDeal.id);

  activeTab = 'summary';
  renderTabs();
  renderContent();
}

// ============================================================
// SUMMARY TAB
// ============================================================

function renderSummary(el) {
  if (!activeDeal || !financials) return;

  const badge = calc.statusBadge(activeDeal.status);
  const score = calc.computeDealScore(financials);
  const metrics = calc.evaluateAllMetrics(financials);
  const progress = calc.computeStageProgress(dosStages);
  const overall = calc.computeOverallProgress(progress);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Deal Header -->
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
        <div>
          <div style="font-size:20px;font-weight:800;">${activeDeal.dealName}</div>
          <div style="font-size:13px;color:var(--ies-gray-400);">${activeDeal.clientName} • ${activeDeal.dealOwner || 'Unassigned'}</div>
        </div>
        <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</span>
        <div style="margin-left:auto;text-align:center;">
          <div style="font-size:32px;font-weight:800;color:${scoreColor(score.grade)};">${score.grade}</div>
          <div style="font-size:11px;font-weight:700;color:var(--ies-gray-400);">SCORE ${score.score}</div>
        </div>
      </div>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Sites', String(sites.length))}
          ${kpi('Total SqFt', financials.totalSqft.toLocaleString())}
          ${kpi('Annual Revenue', calc.formatCurrency(financials.totalAnnualRevenue, { compact: true }))}
          ${kpi('Annual Cost', calc.formatCurrency(financials.totalAnnualCost, { compact: true }))}
          ${kpi('Gross Margin', calc.formatPct(financials.grossMarginPct), financials.grossMarginPct >= 12 ? '#22c55e' : financials.grossMarginPct >= 8 ? '#f59e0b' : '#ef4444')}
          ${kpi('NPV', calc.formatCurrency(financials.npv, { compact: true }), financials.npv >= 0 ? '#22c55e' : '#ef4444')}
        </div>
      </div>

      <!-- Metric Cards + Progress -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Financial Health</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            ${metrics.map(m => `
              <div style="padding:10px;border-radius:6px;border:1px solid var(--ies-gray-200);border-left:3px solid ${calc.ratingColor(m.rating)};">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">${m.label}</div>
                <div style="font-size:20px;font-weight:800;color:${calc.ratingColor(m.rating)};">
                  ${m.metric === 'paybackMonths' ? calc.formatMonths(m.value) : m.metric.includes('Pct') || m.metric.includes('pct') ? calc.formatPct(m.value) : calc.formatCurrency(m.value)}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="hub-card" style="padding:16px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:12px;">DOS Progress</div>
          <div style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:13px;font-weight:600;">Overall: ${overall.currentStage}</span>
              <span style="font-size:13px;font-weight:700;">${overall.overallPct.toFixed(0)}%</span>
            </div>
            <div style="height:8px;border-radius:4px;background:var(--ies-gray-200);overflow:hidden;">
              <div style="height:100%;width:${overall.overallPct}%;background:var(--ies-blue);border-radius:4px;"></div>
            </div>
          </div>
          ${progress.map(p => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:11px;font-weight:600;width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.stageName}</span>
              <div style="flex:1;height:6px;border-radius:3px;background:var(--ies-gray-200);overflow:hidden;">
                <div style="height:100%;width:${p.pct}%;background:${p.pct === 100 ? '#22c55e' : p.blocked > 0 ? '#ef4444' : 'var(--ies-blue)'};border-radius:3px;"></div>
              </div>
              <span style="font-size:11px;font-weight:700;width:40px;text-align:right;">${p.completed}/${p.total}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Site Comparison -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Site Comparison</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Site</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">SqFt</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Annual Cost</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Revenue</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Margin</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">$/SqFt</th>
            </tr>
          </thead>
          <tbody>
            ${financials.bySite.map(sf => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:8px 6px;font-weight:600;">${sf.siteName}</td>
                <td style="padding:8px 6px;text-align:right;">${sites.find(s => s.id === sf.siteId)?.sqft.toLocaleString() || '—'}</td>
                <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(sf.annualCost, { compact: true })}</td>
                <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(sf.annualRevenue, { compact: true })}</td>
                <td style="padding:8px 6px;text-align:right;color:${sf.grossMarginPct >= 10 ? '#22c55e' : '#f59e0b'};">${calc.formatPct(sf.grossMarginPct)}</td>
                <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(sf.costPerSqft)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================
// SITES TAB
// ============================================================

function renderSites(el) {
  if (!activeDeal) return;

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Linked Sites</h3>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-add-site">+ Add Site</button>
      </div>

      ${sites.length === 0 ? `
        <div class="hub-card" style="text-align:center;padding:32px;">
          <p class="text-body text-muted">No sites linked to this deal. Add cost model projects as sites.</p>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
          ${sites.map(s => {
            const sf = financials?.bySite.find(b => b.siteId === s.id);
            return `
              <div class="hub-card" style="padding:16px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                  <span style="font-size:14px;font-weight:700;">${s.name}</span>
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-unlink="${s.id}" style="padding:4px 8px;">✕</button>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:10px;">
                  ${s.environment ? `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:#dbeafe;color:#1d4ed8;">${s.environment}</span>` : ''}
                  ${s.market ? `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:#f3f4f6;color:#6b7280;">${s.market}</span>` : ''}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">SqFt</div>
                    <div style="font-weight:600;">${s.sqft.toLocaleString()}</div>
                  </div>
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">Annual Cost</div>
                    <div style="font-weight:600;">${calc.formatCurrency(s.annualCost, { compact: true })}</div>
                  </div>
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">Target Margin</div>
                    <div style="font-weight:600;">${calc.formatPct(s.targetMarginPct)}</div>
                  </div>
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">Pricing</div>
                    <div style="font-weight:600;text-transform:capitalize;">${s.pricingModel || '—'}</div>
                  </div>
                </div>
                ${s.startupCost ? `
                  <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--ies-gray-200);font-size:11px;color:var(--ies-gray-400);">
                    Startup: ${calc.formatCurrency(s.startupCost, { compact: true })}
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  el.querySelectorAll('[data-unlink]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const siteId = /** @type {HTMLElement} */ (btn).dataset.unlink;
      sites = sites.filter(s => s.id !== siteId);
      financials = calc.computeDealFinancials(sites, activeDeal?.contractTermYears || 5);
      renderSites(el);
    });
  });

  el.querySelector('#dm-add-site')?.addEventListener('click', () => {
    const id = 's' + Date.now();
    sites.push({ id, name: 'New Site', sqft: 200000, annualCost: 2000000, targetMarginPct: 10, pricingModel: 'cost-plus' });
    financials = calc.computeDealFinancials(sites, activeDeal?.contractTermYears || 5);
    renderSites(el);
  });
}

// ============================================================
// FINANCIALS TAB
// ============================================================

function renderFinancials(el) {
  if (!financials || !activeDeal) return;

  const plRows = calc.generateMultiYearPL(financials, activeDeal.contractTermYears || 5);
  const score = calc.computeDealScore(financials);
  const metrics = calc.evaluateAllMetrics(financials);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Financial Metrics Dashboard -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        ${metrics.map(m => `
          <div class="hub-card" style="padding:14px;border-left:4px solid ${calc.ratingColor(m.rating)};">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">${m.label}</div>
            <div style="font-size:20px;font-weight:800;color:${calc.ratingColor(m.rating)};margin-top:4px;">
              ${m.metric === 'paybackMonths' ? calc.formatMonths(m.value) :
                m.metric.includes('Pct') || m.metric.includes('pct') ? calc.formatPct(m.value) :
                calc.formatCurrency(m.value)}
            </div>
            <div style="font-size:11px;margin-top:4px;color:${calc.ratingColor(m.rating)};">${m.rating === 'good' ? '✓ On target' : m.rating === 'warning' ? '⚠ Below target' : '✕ Below minimum'}</div>
          </div>
        `).join('')}
      </div>

      <!-- Additional metrics -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">NPV (${activeDeal.contractTermYears || 5}yr)</div>
          <div style="font-size:20px;font-weight:800;color:${financials.npv >= 0 ? '#22c55e' : '#ef4444'};">${calc.formatCurrency(financials.npv, { compact: true })}</div>
        </div>
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">IRR</div>
          <div style="font-size:20px;font-weight:800;">${calc.formatPct(financials.irr * 100)}</div>
        </div>
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Revenue/SqFt</div>
          <div style="font-size:20px;font-weight:800;">${calc.formatCurrency(financials.revenuePerSqft)}</div>
        </div>
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Deal Score</div>
          <div style="font-size:20px;font-weight:800;color:${scoreColor(score.grade)};">${score.grade} (${score.score})</div>
        </div>
      </div>

      <!-- Multi-Year P&L -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Multi-Year P&L Projection</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:center;padding:8px;font-weight:700;">Year</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Revenue</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Cost</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Gross Profit</th>
              <th style="text-align:right;padding:8px;font-weight:700;">EBITDA</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Cumulative CF</th>
            </tr>
          </thead>
          <tbody>
            ${plRows.map(r => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:8px;text-align:center;font-weight:700;">Y${r.year}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.revenue, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.cost, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.grossProfit, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.ebitda, { compact: true })}</td>
                <td style="padding:8px;text-align:right;color:${r.cumulativeCashFlow >= 0 ? '#22c55e' : '#ef4444'};">${calc.formatCurrency(r.cumulativeCashFlow, { compact: true })}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost breakdown by site -->
      <div class="hub-card" style="padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Cost by Site</div>
        ${financials.bySite.map(sf => {
          const pct = financials.totalAnnualCost > 0 ? (sf.annualCost / financials.totalAnnualCost) * 100 : 0;
          return `
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;">${sf.siteName}</span>
                <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(sf.annualCost, { compact: true })} (${pct.toFixed(1)}%)</span>
              </div>
              <div style="height:20px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:var(--ies-blue);border-radius:6px;"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ============================================================
// PIPELINE TAB (DOS Stages)
// ============================================================

function renderPipeline(el) {
  if (!activeDeal) return;

  const progress = calc.computeStageProgress(dosStages);
  const overall = calc.computeOverallProgress(progress);

  el.innerHTML = `
    <div style="max-width:900px;">
      <!-- Overall progress -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;">
          ${kpi('Current Stage', overall.currentStage)}
          ${kpi('Elements', `${overall.completedElements}/${overall.totalElements}`)}
          ${kpi('Completion', `${overall.overallPct.toFixed(0)}%`)}
        </div>
      </div>

      <!-- Stage cards -->
      ${dosStages.map((stage, si) => {
        const prog = progress[si];
        const stageColor = prog.pct === 100 ? '#22c55e' : prog.blocked > 0 ? '#ef4444' : prog.inProgress > 0 ? '#0047AB' : '#6b7280';

        return `
          <div class="hub-card" style="margin-bottom:16px;border-left:4px solid ${stageColor};">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div>
                <span style="font-size:14px;font-weight:700;">Stage ${stage.stageNumber}: ${stage.stageName}</span>
                <span style="margin-left:8px;font-size:11px;font-weight:700;color:${stageColor};">${prog.pct.toFixed(0)}%</span>
              </div>
              <span style="font-size:11px;color:var(--ies-gray-400);">${prog.completed}/${prog.total} complete</span>
            </div>

            <div style="height:6px;border-radius:3px;background:var(--ies-gray-200);margin-bottom:12px;overflow:hidden;">
              <div style="height:100%;width:${prog.pct}%;background:${stageColor};border-radius:3px;"></div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
              ${stage.elements.map(elem => {
                const statusColors = {
                  complete: { bg: '#dcfce7', color: '#15803d', icon: '✓' },
                  in_progress: { bg: '#dbeafe', color: '#1d4ed8', icon: '◉' },
                  blocked: { bg: '#fee2e2', color: '#991b1b', icon: '✕' },
                  not_started: { bg: '#f3f4f6', color: '#6b7280', icon: '○' },
                  na: { bg: '#f3f4f6', color: '#9ca3af', icon: '—' },
                  skipped: { bg: '#f3f4f6', color: '#9ca3af', icon: '⊘' },
                };
                const sc = statusColors[elem.status] || statusColors.not_started;

                return `
                  <div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;background:${sc.bg};cursor:pointer;" data-elem="${elem.id}">
                    <span style="font-size:14px;color:${sc.color};">${sc.icon}</span>
                    <span style="font-size:11px;font-weight:600;color:${sc.color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${elem.name}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Click to cycle status
  el.querySelectorAll('[data-elem]').forEach(card => {
    card.addEventListener('click', () => {
      const elemId = /** @type {HTMLElement} */ (card).dataset.elem;
      cycleElementStatus(elemId);
      renderPipeline(el);
    });
  });
}

function cycleElementStatus(elemId) {
  const order = ['not_started', 'in_progress', 'complete', 'blocked', 'na'];
  for (const stage of dosStages) {
    const elem = stage.elements.find(e => e.id === elemId);
    if (elem) {
      const idx = order.indexOf(elem.status);
      elem.status = /** @type {any} */ (order[(idx + 1) % order.length]);
      break;
    }
  }
}

// ============================================================
// HOURS TAB
// ============================================================

function renderHours(el) {
  if (!activeDeal) return;

  const summary = calc.calcHoursSummary(hoursEntries);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Summary Tiles -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Total Forecast</div>
          <div style="font-size:24px;font-weight:800;color:var(--ies-blue);margin-top:4px;">${summary.totalForecast.toFixed(1)}h</div>
        </div>
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Total Actual</div>
          <div style="font-size:24px;font-weight:800;color:var(--ies-green);margin-top:4px;">${summary.totalActual.toFixed(1)}h</div>
        </div>
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Delta</div>
          <div style="font-size:24px;font-weight:800;color:${summary.delta >= 0 ? 'var(--ies-red)' : 'var(--ies-green)'};margin-top:4px;">${summary.delta >= 0 ? '+' : ''}${summary.delta.toFixed(1)}h</div>
        </div>
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Utilized</div>
          <div style="font-size:24px;font-weight:800;margin-top:4px;">${summary.percentUtilized.toFixed(0)}%</div>
        </div>
      </div>

      <!-- Hours Table -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="font-size:14px;font-weight:700;">Hours by Week & Work Type</div>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="dm-log-hours">+ Log Hours</button>
        </div>
        ${hoursEntries.length === 0 ? `
          <div style="text-align:center;padding:32px;color:var(--ies-gray-400);">No hours logged yet</div>
        ` : `
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:8px;font-weight:700;">Week</th>
                <th style="text-align:left;padding:8px;font-weight:700;">Work Type</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Forecast</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Actual</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Delta</th>
                <th style="text-align:right;padding:8px;font-weight:700;"></th>
              </tr>
            </thead>
            <tbody>
              ${summary.byWeek.map(week => `
                <tr style="border-bottom:1px solid var(--ies-gray-200);">
                  <td style="padding:8px;font-weight:600;">${week.week}</td>
                  <td style="padding:8px;text-transform:capitalize;">${week.forecast > 0 || week.actual > 0 ? 'All Types' : '—'}</td>
                  <td style="padding:8px;text-align:right;font-weight:600;">${week.forecast}</td>
                  <td style="padding:8px;text-align:right;font-weight:600;">${week.actual}</td>
                  <td style="padding:8px;text-align:right;color:${week.delta >= 0 ? 'var(--ies-red)' : 'var(--ies-green)'};">${week.delta >= 0 ? '+' : ''}${week.delta}</td>
                  <td style="padding:8px;text-align:right;"></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <!-- By Work Type Breakdown -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Breakdown by Work Type</div>
        ${summary.byWorkType.map(wt => {
          const total = wt.forecast + wt.actual;
          if (total === 0) return '';
          return `
            <div style="margin-bottom:16px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="font-size:12px;font-weight:600;">${wt.type}</span>
                <span style="font-size:12px;font-weight:700;">F: ${wt.forecast.toFixed(1)}h | A: ${wt.actual.toFixed(1)}h</span>
              </div>
              <div style="display:flex;height:20px;border-radius:4px;overflow:hidden;background:var(--ies-gray-200);">
                ${wt.forecast > 0 ? `<div style="flex:${wt.forecast};background:var(--ies-blue);"></div>` : ''}
                ${wt.actual > 0 ? `<div style="flex:${wt.actual};background:var(--ies-green);"></div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  el.querySelector('#dm-log-hours')?.addEventListener('click', () => showLogHoursModal());
}

function showLogHoursModal() {
  if (!activeDeal) return;
  const today = new Date().toISOString().split('T')[0];
  const Monday = new Date();
  const day = Monday.getDay();
  const diff = Monday.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(Monday.getFullYear(), Monday.getMonth(), diff);
  const weekStr = startOfWeek.toISOString().split('T')[0];

  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:500px;">
      <h3 style="margin:0 0 16px 0;">Log Hours</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Week Starting</label>
          <input type="date" id="dm-log-week" value="${weekStr}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Category</label>
          <select id="dm-log-category" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="forecast">Forecast</option>
            <option value="actual">Actual</option>
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Work Type</label>
          <select id="dm-log-type" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="Sales Design">Sales Design</option>
            <option value="Engineering">Engineering</option>
            <option value="Deal Mgmt">Deal Mgmt</option>
            <option value="Site Visit">Site Visit</option>
            <option value="Customer Meeting">Customer Meeting</option>
            <option value="Internal Review">Internal Review</option>
            <option value="Documentation">Documentation</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Hours</label>
          <input type="number" id="dm-log-hours-input" min="0" step="0.5" value="0" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Resource</label>
        <input type="text" id="dm-log-resource" value="Brock Eckles" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-log-save">Save Hours</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-log-save')?.addEventListener('click', async () => {
    const week = modal.querySelector('#dm-log-week').value;
    const hours = parseFloat(modal.querySelector('#dm-log-hours-input').value) || 0;
    const type = modal.querySelector('#dm-log-type').value;
    const resource = modal.querySelector('#dm-log-resource').value || 'Brock Eckles';
    const category = modal.querySelector('#dm-log-category').value;

    if (hours <= 0) { alert('Hours must be greater than 0'); return; }
    if (!activeDeal) return;

    const entry = { opportunity_id: activeDeal.id, week_start: week, hours_type: type, hours, resource, category };
    await api.logHours(entry);
    hoursEntries = await api.fetchHours(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderHours(el);
  });
}

// ============================================================
// TASKS TAB
// ============================================================

function renderTasksTab(el) {
  if (!activeDeal) return;

  const summary = calc.calcTaskProgress(tasks);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Progress Summary -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:700;">Task Progress</div>
          <span style="font-size:12px;color:var(--ies-gray-500);">${summary.done}/${summary.total} done</span>
        </div>
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--ies-gray-200);">
          <div style="flex:${summary.done};background:#22c55e;"></div>
          <div style="flex:${summary.inProgress};background:#0047AB;"></div>
          <div style="flex:${summary.blocked};background:#ef4444;"></div>
          <div style="flex:${summary.total - summary.done - summary.inProgress - summary.blocked};background:var(--ies-gray-300);"></div>
        </div>
        <div style="display:flex;gap:16px;margin-top:12px;font-size:12px;">
          <span><strong style="color:var(--ies-green);">${summary.done}</strong> done</span>
          <span><strong style="color:var(--ies-blue);">${summary.inProgress}</strong> in progress</span>
          <span><strong style="color:var(--ies-red);">${summary.blocked}</strong> blocked</span>
        </div>
      </div>

      <!-- Tasks by Stage -->
      ${summary.byStage.map(stage => {
        const stageTasks = tasks.filter(t => t.dos_stage_number === stage.dosStageNumber);
        return `
          <div class="hub-card" style="padding:16px;margin-bottom:16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:2px solid var(--ies-gray-200);">
              <div>
                <div style="font-size:13px;font-weight:700;">Stage ${stage.dosStageNumber}: ${stage.dosStageName}</div>
              </div>
              <span style="font-size:12px;color:var(--ies-gray-500);">${stage.done}/${stage.total} complete</span>
            </div>
            ${stageTasks.length === 0 ? `
              <div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No tasks in this stage</div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${stageTasks.map(task => {
                  const statusColor = {
                    'todo': '#9ca3af',
                    'in_progress': '#0047AB',
                    'done': '#22c55e',
                    'blocked': '#ef4444'
                  }[task.status] || '#6b7280';
                  const priorityColor = {
                    'low': '#6b7280',
                    'medium': '#0047AB',
                    'high': '#f59e0b',
                    'critical': '#ef4444'
                  }[task.priority] || '#6b7280';

                  return `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--ies-gray-200);border-radius:6px;">
                      <div style="width:20px;height:20px;border:2px solid ${statusColor};border-radius:4px;background:${task.status === 'done' ? statusColor : 'white'};"></div>
                      <div style="flex:1;">
                        <div style="font-size:12px;font-weight:600;${task.status === 'done' ? 'text-decoration:line-through;color:var(--ies-gray-400);' : ''}">${task.title}</div>
                        <div style="display:flex;gap:8px;margin-top:4px;font-size:10px;">
                          <span style="background:${statusColor};color:white;padding:2px 6px;border-radius:3px;font-weight:600;">${task.status.replace(/_/g,' ')}</span>
                          <span style="background:${priorityColor};color:white;padding:2px 6px;border-radius:3px;font-weight:600;">${task.priority}</span>
                          ${task.due_date ? `<span style="color:var(--ies-gray-500);">Due ${task.due_date}</span>` : ''}
                          ${task.estimated_hours ? `<span style="color:var(--ies-gray-500);">${task.estimated_hours}h</span>` : ''}
                        </div>
                      </div>
                      <button class="hub-btn hub-btn-sm hub-btn-secondary" onclick="alert('Edit task')">Edit</button>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>
        `;
      }).join('')}

      <!-- Add Task Button -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        <button class="hub-btn hub-btn-primary" id="dm-add-task">+ Add Task</button>
        <button class="hub-btn hub-btn-secondary" id="dm-populate-dos">Populate DOS Activities</button>
      </div>
    </div>
  `;

  el.querySelector('#dm-add-task')?.addEventListener('click', () => showNewTaskModal());
  el.querySelector('#dm-populate-dos')?.addEventListener('click', () => showPopulateDosModal());
}

function showNewTaskModal() {
  if (!activeDeal) return;
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:600px;">
      <h3 style="margin:0 0 16px 0;">Create Task</h3>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Title</label>
        <input type="text" id="dm-task-title" placeholder="Task title" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Priority</label>
          <select id="dm-task-priority" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">DOS Stage</label>
          <select id="dm-task-stage" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="">None</option>
            ${DOS_STAGE_LABELS.map(s => `<option value="${s.number}">${s.number}: ${s.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Assignee</label>
          <input type="text" id="dm-task-assignee" value="Brock Eckles" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Due Date</label>
          <input type="date" id="dm-task-due" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Estimated Hours</label>
        <input type="number" id="dm-task-est-hours" min="0" step="0.5" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-task-save">Create Task</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-task-save')?.addEventListener('click', async () => {
    if (!activeDeal) return;
    const title = modal.querySelector('#dm-task-title').value.trim();
    if (!title) { alert('Title required'); return; }

    const task = {
      opportunity_id: activeDeal.id,
      title,
      priority: modal.querySelector('#dm-task-priority').value,
      status: /** @type {const} */ ('todo'),
      assignee: modal.querySelector('#dm-task-assignee').value || null,
      due_date: modal.querySelector('#dm-task-due').value || null,
      estimated_hours: parseFloat(modal.querySelector('#dm-task-est-hours').value) || null,
      dos_stage_number: parseInt(modal.querySelector('#dm-task-stage').value) || null,
    };

    await api.createTask(task);
    tasks = await api.fetchTasks(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderTasksTab(el);
  });
}

function showPopulateDosModal() {
  if (!activeDeal) return;
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:500px;">
      <h3 style="margin:0 0 16px 0;">Populate DOS Activities</h3>
      <p style="color:var(--ies-gray-600);font-size:12px;margin-bottom:16px;">Select stages to add standard activities as tasks.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
        ${DOS_STAGE_LABELS.map(s => {
          const template = calc.getDosActivityTemplates(s.number);
          return `
            <label style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--ies-gray-200);border-radius:6px;cursor:pointer;">
              <input type="checkbox" class="dos-stage-cb" value="${s.number}" style="width:18px;height:18px;accent-color:var(--ies-blue);">
              <div style="flex:1;">
                <div style="font-weight:600;">Stage ${s.number}: ${s.name}</div>
                <div style="font-size:11px;color:var(--ies-gray-500);">${template.length} activities</div>
              </div>
            </label>
          `;
        }).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-populate-save">Populate</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-populate-save')?.addEventListener('click', async () => {
    if (!activeDeal) return;
    const selected = Array.from(modal.querySelectorAll('.dos-stage-cb:checked')).map(cb => parseInt(cb.value));
    if (selected.length === 0) { alert('Select at least one stage'); return; }

    for (const stageNum of selected) {
      const templates = calc.getDosActivityTemplates(stageNum);
      const stageName = DOS_STAGE_LABELS.find(s => s.number === stageNum)?.name || `Stage ${stageNum}`;
      for (const template of templates) {
        const task = {
          opportunity_id: activeDeal.id,
          title: template.title,
          description: template.description,
          status: /** @type {const} */ ('todo'),
          priority: /** @type {const} */ ('medium'),
          dos_stage_number: stageNum,
          dos_stage_name: stageName,
        };
        await api.createTask(task);
      }
    }

    tasks = await api.fetchTasks(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderTasksTab(el);
  });
}

// ============================================================
// UPDATES TAB
// ============================================================

function renderUpdatesTab(el) {
  if (!activeDeal) return;

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Weekly Updates</h3>
        <button class="hub-btn hub-btn-sm hub-btn-primary" id="dm-new-update">+ New Update</button>
      </div>

      ${updates.length === 0 ? `
        <div class="hub-card" style="text-align:center;padding:32px;color:var(--ies-gray-400);">
          No updates yet
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${updates.map(u => `
            <div class="hub-card" style="padding:16px;border-left:4px solid var(--ies-blue);">
              <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">
                <div>
                  <div style="font-size:13px;font-weight:700;">${u.update_date}</div>
                  <div style="font-size:11px;color:var(--ies-gray-500);">${u.author || 'Unknown'}</div>
                </div>
                <button class="hub-btn hub-btn-sm hub-btn-secondary" onclick="pmDeleteUpdate('${u.id}')" style="color:var(--ies-red);">Delete</button>
              </div>
              <div style="font-size:13px;color:var(--ies-navy);line-height:1.5;margin-bottom:12px;white-space:pre-wrap;">${u.body || ''}</div>
              ${u.next_steps ? `
                <div style="padding:10px 12px;background:rgba(37,99,235,.05);border-left:3px solid var(--ies-blue);border-radius:4px;margin-bottom:8px;">
                  <div style="font-size:11px;font-weight:700;color:var(--ies-blue);text-transform:uppercase;margin-bottom:4px;">Next Steps</div>
                  <div style="font-size:12px;white-space:pre-wrap;">${u.next_steps}</div>
                </div>
              ` : ''}
              ${u.blockers ? `
                <div style="padding:10px 12px;background:rgba(239,68,68,.05);border-left:3px solid var(--ies-red);border-radius:4px;">
                  <div style="font-size:11px;font-weight:700;color:var(--ies-red);text-transform:uppercase;margin-bottom:4px;">Blockers</div>
                  <div style="font-size:12px;white-space:pre-wrap;">${u.blockers}</div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;

  el.querySelector('#dm-new-update')?.addEventListener('click', () => showNewUpdateModal());
}

function showNewUpdateModal() {
  if (!activeDeal) return;
  const today = new Date().toISOString().split('T')[0];
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:600px;">
      <h3 style="margin:0 0 16px 0;">New Weekly Update</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Date</label>
          <input type="date" id="dm-update-date" value="${today}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Author</label>
          <input type="text" id="dm-update-author" value="Brock Eckles" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Update</label>
        <textarea id="dm-update-body" placeholder="What happened this week?" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;min-height:100px;font-family:inherit;"></textarea>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Next Steps</label>
        <textarea id="dm-update-next" placeholder="What's planned next?" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;min-height:60px;font-family:inherit;"></textarea>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Blockers (optional)</label>
        <textarea id="dm-update-blockers" placeholder="Any blockers or risks?" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;min-height:60px;font-family:inherit;"></textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-update-save">Post Update</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-update-save')?.addEventListener('click', async () => {
    if (!activeDeal) return;
    const body = modal.querySelector('#dm-update-body').value.trim();
    if (!body) { alert('Update body required'); return; }

    const update = {
      opportunity_id: activeDeal.id,
      update_date: modal.querySelector('#dm-update-date').value,
      author: modal.querySelector('#dm-update-author').value || null,
      body,
      next_steps: modal.querySelector('#dm-update-next').value.trim() || null,
      blockers: modal.querySelector('#dm-update-blockers').value.trim() || null,
    };

    await api.createUpdate(update);
    updates = await api.fetchUpdates(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderUpdatesTab(el);
  });
}

// ============================================================
// HELPERS
// ============================================================

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

function scoreColor(grade) {
  return { A: '#22c55e', B: '#0047AB', C: '#f59e0b', D: '#ef4444', F: '#991b1b' }[grade] || '#6b7280';
}
