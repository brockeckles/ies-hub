/**
 * IES Hub v3 — Cost Model: Implementation Timeline renderer
 *
 * Pure renderer (no DOM, no module-level state). Returns the HTML
 * string for the Implementation section — phase-by-phase plan with
 * staffing ramp, startup-line callouts, and per-line annual costs.
 *
 * Extracted from `cost-model/ui.js` 2026-05-11 (S14). Original was a
 * top-level function that reached into 5 module-level `model.*`
 * fields and 4 calc functions; this version takes both as a single
 * options bag.
 *
 * @module tools/cost-model/render-implementation
 */

export function renderImplementation(opts) {
  const { model, calc, createEmptyModel, escapeAttr, escapeHtml, renderImplPhaseStepperContent, renderImplRampPanel } = opts || {};
  // Lazy-init for legacy models that pre-date the section
  if (!model.implementationTimeline) {
    model.implementationTimeline = createEmptyModel().implementationTimeline;
  }
  const it = model.implementationTimeline;
  const phases = Array.isArray(it.phases) ? it.phases : [];
  const volumeRamp = Array.isArray(it.volumeRamp) ? it.volumeRamp : [];
  const headcountRamp = Array.isArray(it.headcountRamp) ? it.headcountRamp : [];

  // Compute total implementation timeline span (max end-week across all phases)
  const totalWeeks = phases.reduce((mx, ph) =>
    Math.max(mx, (Number(ph.startWeek) || 0) + (Number(ph.durationWeeks) || 0)), 0
  ) || 24;
  const goLiveWeek = Number(it.goLiveWeek) || 16;
  const rampMonths = Number(it.rampMonths) || volumeRamp.length || 6;

  // Pull steady-state metrics from current model so the ramp curves
  // have real $/FTE numbers to project against.
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || {};
  const totalFtes = (model.laborLines || []).reduce((s, l) => s + calc.fte(l, opHrs), 0);
  const steadyDirectCost = (model.laborLines || []).reduce((s, l) =>
    s + calc.directLineAnnualSimple(l, lc), 0);
  const steadyMonthlyCost = steadyDirectCost / 12;

  // Total implementation spend = sum of startupLines (one-time setup outlay).
  // Field is `one_time_cost` (verified live 2026-04-27 — earlier `cost`/`annual_cost`
  // fallback chain returned 0 since neither field exists on startup line records).
  const totalImplSpend = (model.startupLines || []).reduce((s, l) =>
    s + (Number(l.one_time_cost) || Number(l.cost) || Number(l.annual_cost) || 0), 0);

  // Build week-bar Gantt — week ticks every 4 weeks for readability
  const tickInterval = totalWeeks <= 16 ? 2 : 4;
  const ticks = [];
  for (let w = 0; w <= totalWeeks; w += tickInterval) ticks.push(w);
  if (ticks[ticks.length - 1] !== totalWeeks) ticks.push(totalWeeks);

  return `
    <div class="cm-section-header">
      <div class="cm-section-header__intro">
        <div>
          <h2>Implementation <span class="hub-status-chip cm-chip-info cm-chip-xs">project plan</span></h2>
          <div class="cm-section-desc">Phase plan + ramp curves from contract sign through steady-state. Volume / headcount ramp scales the steady-state numbers from <strong>Labor</strong> and <strong>Volumes</strong> across months 1-${rampMonths} after go-live.</div>
        </div>
      </div>
    </div>

    <!-- 2026-04-30 (G7): removed orphan \${hiddenStripHtml} reference —
         that variable is only declared inside renderOperationalFlow.
         The stale copy-paste threw ReferenceError on every Implementation
         render; the exception aborted container.innerHTML = render(), so
         the prior section's HTML stayed visible (which is why R2 was
         mis-diagnosed as a "false alarm" in the 2026-04-29 audit). -->

    <!-- KPI strip -->
    <div class="hub-kpi-strip" style="margin-bottom:16px;">
      <div class="hub-kpi-tile" title="Calendar week of contract start when ops officially begin handling volume">
        <div class="hub-kpi-tile__label">Go-Live Week</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">W${goLiveWeek}</div>
      </div>
      <div class="hub-kpi-tile" title="Months from go-live to steady-state operations">
        <div class="hub-kpi-tile__label">Ramp Period</div>
        <div class="hub-kpi-tile__value">${rampMonths} mo</div>
      </div>
      <div class="hub-kpi-tile" title="Total implementation phases on the plan">
        <div class="hub-kpi-tile__label">Phases</div>
        <div class="hub-kpi-tile__value">${phases.length}</div>
      </div>
      <div class="hub-kpi-tile" title="Sum of all start-up lines — one-time outlay before steady-state operations">
        <div class="hub-kpi-tile__label">Implementation Spend</div>
        <div class="hub-kpi-tile__value" style="color:var(--ies-orange, #ff3a00);">${calc.formatCurrency(totalImplSpend)}</div>
      </div>
    </div>

    <!-- 2026-04-28 — internal phase stepper. Plan / Ramp / Forecast.
         Plan = Timeline Settings + Phase Plan (the WHAT/WHEN of phases).
         Ramp = Volume + Headcount ramp curves (HOW intensity climbs).
         Forecast = read-only Ramp Burn Estimate (what those choices imply).
         Per EVE2 design-SME convo Item #2 — stepper INSIDE a CM section,
         not over the whole workbook. -->
    <div id="cm-impl-stepper" style="margin-bottom:16px;border-radius:8px;overflow:hidden;">${renderImplPhaseStepperContent()}</div>

    ${activeImplPhase === 'plan' ? `
    <!-- 2026-04-27 — Settings moved to TOP per Brock's feedback. These two
         scalars (Go-Live Week + Ramp Period) drive the totalWeeks math
         and the ramp array shapes, so they belong before the things they
         drive, not buried at the bottom. -->
    <div class="cm-card" style="margin-bottom:16px;">
      <div class="cm-section-header__intro" style="margin-bottom:8px;">
        <div>
          <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Timeline Settings</h3>
          <div class="cm-subtle" style="font-size:12px;">Go-Live + Ramp Period drive the Gantt scale and the ramp tables below.</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:14px;">
        <div class="hub-field">
          <label class="hub-field__label">Go-Live Week (W#)</label>
          <input class="hub-input hub-num" type="number" min="0" step="1" value="${goLiveWeek}" data-field-direct="implementationTimeline.goLiveWeek" data-type="number" />
          <div class="hub-field__hint">Week of contract start when operations begin.</div>
        </div>
        <div class="hub-field">
          <label class="hub-field__label">Ramp Period (months)</label>
          <input class="hub-input hub-num" type="number" min="1" max="24" step="1" value="${rampMonths}" data-field-direct="implementationTimeline.rampMonths" data-type="number" />
          <div class="hub-field__hint">Months from go-live to steady-state. Click <strong>Resize Ramps</strong> if you change this.</div>
        </div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="impl-resize-ramps" title="Re-shape volume + headcount ramp arrays to match the Ramp Period above">Resize Ramp Curves</button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="impl-reset-defaults" title="Reset all phases + ramp curves to defaults">Reset to Defaults</button>
      </div>
    </div>

    <!-- Phase Gantt -->
    <div class="cm-card" style="margin-bottom:16px;">
      <div class="cm-section-header__intro" style="margin-bottom:12px;">
        <div>
          <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Phase Plan</h3>
          <div class="cm-subtle" style="font-size:12px;">Edit Start Week / Duration in the table below to reshape. Bars above visualize the schedule.</div>
        </div>

      </div>

      <!-- Gantt visualization. padding-right of 24px reserves a gutter for
           the rightmost ruler label (e.g. W40) which previously clipped
           when totalWeeks landed on a tick boundary. -->
      <div class="cm-impl-gantt" style="margin:8px 0 16px;padding-right:24px;">
        <div class="cm-impl-gantt__ruler">
          <div class="cm-impl-gantt__ruler-label">&nbsp;</div>
          <div class="cm-impl-gantt__ruler-track" style="position:relative;height:18px;border-bottom:1px solid var(--ies-gray-200);">
${(() => {
              // 2026-04-27 AM7: right-align the LAST tick's label (the one at 100%)
              // instead of left-aligning it, so it doesn't extend past the gantt
              // right edge. All earlier ticks keep the left-of-line layout because
              // their right-side neighbours give the label room to breathe.
              const lastIdx = ticks.length - 1;
              return ticks.map((w, i) => {
                const isLast = i === lastIdx;
                const labelStyle = isLast
                  ? 'position:absolute;top:0;right:2px;font-size:10px;color:var(--ies-gray-500);font-weight:600;'
                  : 'position:absolute;top:0;left:2px;font-size:10px;color:var(--ies-gray-500);font-weight:600;';
                return `
              <div style="position:absolute;left:${(w / totalWeeks * 100).toFixed(2)}%;top:0;bottom:0;border-left:1px dashed var(--ies-gray-200);">
                <span style="${labelStyle}">W${w}</span>
              </div>`;
              }).join('');
            })()}
            <div style="position:absolute;left:${(goLiveWeek / totalWeeks * 100).toFixed(2)}%;top:-4px;bottom:-4px;border-left:2px solid var(--ies-green,#16a34a);" title="Go-Live (W${goLiveWeek})">
              <span style="position:absolute;top:-14px;left:-26px;font-size:9px;font-weight:700;color:var(--ies-green,#16a34a);background:#fff;padding:1px 4px;border-radius:3px;border:1px solid var(--ies-green,#16a34a);white-space:nowrap;">GO-LIVE</span>
            </div>
          </div>
        </div>
        ${phases.map((ph, i) => {
          const startPct = (Number(ph.startWeek) || 0) / totalWeeks * 100;
          const widthPct = Math.max(0.5, (Number(ph.durationWeeks) || 0) / totalWeeks * 100);
          return `
            <div class="cm-impl-gantt__row">
              <div class="cm-impl-gantt__ruler-label" title="${escapeAttr(ph.name || '')}">${escapeHtml(ph.name || `Phase ${i + 1}`)}</div>
              <div class="cm-impl-gantt__ruler-track" style="position:relative;height:24px;">
                <div class="cm-impl-gantt__bar" style="position:absolute;left:${startPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;top:4px;bottom:4px;background:${ph.color || 'var(--ies-blue)'};border-radius:4px;display:flex;align-items:center;padding:0 6px;color:#fff;font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeAttr(ph.name)} — W${ph.startWeek} to W${(ph.startWeek || 0) + (ph.durationWeeks || 0)} (${ph.durationWeeks}w)${ph.owner ? ' · ' + ph.owner : ''}">
                  ${escapeHtml(ph.owner || '')} · ${ph.durationWeeks}w
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Editable phase table. 2026-04-27 — Add Phase button moved
           to a strip directly above the table (was in the card-header
           actions slot, which sat above the GANTT, not the table — Brock
           feedback that adds-go-here-not-up-there). Phase column widened
           from 32 to 40 percent so longer phase names do not truncate. -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0 6px;">
        <div style="font-size:12px;color:var(--ies-gray-500);">${phases.length} phase${phases.length === 1 ? '' : 's'}</div>
        <button class="hub-btn hub-btn-sm" data-action="impl-add-phase" title="Add a new phase to the plan">+ Add Phase</button>
      </div>
      <table class="cm-table" style="width:100%;">
        <thead>
          <tr>
            <th style="width:40%;">Phase</th>
            <th style="width:14%;">Owner</th>
            <th style="width:11%;text-align:right;">Start Week</th>
            <th style="width:12%;text-align:right;">Duration (wk)</th>
            <th style="width:11%;text-align:right;">End Week</th>
            <th style="width:8%;">Color</th>
            <th style="width:4%;"></th>
          </tr>
        </thead>
        <tbody>
          ${phases.length === 0 ? `
            <tr><td colspan="7" class="cm-empty-state" style="text-align:center;padding:24px;color:var(--ies-gray-400);">No phases defined. Click <strong>+ Add Phase</strong> to start.</td></tr>
          ` : phases.map((ph, i) => {
            const endWeek = (Number(ph.startWeek) || 0) + (Number(ph.durationWeeks) || 0);
            return `
              <tr>
                <td><input class="hub-input" value="${escapeAttr(ph.name || '')}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="name" placeholder="Phase name" /></td>
                <td><input class="hub-input" value="${escapeAttr(ph.owner || '')}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="owner" placeholder="PM / IT / Ops" /></td>
                <td><input class="hub-input hub-num" type="number" min="0" step="1" value="${Number(ph.startWeek) || 0}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="startWeek" data-type="number" /></td>
                <td><input class="hub-input hub-num" type="number" min="0" step="1" value="${Number(ph.durationWeeks) || 0}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="durationWeeks" data-type="number" /></td>
                <td style="text-align:right;font-weight:600;color:var(--ies-gray-600);">W${endWeek}</td>
                <td><input type="color" value="${escapeAttr(ph.color || '#0047AB')}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="color" style="width:36px;height:26px;padding:0;border:1px solid var(--ies-gray-200);border-radius:4px;cursor:pointer;" /></td>
                <td style="text-align:center;"><button class="cm-delete-btn" data-action="impl-delete-phase" data-idx="${i}" title="Delete phase">×</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>

    ` : ''}

    ${activeImplPhase === 'ramp' ? `
    <!-- Ramp curves — full-width side-by-side cards. 2026-04-27 redesign:
         tall bar chart on top (~140px) with the % value rendered on each
         bar + a 100% reference line, then editable inputs aligned 1:1
         BELOW each bar. Old design used a one-row table of narrow inputs
         (~56px each) with a 60px sparkline below — Brock feedback that
         the graphs were "basically useless" and the inputs weren't
         wide enough to read or edit comfortably. New layout reads as a
         single unified curve-editor: see the shape AND tune the values
         without losing your place. -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
      <div class="cm-card">
        <div class="cm-section-header__intro" style="margin-bottom:8px;">
          <div>
            <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Volume Ramp</h3>
            <div class="cm-subtle" style="font-size:12px;">% of steady-state volume by month after go-live</div>
          </div>
        </div>
        ${renderImplRampPanel('volumeRamp', volumeRamp, 'Volume', '#0047AB')}
      </div>
      <div class="cm-card">
        <div class="cm-section-header__intro" style="margin-bottom:8px;">
          <div>
            <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Headcount Ramp</h3>
            <div class="cm-subtle" style="font-size:12px;">% of steady-state direct FTE by month after go-live</div>
          </div>
        </div>
        ${renderImplRampPanel('headcountRamp', headcountRamp, 'FTE', '#d97706')}
      </div>
    </div>

    ` : ''}

    ${activeImplPhase === 'forecast' ? `
    <!-- Ramp Burn Estimate (read-only, derives from labor + ramp curves) -->
    <div class="cm-card">
      <div class="cm-section-header__intro" style="margin-bottom:8px;">
        <div>
          <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Ramp Burn Estimate <span class="hub-status-chip cm-chip-info cm-chip-xs">read-only</span></h3>
          <div class="cm-subtle" style="font-size:12px;">Direct labor cost during each ramp month — multiplies steady-state monthly direct labor (${calc.formatCurrency(steadyMonthlyCost)}) by the headcount ramp %. Steady-state baseline: <strong>${totalFtes.toFixed(1)} FTE</strong> · <strong>${calc.formatCurrency(steadyDirectCost)}</strong>/yr.</div>
        </div>
      </div>
      <div class="cm-table-scroll">
      <table class="cm-table" style="width:100%;min-width:680px;">
        <thead>
          <tr>
            <th>Month After Go-Live</th>
            <th style="text-align:right;">Headcount %</th>
            <th style="text-align:right;">Implied FTE</th>
            <th style="text-align:right;">Volume %</th>
            <th style="text-align:right;">Direct Labor Cost</th>
            <th style="text-align:right;">Δ vs steady-state</th>
          </tr>
        </thead>
        <tbody>
          ${headcountRamp.map((pct, i) => {
            const hcPct = Number(pct) || 0;
            const volPct = Number(volumeRamp[i]) || 0;
            const impliedFte = totalFtes * (hcPct / 100);
            const monthlyCost = steadyMonthlyCost * (hcPct / 100);
            const delta = monthlyCost - steadyMonthlyCost;
            const deltaColor = delta < 0 ? 'var(--ies-green,#16a34a)' : (delta > 0 ? 'var(--ies-red,#dc2626)' : 'var(--ies-gray-500)');
            return `
              <tr>
                <td><strong>Month ${i + 1}</strong></td>
                <td style="text-align:right;">${hcPct}%</td>
                <td style="text-align:right;">${impliedFte.toFixed(1)}</td>
                <td style="text-align:right;color:var(--ies-gray-500);">${volPct}%</td>
                <td style="text-align:right;font-weight:600;">${calc.formatCurrency(monthlyCost)}</td>
                <td style="text-align:right;color:${deltaColor};">${delta === 0 ? '—' : (delta > 0 ? '+' : '') + calc.formatCurrency(delta)}</td>
              </tr>
            `;
          }).join('')}
          <tr style="background:var(--ies-gray-50);font-weight:700;border-top:2px solid var(--ies-gray-200);">
            <td>Steady-state (Month ${headcountRamp.length + 1}+)</td>
            <td style="text-align:right;">100%</td>
            <td style="text-align:right;">${totalFtes.toFixed(1)}</td>
            <td style="text-align:right;color:var(--ies-gray-500);">100%</td>
            <td style="text-align:right;">${calc.formatCurrency(steadyMonthlyCost)}</td>
            <td style="text-align:right;color:var(--ies-gray-500);">baseline</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
    ` : ''}
  `;
}
