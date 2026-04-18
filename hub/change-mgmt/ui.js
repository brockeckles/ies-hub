/**
 * IES Hub v3 — Change Management UI
 * Initiative tracker with readiness scoring, timeline, and stakeholder analysis.
 *
 * @module hub/change-mgmt/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sG';
import * as calc from './calc.js?v=20260418-sG';

/** @type {HTMLElement|null} */
let rootEl = null;
let activeView = 'list'; // list | detail | timeline
let activeInitiative = null;
let statusFilter = 'all';
let initiatives = calc.DEMO_INITIATIVES.map(i => ({ ...i }));

export async function mount(el) {
  rootEl = el;
  activeView = 'list';
  activeInitiative = null;
  statusFilter = 'all';
  el.innerHTML = renderShell();
  bindEvents();
  renderContent();
  bus.emit('change-mgmt:mounted');
}

let adkarPhases = [
  { phase: 'Awareness', status: 'completed', description: 'Communicate why change is necessary and business drivers', activities: ['Executive kickoff meeting', 'Stakeholder interviews', 'Draft change impact assessment', 'Communication plan finalized'] },
  { phase: 'Desire', status: 'in-progress', description: 'Build motivation and desire to participate in and support change', activities: ['Launch newsletter series', 'Town halls with Q&A', 'Early wins highlighted', 'Champions network activated'] },
  { phase: 'Knowledge', status: 'planned', description: 'Provide knowledge and how-to information to support the change', activities: ['Training curriculum drafted', 'Pilot group identified', 'Knowledge base articles', 'Train-the-trainer program'] },
  { phase: 'Ability', status: 'not-started', description: 'Enable people to demonstrate the skills and behaviors required', activities: ['Hands-on workshops', 'Job aids and checklists', 'Practice environments', 'Coaching support'] },
  { phase: 'Reinforcement', status: 'not-started', description: 'Sustain the change through reinforcement and continued support', activities: ['Performance monitoring', 'Feedback loops', 'Recognition programs', 'Continuous improvement review'] },
];

export function unmount() { rootEl = null; bus.emit('change-mgmt:unmounted'); }

function renderShell() {
  return `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 class="text-page" style="margin:0;">Change Management</h2>
        <div style="display:flex;gap:8px;" id="cm-tabs">
          <button class="hub-btn hub-btn-sm ${activeView === 'list' ? '' : 'hub-btn-secondary'}" data-view="list">Initiatives</button>
          <button class="hub-btn hub-btn-sm ${activeView === 'board' ? '' : 'hub-btn-secondary'}" data-view="board">Board</button>
          <button class="hub-btn hub-btn-sm ${activeView === 'adkar' ? '' : 'hub-btn-secondary'}" data-view="adkar">ADKAR Framework</button>
          <button class="hub-btn hub-btn-sm ${activeView === 'timeline' ? '' : 'hub-btn-secondary'}" data-view="timeline">Timeline</button>
        </div>
      </div>
      <div id="cm-content"></div>
    </div>
  `;
}

function bindEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Tab clicks
    const viewBtn = target.closest('[data-view]');
    if (viewBtn) {
      activeView = /** @type {HTMLElement} */ (viewBtn).dataset.view;
      activeInitiative = null;
      rootEl.innerHTML = renderShell();
      renderContent();
      return;
    }

    // Filter buttons
    const filterBtn = target.closest('[data-filter]');
    if (filterBtn) {
      statusFilter = /** @type {HTMLElement} */ (filterBtn).dataset.filter;
      const el = rootEl.querySelector('#cm-content');
      if (el) renderList(el);
      return;
    }

    // Initiative card click
    const initCard = target.closest('[data-initiative]');
    if (initCard) {
      activeInitiative = initiatives.find(i => i.id === /** @type {HTMLElement} */ (initCard).dataset.initiative);
      activeView = 'detail';
      rootEl.innerHTML = renderShell();
      renderContent();
      return;
    }

    // Back button
    if (target.closest('#cm-back')) {
      activeView = 'list'; activeInitiative = null;
      rootEl.innerHTML = renderShell();
      renderContent();
      return;
    }
  });
}

