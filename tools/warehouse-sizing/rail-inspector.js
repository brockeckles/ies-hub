/**
 * IES Hub v3 — WSC Rail Inspector (W3 of the UX redesign, 2026-07-15)
 *
 * CM M4 analog for the station shell: click any DESIGN SUMMARY rail row and
 * this module builds its derivation chain — engine math step by step, with
 * ASSERTED / DERIVED / ESTIMATED source pills, W1 seam provenance (which
 * plan filled which unasserted field), media/dynamics cross-checks, and
 * factor-catalog citations — plus per-object what-if levers whose preview
 * is computed by the caller and NEVER touches persisted state or
 * toSizingInputs (transient by construction; the Δ chips are a preview
 * sizeFacility run, not an overlay on the design).
 *
 * Pure module: builders take a ctx bag and return a plain model; the only
 * DOM here is renderInspectorHtml (string) — ui.js owns state + wiring.
 *
 * @module tools/warehouse-sizing/rail-inspector
 */

import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

/** Rail cells that answer clicks (matches shell-w's data-wsw-rail rows). */
export const INSPECTABLE_CELLS = ['sizedSf', 'storageSf', 'positions', 'utilPct', 'doors', 'clearHt'];

const _n = (v) => Math.round(+v || 0).toLocaleString();

/**
 * @param {string} cell — INSPECTABLE_CELLS key
 * @param {Object} ctx — { sized, facility, zones, volumes, seamFields,
 *                        mediaPlan, dynamicsPlan, pinnedFactors }
 * @returns {{title, path, steps:[{val,label,why,cite,src}], levers:[{key,label,min,max,step,value,unit}], note}|null}
 */
