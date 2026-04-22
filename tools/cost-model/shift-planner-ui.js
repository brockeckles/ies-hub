/**
 * IES Hub v3 — Shift Planner section renderer (render + event handlers)
 *
 * Render returns HTML string; bindEvents wires delegated listeners at the
 * section container level per the v3 event-delegation standard. Calc lives
 * in shift-planner.js; this module is pure DOM.
 *
 * @module tools/cost-model/shift-planner-ui
 */

import {
  FUNCTION_ORDER,
  FUNCTION_META,
  createEmptyShiftAllocation,
  applyArchetype as applyArchetypeCalc,
  resizeAllocation,
  validateShiftMatrix,
  normalizeShiftMatrix,
  deriveShiftHeadcount,
} from './shift-planner.js?v=20260422-xI';

/**
 * Return section HTML.
 * @param {{ model: any, archetypes: any[] }} ctx
 * @returns {string}
 */
export function renderShiftPlanningSection(ctx) {
  const { model, archetypes = [] } = ctx || {};
  if (!model) return '<div class="hub-card" style="padding:16px;">No project loaded.</div>';

  // Lazy-init the allocation if the model hasn't been touched yet.
  const alloc = ensureAllocation(model);
  const shiftCount = alloc.shifts?.length || (model.shifts?.shiftsPerDay || 1);
  const volumes = Array.isArray(model.volumeLines) ? model.volumeLines : [];
  const labor = Array.isArray(model.laborLines) ? model.laborLines : [];
  const shiftsCfg = model.shifts || {};
  const premiumMap = {
    '2': Number(model.laborCosting?.shift2Premium) || 0,
    '3': Number(model.laborCosting?.shift3Premium) || 0,
  };
  const derived = deriveShiftHeadcount(alloc, volumes, labor, shiftsCfg, {
    absenceAllowancePct: Number(model.laborCosting?.absenceAllowancePct) || 0,
    shiftPremiumPct: premiumMap,
  });
  const validation = validateShiftMatrix(alloc);

  const archetypeOptions = archetypes
    .map(a => `<option value="${escape(a.archetype_ref)}" ${alloc.archetypeRef === a.archetype_ref ? 'selected' : ''}>${escape(a.display_name)}</option>`)
    .join('');

  return `
    <div class="shift-planning">
      ${renderHeader(alloc, archetypes, archetypeOptions, validation)}
      ${renderMatrixCard(alloc, shiftCount, validation)}
      ${renderPreviewPanel(derived, shiftCount)}
      ${renderByShiftCard(derived, alloc)}
      ${renderFooterNote(alloc)}
    </div>
    <style>
      .shift-planning { display: flex; flex-direction: column; gap: 16px; }
      .sp-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 16px; }
      .sp-header__title h2 { margin: 0 0 4px 0; font-size: 18px; font-weight: 600; color: var(--ies-navy); }
      .sp-header__title p { margin: 0; font-size: 13px; color: var(--ies-gray-600); max-width: 640px; }
      .sp-archetype-picker { display: flex; gap: 8px; align-items: center; }
      .sp-archetype-picker select { min-width: 240px; padding: 8px 10px; border: 1px solid var(--ies-gray-300); border-radius: 6px; font-size: 13px; }
      .sp-matrix-card { padding: 16px; }
      .sp-matrix-card h3 { margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: var(--ies-navy); display: flex; align-items: center; gap: 8px; }
      .sp-matrix { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; }
      .sp-matrix th { background: var(--ies-gray-50); color: var(--ies-gray-700); font-weight: 600; padding: 10px 8px; text-align: center; border-bottom: 1px solid var(--ies-gray-200); font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
      .sp-matrix th.sp-col-fn { text-align: left; min-width: 140px; }
      .sp-matrix th.sp-col-total { background: var(--ies-gray-100); }
      .sp-matrix th .sp-info { color: var(--ies-gray-400); cursor: help; margin-left: 4px; font-size: 11px; }
      .sp-matrix td { padding: 6px 6px; border-bottom: 1px solid var(--ies-gray-100); vertical-align: middle; }
      .sp-matrix tbody tr:hover { background: var(--ies-gray-50); }
      .sp-matrix td.sp-fn-label { font-weight: 600; color: var(--ies-navy); }
      .sp-matrix td.sp-fn-label .sp-fn-tip { display: block; font-weight: 400; color: var(--ies-gray-500); font-size: 11px; margin-top: 2px; }
      .sp-cell { width: 68px; padding: 6px 8px; border: 1px solid var(--ies-gray-300); border-radius: 4px; text-align: right; font-size: 13px; background: white; }
      .sp-cell:focus { outline: 2px solid var(--ies-blue); outline-offset: -1px; border-color: var(--ies-blue); }
      .sp-row-total { text-align: right; font-weight: 600; color: var(--ies-gray-700); font-variant-numeric: tabular-nums; padding-right: 12px; min-width: 64px; }
      .sp-row-total.sp-off { color: var(--ies-red); }
      .sp-row-total.sp-zero { color: var(--ies-gray-400); font-weight: 400; }
      .sp-row-action { text-align: center; }
      .sp-row-action button { font-size: 11px; padding: 3px 8px; border: 1px solid var(--ies-gray-300); background: white; border-radius: 4px; color: var(--ies-gray-600); cursor: pointer; }
      .sp-row-action button:hover { border-color: var(--ies-blue); color: var(--ies-blue); }
      .sp-col-total-row { font-weight: 600; background: var(--ies-gray-50); }
      .sp-col-total-row td { border-top: 2px solid var(--ies-gray-300); }
      .sp-validation-banner { margin: 8px 0 0 0; padding: 10px 12px; border-radius: 6px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
      .sp-validation-banner.sp-ok    { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
      .sp-validation-banner.sp-bad   { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      .sp-validation-banner button   { padding: 5px 10px; font-size: 12px; border-radius: 4px; border: 1px solid currentColor; background: white; color: inherit; cursor: pointer; }
      .sp-preview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 0; }
      .sp-kpi { background: white; padding: 16px; border: 1px solid var(--ies-gray-200); border-radius: 8px; }
      .sp-kpi__label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ies-gray-500); margin-bottom: 4px; }
      .sp-kpi__value { font-size: 20px; font-weight: 700; color: var(--ies-navy); font-variant-numeric: tabular-nums; }
      .sp-kpi__hint  { font-size: 11px; color: var(--ies-gray-500); margin-top: 4px; }
      .sp-byshift { padding: 16px; }
      .sp-byshift h3 { margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: var(--ies-navy); }
      .sp-byshift-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
      .sp-shift-card { border: 1px solid var(--ies-gray-200); border-radius: 8px; padding: 12px; background: var(--ies-gray-50); }
      .sp-shift-card__header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
      .sp-shift-card__header strong { font-size: 13px; color: var(--ies-navy); }
      .sp-shift-card__header span { font-size: 11px; color: var(--ies-gray-500); }
      .sp-shift-card__metric { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
      .sp-shift-card__metric--bold { font-weight: 600; color: var(--ies-navy); border-top: 1px solid var(--ies-gray-200); padding-top: 6px; margin-top: 4px; }
      .sp-footer-note { font-size: 12px; color: var(--ies-gray-500); padding: 12px 16px 0; font-style: italic; }
    </style>
  `;
}

