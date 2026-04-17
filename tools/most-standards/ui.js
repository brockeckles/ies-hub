/**
 * IES Hub v3 — MOST Labor Standards UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Three modes: Template Library, Quick Labor Analysis, Workflow Composer.
 *
 * @module tools/most-standards/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260416-s2';
import { state } from '../../shared/state.js?v=20260416-s2';
import * as calc from './calc.js';
import * as api from './api.js';

// ============================================================
// STATE — tool-local
// ============================================================

/** @type {'library' | 'analysis' | 'workflow'} */
let activeTab = 'library';

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {{ templates: import('./types.js').MostTemplate[], allowanceProfiles: import('./types.js').AllowanceProfile[] }} */
let refData = { templates: [], allowanceProfiles: [] };

/** @type {import('./types.js').MostTemplate|null} */
let selectedTemplate = null;

/** @type {import('./types.js').MostElement[]} */
let selectedElements = [];

/** Filters for template library */
let filters = { search: '', processArea: '', laborCategory: '' };

// --- Analysis state ---
/** @type {import('./types.js').LaborAnalysis} */
let analysis = createEmptyAnalysis();

// --- Workflow state ---
/** @type {import('./types.js').Workflow} */
let workflow = createEmptyWorkflow();

// ============================================================
// PROCESS AREAS & CATEGORIES
// ============================================================