export function buildRailInspector(cell, ctx = {}) {
  const s = ctx.sized || null;
  if (!INSPECTABLE_CELLS.includes(cell)) return null;
  const seam = ctx.seamFields || {};
  const pos = s?.positions || {};
  const dock = s?.dock || {};

  // Shared: how did the pallet requirement enter the engine?
  const palletSource = () => {
    if (seam.totalPallets) return { src: 'derived', why: seam.totalPallets.detail, cite: 'W1 requirement seam — applied media plan' };
    if (Number(ctx.volumes?.totalPallets) > 0) return { src: 'asserted', why: 'Pallet Positions typed in Configure (slotting-study override)', cite: null };
    return { src: 'estimated', why: 'Derived from peak units × storage mix (no explicit pallet count)', cite: null };
  };

  const LEVERS = [
    { key: 'clearHeight', label: 'Clear height', min: 24, max: 40, step: 1, value: +ctx.facility?.clearHeight || 32, unit: 'ft' },
    { key: 'palletScale', label: 'Pallet requirement', min: 50, max: 150, step: 5, value: 100, unit: '%' },
  ];

  switch (cell) {
    case 'positions': {
      const ps = palletSource();
      const steps = [
        { val: _n(pos.palletPositionsNeeded), label: 'pallet positions needed', why: ps.why, cite: ps.cite, src: ps.src },
        { val: '× ' + (pos.honeycombFactor || 1.1), label: 'honeycomb allowance', why: 'slotting fragmentation buffer', src: 'derived' },
        { val: '+ ' + Math.round(((pos.surgeFactor || 1.2) - 1) * 100) + '%', label: `surge buffer → ${_n(pos.surgePositions)} pos`, why: 'receiving surges + seasonal peak headroom', src: 'derived' },
        { val: '= ' + _n(pos.grossPositions), label: 'gross positions', why: pos.shelvingGrossPositions > 0 ? `includes ${_n(pos.shelvingGrossPositions)} shelving-equivalent` : '', src: 'derived' },
      ];
      let note = '';
      if (ctx.mediaPlan?.totals?.positions > 0) {
        const req = ctx.mediaPlan.totals.positions;
        const ok = (pos.grossPositions || 0) >= req * 0.98;
        note = `Cross-check — media plan requires ${_n(req)} positions at plan occupancy (${ctx.mediaPlan.provenance || 'derived'}): ${ok ? 'engine design covers it' : 'engine design falls SHORT'}.`;
      }
      return { title: 'Gross positions', path: 'Storage → positions', steps, levers: LEVERS, note };
    }
    case 'sizedSf': {
      const total = s?.totalSqft || 0;
      const storage = s?.storageSqft || 0;
      const dockSf = s?.dockRequirement?.dockSfRequired ?? s?.dockSqft ?? 0;
      const circ = Math.max(0, total - Math.round(total / 1.1));
      const other = Math.max(0, total - storage - dockSf - circ);
      return {
        title: 'Sized total SF', path: 'Building → footprint',
        steps: [
          { val: _n(storage) + ' sf', label: 'storage block', why: 'racked positions × module geometry', src: 'derived' },
          { val: '+ ' + _n(dockSf) + ' sf', label: 'dock (requirements-driven)', why: 'doors × apron + maneuvering', src: 'derived' },
          { val: '+ ' + _n(other) + ' sf', label: 'staging · office · other zones', why: 'dwell-sized staging + office % + optional zones', src: 'derived' },
          { val: '+ ' + _n(circ) + ' sf', label: '10% circulation buffer', why: 'cross-aisles, egress, column losses', src: 'derived' },
          { val: '= ' + _n(total) + ' sf', label: 'sized total', why: '', src: 'derived' },
        ],
        levers: LEVERS, note: '',
      };
    }
    case 'storageSf': {
      return {
        title: 'Storage SF', path: 'Building → storage block',
        steps: [
          { val: _n(pos.grossPositions), label: 'gross positions', why: 'see Gross positions chain', src: 'derived' },
          { val: '÷ ' + (s?.rackLevels || 1), label: `rack levels → ${_n(pos.floorPositions)} floor positions`, why: 'clear height ÷ pallet-level height', src: 'derived' },
          { val: '× ' + (s?.sfPerFloorPos || 0) + ' sf', label: 'per floor position', why: 'rack depth + aisle share per module', src: 'derived' },
          { val: '= ' + _n(s?.storageSqft) + ' sf', label: 'storage block', why: '', src: 'derived' },
        ],
        levers: LEVERS, note: '',
      };
    }
    case 'utilPct': {
      const u = s?.utilization || {};
      return {
        title: 'Utilization', path: 'Building → capacity headroom',
        steps: [
          { val: _n(u.designed), label: 'designed positions', why: 'needed × honeycomb (pre-surge)', src: 'derived' },
          { val: _n(pos.grossPositions), label: 'gross capacity', why: 'designed + surge buffer', src: 'derived' },
          { val: (u.utilizationPct || 0) + '%', label: 'peak utilization', why: u.warning === 'high_util' ? '⚠ high — limited flex for surges' : u.warning === 'low_util' ? '⚠ low — potentially over-built' : 'inside the healthy band', src: 'derived' },
        ],
        levers: LEVERS, note: '',
      };
    }
    case 'doors': {
      const steps = [];
      let note = '';
      if (ctx.dynamicsPlan?.docks) {
        const f = ctx.dynamicsPlan.flow || {};
        steps.push(
          { val: `${_n(f.inPerDay)} / ${_n(f.outPerDay)}`, label: 'avg pallets/day in · out', why: seam.avgDailyInbound || seam.avgDailyOutbound ? 'flow from the applied dynamics plan (W1 seam)' : 'asserted volumes', src: seam.avgDailyInbound ? 'derived' : 'asserted' },
          { val: '× ' + (f.peakFactor || 1.3), label: 'peak factor → design day', why: '', src: 'derived' },
          { val: `${ctx.dynamicsPlan.docks.inbound?.doors || 0} + ${ctx.dynamicsPlan.docks.outbound?.doors || 0}`, label: 'doors (rate method)', why: 'peak flow ÷ (door rate × arrival window) × safety', cite: 'wsc.dynamics door rate · industry method', src: 'derived' },
        );
        note = 'Applied to the design — Configure dock counts now carry these as explicit values. Dwell-method cross-check ran at apply time.';
      } else {
        steps.push({
          val: `${dock.inboundDoors || 0} + ${dock.outboundDoors || 0}`,
          label: 'inbound + outbound doors',
          why: (dock.inboundDoorsExplicit || dock.outboundDoorsExplicit) ? 'typed in Dock Configuration' : 'derived from daily pallet throughput',
          src: (dock.inboundDoorsExplicit || dock.outboundDoorsExplicit) ? 'asserted' : 'derived',
        });
      }
      return { title: 'Dock doors', path: 'Flow → docks', steps, levers: [], note };
    }
    case 'clearHt': {
      return {
        title: 'Clear height', path: 'Building → vertical profile',
        steps: [
          { val: (ctx.facility?.clearHeight || 0) + ' ft', label: 'clear height', why: 'building attribute (Configure)', src: 'asserted' },
          { val: String(s?.rackLevels || 0), label: 'rack levels', why: 'clear ÷ (load height + beam), sprinkler clearance honored', src: 'derived' },
        ],
        levers: [LEVERS[0]], note: '',
      };
    }
  }
  return null;
}