/**
 * Wire events at the section container level.
 * @param {HTMLElement} container
 * @param {{ model: any, archetypes: any[], onModelChange: () => void, toast?: (msg:string)=>void }} ctx
 */
export function bindShiftPlanningEvents(container, ctx) {
  if (!container || !ctx) return;
  const { model } = ctx;
  const notify = ctx.onModelChange || (() => {});
  const toast = ctx.toast || (() => {});

  // Debounced preview refresh — avoids re-rendering the input while the user
  // is still typing (which would steal focus).
  let debounceHandle = null;

  // Cell edit (delegation on input). Updates model in place, patches the row
  // total + KPI tiles inline, defers a full render to the debounce timer.
  container.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    const cell = target.dataset.spCell;
    if (!cell) return;
    const [fn, idxStr] = cell.split(',');
    const idx = parseInt(idxStr, 10);
    const alloc = ensureAllocation(model);
    if (!alloc.matrix[fn]) return;
    let val = parseFloat(target.value);
    if (!Number.isFinite(val)) val = 0;
    if (val < 0) val = 0;
    if (val > 100) val = 100;
    alloc.matrix[fn][idx] = val;
    alloc.overridden = true;
    alloc.audit = { ...(alloc.audit || {}), lastEditedAt: new Date().toISOString() };

    // Inline patch: update the row total cell in place so typing stays smooth.
    patchRowTotal(container, alloc, fn);

    // Mark dirty now; full re-render (KPI refresh) fires after 450ms of quiet.
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      notify();  // triggers markDirty + full renderSection at the ui.js level
    }, 450);
  });

  // On blur, commit immediately (don't wait for debounce)
  container.addEventListener('blur', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.dataset.spCell) return;
    if (debounceHandle) { clearTimeout(debounceHandle); debounceHandle = null; notify(); }
  }, true);

  // Click delegation (archetype apply, distribute-evenly, normalize, etc.)
  container.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const actionEl = target.closest('[data-sp-action]');
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-sp-action');

    if (action === 'apply-archetype') {
      const select = container.querySelector('[data-sp-archetype-select]');
      if (!(select instanceof HTMLSelectElement)) return;
      const ref = select.value;
      if (!ref) { toast('Pick an archetype first'); return; }
      const arch = (ctx.archetypes || []).find(a => a.archetype_ref === ref);
      if (!arch) { toast('Archetype not found'); return; }
      const shiftsPerDay = model.shifts?.shiftsPerDay || arch.shifts_per_day || 1;
      const hoursPerShift = model.shifts?.hoursPerShift || 8;
      const alloc = applyArchetypeCalc(arch, shiftsPerDay, hoursPerShift);
      model.shiftAllocation = alloc;
      toast(`Applied ${arch.display_name} — matrix seeded across ${shiftsPerDay} shift${shiftsPerDay > 1 ? 's' : ''}`);
      notify();
      return;
    }

    if (action === 'distribute-evenly') {
      const fn = actionEl.getAttribute('data-sp-fn');
      const alloc = ensureAllocation(model);
      if (!alloc.matrix[fn]) return;
      const n = alloc.matrix[fn].length;
      const even = +(100 / n).toFixed(2);
      alloc.matrix[fn] = new Array(n).fill(even);
      // fix drift
      const drift = +(100 - alloc.matrix[fn].reduce((a, v) => a + v, 0)).toFixed(2);
      if (Math.abs(drift) > 0.01) alloc.matrix[fn][0] = +(alloc.matrix[fn][0] + drift).toFixed(2);
      alloc.overridden = true;
      alloc.audit = { ...(alloc.audit || {}), lastEditedAt: new Date().toISOString() };
      notify();
      return;
    }

    if (action === 'clear-row') {
      const fn = actionEl.getAttribute('data-sp-fn');
      const alloc = ensureAllocation(model);
      if (!alloc.matrix[fn]) return;
      alloc.matrix[fn] = new Array(alloc.matrix[fn].length).fill(0);
      alloc.overridden = true;
      alloc.audit = { ...(alloc.audit || {}), lastEditedAt: new Date().toISOString() };
      notify();
      return;
    }

    if (action === 'normalize-all') {
      const alloc = ensureAllocation(model);
      model.shiftAllocation = normalizeShiftMatrix(alloc);
      toast('Rows normalized to sum to 100%');
      notify();
      return;
    }

    if (action === 'reset-matrix') {
      if (!confirm('Clear the entire matrix? Archetype reference will be cleared.')) return;
      const shiftsPerDay = model.shifts?.shiftsPerDay || 1;
      const hoursPerShift = model.shifts?.hoursPerShift || 8;
      model.shiftAllocation = createEmptyShiftAllocation(shiftsPerDay, hoursPerShift);
      toast('Matrix cleared');
      notify();
      return;
    }
  });
}