const PROCESS_AREAS = ['Receiving', 'Putaway', 'Picking', 'Packing', 'Shipping', 'Inventory'];
const LABOR_CATEGORIES = ['manual', 'mhe', 'hybrid'];

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the MOST Labor Standards tool.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeTab = 'library';
  selectedTemplate = null;
  selectedElements = [];
  filters = { search: '', processArea: '', laborCategory: '' };
  analysis = createEmptyAnalysis();
  workflow = createEmptyWorkflow();

  el.innerHTML = renderShell();

  // Wire tab nav
  el.querySelectorAll('.most-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = /** @type {any} */ (tab.dataset.tab);
      el.querySelectorAll('.most-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderContent();
    });
  });

  // Load ref data
  try {
    refData = await api.loadRefData();
  } catch (err) {
    console.warn('[MOST] Failed to load ref data:', err);
  }

  renderContent();
  bus.emit('most:mounted');
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  rootEl = null;
  bus.emit('most:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  return `
    <div class="hub-analyzer" style="height: calc(100vh - 48px);">
      <!-- Tab Bar -->
      <div class="hub-analyzer-tabs">
        <button class="most-tab hub-tab active" data-tab="library">Template Library</button>
        <button class="most-tab hub-tab" data-tab="analysis">Quick Analysis</button>
        <button class="most-tab hub-tab" data-tab="workflow">Workflow Composer</button>
      </div>
      <!-- Content -->
      <div class="hub-analyzer-content" id="most-content" style="padding: 24px; overflow-y: auto;">
        <!-- Tab content renders here -->
      </div>
    </div>

    <style>
      .most-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
      .most-tpl-card {
        border: 1px solid var(--ies-gray-200);
        border-radius: 8px;
        padding: 16px;
        cursor: pointer;
        transition: all 0.15s ease;
        background: #fff;
      }
      .most-tpl-card:hover { border-color: var(--ies-blue); box-shadow: 0 2px 8px rgba(0,71,171,0.1); }
      .most-tpl-card.selected { border-color: var(--ies-blue); background: rgba(0,71,171,0.03); }
      .most-tpl-name { font-size: 14px; font-weight: 700; color: var(--ies-navy); margin-bottom: 4px; }
      .most-tpl-meta { font-size: 12px; color: var(--ies-gray-500); display: flex; gap: 12px; margin-bottom: 8px; }
      .most-tpl-stats { display: flex; gap: 16px; font-size: 13px; }
      .most-tpl-stat { font-weight: 700; }
      .most-tpl-stat span { font-weight: 400; color: var(--ies-gray-500); font-size: 11px; display: block; }

      .most-cat-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
      .most-cat-manual { background: rgba(0,71,171,0.1); color: #0047AB; }
      .most-cat-mhe { background: rgba(32,201,151,0.1); color: #0d9668; }
      .most-cat-hybrid { background: rgba(255,149,0,0.1); color: #cc7700; }

      .most-detail-panel {
        border: 1px solid var(--ies-gray-200);
        border-radius: 8px;
        padding: 20px;
        background: #fff;
        margin-top: 16px;
      }

      .most-filter-bar {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-bottom: 20px;
        flex-wrap: wrap;
      }
      .most-filter-bar input, .most-filter-bar select {
        padding: 8px 12px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
      }
      .most-filter-bar input:focus, .most-filter-bar select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 2px rgba(0,71,171,0.1);
      }

      .most-workflow-step {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 8px;
        background: #fff;
        margin-bottom: 8px;
      }
      .most-workflow-step.bottleneck { border-color: var(--ies-red); background: rgba(220,53,69,0.03); }
      .most-workflow-arrow {
        text-align: center;
        color: var(--ies-gray-300);
        font-size: 18px;
        margin-bottom: 8px;
      }

      .most-push-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        background: var(--ies-blue);
        color: #fff;
        border: none;
        border-radius: 6px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.15s;
      }
      .most-push-btn:hover { background: #003a8c; }
    </style>
  `;
}

// ============================================================
// CONTENT RENDERING
// ============================================================

function renderContent() {
  const container = rootEl?.querySelector('#most-content');
  if (!container) return;

  const renderers = { library: renderLibrary, analysis: renderAnalysis, workflow: renderWorkflowComposer };
  const render = renderers[activeTab];
  if (render) {
    container.innerHTML = render();
    bindContentEvents(container);
  }
}

// ============================================================
// TAB 1: TEMPLATE LIBRARY
// ============================================================

function renderLibrary() {
  const filtered = filterTemplates();
  const grouped = groupByProcessArea(filtered);

  return `
    <div class="most-filter-bar">
      <input type="text" placeholder="Search templates..." value="${filters.search}" id="most-search" style="width:220px;" />
      <select id="most-filter-area">
        <option value="">All Process Areas</option>
        ${PROCESS_AREAS.map(a => `<option value="${a}"${filters.processArea === a ? ' selected' : ''}>${a}</option>`).join('')}
      </select>
      <select id="most-filter-cat">
        <option value="">All Categories</option>
        ${LABOR_CATEGORIES.map(c => `<option value="${c}"${filters.laborCategory === c ? ' selected' : ''}>${c.toUpperCase()}</option>`).join('')}
      </select>
      <span style="font-size:12px; color:var(--ies-gray-400); margin-left:auto;">${filtered.length} template${filtered.length !== 1 ? 's' : ''}</span>
    </div>

    ${Object.entries(grouped).map(([area, templates]) => `
      <div style="margin-bottom: 24px;">
        <div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--ies-gray-500); margin-bottom:12px;">${area}</div>
        <div class="most-card-grid">
          ${templates.map(t => renderTemplateCard(t)).join('')}
        </div>
      </div>
    `).join('')}

    ${filtered.length === 0 ? '<div style="text-align:center; padding:40px; color:var(--ies-gray-400);">No templates match your filters.</div>' : ''}

    ${selectedTemplate ? renderTemplateDetail() : ''}
  `;
}

function renderTemplateCard(t) {
  const isSelected = selectedTemplate?.id === t.id;
  return `
    <div class="most-tpl-card${isSelected ? ' selected' : ''}" data-action="select-template" data-id="${t.id}">
      <div class="most-tpl-name">${t.name}</div>
      <div class="most-tpl-meta">
        <span class="most-cat-badge most-cat-${t.labor_category || 'manual'}">${(t.labor_category || 'manual').toUpperCase()}</span>
        <span>${t.uom || 'each'}</span>
      </div>
      <div class="most-tpl-stats">
        <div class="most-tpl-stat">${calc.formatUph(t.base_uph)}<span>Base UPH</span></div>
        <div class="most-tpl-stat">${t.tmu_total || 0}<span>TMU</span></div>
        <div class="most-tpl-stat">${calc.formatTmu(t.tmu_total || 0)}<span>Cycle Time</span></div>
      </div>
    </div>
  `;
}

function renderTemplateDetail() {
  const t = selectedTemplate;
  if (!t) return '';

  const elBreak = calc.elementBreakdown(selectedElements);

  return `
    <div class="most-detail-panel">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
        <div>
          <div style="font-size:18px; font-weight:800; color:var(--ies-navy);">${t.name}</div>
          <div style="font-size:13px; color:var(--ies-gray-500); margin-top:4px;">
            ${t.process_area} · <span class="most-cat-badge most-cat-${t.labor_category}">${(t.labor_category || 'manual').toUpperCase()}</span> · ${t.uom || 'each'}
          </div>
        </div>
        <button class="cm-delete-btn" data-action="close-detail" style="font-size:16px;">✕</button>
      </div>

      ${t.description ? `<div style="font-size:13px; color:var(--ies-gray-600); margin-bottom:16px;">${t.description}</div>` : ''}

      <!-- KPIs -->
      <div class="hub-kpi-bar mb-4">
        <div class="hub-kpi-item"><div class="hub-kpi-label">Base UPH</div><div class="hub-kpi-value">${calc.formatUph(t.base_uph)}</div></div>
        <div class="hub-kpi-item"><div class="hub-kpi-label">Total TMU</div><div class="hub-kpi-value">${t.tmu_total || 0}</div></div>
        <div class="hub-kpi-item"><div class="hub-kpi-label">Cycle Time</div><div class="hub-kpi-value">${calc.formatTmu(t.tmu_total || 0)}</div></div>
        <div class="hub-kpi-item"><div class="hub-kpi-label">Elements</div><div class="hub-kpi-value">${elBreak.total} <span style="font-size:11px; font-weight:400; color:var(--ies-gray-400);">(${elBreak.variable} var)</span></div></div>
      </div>

      <!-- Element Sequence Table -->
      ${selectedElements.length > 0 ? `
        <div style="font-size:13px; font-weight:700; margin-bottom:8px;">Element Sequence</div>
        <table class="cm-grid-table" style="font-size:12px;">
          <thead>
            <tr><th>#</th><th>Description</th><th>MOST Sequence</th><th class="cm-num">TMU</th><th class="cm-num">Time</th><th>Type</th></tr>
          </thead>
          <tbody>
            ${selectedElements.map(el => `
              <tr>
                <td>${el.sequence}</td>
                <td>${el.description || ''}</td>
                <td style="font-family:monospace; font-size:11px; color:var(--ies-gray-500);">${el.most_sequence || ''}</td>
                <td class="cm-num">${el.tmu || 0}</td>
                <td class="cm-num">${calc.formatTmu(el.tmu || 0)}</td>
                <td>${el.is_variable ? '<span style="color:var(--ies-orange); font-weight:600;">Variable</span>' : 'Fixed'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div style="color:var(--ies-gray-400); font-size:13px;">No elements loaded for this template.</div>'}
    </div>
  `;
}

// ============================================================
// TAB 2: QUICK LABOR ANALYSIS
// ============================================================

function renderAnalysis() {
  const lines = analysis.lines || [];
  const pfd = analysis.pfd_pct || 14;

  // Compute derived fields for display
  const computedLines = lines.map(line => {
    const derived = calc.computeAnalysisLine({
      base_uph: line.base_uph,
      pfd_pct: pfd,
      daily_volume: line.daily_volume,
      shift_hours: analysis.shift_hours,
      hourly_rate: line.hourly_rate || analysis.hourly_rate,
    });
    return { ...line, ...derived };
  });

  const summary = calc.computeAnalysisSummary(computedLines, analysis.operating_days);
  const allowProfiles = refData.allowanceProfiles || [];
  const tplsByArea = groupByProcessArea(refData.templates || []);

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <div>
        <div style="font-size:16px; font-weight:700; color:var(--ies-navy);">Quick Labor Analysis</div>
        <div style="font-size:13px; color:var(--ies-gray-500);">Add activities from template library or enter manual standards.</div>
      </div>
      <button class="most-push-btn" data-action="push-to-cm">Push to Cost Model →</button>
    </div>

    <!-- Analysis Parameters -->
    <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:12px; margin-bottom:20px;">
      <div>
        <label class="cm-form-label">PFD Allowance</label>
        <select class="hub-select" id="most-pfd-select">
          <option value="">Custom</option>
          ${allowProfiles.map(p => `<option value="${p.id}" data-pfd="${calc.totalPfd(p)}"${analysis.allowance_profile_id === p.id ? ' selected' : ''}>${p.name} (${calc.totalPfd(p)}%)</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="cm-form-label">PFD %</label>
        <input class="hub-input" type="number" value="${pfd}" step="1" id="most-pfd-input" data-param="pfd_pct" />
      </div>
      <div>
        <label class="cm-form-label">Shift Hours</label>
        <input class="hub-input" type="number" value="${analysis.shift_hours}" step="0.5" data-param="shift_hours" />
      </div>
      <div>
        <label class="cm-form-label">Operating Days/Yr</label>
        <input class="hub-input" type="number" value="${analysis.operating_days}" step="1" data-param="operating_days" />
      </div>
      <div>
        <label class="cm-form-label">Default $/Hr</label>
        <input class="hub-input" type="number" value="${analysis.hourly_rate}" step="0.5" data-param="hourly_rate" />
      </div>
    </div>

    <!-- Activity Lines Table -->
    <table class="cm-grid-table">
      <thead>
        <tr>
          <th>Activity / Template</th>
          <th>Area</th>
          <th>Category</th>
          <th class="cm-num">Base UPH</th>
          <th class="cm-num">Adj UPH</th>
          <th class="cm-num">Daily Vol</th>
          <th class="cm-num">Hrs/Day</th>
          <th class="cm-num">FTE</th>
          <th class="cm-num">HC</th>
          <th class="cm-num">$/Hr</th>
          <th class="cm-num">Daily Cost</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${computedLines.map((line, i) => `
          <tr>
            <td>
              <select style="width:160px;" data-action="set-template-line" data-idx="${i}">
                <option value="">— Manual —</option>
                ${Object.entries(tplsByArea).map(([area, tpls]) =>
                  `<optgroup label="${area}">
                    ${tpls.map(t => `<option value="${t.id}"${line.template_id === t.id ? ' selected' : ''}>${t.name}</option>`).join('')}
                  </optgroup>`
                ).join('')}
              </select>
            </td>
            <td style="font-size:12px;">${line.process_area || '—'}</td>
            <td><span class="most-cat-badge most-cat-${line.labor_category || 'manual'}">${(line.labor_category || 'manual').toUpperCase()}</span></td>
            <td><input type="number" value="${line.base_uph || 0}" style="width:60px;" data-line="${i}" data-field="base_uph" /></td>
            <td class="cm-num">${calc.formatUph(line.adjusted_uph)}</td>
            <td><input type="number" value="${line.daily_volume || 0}" style="width:70px;" data-line="${i}" data-field="daily_volume" /></td>
            <td class="cm-num">${line.hours_per_day.toFixed(1)}</td>
            <td class="cm-num">${calc.formatFte(line.fte)}</td>
            <td class="cm-num" style="font-weight:700;">${line.headcount}</td>
            <td><input type="number" value="${line.hourly_rate || analysis.hourly_rate || 0}" style="width:55px;" step="0.5" data-line="${i}" data-field="hourly_rate" /></td>
            <td class="cm-num">${formatDollar(line.daily_cost)}</td>
            <td><button class="cm-delete-btn" data-action="delete-analysis-line" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-analysis-line">+ Add Activity Line</button>

    <!-- Summary -->
    ${computedLines.length > 0 ? renderAnalysisSummary(summary) : ''}
  `;
}

function renderAnalysisSummary(summary) {
  const cats = summary.ftesByCategory;
  const totalFte = summary.totalFtes || 1;

  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px;">
      <div class="hub-card">
        <div class="text-subtitle mb-4">Labor Summary</div>
        <div class="hub-kpi-bar">
          <div class="hub-kpi-item"><div class="hub-kpi-label">Total FTEs</div><div class="hub-kpi-value">${calc.formatFte(summary.totalFtes)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Headcount</div><div class="hub-kpi-value">${summary.totalHeadcount}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Hrs/Day</div><div class="hub-kpi-value">${summary.totalHoursPerDay.toFixed(1)}</div></div>
        </div>
        <div class="hub-kpi-bar mt-4">
          <div class="hub-kpi-item"><div class="hub-kpi-label">Daily Cost</div><div class="hub-kpi-value">${formatDollar(summary.dailyCost)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Annual Cost</div><div class="hub-kpi-value" style="color:var(--ies-blue);">${formatDollar(summary.annualCost)}</div></div>
        </div>
      </div>

      <div class="hub-card">
        <div class="text-subtitle mb-4">FTEs by Category</div>
        <div style="display:flex; height:24px; border-radius:4px; overflow:hidden; margin-bottom:12px;">
          ${cats.manual > 0 ? `<div style="width:${(cats.manual / totalFte * 100).toFixed(0)}%; background:#0047AB;" title="Manual"></div>` : ''}
          ${cats.mhe > 0 ? `<div style="width:${(cats.mhe / totalFte * 100).toFixed(0)}%; background:#20c997;" title="MHE"></div>` : ''}
          ${cats.hybrid > 0 ? `<div style="width:${(cats.hybrid / totalFte * 100).toFixed(0)}%; background:#ff9500;" title="Hybrid"></div>` : ''}
        </div>
        <div style="display:flex; gap:24px;">
          <div><span class="most-cat-badge most-cat-manual">MANUAL</span> <span style="font-weight:700; margin-left:4px;">${calc.formatFte(cats.manual)}</span></div>
          <div><span class="most-cat-badge most-cat-mhe">MHE</span> <span style="font-weight:700; margin-left:4px;">${calc.formatFte(cats.mhe)}</span></div>
          <div><span class="most-cat-badge most-cat-hybrid">HYBRID</span> <span style="font-weight:700; margin-left:4px;">${calc.formatFte(cats.hybrid)}</span></div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// TAB 3: WORKFLOW COMPOSER
// ============================================================

function renderWorkflowComposer() {
  const steps = workflow.steps || [];
  const pfd = workflow.pfd_pct || 14;

  // Compute derived fields
  const computedSteps = steps.map(step => {
    const derived = calc.computeWorkflowStep({
      base_uph: step.base_uph,
      pfd_pct: pfd,
      target_volume: workflow.target_volume_per_day,
      volume_ratio: step.volume_ratio ?? 1,
      shift_hours: workflow.shift_hours,
    });
    return { ...step, ...derived };
  });

  const wfResult = calc.analyzeWorkflow(computedSteps);
  const tplsByArea = groupByProcessArea(refData.templates || []);

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <div>
        <div style="font-size:16px; font-weight:700; color:var(--ies-navy);">Workflow Composer</div>
        <div style="font-size:13px; color:var(--ies-gray-500);">Chain templates into an end-to-end warehouse workflow to identify bottlenecks.</div>
      </div>
    </div>

    <!-- Workflow Parameters -->
    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:20px;">
      <div>
        <label class="cm-form-label">Workflow Name</label>
        <input class="hub-input" value="${workflow.name}" id="wf-name" data-wf="name" />
      </div>
      <div>
        <label class="cm-form-label">Target Volume/Day</label>
        <input class="hub-input" type="number" value="${workflow.target_volume_per_day}" data-wf="target_volume_per_day" />
      </div>
      <div>
        <label class="cm-form-label">Shift Hours</label>
        <input class="hub-input" type="number" value="${workflow.shift_hours}" step="0.5" data-wf="shift_hours" />
      </div>
      <div>
        <label class="cm-form-label">PFD %</label>
        <input class="hub-input" type="number" value="${pfd}" step="1" data-wf="pfd_pct" />
      </div>
    </div>

    <!-- Pipeline Steps -->
    <div id="most-wf-steps">
      ${computedSteps.map((step, i) => {
        const isBottleneck = step.adjusted_uph > 0 && step.adjusted_uph === wfResult.bottleneckUph;
        return `
          ${i > 0 ? '<div class="most-workflow-arrow">↓</div>' : ''}
          <div class="most-workflow-step${isBottleneck ? ' bottleneck' : ''}">
            <div style="flex:1;">
              <select style="width:180px;" data-action="set-wf-template" data-idx="${i}">
                <option value="">— Select Template —</option>
                ${Object.entries(tplsByArea).map(([area, tpls]) =>
                  `<optgroup label="${area}">
                    ${tpls.map(t => `<option value="${t.id}"${step.template_id === t.id ? ' selected' : ''}>${t.name}</option>`).join('')}
                  </optgroup>`
                ).join('')}
              </select>
              <div style="font-size:12px; color:var(--ies-gray-400); margin-top:4px;">${step.process_area || ''} · <span class="most-cat-badge most-cat-${step.labor_category || 'manual'}" style="font-size:10px;">${(step.labor_category || '').toUpperCase()}</span></div>
            </div>
            <div style="text-align:center; min-width:60px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">Vol Ratio</div>
              <input type="number" value="${step.volume_ratio ?? 1}" style="width:55px; text-align:center;" step="0.1" min="0" max="1" data-wf-step="${i}" data-field="volume_ratio" />
            </div>
            <div style="text-align:center; min-width:60px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">Adj UPH</div>
              <div style="font-size:16px; font-weight:700;${isBottleneck ? ' color:var(--ies-red);' : ''}">${calc.formatUph(step.adjusted_uph)}</div>
            </div>
            <div style="text-align:center; min-width:50px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">FTE</div>
              <div style="font-size:16px; font-weight:700;">${calc.formatFte(step.fte)}</div>
            </div>
            <div style="text-align:center; min-width:50px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">Hrs/Day</div>
              <div style="font-size:14px; font-weight:600;">${step.hours_per_day.toFixed(1)}</div>
            </div>
            <button class="cm-delete-btn" data-action="delete-wf-step" data-idx="${i}">✕</button>
          </div>
        `;
      }).join('')}
    </div>
    <button class="cm-add-row-btn" data-action="add-wf-step" style="margin-top:12px;">+ Add Step</button>

    <!-- Workflow Summary -->
    ${computedSteps.length > 0 ? renderWorkflowSummary(wfResult, computedSteps) : ''}
  `;
}

function renderWorkflowSummary(result, steps) {
  const cats = result.ftesByCategory;
  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px;">
      <div class="hub-card">
        <div class="text-subtitle mb-4">Workflow Results</div>
        <div class="hub-kpi-bar">
          <div class="hub-kpi-item"><div class="hub-kpi-label">Total FTEs</div><div class="hub-kpi-value">${calc.formatFte(result.totalFtes)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Total Hrs/Day</div><div class="hub-kpi-value">${result.totalHoursPerDay.toFixed(1)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Steps</div><div class="hub-kpi-value">${steps.length}</div></div>
        </div>
      </div>
      <div class="hub-card" style="${result.bottleneckStep ? 'border-left:3px solid var(--ies-red);' : ''}">
        <div class="text-subtitle mb-4">Bottleneck</div>
        ${result.bottleneckStep ? `
          <div style="font-size:16px; font-weight:700; color:var(--ies-red); margin-bottom:4px;">${result.bottleneckStep}</div>
          <div style="font-size:13px; color:var(--ies-gray-500);">Lowest throughput: ${calc.formatUph(result.bottleneckUph)} UPH</div>
        ` : `<div style="color:var(--ies-gray-400);">Add steps to identify bottleneck</div>`}
      </div>
    </div>

    <!-- Throughput Bar Chart (CSS-only) -->
    ${steps.length > 1 ? `
      <div class="hub-card mt-4">
        <div class="text-subtitle mb-4">Throughput Comparison (UPH)</div>
        ${steps.map(s => {
          const maxUph = Math.max(...steps.map(st => st.adjusted_uph || 0));
          const pct = maxUph > 0 ? ((s.adjusted_uph || 0) / maxUph * 100) : 0;
          const isBottle = s.adjusted_uph > 0 && s.adjusted_uph === result.bottleneckUph;
          return `
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
              <div style="width:120px; font-size:12px; font-weight:600; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${s.step_name || 'Unnamed'}</div>
              <div style="flex:1; background:var(--ies-gray-100); border-radius:4px; height:24px; overflow:hidden;">
                <div style="height:100%; width:${pct}%; background:${isBottle ? 'var(--ies-red)' : 'var(--ies-blue)'}; border-radius:4px; transition:width 0.3s;"></div>
              </div>
              <div style="width:60px; font-size:13px; font-weight:700;${isBottle ? ' color:var(--ies-red);' : ''}">${calc.formatUph(s.adjusted_uph)}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
  `;
}

// ============================================================
// EVENT BINDING
// ============================================================

function bindContentEvents(container) {
  // Filter inputs (library)
  container.querySelector('#most-search')?.addEventListener('input', e => {
    filters.search = /** @type {HTMLInputElement} */ (e.target).value;
    renderContent();
  });
  container.querySelector('#most-filter-area')?.addEventListener('change', e => {
    filters.processArea = /** @type {HTMLSelectElement} */ (e.target).value;
    renderContent();
  });
  container.querySelector('#most-filter-cat')?.addEventListener('change', e => {
    filters.laborCategory = /** @type {HTMLSelectElement} */ (e.target).value;
    renderContent();
  });

  // Template card clicks
  container.querySelectorAll('[data-action="select-template"]').forEach(card => {
    card.addEventListener('click', async () => {
      const id = card.dataset.id;
      if (selectedTemplate?.id === id) {
        selectedTemplate = null;
        selectedElements = [];
      } else {
        selectedTemplate = (refData.templates || []).find(t => t.id === id) || null;
        try { selectedElements = selectedTemplate ? await api.listElements(id) : []; } catch { selectedElements = []; }
      }
      renderContent();
    });
  });

  // Close detail
  container.querySelector('[data-action="close-detail"]')?.addEventListener('click', () => {
    selectedTemplate = null;
    selectedElements = [];
    renderContent();
  });

  // PFD profile select
  container.querySelector('#most-pfd-select')?.addEventListener('change', e => {
    const sel = /** @type {HTMLSelectElement} */ (e.target);
    const opt = sel.options[sel.selectedIndex];
    if (opt.dataset.pfd) {
      analysis.pfd_pct = parseFloat(opt.dataset.pfd);
      analysis.allowance_profile_id = sel.value;
      renderContent();
    }
  });

  // Analysis parameter inputs
  container.querySelectorAll('[data-param]').forEach(input => {
    input.addEventListener('change', e => {
      const param = /** @type {HTMLInputElement} */ (e.target).dataset.param;
      analysis[param] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      renderContent();
    });
  });

  // Analysis line field inputs
  container.querySelectorAll('[data-line]').forEach(input => {
    input.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.line);
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.field;
      if (analysis.lines[idx]) {
        analysis.lines[idx][field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
        renderContent();
      }
    });
  });

  // Template dropdown in analysis lines
  container.querySelectorAll('[data-action="set-template-line"]').forEach(select => {
    select.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLSelectElement} */ (e.target).dataset.idx);
      const tplId = /** @type {HTMLSelectElement} */ (e.target).value;
      const tpl = (refData.templates || []).find(t => t.id === tplId);
      if (tpl && analysis.lines[idx]) {
        analysis.lines[idx].template_id = tpl.id;
        analysis.lines[idx].activity_name = tpl.name;
        analysis.lines[idx].process_area = tpl.process_area;
        analysis.lines[idx].labor_category = tpl.labor_category || 'manual';
        analysis.lines[idx].base_uph = tpl.base_uph || 0;
        analysis.lines[idx].uom = tpl.uom || 'each';
      }
      renderContent();
    });
  });

  // Action buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    if (action === 'select-template' || action === 'close-detail' || action === 'set-template-line') return;

    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      handleAction(action, idx);
    });
  });

  // Workflow param inputs
  container.querySelectorAll('[data-wf]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.wf;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      workflow[field] = val;
      renderContent();
    });
  });

  // Workflow step field inputs
  container.querySelectorAll('[data-wf-step]').forEach(input => {
    input.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset['wfStep']);
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.field;
      if (workflow.steps[idx]) {
        workflow.steps[idx][field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
        renderContent();
      }
    });
  });

  // Workflow template dropdown
  container.querySelectorAll('[data-action="set-wf-template"]').forEach(select => {
    select.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLSelectElement} */ (e.target).dataset.idx);
      const tplId = /** @type {HTMLSelectElement} */ (e.target).value;
      const tpl = (refData.templates || []).find(t => t.id === tplId);
      if (tpl && workflow.steps[idx]) {
        workflow.steps[idx].template_id = tpl.id;
        workflow.steps[idx].step_name = tpl.name;
        workflow.steps[idx].process_area = tpl.process_area;
        workflow.steps[idx].labor_category = tpl.labor_category || 'manual';
        workflow.steps[idx].base_uph = tpl.base_uph || 0;
      }
      renderContent();
    });
  });
}