/**
 * @param {Object|null} model — buildRailInspector output
 * @param {Object} [whatIf] — { levers: {clearHeight?, palletScale?}, delta: {sf, positions} | null }
 */
export function renderInspectorHtml(model, whatIf = {}) {
  if (!model) {
    return '<p class="wsw-hint">Click a design figure for its derivation chain — factor citations, ' +
      'ASSERTED / DERIVED / ESTIMATED sources, and quick what-if levers.</p>';
  }
  const pill = (src) => src ? `<span class="wsw-src wsw-src--${escapeAttr(src)}">${escapeHtml(src.toUpperCase())}</span>` : '';
  const steps = model.steps.map(st =>
    '<div class="wsw-step"><b>' + escapeHtml(st.val) + '</b> ' + escapeHtml(st.label) + ' ' + pill(st.src) +
    (st.why ? '<div class="wsw-why">' + escapeHtml(st.why) + '</div>' : '') +
    (st.cite ? '<div class="wsw-cite">' + escapeHtml(st.cite) + '</div>' : '') +
    '</div>').join('');
  const lv = whatIf.levers || {};
  const levers = (model.levers || []).map(l => {
    const cur = lv[l.key] != null ? lv[l.key] : l.value;
    return '<div class="wsw-lever"><div class="wsw-leverlbl"><span>' + escapeHtml(l.label) + '</span><b>' + escapeHtml(String(cur)) + ' ' + escapeHtml(l.unit) + '</b></div>' +
      '<input type="range" min="' + l.min + '" max="' + l.max + '" step="' + l.step + '" value="' + escapeAttr(String(cur)) + '" data-wsw-lever="' + escapeAttr(l.key) + '" data-unit="' + escapeAttr(l.unit) + '">' +
      '</div>';
  }).join('');
  const delta = whatIf.delta
    ? '<div class="wsw-delta" data-wsw-delta>Δ ' + escapeHtml(whatIf.delta.sf) + ' SF · Δ ' + escapeHtml(whatIf.delta.positions) + ' pos <button class="wsw-reset" data-wsw-lever-reset>reset</button></div>'
    : (model.levers?.length ? '<div class="wsw-delta wsw-delta--idle" data-wsw-delta>Drag a lever — preview only, nothing persists.</div>' : '');
  return '' +
    '<div class="wsw-path">' + escapeHtml(model.path) + '</div>' +
    '<div class="wsw-chain">' + steps + '</div>' +
    (model.note ? '<div class="wsw-note">' + escapeHtml(model.note) + '</div>' : '') +
    (levers ? '<div class="wsw-levers"><div class="wsw-railt" style="margin:10px 0 6px">WHAT-IF · PREVIEW</div>' + levers + delta + '</div>' : '');
}