/**
 * Keep allocation in sync with the project's shifts_per_day. If the user
 * changed shifts_per_day elsewhere, the matrix auto-resizes. Called by the
 * ui.js render path before rendering the section.
 *
 * @param {any} model
 */
export function syncAllocationToShifts(model) {
  if (!model) return;
  const target = model.shifts?.shiftsPerDay || 1;
  const alloc = model.shiftAllocation;
  if (!alloc) return;
  if ((alloc.shifts?.length || 0) !== target) {
    model.shiftAllocation = resizeAllocation(alloc, target, model.shifts?.hoursPerShift || 8);
  }
}

// ============================================================
// INTERNAL — render helpers
// ============================================================

function ensureAllocation(model) {
  if (!model.shiftAllocation) {
    const shiftsPerDay = model.shifts?.shiftsPerDay || 1;
    const hoursPerShift = model.shifts?.hoursPerShift || 8;
    model.shiftAllocation = createEmptyShiftAllocation(shiftsPerDay, hoursPerShift);
  }
  // Safety net: if matrix missing a function key (e.g. from an old persisted
  // record), fill it with zeros so the renderer never crashes on undefined.
  for (const fn of FUNCTION_ORDER) {
    if (!Array.isArray(model.shiftAllocation.matrix[fn])) {
      const n = model.shiftAllocation.shifts?.length || 1;
      model.shiftAllocation.matrix[fn] = new Array(n).fill(0);
    }
  }
  return model.shiftAllocation;
}