// ============================================================
// ACTIONS
// ============================================================

function handleAction(action, idx) {
  switch (action) {
    case 'add-analysis-line':
      analysis.lines.push(createEmptyAnalysisLine());
      break;
    case 'delete-analysis-line':
      analysis.lines.splice(idx, 1);
      break;
    case 'add-wf-step':
      workflow.steps.push(createEmptyWorkflowStep());
      break;
    case 'delete-wf-step':
      workflow.steps.splice(idx, 1);
      break;
    case 'push-to-cm':
      pushToCostModel();
      return; // don't re-render
  }
  renderContent();
}

// ============================================================
// MOST → COST MODEL INTEGRATION
// ============================================================

function pushToCostModel() {
  const pfd = analysis.pfd_pct || 14;
  const computedLines = analysis.lines.map(line => {
    const derived = calc.computeAnalysisLine({
      base_uph: line.base_uph,
      pfd_pct: pfd,
      daily_volume: line.daily_volume,
      shift_hours: analysis.shift_hours,
      hourly_rate: line.hourly_rate || analysis.hourly_rate,
    });
    return { ...line, ...derived };
  });

  const cmLines = calc.convertToCmLaborLines(computedLines, {
    operatingDays: analysis.operating_days,
    shiftHours: analysis.shift_hours,
    defaultBurdenPct: 30,
  });

  /** @type {import('./types.js').MostToCmPayload} */
  const payload = {
    laborLines: cmLines,
    operatingDays: analysis.operating_days,
    shiftHours: analysis.shift_hours,
  };

  bus.emit('most:push-to-cm', payload);
}