function renderContent() {
  const el = rootEl?.querySelector('#cm-content');
  if (!el) return;

  if (activeView === 'detail' && activeInitiative) { renderDetail(el); return; }
  if (activeView === 'adkar') { renderAdkar(el); return; }
  if (activeView === 'timeline') { renderTimeline(el); return; }
  if (activeView === 'board') { renderBoard(el); return; }
  renderList(el);
}

// ===== BOARD / KANBAN VIEW =====
function renderBoard(el) {
  const phases = ['Awareness', 'Desire', 'Knowledge', 'Ability', 'Reinforcement'];
  const phaseColors = { 'Awareness': '#2563eb', 'Desire': '#7c3aed', 'Knowledge': '#d97706', 'Ability': '#ea580c', 'Reinforcement': '#16a34a' };
  const byPhase = new Map(phases.map(p => [p, []]));
  for (const i of initiatives) {
    // Map initiative to its current ADKAR phase — use the first incomplete phase if available,
    // otherwise fallback to Awareness.
    const phase = i.currentAdkarPhase || i.phase || 'Awareness';
    if (byPhase.has(phase)) byPhase.get(phase).push(i);
    else byPhase.get('Awareness').push(i);
  }
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(${phases.length},1fr);gap:10px;overflow-x:auto;">
      ${phases.map(p => {
        const items = byPhase.get(p) || [];
        const color = phaseColors[p];
        return `
          <div style="min-width:200px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding-bottom:8px;border-bottom:3px solid ${color};">
              <span style="font-size:12px;font-weight:800;color:${color};">${p}</span>
              <span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--ies-gray-400);">${items.length}</span>
            </div>
            ${items.length === 0 ? '<div style="font-size:11px;color:var(--ies-gray-300);padding:8px;">No initiatives</div>' : items.map(init => `
              <div class="hub-card" style="padding:10px;margin-bottom:8px;cursor:pointer;border-left:3px solid ${color};" data-initiative="${init.id}">
                <div style="font-size:12px;font-weight:700;margin-bottom:4px;">${init.title || init.name || 'Untitled'}</div>
                <div style="font-size:10px;color:var(--ies-gray-400);margin-bottom:4px;">${init.owner || 'Unassigned'}</div>
                <div style="font-size:10px;color:var(--ies-gray-500);">${init.status || 'active'} · Priority ${init.priority || 'P2'}</div>
              </div>
            `).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ===== LIST VIEW =====
function renderList(el) {
  const stats = calc.computeStats(initiatives);
  const filtered = calc.filterByStatus(initiatives, statusFilter);
  const sorted = calc.sortInitiatives(filtered, 'priority', 'desc');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
      ${kpiCard('Total', stats.totalInitiatives, '#2563eb')}
      ${kpiCard('Active', stats.activeInitiatives, '#16a34a')}
      ${kpiCard('Milestones Done', `${stats.completedMilestones}/${stats.totalMilestones}`, '#7c3aed')}
      ${kpiCard('At Risk', stats.overdueMilestones + stats.resistantCount, '#dc2626')}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      ${['all', 'planning', 'in-progress', 'completed', 'on-hold'].map(s => `
        <button class="hub-btn hub-btn-sm ${s === statusFilter ? '' : 'hub-btn-secondary'}" data-filter="${s}">${s === 'all' ? 'All' : s}</button>
      `).join('')}
    </div>
    ${sorted.map(init => {
      const readiness = calc.computeReadiness(init);
      return `
        <div class="hub-card" style="margin-bottom:12px;cursor:pointer;padding:16px;" data-initiative="${init.id}">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
            <span style="font-size:15px;font-weight:700;flex:1;">${init.title}</span>
            <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${calc.statusBadge(init.status)};">${init.status}</span>
            <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${calc.priorityBadge(init.priority)};">${init.priority}</span>
          </div>
          <div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:8px;">${init.description.slice(0, 120)}${init.description.length > 120 ? '...' : ''}</div>
          <div style="display:flex;align-items:center;gap:16px;font-size:11px;color:var(--ies-gray-400);">
            <span>Owner: ${init.owner}</span>
            <span>Target: ${calc.formatDate(init.targetDate)}</span>
            <span style="margin-left:auto;display:flex;align-items:center;gap:4px;">
              Readiness: <span style="font-weight:700;color:${calc.ratingColor(readiness.overall)};">${readiness.overall}%</span>
            </span>
          </div>
        </div>
      `;
    }).join('')}
  `;

  // Event delegation handles filter and initiative clicks at root level
}

// ===== DETAIL VIEW =====
function renderDetail(el) {
  const init = activeInitiative;
  if (!init) return;
  const readiness = calc.computeReadiness(init);
  const groups = calc.groupBySentiment(init.stakeholders || []);
  const atRisk = calc.atRiskStakeholders(init.stakeholders || []);

  el.innerHTML = `
    <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cm-back" style="margin-bottom:16px;">← Back to Initiatives</button>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <h3 style="font-size:18px;font-weight:800;margin:0;flex:1;">${init.title}</h3>
      <span style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;color:#fff;background:${calc.statusBadge(init.status)};">${init.status}</span>
    </div>
    <div style="font-size:13px;color:var(--ies-gray-500);margin-bottom:20px;">${init.description}</div>

    <!-- Readiness Score -->
    <div class="hub-card" style="padding:16px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Change Readiness</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
        ${scoreCircle('Overall', readiness.overall)}
        ${scoreCircle('Milestones', readiness.milestoneScore)}
        ${scoreCircle('Stakeholders', readiness.stakeholderScore)}
        ${scoreCircle('Comms', readiness.communicationScore)}
      </div>
    </div>

    <!-- Milestones -->
    <div class="hub-card" style="padding:16px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Milestones</div>
      ${(init.milestones || []).map(m => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--ies-gray-100);">
          <span style="width:10px;height:10px;border-radius:50%;background:${calc.statusBadge(m.status)};flex-shrink:0;"></span>
          <span style="font-size:13px;flex:1;">${m.title}</span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${calc.formatDate(m.dueDate)}</span>
          <span style="font-size:11px;font-weight:700;color:${calc.statusBadge(m.status)};">${m.status}</span>
        </div>
      `).join('')}
    </div>

    <!-- Stakeholders -->
    <div class="hub-card" style="padding:16px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="font-size:13px;font-weight:700;">Stakeholders</span>
        ${atRisk.length > 0 ? `<span style="font-size:11px;color:#dc2626;font-weight:700;">${atRisk.length} at risk</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">
        ${['champion', 'supporter', 'neutral', 'resistant'].map(sentiment => `
          <div style="padding:8px;border-radius:6px;background:var(--ies-gray-50);">
            <div style="font-size:11px;font-weight:700;color:${calc.statusBadge(sentiment)};text-transform:uppercase;margin-bottom:4px;">${sentiment} (${(groups[sentiment] || []).length})</div>
            ${(groups[sentiment] || []).map(s => `
              <div style="font-size:12px;padding:2px 0;">${s.name} <span style="color:var(--ies-gray-400);">— ${s.role}</span></div>
            `).join('') || '<div style="font-size:11px;color:var(--ies-gray-300);">None</div>'}
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Communications -->
    <div class="hub-card" style="padding:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Communications</div>
      ${(init.communications || []).map(c => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--ies-gray-100);">
          <span style="font-size:13px;flex:1;">${c.title}</span>
          <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#f3f4f6;color:#6b7280;">${c.type}</span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${calc.formatDate(c.date)}</span>
          <span style="font-size:11px;font-weight:700;color:${calc.statusBadge(c.status)};">${c.status}</span>
        </div>
      `).join('')}
    </div>
  `;

  // Back button handled by delegated events at root level
}

// ===== ADKAR FRAMEWORK VIEW =====
function renderAdkar(el) {
  const statusColors = {
    'not-started': '#d1d5db',
    'planned': '#fbbf24',
    'in-progress': '#3b82f6',
    'completed': '#10b981',
  };

  el.innerHTML = `
    <div style="max-width:1200px;">
      <div style="margin-bottom:24px;">
        <h3 class="text-section" style="margin:0 0 8px 0;">ADKAR Change Management Framework</h3>
        <p style="font-size:13px;color:var(--ies-gray-400);margin:0;">The ADKAR model (Awareness, Desire, Knowledge, Ability, Reinforcement) provides a structured approach to organizational change.</p>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;">
        ${adkarPhases.map((phase, idx) => `
          <div class="hub-card" style="padding:20px;border-top:4px solid ${statusColors[phase.status]};">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <h4 style="font-size:15px;font-weight:700;margin:0;flex:1;">${idx + 1}. ${phase.phase}</h4>
              <span style="display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${statusColors[phase.status]};text-transform:capitalize;">${phase.status.replace('-', ' ')}</span>
            </div>
            <p style="font-size:13px;color:var(--ies-gray-600);margin:0 0 12px 0;line-height:1.5;">${phase.description}</p>
            <div style="border-top:1px solid var(--ies-gray-200);padding-top:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;margin-bottom:8px;">Key Activities</div>
              <ul style="margin:0;padding-left:16px;font-size:13px;">
                ${phase.activities.map(activity => `<li style="margin:4px 0;color:var(--ies-gray-600);">${activity}</li>`).join('')}
              </ul>
            </div>
          </div>
        `).join('')}
      </div>

      <!-- ADKAR Explanation -->
      <div class="hub-card" style="padding:20px;margin-top:24px;background:#f9fafb;">
        <div style="font-size:13px;font-weight:700;color:var(--ies-gray-700);margin-bottom:12px;">Framework Overview</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;font-size:13px;line-height:1.6;color:var(--ies-gray-600);">
          <div>
            <strong style="color:var(--ies-gray-700);">Awareness</strong> — Help people understand why change is happening. Share business drivers, market pressures, and strategic rationale. One-way communication: leadership to employee.
          </div>
          <div>
            <strong style="color:var(--ies-gray-700);">Desire</strong> — Build personal motivation to engage. Use incentives, success stories, and champions. Create psychological safety. Two-way dialogue and listening.
          </div>
          <div>
            <strong style="color:var(--ies-gray-700);">Knowledge</strong> — Provide training, documentation, and learning resources. Ensure people have the information needed to execute the change effectively.
          </div>
          <div>
            <strong style="color:var(--ies-gray-700);">Ability</strong> — Enable demonstrated performance through practice, coaching, and feedback. Remove barriers and provide job aids. Measure competency.
          </div>
          <div>
            <strong style="color:var(--ies-gray-700);">Reinforcement</strong> — Sustain the change through recognition, continued coaching, and monitoring. Prevent backsliding. Celebrate wins and document lessons learned.
          </div>
        </div>
      </div>
    </div>
  `;
}

// ===== TIMELINE VIEW =====
function renderTimeline(el) {
  const timeline = calc.buildTimeline(initiatives);
  const typeIcons = { start: '🟢', target: '🎯', milestone: '📍', communication: '📨' };

  el.innerHTML = `
    <div style="max-width:700px;">
      ${timeline.map((evt, i) => {
        const isNewDate = i === 0 || timeline[i - 1].date !== evt.date;
        return `
          ${isNewDate ? `<div style="font-size:12px;font-weight:700;color:var(--ies-gray-500);margin:${i > 0 ? '16px' : '0'} 0 8px 0;">${calc.formatDate(evt.date)}</div>` : ''}
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-left:3px solid ${calc.statusBadge(evt.status)};margin-bottom:4px;background:var(--ies-gray-50);border-radius:0 6px 6px 0;">
            <span style="font-size:14px;">${typeIcons[evt.type] || '📌'}</span>
            <span style="font-size:13px;flex:1;">${evt.title}</span>
            <span style="font-size:11px;font-weight:700;color:${calc.statusBadge(evt.status)};">${evt.status}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ===== HELPERS =====
function kpiCard(label, value, color) {
  return `
    <div class="hub-card" style="padding:12px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${label}</div>
    </div>
  `;
}

function scoreCircle(label, score) {
  return `
    <div style="text-align:center;">
      <div style="font-size:22px;font-weight:800;color:${calc.ratingColor(score)};">${score}%</div>
      <div style="font-size:11px;color:var(--ies-gray-400);">${label}</div>
    </div>
  `;
}