function renderHeader(alloc, archetypes, archetypeOptions, validation) {
  const seededHint = alloc.archetypeRef
    ? `<span class="hub-chip hub-chip--info" title="Seeded from archetype">${escape(alloc.archetypeRef)}</span>`
    : alloc.overridden
      ? `<span class="hub-chip hub-chip--neutral">Custom matrix</span>`
      : `<span class="hub-chip hub-chip--neutral">Not set</span>`;
  return `
    <div class="hub-card sp-header">
      <div class="sp-header__title">
        <h2>Shift Planning</h2>
        <p>Set the % of daily throughput by shift for each functional area. Drives the preview below and feeds the Direct Labor grid when lines are set to <strong>Split by matrix</strong>.</p>
        <div style="margin-top: 8px;">${seededHint}</div>
      </div>
      <div class="sp-archetype-picker">
        <select data-sp-archetype-select>
          <option value="">— Apply Archetype —</option>
          ${archetypeOptions}
        </select>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-sp-action="apply-archetype">Apply</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-sp-action="reset-matrix" title="Clear matrix + archetype reference">Reset</button>
      </div>
    </div>
  `;
}

function renderMatrixCard(alloc, shiftCount, validation) {
  const shiftHeaders = alloc.shifts.map(s =>
    `<th class="hub-num">S${s.num}<br><span style="font-weight:400;color:var(--ies-gray-500);text-transform:none;">${fmtHour(s.startHour)}–${fmtHour(s.endHour)}</span></th>`
  ).join('');

  const rows = FUNCTION_ORDER.map(fn => {
    const row = alloc.matrix[fn];
    const sum = row.reduce((a, v) => a + (Number(v) || 0), 0);
    const zero = sum === 0;
    const off = !zero && Math.abs(sum - 100) > 0.5;
    const totalClass = zero ? 'sp-zero' : off ? 'sp-off' : '';
    const cells = row.map((v, i) =>
      `<td class="hub-num"><input class="sp-cell" type="number" min="0" max="100" step="1" value="${Number(v) || 0}" data-sp-cell="${fn},${i}" aria-label="${FUNCTION_META[fn]?.label || fn} S${i + 1}" /></td>`
    ).join('');
    return `
      <tr>
        <td class="sp-fn-label">${escape(FUNCTION_META[fn]?.label || fn)}
          <span class="sp-fn-tip">${escape(FUNCTION_META[fn]?.tip || '')}</span>
        </td>
        ${cells}
        <td class="sp-row-total ${totalClass}">${zero ? '—' : sum.toFixed(0) + '%'}</td>
        <td class="sp-row-action">
          <button type="button" data-sp-action="distribute-evenly" data-sp-fn="${fn}" title="Distribute evenly across shifts">↔ Even</button>
          <button type="button" data-sp-action="clear-row" data-sp-fn="${fn}" title="Clear this function (not used)">Clear</button>
        </td>
      </tr>
    `;
  }).join('');

  // "Shift workload mix" — normalized column totals expressed as a share
  // of the total matrix points. Rows each sum to 100 across shifts, so the
  // column sums add up to (8 × 100) = 800 at most; this divides by the
  // actual grand total (which can be <800 if some rows are zero-filled /
  // unused, like cold-chain Pack or cross-dock Put-Away). Result is a
  // percentage per shift that reads directly as "Shift 2 carries 48% of
  // the work" — much clearer than the raw point total.
  const rawColSums = alloc.shifts.map((_, i) => {
    let s = 0;
    for (const fn of FUNCTION_ORDER) s += Number(alloc.matrix[fn][i]) || 0;
    return s;
  });
  const grandTotal = rawColSums.reduce((a, v) => a + v, 0);
  const colMixPct = rawColSums.map(s => grandTotal > 0 ? (s / grandTotal * 100) : 0);

  const validationBanner = validation.valid
    ? ''
    : `<div class="sp-validation-banner sp-bad">
         <span>
           <strong>Rows not summing to 100%:</strong>
           ${validation.offenders.map(o => `${escape(FUNCTION_META[o.fn]?.label || o.fn)} (${o.sum.toFixed(1)}%)`).join(', ')}
         </span>
         <button type="button" data-sp-action="normalize-all">Normalize All</button>
       </div>`;

  return `
    <div class="hub-card sp-matrix-card">
      <h3>Throughput Matrix — % of daily volume by shift × function</h3>
      <div style="overflow-x:auto;">
        <table class="sp-matrix">
          <thead>
            <tr>
              <th class="sp-col-fn">Functional area</th>
              ${shiftHeaders}
              <th class="sp-col-total">Row total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
          <tfoot>
            <tr class="sp-col-total-row" title="Share of total matrix workload — normalized so the row sums to 100%. Tells you which shift carries the most work.">
              <td>Shift workload mix</td>
              ${colMixPct.map(c => `<td class="hub-num" style="text-align:right;">${c.toFixed(0)}%</td>`).join('')}
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      ${validationBanner}
    </div>
  `;
}

