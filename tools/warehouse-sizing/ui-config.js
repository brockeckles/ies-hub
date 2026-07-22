/**
 * IES Hub v3 — Warehouse Sizing — Config Panel (extracted from ui.js 2026-05-13)
 *
 * Slice 2 of 7: the left-side configuration drawer. Two exports:
 *
 *   renderConfigHtml(ctx)   — pure-ish: returns the panel HTML based on
 *                             current ctx.facility/ctx.zones/ctx.volumes state.
 *   bindConfigEvents(panel, ctx) — attaches all input-change handlers to
 *                                  the rendered panel. Writes to ctx.facility/
 *                                  ctx.zones/ctx.volumes (object mutation, live via
 *                                  getters), flips ctx.setDirty(true), and
 *                                  calls ctx.refreshContent() to redraw the
 *                                  dashboard/canvas after each change.
 *
 * ctx shape (constructed by ui.js):
 *   { ctx.facility, ctx.zones, ctx.volumes, ctx.viewMode, rootEl,    // getters (live reads)
 *     ctx.isDirty, setDirty(v), resetState(),             // dirty-flag + bulk reset
 *     refreshKpis(), refreshContent(), refreshConfig(), refreshLanding(),
 *     copySummary(), ctx.toSizingInputs(), ctx.debounceRender(),
 *     ctx.handleCmPush(payload), ctx.handleSaveWsc(),
 *     ctx.createDefaultFacility(), ctx.createDefaultZones(), ctx.createDefaultVolumes() }
 *
 * @module tools/warehouse-sizing/ui-config
 */

import * as calc from './calc.js?v=20260722-s2';
import * as cmApi from '../cost-model/api.js?v=20260722-s4e';
import { showConfirm } from '../../shared/confirm-modal.js?v=20260705-u1a';
import { showToast } from '../../shared/toast.js?v=20260705-u1a';
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

