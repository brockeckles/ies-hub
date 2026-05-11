/**
 * IES Hub v3 — Tool Frame Helpers
 *
 * Shared primitives for the phase stepper rendered above the Cost Model
 * scope-structure-solution-output-analysis chrome. The broader header/tab
 * primitives that used to live here (`renderToolHeader`, `renderInputGroup`,
 * `renderResultsShelf`, etc.) were superseded by `shared/tool-chrome.js`
 * and dropped 2026-05-11 as part of the port-readiness cleanup.
 *
 * @module shared/tool-frame
 */

/**
 * @typedef {Object} StepperPhase
 * @property {string} key
 * @property {string} label
 * @property {string} [sub]
 * @property {number} [num]
 * @property {'pending'|'active'|'complete'} [status]
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

/**
 * Render a horizontal phase stepper (Scope → Structure → Solution → ...).
 * Used by Cost Model. Caller passes phases + the currently-active key.
 *
 * @param {{ phases: StepperPhase[], activePhase: string }} opts
 * @returns {string}
 */
export function renderPhaseStepper({ phases, activePhase }) {
  if (!Array.isArray(phases) || phases.length === 0) return '';
  const styleFor = (key, status) => {
    if (key === activePhase) return { circleBg: 'var(--ies-blue)', circleFg: '#fff', label: 'var(--ies-blue)', icon: null, ring: true };
    if (status === 'complete') return { circleBg: 'var(--ies-green, #047857)', circleFg: '#fff', label: 'var(--ies-green, #047857)', icon: '✓', ring: false };
    return { circleBg: 'var(--ies-gray-200)', circleFg: 'var(--ies-gray-600)', label: 'var(--ies-gray-600)', icon: null, ring: false };
  };
  return `
    <div class="hub-phase-stepper" style="display:flex;align-items:stretch;gap:0;padding:14px 24px;background:#fff;border-bottom:1px solid var(--ies-gray-200);box-shadow:0 1px 0 rgba(0,0,0,0.02);">
      ${phases.map((p, idx) => {
        const c = styleFor(p.key, p.status);
        const display = c.icon || String(p.num != null ? p.num : (idx + 1));
        const isActive = (p.key === activePhase);
        return `
          <div data-phase="${escapeAttr(p.key)}"
               role="button" tabindex="0"
               style="flex:1;display:flex;align-items:center;gap:12px;cursor:pointer;padding:8px 12px;border-radius:8px;min-width:0;transition:background .15s;${isActive ? 'background:var(--ies-blue-50, #eff6ff);' : ''}"
               onmouseover="this.style.background='${isActive ? 'var(--ies-blue-50, #eff6ff)' : 'var(--ies-gray-50, #f9fafb)'}'"
               onmouseout="this.style.background='${isActive ? 'var(--ies-blue-50, #eff6ff)' : 'transparent'}'"
               title="Jump to ${escapeAttr(p.label)}">
            <div style="width:34px;height:34px;border-radius:50%;background:${c.circleBg};color:${c.circleFg};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0;${c.ring ? 'box-shadow:0 0 0 3px var(--ies-blue-100, #dbeafe);' : ''}">
              ${escapeHtml(display)}
            </div>
            <div style="display:flex;flex-direction:column;line-height:1.25;min-width:0;">
              <span style="font-size:14px;font-weight:700;color:${c.label};letter-spacing:0.2px;">${escapeHtml(p.label)}</span>
              ${p.sub ? `<span style="font-size:11px;color:var(--ies-gray-500);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.sub)}</span>` : ''}
            </div>
          </div>
          ${idx < phases.length - 1 ? `
            <div style="display:flex;align-items:center;color:var(--ies-gray-300);font-size:18px;padding:0 6px;flex-shrink:0;">›</div>
          ` : ''}
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Wire stepper-chip clicks (and Enter keypresses) to a phase-jump callback.
 * Idempotent: removes any prior handler bound to the same container.
 *
 * @param {HTMLElement|null} container
 * @param {(phase: string) => void} onJump
 */
export function bindPhaseStepper(container, onJump) {
  if (!container || typeof onJump !== 'function') return;
  if (container._phaseHandler) container.removeEventListener('click', container._phaseHandler);
  const handler = (e) => {
    const chip = /** @type {HTMLElement} */ (e.target).closest('[data-phase]');
    if (!chip) return;
    const key = chip.getAttribute('data-phase');
    if (key) onJump(key);
  };
  container.addEventListener('click', handler);
  container._phaseHandler = handler;
}

export default { renderPhaseStepper, bindPhaseStepper };