function renderPreviewPanel(derived, shiftCount) {
  const totalHc = derived.totals.directHc || 0;
  const peakShift = derived.totals.peakShift;
  const peakShiftHc = peakShift ? (derived.byShift[peakShift - 1]?.directHc || 0) : 0;
  const laborAnnual = derived.totals.costAnnual || 0;
  const premiumAnnual = derived.totals.premiumAnnual || 0;
  return `
    <div class="sp-preview-grid">
      <div class="sp-kpi">
        <div class="sp-kpi__label">Total Direct HC</div>
        <div class="sp-kpi__value">${totalHc}</div>
        <div class="sp-kpi__hint">Across ${shiftCount} shift${shiftCount > 1 ? 's' : ''}</div>
      </div>
      <div class="sp-kpi">
        <div class="sp-kpi__label">Peak Shift HC</div>
        <div class="sp-kpi__value">${peakShiftHc}</div>
        <div class="sp-kpi__hint">${peakShift ? `Shift ${peakShift}` : 'No shift peaks — matrix is empty or flat'}</div>
      </div>
      <div class="sp-kpi">
        <div class="sp-kpi__label">Labor $/yr</div>
        <div class="sp-kpi__value">${fmtDollars(laborAnnual)}</div>
        <div class="sp-kpi__hint">Implied from matrix × UPH × loaded rate</div>
      </div>
      <div class="sp-kpi">
        <div class="sp-kpi__label">Shift Premium $/yr</div>
        <div class="sp-kpi__value">${fmtDollars(premiumAnnual)}</div>
        <div class="sp-kpi__hint">From S2 / S3 premium %</div>
      </div>
    </div>
  `;
}

