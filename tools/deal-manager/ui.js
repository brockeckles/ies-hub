/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Views: Deal List (landing), then per-deal: Summary, Sites, Financials, Pipeline.
 *
 * @module tools/deal-manager/ui
 */

import { bus } from '../../shared/event-bus.js';
import { state } from '../../shared/state.js';
import * as calc from './calc.js';
import * as api from './api.js';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'list' | 'summary' | 'sites' | 'financials' | 'pipeline'} */
let activeTab = 'list';

/** @type {import('./types.js').Deal|null} */
let activeDeal = null;

/** @type {import('./types.js').Site[]} */
let sites = [];

/** @type {import('./types.js').DealFinancials|null} */
let financials = null;

/** @type {import('./types.js').DosStage[]} */
let dosStages = [];

/** @type {import('./types.js').Deal[]} */
let allDeals = [];

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

  if (activeTab === 'list') {
    tabBar.innerHTML = `<button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-new-deal">+ New Deal</button>`;
    tabBar.querySelector('#dm-new-deal')?.addEventListener('click', () => createNewDeal());
    return;
  }

  const tabs = [
    { key: 'summary', label: 'Summary' },
    { key: 'sites', label: 'Sites' },
    { key: 'financials', label: 'Financials' },
    { key: 'pipeline', label: 'Pipeline' },
  ];

  tabBar.innerHTML = `
    <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-back" style="margin-right:8px;">← All Deals</button>
    ${tabs.map(t => `
      <button class="hub-btn hub-btn-sm ${t.key === activeTab ? 'hub-btn-primary' : 'hub-btn-secondary'}"
              data-tab="${t.key}">${t.label}</button>
    `).join('')}
  `;

  tabBar.querySelector('#dm-back')?.addEventListener('click', () => {
    activeTab = 'list';
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
    case 'list': renderDealList(el); break;
    case 'summary': renderSummary(el); break;
    case 'sites': renderSites(el); break;
    case 'financials': renderFinancials(el); break;
    case 'pipeline': renderPipeline(el); break;
  }
}

// ============================================================
// DEAL LIST (LANDING)
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
    card.addEventListener('click', () => openDeal(/** @type {HTMLElement} */ (card).dataset.dealId));
  });

  el.querySelector('#dm-first-deal')?.addEventListener('click', () => createNewDeal());
}

function createNewDeal() {
  const id = 'deal-' + Date.now();
  const newDeal = { id, dealName: 'New Deal', clientName: '', dealOwner: '', status: /** @type {const} */ ('draft'), contractTermYears: 5 };
  allDeals.push(newDeal);
  openDeal(id);
}

function openDeal(id) {
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