// ============================================================
// HELPERS
// ============================================================

function filterTemplates() {
  return (refData.templates || []).filter(t => {
    if (filters.processArea && t.process_area !== filters.processArea) return false;
    if (filters.laborCategory && t.labor_category !== filters.laborCategory) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!t.name.toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function groupByProcessArea(templates) {
  /** @type {Record<string, import('./types.js').MostTemplate[]>} */
  const groups = {};
  for (const t of templates) {
    const area = t.process_area || 'Other';
    if (!groups[area]) groups[area] = [];
    groups[area].push(t);
  }
  return groups;
}

function createEmptyAnalysis() {
  return {
    id: null,
    name: 'New Analysis',
    allowance_profile_id: null,
    pfd_pct: 14,
    shift_hours: 8,
    operating_days: 260,
    hourly_rate: 18,
    lines: [],
  };
}

function createEmptyAnalysisLine() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
    template_id: null,
    activity_name: '',
    process_area: '',
    labor_category: 'manual',
    uom: 'each',
    base_uph: 0,
    adjusted_uph: 0,
    daily_volume: 0,
    hours_per_day: 0,
    fte: 0,
    headcount: 0,
    hourly_rate: 0,
    daily_cost: 0,
  };
}

function createEmptyWorkflow() {
  return {
    id: null,
    name: 'New Workflow',
    target_volume_per_day: 5000,
    shift_hours: 8,
    pfd_pct: 14,
    steps: [],
  };
}

function createEmptyWorkflowStep() {
  return {
    id: Date.now().toString(),
    template_id: null,
    step_name: '',
    process_area: '',
    labor_category: 'manual',
    base_uph: 0,
    adjusted_uph: 0,
    volume_ratio: 1,
    daily_volume: 0,
    hours_per_day: 0,
    fte: 0,
  };
}

function formatDollar(val) {
  return '$' + (val || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