export function renderConfigHtml(ctx) {
  // W1 requirement seam (2026-07-15) — badge every field the seam is filling
  // from an applied basis plan (display must match mechanism): the input
  // shows 0 (unasserted) while the engine sizes from the derived value.
  const _seam = (typeof ctx.reqSeam === 'function' ? ctx.reqSeam() : null) || { active: false, fields: {} };
  const _seamHint = (key) => {
    const f = _seam.fields[key];
    if (!f) return '';
    return `<div class="wsc-seam-hint" style="margin-top:2px;font-size:10.5px;font-weight:600;color:var(--c-success-ink,#15803d);" title="${escapeAttr(f.detail)}. Type a value to override.">&#8627; ${(+f.value).toLocaleString()} derived &middot; Design Basis</div>`;
  };
  // Compute sized once — used by Step 1 readout, Step 5 derived outputs, and CTA banner.
  let sized = null;
  try { sized = calc.sizeFacility(ctx.toSizingInputs()); } catch {}
  const sizedSqft = sized?.totalSqft || 0;
  const mode = ctx.facility.sizingMode || 'design';

  return `
    <!-- ──────────────────────────────────────────────────────────────────
         SIZING MODE — Phase A (2026-05-05). Foundation toggle that drives
         the whole tool: Design = inventory drives building (engine answer
         is the single output, W/D hidden); Constraint = user W×D is a
         hard constraint (rendering uses user dims, dashboard surfaces gap).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section" style="margin-bottom:14px;padding:10px 12px;background:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%);border-radius:6px;border:1px solid var(--ies-gray-200);">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ies-gray-500);margin-bottom:6px;">Sizing Mode</div>
      <div role="radiogroup" aria-label="Sizing mode" style="display:flex;gap:6px;">
        <button type="button" role="radio" aria-checked="${mode === 'design'}" data-wsc-mode="design"
                title="Inventory drives building dimensions. The engine sizes the facility from your peak units / mix / dock throughput. The 2D/3D rendering uses the sized footprint exactly. Use this for greenfield design or when you don't yet have a candidate building."
                style="flex:1;padding:8px 10px;font-size:12px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${mode === 'design' ? 'var(--ies-blue,var(--ies-blue))' : 'var(--ies-gray-200)'};background:${mode === 'design' ? 'var(--ies-blue,var(--ies-blue))' : '#fff'};color:${mode === 'design' ? '#fff' : 'var(--ies-gray-700)'};transition:all .12s;">
          Design
          <div style="font-size:10px;font-weight:500;margin-top:2px;color:${mode === 'design' ? 'rgba(255,255,255,.85)' : 'var(--ies-gray-500)'};">Inventory → building</div>
        </button>
        <button type="button" role="radio" aria-checked="${mode === 'constraint'}" data-wsc-mode="constraint"
                title="Building W×D is a hard constraint (existing site or candidate). Tool computes the required footprint from inventory and shows the gap vs your entered building. Rendering uses your W×D; empty space surfaces as 'capacity slack'."
                style="flex:1;padding:8px 10px;font-size:12px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${mode === 'constraint' ? 'var(--ies-blue,var(--ies-blue))' : 'var(--ies-gray-200)'};background:${mode === 'constraint' ? 'var(--ies-blue,var(--ies-blue))' : '#fff'};color:${mode === 'constraint' ? '#fff' : 'var(--ies-gray-700)'};transition:all .12s;">
          Constraint
          <div style="font-size:10px;font-weight:500;margin-top:2px;color:${mode === 'constraint' ? 'rgba(255,255,255,.85)' : 'var(--ies-gray-500)'};">Building → fit check</div>
        </button>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 1 — Demand & Inventory Profile (Phase B redesign 2026-05-05).
         Primary-input toggle picks driving UOM (throughput vs on-hand pallets);
         non-active path becomes a derived read-only tile. ABC velocity tier
         inputs (A/B/C %) drive forward-pick demand and slotting tilt.
         Inv Turns + Total SKUs no longer surfaced in UI (data fields preserved
         on the model for back-compat with legacy heuristic paths).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="1">
      <div class="wsc-step-header u-row u-mb-2">
        <span class="wsc-step-num" style="display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,var(--ies-blue));color:#fff;font-size:11px;font-weight:700;">1</span>
        <span class="wsc-step-title wsc-section-title">Demand &amp; Inventory Profile</span>
        ${ctx.facility.parent_cost_model_id ? `<button class="hub-btn hub-btn-ghost hub-btn-sm" data-action="wsc-pull-from-cm" title="Re-pull volume defaults from the linked Cost Model." style="font-weight:500;margin-left:auto;">↻ Pull from CM</button>` : ''}
      </div>
      <div class="wsc-config-field" style="margin-bottom:10px;">
        <label>Facility Name</label>
        <input value="${ctx.facility.name}" data-fac="name" />
      </div>

      <!-- Brock 2026-05-08 (consolidation): unified inventory inputs.
           Pre-fix the form had a binary toggle (Throughput vs Pallet Positions)
           that branched into two distinct sub-forms. Now everything lives in
           one flat form: throughput inputs (annual outbound, DOH, peak, daily
           inbound) AND override inputs (total pallets, total shelving) all
           visible at once. Engine logic: if override > 0 use it directly,
           else derive forward from throughput. Removes the toggle entirely
           and the wart where 'pallets mode' silently produced 0 shelving. -->
      ${(() => {
        const doh = +ctx.volumes.daysOnHand || 30;
        const peakMult = +ctx.volumes.peakMultiplier || 1.3;
        const annualOut = +ctx.volumes.annualOutboundUnits || 0;
        const totalPallets = +ctx.volumes.totalPallets || 0;
        const totalShelv = +ctx.volumes.totalShelvingLocations || 0;
        const palOverrideOn = totalPallets > 0;
        const shelvOverrideOn = totalShelv > 0;
        const cartonProf = sized?.cartonProfile;
        const cppActual = (cartonProf?.cartonsPerPallet) || (ctx.zones.productDimensions?.cartonsPerPallet) || 0;
        const ucActual = (ctx.zones.productDimensions?.unitsPerCartonPallet) || 0;
        const unitsPerPallet = cppActual * ucActual;

        // Forward-derived peak on-hand inventory (always computed from throughput).
        // Brock 2026-05-08 (consolidation): chips read from sized.positions.*,
        // not sized.locations.shelving.locationsRequired. The Phase 1 helper
        // computeShelvingLocations uses a different (more aggressive) demand
        // formula than sizeFacility's legacy peakUnits × csPct ÷ ucShelv ÷
        // cartonsPerLocation path, so the two numbers drift. The chip should
        // show what the engine ACTUALLY sizes against (= positions.shelvingPositions).
        const peakOnHandUnits = (annualOut > 0 && doh > 0)
          ? Math.round((annualOut / 365) * doh * peakMult)
          : 0;
        const derivedPallets = (peakOnHandUnits > 0 && unitsPerPallet > 0)
          ? Math.ceil(peakOnHandUnits / unitsPerPallet)
          : 0;
        // Pull the engine-used shelving count from sized.positions; fall back
        // to a local derivation (peakUnits × csMix ÷ unitsPerCartonShelv ÷
        // cartonsPerLocation) when sized isn't yet populated.
        const csMix = (+ctx.zones.storageAllocation?.cartonOnShelving || 0) / 100;
        const ucShelv = (+ctx.zones.productDimensions?.unitsPerCartonShelving) || 0;
        const cpl = (+ctx.zones.productDimensions?.cartonsPerLocation) || 0;
        const localDerivedShelving = (peakOnHandUnits > 0 && csMix > 0 && ucShelv > 0 && cpl > 0)
          ? Math.ceil(Math.round(peakOnHandUnits * csMix) / ucShelv / cpl)
          : 0;
        const derivedShelving = sized?.positions?.shelvingPositions
          ? (shelvOverrideOn ? localDerivedShelving : sized.positions.shelvingPositions)
          : localDerivedShelving;

        // What the engine will actually use (override wins over derived).
        const effectivePallets = palOverrideOn ? totalPallets : derivedPallets;
        const effectiveShelving = shelvOverrideOn ? totalShelv : derivedShelving;

        const palBadge = palOverrideOn
          ? '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:var(--c-info-bg);color:var(--c-info-ink);font-size:10px;font-weight:700;letter-spacing:.02em;margin-left:6px;">OVERRIDE</span>'
          : '<span style="color:var(--ies-gray-500);font-weight:400;font-size:11px;margin-left:6px;">(derived)</span>';
        const shelvBadge = shelvOverrideOn
          ? '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:var(--c-info-bg);color:var(--c-info-ink);font-size:10px;font-weight:700;letter-spacing:.02em;margin-left:6px;">OVERRIDE</span>'
          : '<span style="color:var(--ies-gray-500);font-weight:400;font-size:11px;margin-left:6px;">(derived)</span>';

        return `
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin:6px 0 6px 0;">Throughput</div>
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="Annual outbound throughput in units. Drives the on-hand inventory derivation: peak on-hand = (annual / 365) × DOH × peak factor.">Annual Outbound <span class="wsc-muted-reg">(units)</span></label><input type="number" value="${annualOut}" data-vol="annualOutboundUnits" /></div>
            <div class="wsc-config-field"><label title="Days On Hand target — drives the throughput → on-hand inventory conversion. Default 30 days. Tier-A SKUs typically run 7-15 DOH; Tier-C 60-90.">DOH (days)</label><input type="number" value="${doh}" step="1" data-vol="daysOnHand" /></div>
          </div>
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="Peak vs avg-day demand multiplier. Default 1.3. Drives both the peak on-hand units and the dock peak throughput.">Peak Factor</label><input type="number" value="${peakMult}" step="0.1" data-vol="peakMultiplier" /></div>
            <div class="wsc-config-field"><label title="Average inbound pallets/day — drives dock throughput sizing.">Daily Inbound <span class="wsc-muted-reg">(pallets/day)</span></label><input type="number" value="${ctx.volumes.avgDailyInbound || 0}" data-vol="avgDailyInbound" />${_seamHint('avgDailyInbound')}</div>
          </div>

          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin:14px 0 6px 0;">Storage Counts <span class="wsc-label-soft">(optional — override derived values when you have a slotting study)</span></div>
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="Total pallet positions on-hand at peak. Leave blank (0) to derive from throughput. When > 0, replaces the derived count and bypasses peakUnits × mix derivation for FP+CP.">Pallet Positions <span class="wsc-muted-reg">(0 = derive)</span></label><input type="number" value="${totalPallets}" data-vol="totalPallets" />${_seamHint('totalPallets')}</div>
            <div class="wsc-config-field"><label title="Total carton-on-shelving locations on-hand at peak. Leave blank (0) to derive from throughput × shelving mix. When > 0, replaces the derived count.">Shelving Locations <span class="wsc-muted-reg">(0 = derive)</span></label><input type="number" value="${totalShelv}" data-vol="totalShelvingLocations" /></div>
          </div>

          <div style="margin-top:10px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
            <div class="wsc-microlabel-b">Engine will size</div>
            <div>Peak units on-hand: <strong>${peakOnHandUnits.toLocaleString()}</strong> <span class="u-muted">(annual ÷ 365 × DOH × peak)</span></div>
            <div>Pallet positions: <strong>${effectivePallets.toLocaleString()}</strong>${palBadge}<span class="u-muted"> ${palOverrideOn ? `(your count, derived = ${derivedPallets.toLocaleString()})` : `(at ${unitsPerPallet} units/pallet)`}</span></div>
            <div>Shelving locations: <strong>${effectiveShelving.toLocaleString()}</strong>${shelvBadge}<span class="u-muted"> ${shelvOverrideOn ? `(your count, derived = ${derivedShelving.toLocaleString()})` : `(from peak units × shelving mix)`}</span></div>
          </div>
        `;
      })()}

      <!-- ABC velocity tiers -->
      <div class="wsc-subsection">
        <div class="wsc-microlabel">ABC velocity tiers <span class="wsc-label-soft">(% of SKUs by velocity — Pareto default 20/30/50)</span></div>
        ${(() => {
          const a = +ctx.facility.velocityTierAPct || 0;
          const b = +ctx.facility.velocityTierBPct || 0;
          const c = +ctx.facility.velocityTierCPct || 0;
          const total = Math.round((a + b + c) * 10) / 10;
          const ok = total === 100;
          const pillBg = ok ? 'var(--c-success-bg)' : 'var(--c-warn-bg)';
          const pillCol = ok ? 'var(--c-success-ink)' : 'var(--c-warn-ink)';
          const pillTxt = ok ? `${total}% ✓` : `${total}% ⚠ ≠100`;
          return `
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="A-velocity SKUs (fast-movers, ~20% of SKUs drive ~80% of picks). Drives forward-pick demand and replenishment frequency.">A %</label><input type="number" min="0" max="100" value="${a}" data-fac="velocityTierAPct" /></div>
              <div class="wsc-config-field"><label title="B-velocity SKUs (medium movers).">B %</label><input type="number" min="0" max="100" value="${b}" data-fac="velocityTierBPct" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="C-velocity SKUs (slow movers — typical reserve storage candidates).">C %</label><input type="number" min="0" max="100" value="${c}" data-fac="velocityTierCPct" /></div>
              <div class="wsc-config-field" style="display:flex;align-items:flex-end;justify-content:flex-end;">
                <span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:${pillBg};color:${pillCol};font-size:11px;font-weight:700;letter-spacing:.02em;">Total: ${pillTxt}</span>
              </div>
            </div>
          `;
        })()}
      </div>

      <!-- Slotting % (Reserve / Case Pick / Each Pick) — Phase C (2026-05-05)
           moved from old Step 4 into Step 1, since slotting % is tightly
           coupled to the ABC velocity tiers above (A SKUs feed Each Pick,
           C SKUs feed Reserve, etc.). Numeric inputs + sum-validation pill. -->
      ${(() => {
        const fp = +ctx.zones.storageAllocation?.fullPallet || 0;
        const cp = +ctx.zones.storageAllocation?.cartonOnPallet || 0;
        const cs = +ctx.zones.storageAllocation?.cartonOnShelving || 0;
        const total = Math.round((fp + cp + cs) * 10) / 10;
        const ok = total === 100;
        const pillBg = ok ? 'var(--c-success-bg)' : 'var(--c-warn-bg)';
        const pillCol = ok ? 'var(--c-success-ink)' : 'var(--c-warn-ink)';
        const pillTxt = ok ? `${total}% ✓` : `${total}% ⚠ ≠100`;
        return `
          <div class="wsc-subsection">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
              <span>Storage type mix <span class="wsc-label-soft">(% of on-hand inventory by storage pattern)</span></span>
              <span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:${pillBg};color:${pillCol};font-size:11px;font-weight:700;letter-spacing:.02em;">Total: ${pillTxt}</span>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="Reserve / Full Pallet — units stored as full pallet loads in selective rack. Highest density, bulk movement; typical for slower-moving / case-pick reserve.">Reserve <span class="wsc-muted-reg">(Full Pallet) %</span></label><input type="number" min="0" max="100" value="${fp}" data-alloc="fullPallet" /></div>
              <div class="wsc-config-field"><label title="Case Pick / Carton-on-Pallet — pallets staged in pick face for case-quantity pull. Mid-density; typical for B-velocity SKUs needing case-level access.">Case Pick <span class="wsc-muted-reg">(Carton-on-Pallet) %</span></label><input type="number" min="0" max="100" value="${cp}" data-alloc="cartonOnPallet" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="Each Pick / Carton Shelving — cartons in shelf locations for unit-level picking. Lowest density, highest pick velocity; typical for A-velocity SKUs and split-case forward.">Each Pick <span class="wsc-muted-reg">(Carton Shelving) %</span></label><input type="number" min="0" max="100" value="${cs}" data-alloc="cartonOnShelving" /></div>
              <div class="wsc-config-field"></div>
            </div>
          </div>
        `;
      })()}

      <!-- SKU breadth by zone — Phase C: lifted from old Step 4 into Step 1
           (drives min-locations + sku-bound mode for shelving sizing). -->
      <div class="wsc-subsection">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">SKU breadth by zone <span class="wsc-label-soft">(0 = derive heuristic)</span></div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="Number of distinct SKUs in the full-pallet zone. Sets a floor on minimum locations (one face per SKU). 0 = derive from positions × 0.1.">FP SKUs</label><input type="number" value="${ctx.facility.fullPalletSkus ?? 0}" data-fac="fullPalletSkus" /></div>
          <div class="wsc-config-field"><label title="SKUs in the carton-on-pallet zone.">CP SKUs</label><input type="number" value="${ctx.facility.cartonPalletSkus ?? 0}" data-fac="cartonPalletSkus" /></div>
        </div>
        <div class="wsc-config-field" style="margin-top:8px;">
          <label title="SKUs in the shelving zone — each SKU minimally needs 1 shelf face. When SKUs × 1 face > demand-driven cartons, locations become sku-bound.">Shelving SKUs</label>
          <input type="number" value="${ctx.facility.shelvingSkus ?? 0}" data-fac="shelvingSkus" />
        </div>
        ${(() => {
          const sh = sized?.locations?.shelving;
          if (!sh) return '';
          const modeColor = sh.mode === 'sku-bound' ? 'var(--ies-orange, #ff3a00)' : 'var(--ies-gray-700)';
          return `
            <div class="wsc-note">
              <div class="wsc-microlabel-b">Shelving locations</div>
              <div>Demand-side: <strong>${sh.demandLocations.toLocaleString()}</strong> · SKU-side: <strong>${sh.skuMinLocations.toLocaleString()}</strong></div>
              <div>Required (× honeycomb × surge): <strong>${sh.locationsRequired.toLocaleString()}</strong> in <strong>${sh.baysRequired.toLocaleString()}</strong> bays</div>
              <div>Mode: <strong style="color:${modeColor};">${sh.mode}</strong></div>
            </div>
          `;
        })()}
      </div>

      <!-- Per-channel allocation overrides — Phase C: lifted from old Step 4
           into Step 1 (Phase 4 Layer B per-channel slotting overrides). -->
      ${(() => {
        const chans = Array.isArray(ctx.zones.channelMixes) ? ctx.zones.channelMixes : [];
        if (chans.length === 0) return '';
        const facAlloc = ctx.zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
        const rows = chans.map(c => {
          const a = (c.storageAllocation && typeof c.storageAllocation === 'object') ? c.storageAllocation : null;
          const fp = a ? a.fullPallet : facAlloc.fullPallet;
          const cp = a ? a.cartonOnPallet : facAlloc.cartonOnPallet;
          const cs = a ? a.cartonOnShelving : facAlloc.cartonOnShelving;
          const total = (Number(fp) || 0) + (Number(cp) || 0) + (Number(cs) || 0);
          const totalOk = total === 100;
          const isOverridden = !!a;
          return `
            <div class="wsc-channel-alloc-row" data-channel-key="${escapeAttr(c.channelKey)}" style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--ies-gray-100);">
              <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;">
                <span>${escapeHtml(c.name || c.channelKey)} ${isOverridden ? '<span style="color:var(--ies-blue);font-weight:700;" title="Channel override active">●</span>' : '<span class="u-faint" title="Inheriting facility-level allocation">○</span>'}</span>
                <span style="color:${totalOk ? 'var(--ies-gray-500)' : 'var(--ies-orange)'};">${total}%${totalOk ? '' : ' ⚠'}</span>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr) auto;gap:4px;">
                <input type="number" min="0" max="100" value="${fp}" data-channel-alloc="fullPallet" data-channel-key="${escapeAttr(c.channelKey)}" title="Full Pallet %" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;" />
                <input type="number" min="0" max="100" value="${cp}" data-channel-alloc="cartonOnPallet" data-channel-key="${escapeAttr(c.channelKey)}" title="Carton on Pallet %" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;" />
                <input type="number" min="0" max="100" value="${cs}" data-channel-alloc="cartonOnShelving" data-channel-key="${escapeAttr(c.channelKey)}" title="Carton Shelving %" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;" />
                ${isOverridden ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-channel-alloc-reset="${escapeAttr(c.channelKey)}" title="Reset this channel to inherit the facility-level allocation" style="font-size:10px;padding:2px 6px;">↻</button>` : '<span></span>'}
              </div>
            </div>`;
        }).join('');
        return `
          <details class="wsc-channel-allocs" style="margin-top:14px;border-top:1px solid var(--ies-gray-200);padding-top:8px;" open>
            <summary style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);cursor:pointer;">Per-channel allocation overrides</summary>
            <div style="display:flex;flex-direction:column;gap:0;margin-top:6px;font-size:11px;color:var(--ies-gray-600);">
              <div style="font-size:10px;color:var(--ies-gray-400);font-weight:500;text-transform:none;letter-spacing:0;line-height:1.4;padding-bottom:4px;">Reserve / Case Pick / Each Pick — must sum to 100. ● = overridden, ○ = inheriting the facility-level allocation.</div>
              ${rows}
            </div>
          </details>`;
      })()}

      <!-- Operating days/yr + Daily Outbound (pallets/day) — kept in Step 1
           with the volume profile; both feed downstream metrics. -->
      <div class="wsc-config-row" style="margin-top:10px;">
        <div class="wsc-config-field"><label title="Operating days per year — used downstream by DIOH metric.">Operating Days/Yr</label><input type="number" value="${ctx.zones.operatingDaysPerYear || 250}" data-inv="operatingDaysPerYear" /></div>
        <div class="wsc-config-field"><label title="Average outbound pallets/day — drives dock throughput sizing.">Daily Outbound <span class="wsc-muted-reg">(pallets/day)</span></label><input type="number" value="${ctx.volumes.avgDailyOutbound}" data-vol="avgDailyOutbound" />${_seamHint('avgDailyOutbound')}</div>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 2 — Unit Load & Carton (Phase C 2026-05-05: merged previous
         Step 2 "Unit Load Pallet" + Step 3 "Carton Profile" into a single
         step covering pallet + carton physical dimensions and the two
         computed readouts (bay/rack/level + ti×hi/cartons-per-shelf).
         Legacy product-dimensions sub-section dropped from the UI surface
         (data fields preserved on ctx.zones.productDimensions for back-compat).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="2">
      <div class="wsc-step-header u-row u-mb-2">
        <span class="wsc-step-num" style="display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,var(--ies-blue));color:#fff;font-size:11px;font-weight:700;">2</span>
        <span class="wsc-step-title wsc-section-title">Unit Load &amp; Carton</span>
      </div>

      <!-- Pallet -->
      <div class="wsc-microlabel">Pallet</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field">
          <label title="Pallet type drives default L×W. GMA / CHEP = 48×40. Euro = 1200×800mm. Custom uses the L/W fields below.">Pallet Type</label>
          <select data-fac="palletType">
            ${['GMA','CHEP','Euro','EuroHalf','Custom'].map(t =>
              `<option value="${t}"${(ctx.facility.palletType || 'GMA') === t ? ' selected' : ''}>${t}</option>`
            ).join('')}
          </select>
        </div>
        <div class="wsc-config-field"><label>Clear Ht (ft)</label><input type="number" value="${ctx.facility.clearHeight}" step="1" data-fac="clearHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Pallet Length (in)</label><input type="number" value="${ctx.facility.palletWidth ?? 48}" data-fac="palletWidth" /></div>
        <div class="wsc-config-field"><label>Pallet Width (in)</label><input type="number" value="${ctx.facility.palletDepth ?? 40}" data-fac="palletDepth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Load Height (in)</label><input type="number" value="${ctx.facility.palletHeight ?? 54}" data-fac="palletHeight" /></div>
        <div class="wsc-config-field"><label>Beam Ht (in)</label><input type="number" value="${ctx.facility.beamHeight ?? 5}" data-fac="beamHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Flue Space (in)</label><input type="number" value="${ctx.facility.flueSpace ?? 3}" data-fac="flueSpace" /></div>
        <div class="wsc-config-field"><label>Sprinkler Clear (in)</label><input type="number" value="${ctx.facility.topClearance ?? 36}" data-fac="topClearance" /></div>
      </div>
      ${(() => {
        const u = sized?.unitLoad;
        if (!u) return '';
        return `
          <div class="wsc-note">
            <div class="wsc-microlabel-b">Computed unit load</div>
            <div>Bay width (2 pallets per crossbeam): <strong>${u.bayWidthFt.toFixed(2)} ft</strong> (${u.bayWidthIn}")</div>
            <div>Rack depth (single / back-to-back): <strong>${u.rackDepthSingleFt.toFixed(2)} ft / ${u.rackDepthBackToBackFt.toFixed(2)} ft</strong></div>
            <div>Level pitch: <strong>${u.palletLevelHeightFt.toFixed(2)} ft</strong> · Levels at 30 ft clear: <strong>${u.palletLevelsAt30FtClear}</strong></div>
          </div>
        `;
      })()}

      <!-- Carton -->
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-top:14px;margin-bottom:6px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">Carton</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Carton L (in)</label><input type="number" value="${ctx.facility.cartonLengthIn ?? 12}" step="0.5" data-fac="cartonLengthIn" /></div>
        <div class="wsc-config-field"><label>Carton W (in)</label><input type="number" value="${ctx.facility.cartonWidthIn ?? 9}" step="0.5" data-fac="cartonWidthIn" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Carton H (in)</label><input type="number" value="${ctx.facility.cartonHeightIn ?? 12}" step="0.5" data-fac="cartonHeightIn" /></div>
        <div class="wsc-config-field">
          <label title="L-along-rack: long edge of carton sits parallel to the rack run. W-along-rack: short edge along rack run. Affects cartons-per-shelf math.">Orientation</label>
          <select data-fac="cartonOrientation">
            <option value="L-along-rack"${(ctx.facility.cartonOrientation || 'L-along-rack') === 'L-along-rack' ? ' selected' : ''}>L along rack</option>
            <option value="W-along-rack"${ctx.facility.cartonOrientation === 'W-along-rack' ? ' selected' : ''}>W along rack</option>
          </select>
        </div>
      </div>
      <div class="wsc-config-field u-mb-2">
        <label title="Override ti×hi-derived cartons-per-pallet. Use 0 to let the engine compute from carton + pallet dims (typical). Set > 0 if you have a slotting study with a specific case-pack.">Cartons/Pallet Override <span class="wsc-muted-reg">(0 = derive)</span></label>
        <input type="number" value="${ctx.facility.cartonsPerPalletOverride ?? 0}" data-fac="cartonsPerPalletOverride" />
      </div>
      ${(() => {
        const c = sized?.cartonProfile;
        if (!c) return '';
        const tag = c.cartonsPerPalletOverride ? ' (override)' : ' (ti×hi derived)';
        return `
          <div class="wsc-note">
            <div class="wsc-microlabel-b">Computed carton profile</div>
            <div>ti × hi: <strong>${c.ti} × ${c.hi}</strong> — Cartons/Pallet: <strong>${c.cartonsPerPallet}</strong>${tag}</div>
            <div>Cartons/Shelf: <strong>${c.cartonsPerShelf}</strong> (${c.cartonsPerShelfAcross} across × ${c.cartonsPerShelfDeep} deep, ${c.orientation})</div>
            <div>Shelf level pitch: <strong>${c.shelfLevelHeightFt.toFixed(2)} ft</strong> · Levels in 84": <strong>${c.shelfLevelsAt84In}</strong></div>
          </div>
        `;
      })()}

      <!-- UX0-2 (2026-07-03): unit-conversion divisors restored to the UI.
           They were dropped 2026-05-05 while the engine kept honoring 0 —
           the peak-units inventory path could never produce positions. -->
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin:10px 0 6px;">Unit Conversions (inventory &rarr; positions)</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Units per full pallet. Divides peak units into pallet positions. Typical 3PL mixed-SKU: 48.">Units/Pallet</label><input type="number" value="${ctx.zones.productDimensions?.unitsPerPallet ?? 0}" placeholder="48" data-prod="unitsPerPallet" /></div>
        <div class="wsc-config-field"><label title="Units per carton for the carton-on-pallet channel. Typical: 6.">Units/Carton (pallet)</label><input type="number" value="${ctx.zones.productDimensions?.unitsPerCartonPallet ?? 0}" placeholder="6" data-prod="unitsPerCartonPallet" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Cartons per pallet for the carton-on-pallet channel. Typical: 12.">Cartons/Pallet</label><input type="number" value="${ctx.zones.productDimensions?.cartonsPerPallet ?? 0}" placeholder="12" data-prod="cartonsPerPallet" /></div>
        <div class="wsc-config-field"><label title="Units per carton for the shelving channel. Typical: 6.">Units/Carton (shelving)</label><input type="number" value="${ctx.zones.productDimensions?.unitsPerCartonShelving ?? 0}" placeholder="6" data-prod="unitsPerCartonShelving" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Cartons per shelving location. Divides shelving-channel cartons into locations. Typical: 4.">Cartons/Location</label><input type="number" value="${ctx.zones.productDimensions?.cartonsPerLocation ?? 0}" placeholder="4" data-prod="cartonsPerLocation" /></div>
        <div class="wsc-config-field"></div>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 3 — Operating Strategy (Phase C 2026-05-05).
         The "how" of physical rack/MHE/pick design, separate from "what"
         (slotting %, which moved to Step 1). Storage Type drives default
         aisle width; bottom-beam toggles drive rack-level rendering;
         Forward Pick is a velocity-driven slotting decision (paired with
         the A-velocity tier from Step 1).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="3">
      <div class="wsc-step-header u-row u-mb-2">
        <span class="wsc-step-num" style="display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,var(--ies-blue));color:#fff;font-size:11px;font-weight:700;">3</span>
        <span class="wsc-step-title wsc-section-title">Operating Strategy</span>
      </div>

      <div class="wsc-config-row">
        <div class="wsc-config-field">
          <label title="Storage type drives aisle width default and rack design. Single-deep selective is most flexible; double-deep / drive-in / push-back trade flexibility for density.">Storage Type</label>
          <select data-fac="storageType">
            ${['single', 'double', 'bulk', 'carton', 'mix'].map(s =>
              `<option value="${s}"${ctx.facility.storageType === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="wsc-config-field"><label title="Aisle clear width in feet. Counterbalance ~12 ft, reach ~10 ft, VNA ~6 ft. Drives the module width = 2×rack-depth + aisle.">Aisle Width (ft)</label><input type="number" value="${ctx.facility.aisleWidth || calc.AISLE_WIDTHS[ctx.facility.storageType] || 12}" step="0.5" data-fac="aisleWidth" /></div>
      </div>

      <!-- Bottom-beam toggles per zone — drive 3D rendering (rack levels w/ vs w/o ground beam) -->
      <div class="wsc-subsection">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Bottom-beam <span class="wsc-label-soft">(off = pallet on slab)</span></div>
        <div class="wsc-config-field" style="margin-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;">
            <input type="checkbox" data-fac-bool="bottomBeamFp" ${ctx.facility.bottomBeamFp ? 'checked' : ''} class="u-m0" />
            <span>Full-Pallet zone (default off)</span>
          </label>
        </div>
        <div class="wsc-config-field" style="margin-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;">
            <input type="checkbox" data-fac-bool="bottomBeamCp" ${ctx.facility.bottomBeamCp ? 'checked' : ''} class="u-m0" />
            <span>Carton-Pallet zone (default on for wire-deck case-pick)</span>
          </label>
        </div>
        <div class="wsc-config-field">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;">
            <input type="checkbox" data-fac-bool="bottomBeamShelving" ${ctx.facility.bottomBeamShelving ? 'checked' : ''} class="u-m0" />
            <span>Shelving zone (default off — has own deck)</span>
          </label>
        </div>
      </div>

      <!-- Forward Pick — pairs with A-velocity tier from Step 1 -->
      <div class="wsc-subsection">
        <div class="wsc-microlabel">Forward Pick <span class="wsc-label-soft">(velocity-driven slotting)</span></div>
        <div class="wsc-config-field" style="margin-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;font-size:12px;">
            <input type="checkbox" ${ctx.zones.forwardPick?.enabled ? 'checked' : ''} data-fwd="enabled" class="u-m0" />
            <span>Enable Forward Pick area</span>
          </label>
        </div>
        ${ctx.zones.forwardPick?.enabled ? `
          <div class="wsc-config-row">
            <div class="wsc-config-field">
              <label title="Pick type drives sf-per-active-face. Carton Flow ~12 sf, Light Case ~14 sf, Heavy Case ~45 sf (pallet-style face).">Pick Type</label>
              <select data-fwd="type">
                <option value="carton_flow"${ctx.zones.forwardPick?.type === 'carton_flow' ? ' selected' : ''}>Carton Flow</option>
                <option value="light_case"${ctx.zones.forwardPick?.type === 'light_case' ? ' selected' : ''}>Light Case</option>
                <option value="heavy_case"${ctx.zones.forwardPick?.type === 'heavy_case' ? ' selected' : ''}>Heavy Case</option>
              </select>
            </div>
            <div class="wsc-config-field"><label title="Total SKUs eligible for forward-pick assignment. The A-velocity tier % from Step 1 determines how many of these get an active pick face.">SKU count</label><input type="number" value="${ctx.zones.forwardPick?.skuCount || 2000}" data-fwd="skuCount" /></div>
          </div>
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="DOH held in the forward-pick area before replenishment from reserve. Lower = more frequent reps; higher = bigger forward area.">Days Inventory (DOH)</label><input type="number" value="${ctx.zones.forwardPick?.daysInventory || 3}" step="0.5" data-fwd="daysInventory" /></div>
            <div class="wsc-config-field"><label title="Outbound units/day flowing through the forward-pick area. Used by some downstream metrics; doesn't drive area sizing directly (active-face count does).">Outbound (units/day)</label><input type="number" value="${ctx.zones.forwardPick?.outboundUnitsPerDay || 5000}" data-fwd="outboundUnitsPerDay" /></div>
          </div>
          <div class="wsc-note">
            <div class="wsc-microlabel-b">Active-face derivation</div>
            ${(() => {
              const skus = +ctx.zones.forwardPick?.skuCount || 0;
              const aPct = +ctx.facility.velocityTierAPct || 20;
              const activeFaces = Math.ceil(skus * aPct / 100);
              return `<div>Active faces = SKU count × A-velocity % = <strong>${skus.toLocaleString()}</strong> × <strong>${aPct}%</strong> = <strong>${activeFaces.toLocaleString()}</strong> faces</div>`;
            })()}
          </div>
        ` : ''}
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 4 — Dock & Support (Phase C 2026-05-05 — lifted from old
         Advanced collapsible). Peak-throughput-driven dock door derivation
         (Phase 1 helper) + explicit door overrides + optional ctx.zones (VAS,
         Returns, Chargeback, Charging, Repack/VAS, Other) + custom ctx.zones.
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="4">
      <div class="wsc-step-header u-row u-mb-2">
        <span class="wsc-step-num" style="display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,var(--ies-blue));color:#fff;font-size:11px;font-weight:700;">4</span>
        <span class="wsc-step-title wsc-section-title">Dock &amp; Support</span>
      </div>

      <!-- Dock throughput parameters (peak-throughput-driven derivation) -->
      <div class="wsc-microlabel">Dock throughput parameters</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Pallets per truck — 26 with stack, 30 floor-loaded.">Pallets/Truck</label><input type="number" value="${ctx.facility.palletsPerTruck ?? 26}" data-fac="palletsPerTruck" /></div>
        <div class="wsc-config-field"><label title="Hours each truck occupies a door (live unload + stage).">Dwell Hrs/Truck</label><input type="number" value="${ctx.facility.dwellHoursPerTruck ?? 1.5}" step="0.25" data-fac="dwellHoursPerTruck" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Operating shift hours per day. 16 = 2-shift, 24 = round-clock.">Shift Hours/Day</label><input type="number" value="${ctx.facility.shiftHoursPerDay ?? 16}" data-fac="shiftHoursPerDay" /></div>
        <div class="wsc-config-field"><label title="Dock surge buffer fraction. 0.20 = 20% buffer on derived door count.">Dock Surge</label><input type="number" value="${ctx.facility.surgePctDock ?? 0.20}" step="0.05" data-fac="surgePctDock" /></div>
      </div>

      <!-- Dock layout + explicit door overrides -->
      <div class="wsc-subsection">
        <div class="wsc-microlabel">Dock layout &amp; overrides</div>
        <div class="wsc-config-field u-mb-2">
          <label title="Single-sided = inbound + outbound on the same dock face. Two-sided = inbound on one wall, outbound on the opposite wall — uses 2× as much wall but separates flows.">Dock Layout</label>
          <select data-dock="sided">
            <option value="single"${ctx.zones.dockConfig?.sided === 'single' ? ' selected' : ''}>Single-Sided</option>
            <option value="two"${ctx.zones.dockConfig?.sided === 'two' ? ' selected' : ''}>Two-Sided</option>
          </select>
        </div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="If > 0, engine uses this explicit count instead of deriving from peak throughput.">Inbound Doors <span class="wsc-muted-reg">(explicit)</span></label><input type="number" value="${ctx.zones.dockConfig?.inboundDoors ?? 0}" data-dock="inboundDoors" /></div>
          <div class="wsc-config-field"><label title="If > 0, engine uses this explicit count instead of deriving from peak throughput.">Outbound Doors <span class="wsc-muted-reg">(explicit)</span></label><input type="number" value="${ctx.zones.dockConfig?.outboundDoors ?? 0}" data-dock="outboundDoors" /></div>
        </div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="Pallets per door per hour throughput rate. Drives the legacy door-utilization metric.">Pallets/Hr/Door</label><input type="number" value="${ctx.zones.dockConfig?.palletsPerDockHour ?? 0}" step="1" data-dock="palletsPerDockHour" /></div>
          <div class="wsc-config-field"><label title="Legacy operating hours/day for door-utilization metric.">Operating Hrs <span class="wsc-muted-reg">(legacy)</span></label><input type="number" value="${ctx.zones.dockConfig?.dockOperatingHours ?? 0}" step="0.5" data-dock="dockOperatingHours" /></div>
        </div>
      </div>

      <!-- Optional ctx.zones (VAS / Returns / Chargeback) -->
      <div class="wsc-subsection">
        <div class="wsc-microlabel">Optional Zones</div>
        <div class="wsc-config-field u-mb-2">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" ${ctx.zones.optionalZones?.vas?.enabled ? 'checked' : ''} data-opt="vas-enabled" class="u-m0" />
            <span>VAS</span>
          </label>
        </div>
        <div class="wsc-config-row single-col" id="wsc-opt-vas-row" style="display:${ctx.zones.optionalZones?.vas?.enabled ? 'grid' : 'none'};">
          <div class="wsc-config-field"><label>VAS SF</label><input type="number" value="${ctx.zones.optionalZones?.vas?.sqft || 0}" data-opt="vas-sqft" /></div>
        </div>
        <div class="wsc-config-field u-mb-2">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" ${ctx.zones.optionalZones?.returns?.enabled ? 'checked' : ''} data-opt="returns-enabled" class="u-m0" />
            <span>Returns</span>
          </label>
        </div>
        <div class="wsc-config-row single-col" id="wsc-opt-returns-row" style="display:${ctx.zones.optionalZones?.returns?.enabled ? 'grid' : 'none'};">
          <div class="wsc-config-field"><label>Returns SF</label><input type="number" value="${ctx.zones.optionalZones?.returns?.sqft || 0}" data-opt="returns-sqft" /></div>
        </div>
        <div class="wsc-config-field u-mb-2">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" ${ctx.zones.optionalZones?.chargeback?.enabled ? 'checked' : ''} data-opt="chargeback-enabled" class="u-m0" />
            <span>Chargeback</span>
          </label>
        </div>
        <div class="wsc-config-row single-col" id="wsc-opt-chargeback-row" style="display:${ctx.zones.optionalZones?.chargeback?.enabled ? 'grid' : 'none'};">
          <div class="wsc-config-field"><label>Chargeback SF</label><input type="number" value="${ctx.zones.optionalZones?.chargeback?.sqft || 0}" data-opt="chargeback-sqft" /></div>
        </div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="Battery charging / equipment maintenance area.">Charging SF</label><input type="number" value="${ctx.zones.chargingSqft || 0}" data-zone="chargingSqft" /></div>
          <div class="wsc-config-field"><label title="Repack / value-add area inside the warehouse footprint.">Repack/VAS SF</label><input type="number" value="${ctx.zones.repackSqft || 0}" data-zone="repackSqft" /></div>
        </div>
        <div class="wsc-config-field" style="margin-top:8px;">
          <label>Other SF</label>
          <input type="number" value="${ctx.zones.otherSqft || 0}" data-zone="otherSqft" />
        </div>
      </div>

      <!-- Custom ctx.zones -->
      <div class="wsc-subsection">
        <div class="wsc-microlabel">Custom Zones</div>
        <div id="wsc-custom-zones-list" style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px;">
          ${(ctx.zones.customZones || []).map((z, i) => `
            <div style="display:flex; gap:4px; align-items:center;">
              <input type="text" value="${z.name}" data-custom-name="${i}" placeholder="Zone name" style="flex:1; padding:4px 6px; border:1px solid var(--ies-gray-200); border-radius:4px; font-size:11px;" />
              <input type="number" value="${z.sqft}" data-custom-sqft="${i}" min="0" placeholder="SF" style="width:80px; padding:4px 6px; border:1px solid var(--ies-gray-200); border-radius:4px; font-size:11px;" />
              <button data-custom-remove="${i}" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:18px; padding:0; line-height:1;">×</button>
            </div>
          `).join('')}
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-add-custom-zone" class="u-full">+ Add Custom Zone</button>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 5 — Sized Facility (Design mode) / Capacity Check (Constraint mode).
         Phase A (2026-05-05): mode-aware title + content. Design = single
         answer (engine output); Constraint = required vs entered W×D with
         explicit gap row. The misleading "Built (current): X SF at Y ft"
         label that mixed sized output with user dims under one label is gone.
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="5">
      <div class="wsc-step-header u-row u-mb-2">
        <span class="wsc-step-num" style="display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-gray-500);color:#fff;font-size:11px;font-weight:700;">5</span>
        <span class="wsc-step-title wsc-section-title">${mode === 'constraint' ? 'Capacity Check' : 'Sized Facility'}</span>
      </div>
      ${(() => {
        if (!sized) return `<div style="font-size:11px;color:var(--ies-gray-500);">Sizing unavailable — fill in Steps 1-4.</div>`;
        const r = sized.requirementsDriven || {};
        const requiredBlock = `
          <div style="padding:10px 12px;background:var(--ies-gray-50);border-radius:6px;font-size:12px;color:var(--ies-gray-700);margin-bottom:8px;">
            <div class="wsc-kv-plain"><span>Storage</span><strong>${r.storageSf?.toLocaleString() || 0} sf</strong></div>
            <div class="wsc-kv-plain"><span>Dock (peak-throughput driven)</span><strong>${r.dockSf?.toLocaleString() || 0} sf</strong></div>
            <div class="wsc-kv-plain"><span>Office</span><strong>${r.officeSf?.toLocaleString() || 0} sf</strong></div>
            <div class="wsc-kv-plain"><span>Staging</span><strong>${r.stagingSf?.toLocaleString() || 0} sf</strong></div>
            ${r.additionalSf > 0 ? `<div class="wsc-kv-plain"><span>Additional</span><strong>${r.additionalSf.toLocaleString()} sf</strong></div>` : ''}
            <div style="display:flex;justify-content:space-between;padding:2px 0;color:var(--ies-gray-500);"><span>+ Circulation buffer (10%)</span><strong>${r.circulationSf?.toLocaleString() || 0} sf</strong></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0 2px;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:var(--ies-blue,var(--ies-blue));"><span>${mode === 'constraint' ? 'Required' : 'Sized Total'}</span><strong>${r.totalSfRequired?.toLocaleString() || 0} sf</strong></div>
            ${mode === 'design' ? `<div style="display:flex;justify-content:space-between;padding:2px 0;color:var(--ies-gray-500);font-size:11px;"><span>Suggested footprint (1.5:1)</span><strong>${r.suggestedLongFt || 0} × ${r.suggestedShortFt || 0} ft</strong></div>` : ''}
          </div>
        `;
        if (mode === 'design') return requiredBlock;
        // Constraint mode — show user dims + capacity gap row.
        const builtSf = (Number(ctx.facility.buildingWidth) || 0) * (Number(ctx.facility.buildingDepth) || 0);
        const haveBuilt = builtSf > 0;
        const required = r.totalSfRequired || 0;
        const deltaSf = haveBuilt ? builtSf - required : 0;
        const deltaPct = (haveBuilt && required > 0) ? Math.round((deltaSf / required) * 1000) / 10 : 0;
        const gapColor = !haveBuilt ? 'var(--ies-gray-500)' : Math.abs(deltaPct) <= 5 ? 'var(--ies-green,#10b981)' : deltaSf > 0 ? 'var(--ies-blue,var(--ies-blue))' : 'var(--ies-orange, #ff3a00)';
        const gapLabel = !haveBuilt ? 'Enter building dims to compute gap' : Math.abs(deltaPct) <= 5 ? `Within ±5% — fits` : deltaSf > 0 ? `+${deltaPct}% slack` : `${deltaPct}% short`;
        return `
          ${requiredBlock}
          <div style="padding:10px 12px;background:#fff;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:12px;color:var(--ies-gray-700);margin-bottom:8px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:4px;">Existing building</div>
            <div class="wsc-config-row" style="margin-bottom:6px;">
              <div class="wsc-config-field"><label>Width (ft)</label><input type="number" value="${ctx.facility.buildingWidth || 0}" data-fac="buildingWidth" /></div>
              <div class="wsc-config-field"><label>Depth (ft)</label><input type="number" value="${ctx.facility.buildingDepth || 0}" data-fac="buildingDepth" /></div>
            </div>
            <div class="wsc-kv-plain"><span>Footprint area</span><strong>${haveBuilt ? builtSf.toLocaleString() + ' sf' : '—'}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0 2px;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:${gapColor};"><span>Gap</span><strong>${haveBuilt ? (deltaSf >= 0 ? '+' : '') + deltaSf.toLocaleString() + ' sf · ' : ''}${gapLabel}</strong></div>
          </div>
          <div style="border-top:1px dashed var(--ies-gray-300);padding-top:8px;margin-top:4px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Constraint dims</div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label>Col Spacing (ft)</label><input type="number" value="${ctx.facility.columnSpacingX || 50}" data-fac="columnSpacingX" /></div>
              <div class="wsc-config-field"><label>Office SF</label><input type="number" value="${ctx.zones.officeSqft}" data-zone="officeSqft" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label>Recv Staging SF</label><input type="number" value="${ctx.zones.receiveStagingSqft}" data-zone="receiveStagingSqft" /></div>
              <div class="wsc-config-field"><label>Ship Staging SF</label><input type="number" value="${ctx.zones.shipStagingSqft}" data-zone="shipStagingSqft" /></div>
            </div>
          </div>
        `;
      })()}
    </div>

  `;
}


// ============================================================
// UX-2 WSC QUICK SIZE (2026-07-04) — consumer tier panel.
// Five inputs → sized SF, reusing the SAME data-fac / data-vol
// attributes so bindConfigEvents wires them with zero new plumbing.
// Everything else rides engineering defaults; the full stepped
// Configure panel stays behind the Engineering toggle.
// ============================================================

export const WSC_QUICK_MIX_PRESETS = [
  { key: 'fp',       label: 'Full-Pallet DC',   hint: 'Bulk reserve · low touch',        mix: { fullPallet: 80, cartonOnPallet: 15, cartonOnShelving: 5 } },
  { key: 'balanced', label: 'Mixed Case-Pick',  hint: 'Standard distribution mix',       mix: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 } },
  { key: 'ecom',     label: 'E-Comm Each-Pick', hint: 'High shelving · forward pick',    mix: { fullPallet: 40, cartonOnPallet: 35, cartonOnShelving: 25 } },
];

export function renderQuickConfigHtml(ctx) {
  let sized = null;
  try { sized = calc.sizeFacility(ctx.toSizingInputs()); } catch {}
  const sizedSqft = Math.round(sized?.totalSqft || 0);
  const alloc = ctx.zones.storageAllocation || {};
  const activeKey = (WSC_QUICK_MIX_PRESETS.find(p =>
    p.mix.fullPallet === +alloc.fullPallet
    && p.mix.cartonOnPallet === +alloc.cartonOnPallet
    && p.mix.cartonOnShelving === +alloc.cartonOnShelving) || {}).key || null;

  return `
    <div class="wsc-config-section" style="margin-bottom:12px;">
      <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;">Answer five things — get a sized building and walk it in 3D. Flip to <strong>Engineering</strong> for throughput derivation, docks, carton profile, and ABC tiers.</div>
    </div>

    <div class="wsc-config-section wsc-step">
      <div class="wsc-config-field" style="margin-bottom:10px;">
        <label>Facility Name</label>
        <input value="${ctx.facility.name}" data-fac="name" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:10px;">
        <label title="Total pallet positions on hand at peak. The engine sizes racking from this directly.">Peak Pallet Positions</label>
        <input type="number" min="0" value="${+ctx.volumes.totalPallets || 0}" data-vol="totalPallets" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:10px;">
        <label title="Carton-on-shelving locations at peak. Leave 0 if everything lives in rack.">Shelving Locations <span class="wsc-muted-reg">(0 = none)</span></label>
        <input type="number" min="0" value="${+ctx.volumes.totalShelvingLocations || 0}" data-vol="totalShelvingLocations" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:10px;">
        <label title="Clear stacking height to the lowest obstruction. Drives rack levels.">Clear Height (ft)</label>
        <input type="number" min="12" max="60" value="${+ctx.facility.clearHeight || 32}" data-fac="clearHeight" />
      </div>
      <div class="wsc-config-field">
        <label title="How inventory splits across full-pallet rack, case-pick faces, and shelving. Sets the storage allocation mix.">Operation Type</label>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;">
          ${WSC_QUICK_MIX_PRESETS.map(p => `
            <button type="button" data-wsc-mix-preset="${p.key}"
                    style="text-align:left;padding:8px 10px;border-radius:6px;cursor:pointer;border:1px solid ${activeKey === p.key ? 'var(--ies-blue,var(--ies-blue))' : 'var(--ies-gray-200)'};background:${activeKey === p.key ? 'rgba(0,71,171,0.06)' : '#fff'};">
              <div style="font-size:12px;font-weight:700;color:var(--ies-gray-700);">${p.label} <span style="font-weight:500;color:var(--ies-gray-500);">· ${p.mix.fullPallet}/${p.mix.cartonOnPallet}/${p.mix.cartonOnShelving}</span></div>
              <div style="font-size:11px;color:var(--ies-gray-500);">${p.hint}</div>
            </button>`).join('')}
        </div>
      </div>
    </div>

    <div class="wsc-config-section" style="margin-top:12px;padding:12px;background:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%);border:1px solid var(--ies-gray-200);border-radius:8px;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ies-gray-500);">Sized Facility</div>
      <div style="font-size:24px;font-weight:800;color:var(--ies-navy);margin:4px 0;">${sizedSqft > 0 ? sizedSqft.toLocaleString() + ' SF' : '—'}</div>
      ${sized && sizedSqft > 0 ? `
        <div style="font-size:11px;color:var(--ies-gray-600);line-height:1.6;">
          ${(sized.positions?.grossPositions || 0).toLocaleString()} gross positions · ${(sized.positions?.shelvingPositions || 0).toLocaleString()} shelving loc<br/>
          Storage ${Math.round(sized.storageSqft || 0).toLocaleString()} SF · docks + staging + circulation included
        </div>` : `
        <div style="font-size:11px;color:var(--ies-gray-500);">Enter peak pallet positions to size the building.</div>`}
    </div>
  `;
}

export function bindConfigEvents(panel, ctx) {
  const debouncedRender = ctx.debounceRender(ctx.refreshContent, 100);

  // Facility fields (with input debounce for live update)
  panel.querySelectorAll('[data-fac]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fac;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      ctx.facility[field] = val;
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  // Phase 2 redesign — boolean ctx.facility toggles (bottom-beam, override).
  // Re-renders the Configure panel itself when toggled because the override
  // toggle hides/shows the dims editor.
  panel.querySelectorAll('[data-fac-bool]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.facBool;
      ctx.facility[field] = !!(/** @type {HTMLInputElement} */ (e.target)).checked;
      ctx.setDirty(true);
      // Override toggle re-renders the panel (to flip dim editor visibility);
      // bottom-beam toggles only re-render the content view.
      if (field === 'buildingDimsOverride') ctx.refreshConfig();
      ctx.refreshContent();
    });
  });

  // Phase A redesign (2026-05-05) — Sizing Mode toggle (Design / Constraint).
  // Re-renders both the Configure panel (Step 5 changes shape) and the content
  // view (rendering swaps to mode-aware footprint). Phase E fix: also refresh
  // the chrome KPI strip so the mode-aware chip label (Sized SF / Built SF)
  // doesn't stay stale on mode toggle.
  panel.querySelectorAll('[data-wsc-mode]').forEach(btn => {
    btn.addEventListener('click', e => {
      const next = /** @type {HTMLElement} */ (e.currentTarget).dataset.wscMode;
      if (next !== 'design' && next !== 'constraint') return;
      if (ctx.facility.sizingMode === next) return;
      ctx.facility.sizingMode = next;
      // Keep buildingDimsOverride coherent with the new mode for any code
      // path still consulting the legacy boolean. Constraint = override on;
      // design = override off.
      ctx.facility.buildingDimsOverride = (next === 'constraint');
      ctx.setDirty(true);
      ctx.refreshConfig();
      ctx.refreshContent();
      ctx.refreshKpis();
    });
  });

  // UX-2 WSC Quick Size — storage-mix preset chips (quick panel only;
  // querySelectorAll is empty on the engineering panel).
  panel.querySelectorAll('[data-wsc-mix-preset]').forEach(btn => {
    btn.addEventListener('click', e => {
      const key = /** @type {HTMLElement} */ (e.currentTarget).dataset.wscMixPreset;
      const preset = WSC_QUICK_MIX_PRESETS.find(p => p.key === key);
      if (!preset) return;
      ctx.zones.storageAllocation = { ...preset.mix };
      ctx.setDirty(true);
      ctx.refreshConfig();
      ctx.refreshContent();
      ctx.refreshKpis();
    });
  });

  // Brock 2026-05-08 (consolidation): primary-input toggle removed. The Phase B
  // toggle lived here from 2026-05-05 to 2026-05-08; it was replaced with a
  // unified form where throughput inputs and override inputs live side-by-side.
  // Engine logic now picks override-vs-derived per-field rather than mode-wide.
  // ctx.facility.primaryInventoryInput is now silently unused (preserved on saved
  // models for back-compat — has no effect on rendering or sizing).

  // Zone fields (with input debounce for live update)
  panel.querySelectorAll('[data-zone]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.zone;
      ctx.zones[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  // Volume fields (with input debounce for live update).
  // Brock 2026-05-08 (consolidation): on change (= blur), also re-render the
  // Configure panel so the "Engine will size" chips update to reflect new
  // throughput / override values. Pre-fix the chips stayed at 0 even after
  // typing 50M into Annual Outbound — only ctx.refreshContent ran. Safe to
  // re-render the panel on `change` because the user has already left the
  // field (focus is elsewhere) by the time `change` fires.
  panel.querySelectorAll('[data-vol]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.vol;
      ctx.volumes[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshConfig();
      ctx.refreshContent();
      ctx.refreshKpis();
    });
  });

  // Storage allocation inputs — ctx.facility-level (legacy single mix).
  // Phase B redesign (2026-05-05): replaced sliders with numeric inputs +
  // sum-validation pill. Handler now re-renders the Configure panel so the
  // pill updates and the per-channel "inheriting" rows reflect new ctx.facility
  // defaults (fixes a Phase 2 bug where inheriting channels didn't refresh
  // when ctx.facility-level allocation changed).
  panel.querySelectorAll('input[data-alloc]').forEach(input => {
    // Phase A.A12 (2026-05-26) — live canvas update as the user types.
    // input fires on every keystroke; we write to the model immediately and
    // debounce the content re-render so the 2D Plan rack mix updates in
    // real time. The panel itself is NOT re-rendered here — that would
    // destroy input focus mid-typing. The blur-time change handler below
    // still does the full refresh (panel pill + content) once the user
    // commits the field.
    input.addEventListener('input', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!ctx.zones.storageAllocation) ctx.zones.storageAllocation = { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      ctx.zones.storageAllocation[field] = val;
      ctx.setDirty(true);
      debouncedRender();
    });
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!ctx.zones.storageAllocation) ctx.zones.storageAllocation = { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      ctx.zones.storageAllocation[field] = val;
      ctx.setDirty(true);
      ctx.refreshConfig();
      ctx.refreshContent();
    });
  });

  // Phase 4 Layer B (ctx.volumes-as-nucleus, 2026-04-29) — per-channel
  // storageAllocation override inputs. First write to a channel auto-promotes
  // it from "inheriting ctx.facility" to "explicit override" (storageAllocation
  // populated on the channel mix). Reset (↻) wipes the override.
  panel.querySelectorAll('input[data-channel-alloc]').forEach(input => {
    // Shared write — used by both input (live) and change (commit) paths.
    const writeChannelAlloc = (tgt) => {
      const field = tgt.dataset.channelAlloc;
      const k = tgt.dataset.channelKey;
      const val = parseFloat(tgt.value) || 0;
      const facAlloc = ctx.zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      if (!Array.isArray(ctx.zones.channelMixes)) return false;
      const mix = ctx.zones.channelMixes.find(m => m.channelKey === k);
      if (!mix) return false;
      if (!mix.storageAllocation) {
        // First write promotes the channel to "explicit override" by
        // seeding from the facility-level default.
        mix.storageAllocation = {
          fullPallet: facAlloc.fullPallet || 0,
          cartonOnPallet: facAlloc.cartonOnPallet || 0,
          cartonOnShelving: facAlloc.cartonOnShelving || 0,
        };
      }
      mix.storageAllocation[field] = val;
      return true;
    };
    // Phase A.A12 — live canvas update as the user types. Skip the panel
    // re-render (would destroy input focus); blur-time change handler
    // below still refreshes the panel so the channel-mix UI re-reflects
    // the new override (e.g., reset button appears if alloc diverges).
    input.addEventListener('input', e => {
      if (!writeChannelAlloc(/** @type {HTMLInputElement} */ (e.target))) return;
      ctx.setDirty(true);
      debouncedRender();
    });
    input.addEventListener('change', e => {
      if (!writeChannelAlloc(/** @type {HTMLInputElement} */ (e.target))) return;
      ctx.setDirty(true);
      ctx.refreshConfig();
      ctx.refreshContent();
    });
  });
  panel.querySelectorAll('[data-channel-alloc-reset]').forEach(btn => {
    btn.addEventListener('click', e => {
      const k = /** @type {HTMLElement} */ (e.currentTarget).dataset.channelAllocReset;
      if (!Array.isArray(ctx.zones.channelMixes)) return;
      const mix = ctx.zones.channelMixes.find(m => m.channelKey === k);
      if (!mix) return;
      delete mix.storageAllocation;
      ctx.setDirty(true);
      ctx.refreshConfig();
      ctx.refreshContent();
    });
  });

  // Product dimension fields (with input debounce for live update)
  panel.querySelectorAll('[data-prod]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.prod;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      // UX0-2: seed zeros — seeding 48/6/12/6/4 here silently committed
      // phantom conversions for the four fields the user did NOT touch.
      if (!ctx.zones.productDimensions) ctx.zones.productDimensions = { unitsPerPallet: 0, unitsPerCartonPallet: 0, cartonsPerPallet: 0, unitsPerCartonShelving: 0, cartonsPerLocation: 0 };
      ctx.zones.productDimensions[field] = val;
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  // Dock configuration fields (with input debounce for live update)
  panel.querySelectorAll('[data-dock]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.dock;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      if (!ctx.zones.dockConfig) ctx.zones.dockConfig = { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 };
      ctx.zones.dockConfig[field] = val;
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  // Inventory parameters (with input debounce for live update)
  panel.querySelectorAll('[data-inv]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.inv;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      ctx.zones[field] = val;
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  // Forward pick fields. Phase B (2026-05-05): the legacy display-toggle path
  // relied on #wsc-fwd-opts / #wsc-fwd-params / #wsc-fwd-outbound DOM ids that
  // disappeared when Forward Pick was lifted into Step 4 with conditional
  // template-literal rendering. Now: when 'enabled' toggles, re-render the
  // Configure panel so the sub-block flips visibility correctly.
  panel.querySelectorAll('[data-fwd]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fwd;
      if (!ctx.zones.forwardPick) ctx.zones.forwardPick = { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 };
      if (field === 'enabled') {
        ctx.zones.forwardPick[field] = /** @type {HTMLInputElement} */ (e.target).checked;
      } else {
        const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
        ctx.zones.forwardPick[field] = val;
      }
      ctx.setDirty(true);
    };
    input.addEventListener('change', (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fwd;
      handleChange(e);
      // Toggling enabled flips the conditional sub-block; re-render the panel.
      if (field === 'enabled') ctx.refreshConfig();
      ctx.refreshContent();
    });
    // Keep input-event live update for non-enabled fields (text/number).
    if (input.type !== 'checkbox') {
      input.addEventListener('input', (e) => {
        handleChange(e);
        debouncedRender();
      });
    }
  });

  // Optional zone fields (with input debounce for live update)
  panel.querySelectorAll('[data-opt]').forEach(input => {
    const handleChange = (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.opt;
      if (!ctx.zones.optionalZones) ctx.zones.optionalZones = { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } };
      if (key.endsWith('-enabled')) {
        const zone = key.replace('-enabled', '');
        ctx.zones.optionalZones[zone].enabled = /** @type {HTMLInputElement} */ (e.target).checked;
        const sqftDiv = panel.querySelector(`#wsc-opt-${zone}-row`);
        if (sqftDiv) sqftDiv.style.display = ctx.zones.optionalZones[zone].enabled ? 'grid' : 'none';
      } else if (key.endsWith('-sqft')) {
        const zone = key.replace('-sqft', '');
        ctx.zones.optionalZones[zone].sqft = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  // Custom zone management (with input debounce for live update)
  panel.querySelectorAll('[data-custom-name], [data-custom-sqft]').forEach(input => {
    const handleChange = (e) => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.customName || /** @type {HTMLInputElement} */ (e.target).dataset.customSqft);
      if (!ctx.zones.customZones) ctx.zones.customZones = [];
      if (e.target.dataset.customName !== undefined) {
        ctx.zones.customZones[idx].name = /** @type {HTMLInputElement} */ (e.target).value;
      } else {
        ctx.zones.customZones[idx].sqft = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      ctx.setDirty(true);
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      ctx.refreshContent();
    });
  });

  panel.querySelectorAll('[data-custom-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const idx = parseInt(/** @type {HTMLElement} */ (e.target).dataset.customRemove);
      if (ctx.zones.customZones) ctx.zones.customZones.splice(idx, 1);
      ctx.setDirty(true);
      ctx.refreshConfig();
      ctx.refreshContent();
    });
  });

  panel.querySelector('[data-action="wsc-add-custom-zone"]')?.addEventListener('click', () => {
    if (!ctx.zones.customZones) ctx.zones.customZones = [];
    ctx.zones.customZones.push({ name: `Custom Zone ${ctx.zones.customZones.length + 1}`, sqft: 2000 });
    ctx.setDirty(true);
    ctx.refreshConfig();
    ctx.refreshContent();
  });

  // Phase 4 of ctx.volumes-as-nucleus (Layer A, 2026-04-29): Pull-from-CM button.
  // Re-fetches the linked cost model and re-runs the channel-aware payload
  // builder, then applies it through ctx.handleCmPush so ctx.volumes (and ctx.zones'
  // peakUnitsPerDay) refresh in place.
  panel.querySelector('[data-action="wsc-pull-from-cm"]')?.addEventListener('click', async () => {
    const cmId = ctx.facility.parent_cost_model_id;
    if (!cmId) {
      showToast('No linked Cost Model on this scenario.', 'error');
      return;
    }
    try {
      const row = await cmApi.getModel(cmId);
      const cmModel = (row && row.model_data) ? row.model_data : row;
      if (!cmModel) {
        showToast('Could not load linked Cost Model.', 'error');
        return;
      }
      // backfillChannelsFromLegacy ensures synthetic channels exist on legacy models.
      try { cmApi.backfillChannelsFromLegacy(cmModel); } catch {}
      const payload = cmApi.buildWscLaunchPayload(cmModel);
      ctx.handleCmPush(payload);
      ctx.setDirty(true);
      showToast('Pulled volume defaults from Cost Model.', 'success');
    } catch (e) {
      console.warn('[WSC] Pull from CM failed:', e);
      showToast('Pull from CM failed - see console.', 'error');
    }
  });

  // Toolbar
  panel.querySelector('[data-action="wsc-new"]')?.addEventListener('click', async () => {
    if (ctx.isDirty && !(await showConfirm('Unsaved changes. Start new?'))) return;
    ctx.resetState();
    ctx.refreshConfig();
    ctx.refreshContent();
  });

  // 2026-04-27 EVE: wsc-back delegated on rootEl. The button now lives in
  // tool-frame.js's top header strip (outside #wsc-config), so a panel-scoped
  // listener never fired. Delegated on root so any data-action="wsc-back"
  // click — wherever it lives in the tool DOM — routes here.
  ctx.rootEl?.addEventListener('click', async (e) => {
    if (!(/** @type {HTMLElement} */ (e.target))?.closest?.('[data-action="wsc-back"]')) return;
    if (ctx.isDirty && !(await showConfirm('Unsaved changes. Leave for the scenarios list?'))) return;
    ctx.setDirty(false);
    ctx.viewMode = 'landing';
    await ctx.refreshLanding();
  });

  // Copy-summary button
  panel.querySelector('[data-action="wsc-copy-summary"]')?.addEventListener('click', () => {
    ctx.copySummary();
  });

  panel.querySelector('[data-action="wsc-save"]')?.addEventListener('click', async (e) => {
    // Phase 4 (2026-05-04): delegate to ctx.handleSaveWsc so the WSC→CM writeback
    // path runs from this button too. Pre-Phase-4 this had its own inline
    // save that bypassed the writeback logic, so saves from the side-panel
    // legacy save button silently skipped the CM update.
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await ctx.handleSaveWsc();
      btn.textContent = '✓ Saved';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    } catch (err) {
      console.error('[WSC] Save failed:', err);
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // 2026-04-21 audit: legacy `[data-action="wsc-load"]` prompt()-based loader
  // removed — scenario loading now flows through the standard scenarioLanding
  // shell (← Scenarios button at top of config panel). Handler block deleted
  // rather than left as dead code.
}
