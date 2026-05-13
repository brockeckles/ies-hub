/**
 * IES Hub v3 — Warehouse Sizing — Dashboard view (extracted from ui.js 2026-05-13)
 *
 * Slice 4 of 7: the right-side "Required vs Built" landing panel + KPI tiles
 * + sized-facility breakdown tables. Pure read; no state mutation.
 *
 * Exports:
 *   renderDashboard(ctx) — returns the dashboard HTML string.
 *   renderUtilBar(label, pct, opts) — pure utility-bar helper (no ctx needed).
 *
 * ctx shape:
 *   { facility, zones, volumes,             // getters (live reads)
 *     renderFacility(facility, sized),      // = _renderFacility
 *     toSizingInputs() }
 *
 * @module tools/warehouse-sizing/ui-dashboard
 */

import * as calc from './calc.js?v=20260514-fsi1';
import { escapeHtml } from '../../shared/escape.js?v=20260511-port12';
import { renderCmDrillbackChip } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';

export function renderDashboard(ctx) {
  const storage = calc.computeStorage(ctx.facility, ctx.zones);
  const summary = calc.computeCapacitySummary(ctx.facility, ctx.zones, ctx.volumes);
  // WSC-A1: collapse ctx.facility.dockDoors -> ctx.zones.dockConfig as the single
  // source of truth. ctx.facility.dockDoors used to be a separate field that
  // could drift from ctx.zones.dockConfig (which the door-allocation UI actually
  // edits). Derive total doors from ctx.zones every render.
  const _dockCfg = ctx.zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const _totalDoors = (_dockCfg.inboundDoors || 0) + (_dockCfg.outboundDoors || 0) || (ctx.facility.dockDoors || 0);
  const dock = calc.dockUtilization(_totalDoors, ctx.volumes.avgDailyInbound, ctx.volumes.avgDailyOutbound, ctx.volumes.peakMultiplier);
  const dockAnalysis = calc.calcDockAnalysis(ctx.facility, ctx.zones, ctx.volumes);
  // WSC-A5 (2026-04-25): calcStorageByType produced fake "positions" for
  // carton-on-shelving (treated 1 shelf location as 1 pallet position).
  // Dashboard now reads sized.positions.shelvingPositions (loc) directly,
  // so this call is dead. Removed.
  const dioh = calc.calcDIOH(ctx.zones);
  const fwdPick = calc.calcForwardPick(ctx.zones);
  const correctedSf = calc.calcSuggestedSF(ctx.facility, ctx.zones, ctx.volumes);
  const zoneBD = calc.zoneBreakdown(ctx.zones);

  // v2-equivalent volume-first sizing (the engine we actually trust).
  const sized = calc.sizeFacility(ctx.toSizingInputs());

  // Phase A: route elevation params through mode-aware ctx.facility shape.
  const elev = calc.elevationParams(ctx.renderFacility(ctx.facility, sized));

  // Phase 4 Layer B (ctx.volumes-as-nucleus, 2026-04-29): per-channel positions
  // breakdown for display. Same pallet-vs-carton math as sizeFacility but
  // split per-channel using each channel's storageAllocation override (or
  // the ctx.facility-level allocation as fallback). Empty when ctx.zones.channelMixes
  // is unset — falls back to the legacy single-row display.
  let byChannel = [];
  try {
    const cbt = calc.calcStorageByType(ctx.facility, ctx.zones);
    if (Array.isArray(cbt.byChannel)) byChannel = cbt.byChannel;
  } catch (_) {}

  return `
    <!-- KPI Bar — Sized Facility (v2-equivalent volume-first engine) -->
    <div class="hub-kpi-bar mb-6">
      <div class="hub-kpi-item"><div class="hub-kpi-label">Sized Total SF</div><div class="hub-kpi-value" title="Sum of pallet storage + carton shelving + dock + staging + ctx.zones + office, computed from peak units / mix / dock throughput. v2-equivalent engine.">${calc.formatSqft(sized.totalSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Storage SF</div><div class="hub-kpi-value">${calc.formatSqft(sized.storageSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Gross Positions</div><div class="hub-kpi-value" title="Designed positions + ${sized.utilization.designed > 0 ? Math.round((sized.positions.surgePositions / sized.utilization.designed) * 100) : 0}% surge buffer">${sized.positions.grossPositions.toLocaleString()}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Rack Levels</div><div class="hub-kpi-value">${sized.rackLevels}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">SF / Position</div><div class="hub-kpi-value" title="Total ctx.facility SF / gross positions. Lower = denser. Selective racking 8-12; VNA 5-8; Drive-in 3-5.">${sized.sfPerPosition.toFixed(1)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Dock Doors</div><div class="hub-kpi-value" title="${sized.dock.inboundDoors} in${sized.dock.inboundDoorsExplicit ? ' (explicit)' : ` (derived; throughput suggests ${sized.dock.inboundDoorsDerived})`} + ${sized.dock.outboundDoors} out${sized.dock.outboundDoorsExplicit ? ' (explicit)' : ` (derived; throughput suggests ${sized.dock.outboundDoorsDerived})`}${(sized.dock.inboundDoorsExplicit || sized.dock.outboundDoorsExplicit) ? '' : ', +25% surge buffer'}">${sized.dock.totalDoors}</div></div>
    </div>

    <!-- Phase A redesign (2026-05-05) — Sized Facility / Capacity Check panel.
         Mode-aware: Design mode shows the engine's sized footprint as the
         single answer (no Built column, no Apply button — the engine answer
         IS the answer). Constraint mode keeps the two-column Required vs
         Built layout with status chip and the right-size button. The
         pre-Phase-A panel always showed both columns and an Apply button,
         which created the "two competing sizes" confusion. -->
    ${(() => {
      const r = sized.requirementsDriven;
      if (!r || !r.totalSfRequired) return '';
      const _mode = ctx.facility.sizingMode || 'design';

      // Design mode — single column. Engine answer = footprint.
      if (_mode === 'design') {
        return `
          <div class="hub-card mb-6" style="border-left:4px solid var(--ies-blue,#0047AB);padding:16px 20px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div>
                <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ies-gray-700);">Sized Facility</div>
                <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">Design mode — engine sizes the building from inventory + dock throughput. Switch to Constraint mode in the Configure panel to evaluate an existing W×D.</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">Sized total</div>
                <div style="font-size:18px;font-weight:800;color:var(--ies-blue,#0047AB);">${r.totalSfRequired.toLocaleString()} sf</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
              <div>
                <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Critical-path SF</div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Storage</span><strong>${r.storageSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Dock <span style="color:var(--ies-gray-400);">(peak-throughput driven)</span></span><strong>${r.dockSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Office</span><strong>${r.officeSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Staging</span><strong>${r.stagingSf.toLocaleString()} sf</strong></div>
                ${r.additionalSf > 0 ? `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Additional</span><strong>${r.additionalSf.toLocaleString()} sf</strong></div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:var(--ies-gray-500);"><span>+ Circulation buffer (10%)</span><strong>${r.circulationSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:var(--ies-blue,#0047AB);"><span>Total</span><strong>${r.totalSfRequired.toLocaleString()} sf</strong></div>
              </div>
              <div>
                <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Footprint</div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Long edge × Short edge</span><strong>${r.suggestedLongFt} × ${r.suggestedShortFt} ft</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;color:var(--ies-gray-500);"><span>Aspect ratio</span><strong>1.5 : 1</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:var(--ies-gray-500);"><span>Convention</span><strong>Dock on long edge</strong></div>
                <div style="margin-top:10px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-600);line-height:1.5;">
                  The 2D plan and 3D scene render this footprint exactly. No empty-building visual — what you see equals the engineered answer.
                </div>
              </div>
            </div>
          </div>
        `;
      }

      // Constraint mode — Required vs Existing with status chip + right-size CTA.
      const builtSf = (ctx.facility.buildingWidth || 0) * (ctx.facility.buildingDepth || 0);
      const haveBuilt = builtSf > 0;
      const deltaSf = haveBuilt ? builtSf - r.totalSfRequired : 0;
      const deltaPct = (haveBuilt && r.totalSfRequired > 0) ? Math.round((deltaSf / r.totalSfRequired) * 1000) / 10 : 0;
      const status = !haveBuilt ? 'unbuilt' : Math.abs(deltaPct) <= 5 ? 'on-target' : deltaPct > 5 ? 'slack' : 'short';
      const statusColor = status === 'on-target' ? 'var(--ies-green,#10b981)' : status === 'slack' ? 'var(--ies-blue,#0047AB)' : status === 'short' ? 'var(--ies-orange, #ff3a00)' : 'var(--ies-gray-500)';
      const statusLabel = status === 'on-target' ? '✓ On target (within 5%)' : status === 'slack' ? `+${deltaPct}% capacity slack` : status === 'short' ? `${deltaPct}% short` : 'Enter building dims';
      const canApply = r.suggestedLongFt > 0 && r.suggestedShortFt > 0;
      return `
        <div class="hub-card mb-6" style="border-left:4px solid ${statusColor};padding:16px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div>
              <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ies-gray-700);">Capacity Check</div>
              <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">Constraint mode — your building is fixed. Tool shows whether your inventory fits, and by how much.</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">Status</div>
              <div style="font-size:14px;font-weight:700;color:${statusColor};">${statusLabel}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
            <div>
              <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Required (computed)</div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Storage</span><strong>${r.storageSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Dock <span style="color:var(--ies-gray-400);">(peak-throughput driven)</span></span><strong>${r.dockSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Office</span><strong>${r.officeSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Staging</span><strong>${r.stagingSf.toLocaleString()} sf</strong></div>
              ${r.additionalSf > 0 ? `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Additional</span><strong>${r.additionalSf.toLocaleString()} sf</strong></div>` : ''}
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:var(--ies-gray-500);"><span>+ Circulation buffer (10%)</span><strong>${r.circulationSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:var(--ies-blue,#0047AB);"><span>Total Required</span><strong>${r.totalSfRequired.toLocaleString()} sf</strong></div>
              <div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Suggested footprint: <strong>${r.suggestedLongFt} × ${r.suggestedShortFt} ft</strong> (1.5:1)</div>
            </div>
            <div>
              <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Existing building</div>
              ${haveBuilt ? `
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Width × Depth</span><strong>${ctx.facility.buildingWidth} × ${ctx.facility.buildingDepth} ft</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Footprint area</span><strong>${builtSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:${statusColor};"><span>Gap</span><strong>${deltaSf >= 0 ? '+' : ''}${deltaSf.toLocaleString()} sf (${deltaPct >= 0 ? '+' : ''}${deltaPct}%)</strong></div>
              ` : `
                <div style="font-size:11px;color:var(--ies-gray-500);font-style:italic;padding:8px 0;">No building dims set. Enter Width / Depth in Step 5, or click Apply suggested dims to use the engineered footprint as a starting point.</div>
              `}
              ${canApply ? `
                <div style="margin-top:12px;display:flex;gap:8px;">
                  <button class="hub-btn hub-btn-primary hub-btn-sm" data-wsc-action="apply-required-dims" data-long="${r.suggestedLongFt}" data-short="${r.suggestedShortFt}" style="flex:1;">${haveBuilt && status !== 'on-target' ? 'Right-size to suggested' : 'Apply suggested dims'}</button>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    })()}

    <!-- Sized Facility Recommendation Card -->
    <div class="hub-card mb-6" style="border-left:4px solid var(--ies-blue);padding:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div class="text-section" style="margin:0;">${calc.formatSqft(sized.totalSqft)} Facility — ${calc.labelForStoreType(sized.storageDetail.storeType)}</div>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">${escapeHtml(sized.storageDetail.layoutDescription)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">SF / Position</div>
          <div style="font-size:20px;font-weight:800;">${sized.sfPerPosition.toFixed(1)}</div>
        </div>
      </div>

      <table class="cm-grid-table" style="font-size:13px;width:100%;">
        <tbody>
          <tr><td colspan="2" style="padding-top:8px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;">Inventory → Positions</td></tr>
          ${sized.positions.palletPositionsOverridden ? `
            <tr><td title="Total pallet positions you entered on Volume Requirements. Replaces the peakUnits × mix derivation (peak-derived FP + CP rows are not used downstream when an override is engaged).">
              <strong>Total Pallets (entered)</strong>
              <span style="color:var(--ies-gray-400);font-size:11px;display:block;line-height:1.5;">
                Split by mix: Full Pallet ${Math.round((sized.meta.normalisedMix.fullPalletPct / Math.max(0.0001, sized.meta.normalisedMix.fullPalletPct + sized.meta.normalisedMix.cartonOnPalletPct)) * 100)}% / Carton on Pallet ${Math.round((sized.meta.normalisedMix.cartonOnPalletPct / Math.max(0.0001, sized.meta.normalisedMix.fullPalletPct + sized.meta.normalisedMix.cartonOnPalletPct)) * 100)}%
              </span>
            </td><td class="cm-num"><strong>${sized.positions.palletPositionsNeeded.toLocaleString()}</strong> pos</td></tr>
            <tr><td>Carton Shelving (${Math.round(sized.meta.normalisedMix.cartonOnShelvingPct * 100)}%)</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()} loc</td></tr>
          ` : `
            <tr><td>Full Pallet (${Math.round(sized.meta.normalisedMix.fullPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.fullPalletPositions.toLocaleString()} pos</td></tr>
            <tr><td>Carton on Pallet (${Math.round(sized.meta.normalisedMix.cartonOnPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.cartonPalletPositions.toLocaleString()} pos</td></tr>
            <tr><td>Carton Shelving (${Math.round(sized.meta.normalisedMix.cartonOnShelvingPct * 100)}%)</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()} loc</td></tr>
          `}
          <tr style="border-top:1px dashed var(--ies-gray-200);"><td title="Pallet inventory + shelving locations going into the engine before buffers."><strong>Subtotal: Inventory positions</strong></td><td class="cm-num"><strong>${(sized.positions.palletPositionsNeeded + sized.positions.shelvingPositions).toLocaleString()}</strong></td></tr>
          <tr><td title="Honeycomb buffer = empty positions reserved for inbound/outbound flux + slotting flexibility. Applied to pallet + shelving sides at the same rate.">+ Honeycomb buffer (${Math.round((sized.positions.honeycombFactor - 1) * 100)}%)</td><td class="cm-num">${(sized.positions.designedPositions - sized.positions.palletPositionsNeeded - sized.positions.shelvingPositions).toLocaleString()} pos</td></tr>
          <tr><td><strong>Designed positions</strong></td><td class="cm-num"><strong>${sized.positions.designedPositions.toLocaleString()} pos</strong></td></tr>
          <tr><td title="Surge buffer = additional positions for seasonal peaks above the engineered design.">+ Surge buffer (${Math.round((sized.positions.surgeFactor - 1) * 100)}%)</td><td class="cm-num">${sized.positions.surgePositions.toLocaleString()} pos</td></tr>
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Gross Positions</strong></td><td class="cm-num"><strong>${sized.positions.grossPositions.toLocaleString()}</strong></td></tr>

          ${byChannel.length > 0 ? `
            <tr><td colspan="2" style="padding-top:14px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;" title="Phase 4 Layer B (ctx.volumes-as-nucleus): positions sized per-channel using each channel's storageAllocation override (falls back to ctx.facility allocation when no override).">Inventory → Positions by Channel</td></tr>
            ${byChannel.map(c => `
              <tr>
                <td style="padding-left:8px;">${escapeHtml(c.name)}${renderCmDrillbackChip({ cmId: ctx.facility.parent_cost_model_id, channelKey: c.channelKey, channelName: c.name })}</td>
                <td class="cm-num">
                  <span title="Full pallet positions">${c.fullPalletPositions.toLocaleString()} fp</span>
                  <span style="color:var(--ies-gray-400);"> · </span>
                  <span title="Carton-on-pallet positions">${c.cartonOnPalletPositions.toLocaleString()} cp</span>
                  <span style="color:var(--ies-gray-400);"> · </span>
                  <span title="Carton-on-shelving locations">${c.cartonOnShelvingLocations.toLocaleString()} cs</span>
                </td>
              </tr>
            `).join('')}
          ` : ''}

          <tr><td colspan="2" style="padding-top:14px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;">Zone Breakdown</td></tr>
          ${sized.zoneBreakdown.map(z => `
            <tr><td>${escapeHtml(z.label)}</td><td class="cm-num">${calc.formatSqft(z.sqft)} <span style="color:var(--ies-gray-400);font-size:11px;">${z.pct}%</span></td></tr>
          `).join('')}
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Total Facility</strong></td><td class="cm-num"><strong>${calc.formatSqft(sized.totalSqft)}</strong></td></tr>
        </tbody>
      </table>

      ${sized.utilization.warning === 'high_util' ? `
        <div style="margin-top:12px;padding:10px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#92400e;font-size:12px;">
          ⚠ <strong>High Utilization (${sized.utilization.utilizationPct}%)</strong> — limited operational flexibility for receiving surges and seasonal peaks. Consider increasing ctx.facility size or reducing peak inventory assumptions.
        </div>
      ` : sized.utilization.warning === 'low_util' ? `
        <div style="margin-top:12px;padding:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;color:#9a3412;font-size:12px;">
          ⚠ <strong>Low Utilization (${sized.utilization.utilizationPct}%)</strong> — gap between average (${sized.utilization.avg.toLocaleString()}) and peak (${sized.utilization.peak.toLocaleString()}) is significant. Verify the ctx.facility is sized for the right scenario.
        </div>
      ` : ''}

      ${!sized.dock.dockWallOk ? `
        <div style="margin-top:8px;padding:10px;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;color:#991b1b;font-size:12px;">
          ⚠ <strong>Dock Wall Constraint:</strong> required ${sized.dock.dockWallRequiredFt} ft for ${sized.dock.totalDoors} doors at 12' on-center spacing exceeds available wall length (${sized.dock.dockWallAvailableFt} ft). Consider a second dock face or fewer doors.
        </div>
      ` : ''}

    </div>

    <!-- Capacity Analysis (vs sized requirement) -->
    <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:8px;text-transform:uppercase;font-weight:700;">Capacity Analysis</div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <!-- Capacity Utilization — tied to sizing engine -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Capacity Utilization</div>
        ${renderUtilBar('Storage SF vs Existing',
          ctx.facility.totalSqft > 0 ? Math.round((sized.storageSqft / ctx.facility.totalSqft) * 100) : 0,
          { mode: 'cap', tooltip: 'Sized storage SF / ctx.facility.totalSqft. >95% means storage alone consumes all available SF — no room for staging, dock, office.' })}
        ${renderUtilBar('Sized SF vs Existing',
          ctx.facility.totalSqft > 0 ? Math.round((sized.totalSqft / ctx.facility.totalSqft) * 100) : 0,
          { mode: 'cap', tooltip: 'Sized total SF / ctx.facility.totalSqft. >100% means the engineered ctx.facility does not fit in the existing footprint.' })}
        ${renderUtilBar('Pallet Position Util',
          sized.utilization.utilizationPct,
          { mode: 'band', tooltip: 'Average inventory positions / designed positions. Healthy band 70-90%. Below 70% = over-built; above 90% = no slack for receiving surges or seasonal peaks. (WSC-D4 fix: was inverted as cap-mode.)' })}
        ${renderUtilBar('Cubic Utilization',
          summary.cubicUtilizationPct,
          { mode: 'cap', tooltip: 'Pallet cube (positions × bay W × rack D × level H) / building cube (storage SF × usable Ht). High % = dense vertical use.' })}
      </div>

      <!-- Capacity Reconciliation — bridge the two ways the tool counts positions (WSC-A4) -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Capacity Reconciliation</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td title="What the building geometrically holds, given building width × depth × clear height × storage type × aisle width. Bounded by physics, not demand.">Geom Capacity (max)</td>
                <td class="cm-num" style="color:var(--ies-blue);font-weight:700;">${storage.totalPalletPositions.toLocaleString()}</td></tr>
            <tr><td title="What the customer's inventory NEEDS, derived from peak units × storage mix ÷ units-per-pallet, plus honeycomb buffer.">Designed (need)</td>
                <td class="cm-num" style="font-weight:700;">${sized.utilization.designed.toLocaleString()}</td></tr>
            <tr><td title="Designed positions / Geometric capacity. Low = building is over-sized for inventory; >100% = building cannot physically hold the engineered position count.">Geom Util</td>
                <td class="cm-num" style="color:${storage.totalPalletPositions > 0 && (sized.utilization.designed / storage.totalPalletPositions) > 1 ? 'var(--ies-red)' : 'inherit'};">
                  ${storage.totalPalletPositions > 0 ? Math.round((sized.utilization.designed / storage.totalPalletPositions) * 100) + '%' : '—'}
                </td></tr>
            <tr><td colspan="2" style="padding-top:8px;font-size:11px;color:var(--ies-gray-500);font-style:italic;">
              Geometric capacity is what the building can hold. Designed positions are what the customer needs. Two different lenses on the same ctx.facility.
            </td></tr>
          </tbody>
        </table>
      </div>

      <!-- Zone Allocation — same breakdown as Sized Facility -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Zone Allocation</div>
        <div style="display:flex; height:24px; border-radius:4px; overflow:hidden; margin-bottom:12px;">
          ${sized.zoneBreakdown.map((z, i) => {
            const palette = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
            return `<div style="width:${z.pct}%;background:${palette[i % palette.length]};" title="${escapeHtml(z.label)}"></div>`;
          }).join('')}
        </div>
        <div style="font-size:13px;">
          ${sized.zoneBreakdown.map((z, i) => {
            const palette = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
            return `
              <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:${palette[i % palette.length]};font-weight:600;">${escapeHtml(z.label)}</span>
                <span style="font-weight:700;">${calc.formatSqft(z.sqft)} <span style="color:var(--ies-gray-400);font-weight:400;font-size:11px;">${z.pct}%</span></span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Dock Analysis — tied to sizing engine so numbers match the KPI bar -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Dock Analysis</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Inbound Doors ${sized.dock.inboundDoorsExplicit ? '<span style="font-size:10px;background:#dbeafe;color:#1e3a8a;padding:1px 5px;border-radius:3px;margin-left:4px;">EXPLICIT</span>' : `<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;margin-left:4px;" title="Throughput-derived. Set explicit count in Dock Configuration to override.">DERIVED</span>`}</td><td class="cm-num" style="color:var(--ies-blue);">${sized.dock.inboundDoors}${!sized.dock.inboundDoorsExplicit ? ` <span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;">(throughput suggests ${sized.dock.inboundDoorsDerived})</span>` : ''}</td></tr>
            <tr><td>Outbound Doors ${sized.dock.outboundDoorsExplicit ? '<span style="font-size:10px;background:#dbeafe;color:#1e3a8a;padding:1px 5px;border-radius:3px;margin-left:4px;">EXPLICIT</span>' : `<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;margin-left:4px;" title="Throughput-derived. Set explicit count in Dock Configuration to override.">DERIVED</span>`}</td><td class="cm-num" style="color:var(--ies-blue);">${sized.dock.outboundDoors}${!sized.dock.outboundDoorsExplicit ? ` <span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;">(throughput suggests ${sized.dock.outboundDoorsDerived})</span>` : ''}</td></tr>
            <tr><td>Total Doors${(sized.dock.inboundDoorsExplicit || sized.dock.outboundDoorsExplicit) ? '' : ' (incl. 25% surge)'}</td><td class="cm-num" style="font-weight:700;">${sized.dock.totalDoors}</td></tr>
            <tr><td>Dock Wall Required</td><td class="cm-num" style="color:${sized.dock.dockWallOk ? 'var(--ies-green)' : 'var(--ies-red)'};">${sized.dock.dockWallRequiredFt} ft${sized.dock.dockWallOk ? '' : ` > ${sized.dock.dockWallAvailableFt} ft avail`}</td></tr>
            <tr><td>Dock Staging SF</td><td class="cm-num">${calc.formatSqft(sized.dockSqft || 0)}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Rack & Aisle Geometry (WSC-C1: renamed from "Rack Geometry" — IE-standard term) -->
      <div class="hub-card">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
          <div class="text-subtitle" style="margin:0;">Rack &amp; Aisle Geometry</div>
          ${storage.geometryIsHeuristic
            ? `<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:3px;" title="Building Width × Depth not set — geometry assumes a 1.5:1 rectangle from total SF. Set Width / Depth on the Building card for measured geometry.">HEURISTIC</span>`
            : `<span style="font-size:10px;background:#dcfce7;color:#166534;padding:2px 6px;border-radius:3px;" title="Geometry computed from ctx.facility.buildingWidth × buildingDepth.">MEASURED</span>`
          }
        </div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Rack Levels</td><td class="cm-num" style="font-weight:700;" title="Bounded [2, 7]. Formula: floor((clearHt × 12 − sprinkler_clearance) / (load_height + 10\")).">${storage.rackLevels}</td></tr>
            <tr><td>Level Height</td><td class="cm-num">${calc.formatFt(storage.positionHeight)}</td></tr>
            <tr><td>Top of Steel</td><td class="cm-num">${calc.formatFt(calc.topOfSteelFt(storage.rackLevels))}</td></tr>
            <tr><td>Usable Height</td><td class="cm-num">${calc.formatFt(storage.usableHeight)}</td></tr>
            <tr><td>Sprinkler Clearance</td><td class="cm-num">${calc.formatFt(elev.topClearanceFt)}</td></tr>
            <tr><td>Bay Width</td><td class="cm-num">${calc.formatFt(storage.bayWidth)}</td></tr>
            <tr><td>Rack Depth</td><td class="cm-num">${calc.formatFt(storage.bayDepth)}</td></tr>
            <tr><td>Aisle Width</td><td class="cm-num" title="${ctx.facility.aisleWidth ? 'User-set' : 'Default for ' + ctx.facility.storageType}">${calc.formatFt(elev.aisleWidth)}</td></tr>
            <tr><td>Aisle Count</td><td class="cm-num" title="${storage.geometryIsHeuristic ? 'Estimated from total SF assuming 1.5:1 aspect ratio.' : 'floor(buildingWidth / aisleModuleWidth) where module = rack-depth + aisle + rack-depth.'}">${storage.aisleCount}</td></tr>
            <tr><td>Bays/Aisle</td><td class="cm-num" title="${storage.geometryIsHeuristic ? 'Estimated from total SF.' : 'floor((buildingDepth − dockSetback) / bayWidth). 30 ft reserved at dock face.'}">${storage.bayCountPerAisle}</td></tr>
            <tr><td>Total Geom Positions</td><td class="cm-num" title="aisleCount × 2 sides × bays × levels${ctx.facility.storageType === 'double' ? ' × 2 (double-deep)' : ''}. Compare to Sized Gross Positions above to spot capacity gaps.">${storage.totalPalletPositions.toLocaleString()}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Inventory Metrics -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Inventory Metrics</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Peak Units/Day</td><td class="cm-num">${(ctx.zones.peakUnitsPerDay || 500000).toLocaleString()}</td></tr>
            <tr><td>Avg Units/Day</td><td class="cm-num">${(ctx.zones.avgUnitsPerDay || 350000).toLocaleString()}</td></tr>
            <tr><td>Operating Days/Yr</td><td class="cm-num">${(ctx.zones.operatingDaysPerYear || 250)}</td></tr>
            <tr><td title="Days Inventory On-Hand = avgUnits / dailyOutbound. Typical 3PL DC: 30-90 days; high-turn retail: 10-30 days; DTC ecomm: 60-120 days. Sources: ctx.zones.outboundUnitsPerDay → outboundUnitsYr/operatingDays → forwardPick.outboundUnitsPerDay (legacy).">DIOH (Days)</td><td class="cm-num">${dioh.toFixed(1)}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Forward Pick -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Forward Pick Area</div>
        ${ctx.zones.forwardPick?.enabled ? `
          <table class="cm-grid-table" style="font-size:13px;">
            <tbody>
              <tr><td>Pick Type</td><td class="cm-num">${(ctx.zones.forwardPick.type || 'carton_flow').replace('_', ' ')}</td></tr>
              <tr><td>SKU Count</td><td class="cm-num">${(ctx.zones.forwardPick.skuCount || 0).toLocaleString()}</td></tr>
              <tr><td>Days Inventory</td><td class="cm-num">${(ctx.zones.forwardPick.daysInventory || 0).toFixed(1)}</td></tr>
              <tr><td>Forward Pick SF</td><td class="cm-num">${calc.formatSqft(fwdPick)}</td></tr>
            </tbody>
          </table>
        ` : `
          <div style="padding:12px; text-align:center; color:var(--ies-gray-400); font-size:13px;">
            Forward pick not enabled
          </div>
        `}
      </div>

      <!-- WSC-D5 (2026-04-25): "Size Recommendation" card removed. It duplicated the Zone Allocation
           card (both rendered sized.zoneBreakdown). The Sized Facility Recommendation card at the top
           of the dashboard is the canonical "single source" summary; the Zone Allocation card here adds
           the visualization. Two breakdowns of the same numbers was three places to keep in sync. -->
    </div>
  `;
}

/**
 * Render a labeled utilization bar.
 *
 * @param {string} label
 * @param {number} pct
 * @param {Object} [opts]
 * @param {'cap'|'band'|'hi'} [opts.mode='cap'] — color semantics:
 *   - 'cap' (default): higher is worse. > 95 red, > 80 orange, else green.
 *     Use for "% of available space consumed" metrics.
 *   - 'band': healthy band of 70-90%. < 60 / > 95 red, 60-70 / 90-95 orange,
 *     70-90 green. Use for utilization that should sit in an operational
 *     sweet spot (Pallet Position Util — too low = over-built, too high =
 *     no slack for surges).
 *   - 'hi': higher is better (rare; left for parity).
 * @param {string} [opts.tooltip]
 * @returns {string}
 */
export function renderUtilBar(label, pct, opts = {}) {
  const mode = opts.mode || 'cap';
  let color;
  if (mode === 'band') {
    if (pct < 60 || pct > 95) color = 'var(--ies-red)';
    else if (pct < 70 || pct > 90) color = 'var(--ies-orange)';
    else color = 'var(--ies-green)';
  } else if (mode === 'hi') {
    if (pct < 50) color = 'var(--ies-red)';
    else if (pct < 70) color = 'var(--ies-orange)';
    else color = 'var(--ies-green)';
  } else {
    // 'cap' (default)
    color = pct > 95 ? 'var(--ies-red)' : pct > 80 ? 'var(--ies-orange)' : 'var(--ies-green)';
  }
  const tip = opts.tooltip ? `title="${opts.tooltip}"` : '';
  return `
    <div style="margin-bottom:12px;" ${tip}>
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px;">
        <span style="font-weight:600;">${label}</span>
        <span style="font-weight:700; color:${color};">${calc.formatPct(pct)}</span>
      </div>
      <div class="wsc-util-bar">
        <div class="wsc-util-fill" style="width:${Math.min(100, pct)}%; background:${color};"></div>
      </div>
    </div>
  `;
}