function renderByShiftCard(derived, alloc) {
  const cards = (derived.byShift || []).map((s, i) => {
    const shiftMeta = alloc.shifts[i] || {};
    const pctOfHc = derived.totals.directHc > 0 ? (s.directHc / derived.totals.directHc * 100) : 0;
    return `
      <div class="sp-shift-card">
        <div class="sp-shift-card__header">
          <strong>Shift ${s.num}</strong>
          <span>${fmtHour(shiftMeta.startHour)}–${fmtHour(shiftMeta.endHour)}</span>
        </div>
        <div class="sp-shift-card__metric">
          <span>Direct HC</span><span>${s.directHc}</span>
        </div>
        <div class="sp-shift-card__metric">
          <span>% of total</span><span>${pctOfHc.toFixed(0)}%</span>
        </div>
        <div class="sp-shift-card__metric">
          <span>Hours/yr</span><span>${fmtCompact(s.hours)}</span>
        </div>
        <div class="sp-shift-card__metric sp-shift-card__metric--bold">
          <span>Labor $/yr</span><span>${fmtDollars(s.costAnnual)}</span>
        </div>
        ${s.premiumAnnual > 0 ? `
          <div class="sp-shift-card__metric" style="color:var(--ies-gray-600);">
            <span>+ Premium $/yr</span><span>${fmtDollars(s.premiumAnnual)}</span>
          </div>` : ''}
      </div>
    `;
  }).join('');
  return `
    <div class="hub-card sp-byshift">
      <h3>Shift Breakdown</h3>
      <div class="sp-byshift-grid">${cards || '<div style="padding:16px;color:var(--ies-gray-500);font-size:13px;">No shift data yet. Apply an archetype or fill the matrix.</div>'}</div>
    </div>
  `;
}

function renderFooterNote(alloc) {
  const ts = alloc.audit?.lastEditedAt
    ? new Date(alloc.audit.lastEditedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  const seedTs = alloc.audit?.seededAt
    ? new Date(alloc.audit.seededAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  return `
    <div class="sp-footer-note">
      ${seedTs ? `Seeded ${seedTs}` : 'Not yet seeded'}
      ${ts ? ` · Last edited ${ts}` : ''}
      · Matrix changes save when you click Save elsewhere in the project.
    </div>
  `;
}

// ============================================================
// formatters
// ============================================================

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtHour(h) {
  if (h == null || !Number.isFinite(Number(h))) return '—';
  const hr = Math.round(Number(h));
  if (hr === 0 || hr === 24) return '12a';
  if (hr === 12) return '12p';
  if (hr < 12) return `${hr}a`;
  return `${hr - 12}p`;
}

function fmtDollars(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * Patch the row-total cell in place (no full re-render) so typing stays smooth.
 */
function patchRowTotal(container, alloc, fn) {
  const row = alloc.matrix[fn];
  if (!Array.isArray(row)) return;
  const sum = row.reduce((a, v) => a + (Number(v) || 0), 0);
  const zero = sum === 0;
  const off = !zero && Math.abs(sum - 100) > 0.5;
  // Find the row total cell for this fn. Each row's total follows after all
  // its data-sp-cell inputs; use a scoped selector.
  const firstCell = container.querySelector(`[data-sp-cell="${fn},0"]`);
  if (!firstCell) return;
  const tr = firstCell.closest('tr');
  if (!tr) return;
  const totalCell = tr.querySelector('.sp-row-total');
  if (!totalCell) return;
  totalCell.classList.remove('sp-off', 'sp-zero');
  if (zero) { totalCell.classList.add('sp-zero'); totalCell.textContent = '—'; }
  else {
    if (off) totalCell.classList.add('sp-off');
    totalCell.textContent = sum.toFixed(0) + '%';
  }
}

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}
