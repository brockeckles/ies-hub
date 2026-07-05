/**
 * IES Hub v3 — WSC Design Basis section (N1, 2026-07-04)
 *
 * The ingest + profiling surface of the re-founded WSC. Two first-class
 * paths (Brock's call, 2026-07-04):
 *   - Data mode  : upload SKU master / inventory snapshot / order history
 *                  through a column-mapping wizard (COG C1 pattern,
 *                  generalized to three file types).
 *   - Sparse mode: RFP-summary aggregates via a short form.
 *
 * Both emit the same DesignProfile (profile-calc.js) with per-field
 * provenance. Nothing here writes to the DB — the profile rides the
 * scenario's normal Save path inside config_data.profile.
 *
 * @module tools/warehouse-sizing/ui-basis
 */

import {
  parseSkuMaster, parseInventory, parseOrders,
  computeProfile, computeSparseProfile, profileReadiness,
  autoDetectMapping, SKU_MASTER_ROLES, INVENTORY_ROLES, ORDER_ROLES,
} from './profile-calc.js?v=20260704-n1a';
import { wscFactorsDrift } from './factors-calc.js?v=20260704-n2a';
import { icon } from '../../shared/icons.js?v=20260705-u3e';
import { selectMedia } from './media-calc.js?v=20260704-n3a';
import { computeDynamics } from './dynamics-calc.js?v=20260705-mhe1';
import { synthesizeLayout } from './layout-calc.js?v=20260705-mhe1';
import { buildDesignBasisModel, renderDesignBasisHtml } from './basis-doc.js?v=20260705-mhe1';

// ── Module state (session-scoped; raw rows never persisted) ──
/** Parsed datasets awaiting/backing the profile. */
let _data = { skus: null, inventory: null, orders: null };
/** Per-slot source metadata for the summary cards. */
let _sources = { skuMaster: null, inventory: null, orders: null };
/** Pending upload wizard: { slot, fileName, aoa, headerRow, mapping } */
let _pending = null;
/** N2 — live factor catalog cache (session): null = not fetched yet. */
let _liveFactors = null;
/** N3 — rotation policy for the media plan preview (persisted on Apply). */
let _rotationPolicy = 'none';
/** N4 — dynamics policy inputs (persisted on Apply). */
let _dynPolicy = { arrivalWindowHrs: 8, dwellDaysIn: 1, dwellDaysOut: 0.5, mheStorageType: null };
/** N5 — flue standard toggle (null = catalog default, currently FM). */
let _flueStd = null;

const SLOTS = [
  { key: 'skuMaster', label: 'SKU Master',         roles: SKU_MASTER_ROLES, hint: 'Item #, units/case, Ti×Hi, case dims' },
  { key: 'inventory', label: 'Inventory Snapshot', roles: INVENTORY_ROLES,  hint: 'SKU + on-hand units, cases, or pallets' },
  { key: 'orders',    label: 'Order History',      roles: ORDER_ROLES,      hint: 'Date, order #, SKU, qty — 12–24 months ideal' },
];

/** Reset session ingest state — called when the editor opens a scenario. */
export function resetBasisState() {
  _data = { skus: null, inventory: null, orders: null };
  _sources = { skuMaster: null, inventory: null, orders: null };
  _pending = null;
}

const PROV_CHIP = {
  derived:   ['var(--c-success-bg)', 'var(--c-success-strong)', 'DERIVED'],
  asserted:  ['var(--c-info-bg)', 'var(--c-info-strong)', 'ASSERTED'],
  estimated: ['var(--c-warn-bg)', 'var(--c-warn-deep)', 'ESTIMATED'],
};
function provChip(kind) {
  const [bg, fg, label] = PROV_CHIP[kind] || PROV_CHIP.estimated;
  return `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:0.5px;background:${bg};color:${fg};vertical-align:middle;">${label}</span>`;
}
const fmt = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
const esc = (s) => String(s ?? '').replace(/</g, '&lt;');

// ============================================================
// RENDER
// ============================================================

/**
 * @param {HTMLElement} container
 * @param {Object} ctx — { getProfile, setProfile, markDirty, rerender }
 */
export function renderBasisView(container, ctx) {
  const profile = ctx.getProfile();
  const readiness = profileReadiness(profile);
  container.innerHTML = `
    <div style="max-width:1080px;">
      ${_renderHeader(profile, readiness)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;">
        ${_renderDataCard(profile)}
        ${_renderSparseCard(profile)}
      </div>
      <div id="wsc-basis-wizard" style="display:none;"></div>
      ${profile ? _renderProfileSummary(profile) : _renderEmptyState()}
      ${profile ? _renderMediaCard(profile, ctx) : ''}
      ${profile ? _renderDynamicsCard(profile, ctx) : ''}
      ${_renderLayoutCard(ctx)}
      <div id="wsc-basis-factors"></div>
    </div>
  `;
  _bindEvents(container, ctx);
  if (_pending) _renderWizard(container.querySelector('#wsc-basis-wizard'), ctx);
  _renderFactorsCard(container.querySelector('#wsc-basis-factors'), ctx);
}

function _renderHeader(profile, readiness) {
  const barColor = readiness.score >= 85 ? 'var(--c-success-strong)' : readiness.score >= 50 ? 'var(--c-warn-deep)' : 'var(--c-muted-light)';
  return `
    <div class="hub-card" style="padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;">
        <div style="font-size:14px;font-weight:700;">Design Basis</div>
        <div style="font-size:12px;color:var(--ies-gray-500);margin-top:2px;">
          Every defendable number starts here — load customer data, or assert RFP-level aggregates and upgrade later.
        </div>
      </div>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="wsc-basis-doc"
              title="Assemble the 12-section Basis of Design document — profile provenance, assumptions register, media rationale, dynamics math, compliance checklist, reconciliation — as a print/PDF page.">
        ${icon('doc')} Design Basis Doc</button>
      <div style="min-width:200px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:600;margin-bottom:3px;">
          <span>Profile readiness</span><span style="color:${barColor};">${readiness.label} · ${readiness.score}%</span>
        </div>
        <div style="height:6px;background:var(--ies-gray-100);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${readiness.score}%;background:${barColor};border-radius:3px;"></div>
        </div>
        ${profile ? `<div style="font-size:10px;color:var(--ies-gray-500);margin-top:3px;">Mode: ${profile.mode === 'data' ? 'customer data' : 'sparse / RFP'}</div>` : ''}
      </div>
    </div>
  `;
}

function _renderDataCard(profile) {
  return `
    <div class="hub-card" style="padding:14px 16px;${profile?.mode === 'data' ? 'border-left:3px solid var(--c-success-strong);' : ''}">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
        Customer Data ${profile?.mode === 'data' ? '· active' : ''}
      </div>
      ${SLOTS.map(s => {
        const src = _sources[s.key];
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--ies-gray-100);">
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:600;">${s.label}
                ${src ? `<span style="color:var(--c-success-strong);font-weight:700;"> ✓</span>` : ''}
              </div>
              <div style="font-size:10.5px;color:var(--ies-gray-500);">
                ${src ? `${esc(src.fileName)} · ${fmt(src.rows)} rows${src.skipped ? ` · ${src.skipped} skipped` : ''}` : s.hint}
              </div>
            </div>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" data-basis-upload="${s.key}">${src ? 'Replace' : 'Upload'}</button>
            ${src ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-basis-clear="${s.key}" title="Remove this dataset">✕</button>` : ''}
          </div>
        `;
      }).join('')}
      <div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:8px;">
        XLSX / XLS / CSV. Any single file yields a partial profile; each added file derives more and asserts less.
      </div>
      <input type="file" id="wsc-basis-file" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>
  `;
}

function _renderSparseCard(profile) {
  const v = (profile?.mode === 'sparse') ? profile : null;
  const val = (x) => x == null ? '' : x;
  return `
    <div class="hub-card" style="padding:14px 16px;${v ? 'border-left:3px solid var(--c-info-strong);' : ''}">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
        Sparse / RFP Summary ${v ? '· active' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;">
        ${[
          ['sp-skuCount', 'SKU count *', val(v?.skuCount)],
          ['sp-onHandPallets', 'On-hand pallets (peak)', val(v?.volumes?.onHandPallets)],
          ['sp-annualOutboundUnits', 'Annual outbound units', val(v?.volumes?.annualOutboundUnits)],
          ['sp-avgPalletsPerSku', 'Avg pallets per SKU', val(v?.provenance?.depthOfHolding === 'asserted' ? v?.depthOfHolding?.avgPalletsPerSku : '')],
          ['sp-avgCasesPerPallet', 'Avg cases per pallet (Ti×Hi)', val(v?.tiHi?.avgCasesPerPallet)],
          ['sp-peakFactor', 'Peak factor', val(v?.provenance?.peak === 'asserted' ? v?.peak?.peakFactor : '')],
        ].map(([id, label, value]) => `
          <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:block;">
            ${label}
            <input type="number" id="${id}" value="${value}" min="0" step="any"
                   style="display:block;width:100%;margin-top:3px;padding:5px 8px;border:1px solid var(--ies-gray-200);border-radius:5px;font-size:12px;">
          </label>
        `).join('')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:8px;">
        <div style="font-size:10.5px;color:var(--ies-gray-500);">* required. Blank fields fall back to cited defaults and are flagged in the gap report.</div>
        <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-basis-sparse-apply">Build Profile</button>
      </div>
    </div>
  `;
}

function _renderEmptyState() {
  return `
    <div class="hub-card" style="padding:22px;margin-top:14px;text-align:center;color:var(--ies-gray-500);font-size:12.5px;">
      No design basis yet. Upload customer data (left) or enter RFP aggregates (right) —
      the profile, its provenance, and a data-gap report will render here.
    </div>
  `;
}

function _renderProfileSummary(p) {
  const prov = p.provenance || {};
  const bands = p.velocityBands;
  const d = p.depthOfHolding;
  const gapIcon = { error: '⛔', warn: '⚠', info: 'ℹ' };
  const maxBucket = d?.distribution ? Math.max(1, ...d.distribution.map(b => b.skuCount)) : 1;
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:start;">

      <div class="hub-card" style="padding:14px 16px;">
        <div class="wsc-card-title">Velocity Profile ${provChip(prov.velocityBands)}</div>
        ${bands ? `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="color:var(--ies-gray-500);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;">
              <th style="text-align:left;padding:3px 0;">Band</th><th class="u-right">SKUs</th>
              <th class="u-right">SKU %</th><th class="u-right">Line %</th>
            </tr></thead>
            <tbody>
              ${['A', 'B', 'C'].map(k => `
                <tr class="wsc-rule-top">
                  <td style="padding:5px 0;font-weight:700;">${k}</td>
                  <td class="u-right">${fmt(bands[k].skuCount)}</td>
                  <td class="u-right">${fmt(bands[k].skuPct, 1)}%</td>
                  <td class="u-right">${fmt(bands[k].linePct, 1)}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${p.cubeMovement ? `
            <div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:6px;">
              Cube movement ${provChip(prov.cubeMovement)} : A ${fmt(p.cubeMovement.A.cubePct, 1)}% ·
              B ${fmt(p.cubeMovement.B.cubePct, 1)}% · C ${fmt(p.cubeMovement.C.cubePct, 1)}% of shipped cube
            </div>` : ''}
        ` : '<div style="font-size:12px;color:var(--ies-gray-500);">Not available — needs order history (or ABC assertion in sparse mode).</div>'}
      </div>

      <div class="hub-card" style="padding:14px 16px;">
        <div class="wsc-card-title">Depth of Holding ${provChip(prov.depthOfHolding || prov.onHandPallets)}</div>
        ${d ? `
          <div style="display:flex;gap:16px;font-size:12px;margin-bottom:8px;">
            <div><span class="wsc-stat">${fmt(d.avgPalletsPerSku, 1)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">avg plt/SKU</span></div>
            ${d.p50 != null ? `<div><span class="wsc-stat">${fmt(d.p50, 1)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">median</span></div>` : ''}
            ${d.p90 != null ? `<div><span class="wsc-stat">${fmt(d.p90, 1)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">p90</span></div>` : ''}
            ${p.volumes?.onHandPallets != null ? `<div><span class="wsc-stat">${fmt(p.volumes.onHandPallets)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">total pallets</span></div>` : ''}
          </div>
          ${d.distribution ? `
            <div style="font-size:10px;color:var(--ies-gray-500);margin-bottom:3px;">SKUs by pallets-per-SKU (media-map buckets)</div>
            ${d.distribution.map(b => `
              <div style="display:flex;align-items:center;gap:6px;font-size:10.5px;margin:2px 0;">
                <span style="width:38px;color:var(--ies-gray-600);font-weight:600;">${b.bucket}</span>
                <div style="flex:1;height:9px;background:var(--ies-gray-100);border-radius:2px;overflow:hidden;">
                  <div style="height:100%;width:${(b.skuCount / maxBucket) * 100}%;background:#6366f1;border-radius:2px;"></div>
                </div>
                <span style="width:56px;text-align:right;color:var(--ies-gray-600);">${fmt(b.skuCount)} SKU</span>
              </div>
            `).join('')}` : '<div style="font-size:10.5px;color:var(--ies-gray-500);">No per-SKU distribution in sparse mode — upload an inventory snapshot to unlock it.</div>'}
        ` : '<div style="font-size:12px;color:var(--ies-gray-500);">Not available — needs an inventory snapshot or a pallets-per-SKU assertion.</div>'}
      </div>

      <div class="hub-card" style="padding:14px 16px;">
        <div class="wsc-card-title">Volumes & Peak</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          ${[
            ['SKU universe', fmt(p.skuCount), prov.skuCount],
            ['Annual outbound units', fmt(p.volumes?.annualOutboundUnits), prov.volumes],
            ['On-hand pallets', fmt(p.volumes?.onHandPallets), prov.onHandPallets || prov.volumes],
            ['Avg cases/pallet (Ti×Hi)', fmt(p.tiHi?.avgCasesPerPallet, 1), prov.tiHi],
            ['Peak factor', fmt(p.peak?.peakFactor, 2), prov.peak],
            p.peak?.weeksObserved != null ? ['Weeks observed', fmt(p.peak.weeksObserved), 'derived'] : null,
          ].filter(Boolean).map(([label, value, pv]) => `
            <tr class="wsc-rule-top">
              <td style="padding:5px 0;color:var(--ies-gray-600);">${label}</td>
              <td style="text-align:right;font-weight:700;">${value}</td>
              <td style="text-align:right;width:78px;">${pv ? provChip(pv) : ''}</td>
            </tr>
          `).join('')}
        </table>
      </div>

      <div class="hub-card" style="padding:14px 16px;">
        <div class="wsc-card-title">Data Gap Report
          <span style="font-weight:400;color:var(--ies-gray-500);font-size:11px;">· ${p.dataGaps.length} item${p.dataGaps.length === 1 ? '' : 's'}</span>
        </div>
        ${p.dataGaps.length === 0
          ? '<div style="font-size:12px;color:var(--c-success-strong);font-weight:600;">✓ No gaps — fully derived basis.</div>'
          : p.dataGaps.map(g => `
            <div style="display:flex;gap:7px;font-size:11.5px;padding:4px 0;border-top:1px solid var(--ies-gray-100);">
              <span>${gapIcon[g.severity] || 'ℹ'}</span>
              <span style="color:var(--ies-gray-700);">${esc(g.message)}</span>
            </div>
          `).join('')}
        <div style="font-size:10px;color:var(--ies-gray-500);margin-top:8px;">
          This report prints in the Design Basis document — gaps are disclosed, not hidden.
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// WIZARD (COG C1 pattern, three-file generalization)
// ============================================================

function _renderWizard(container, ctx) {
  if (!_pending || !container) return;
  const pu = _pending;
  const slot = SLOTS.find(s => s.key === pu.slot);
  const aoa = pu.aoa;
  const ncol = Math.max(...aoa.slice(0, 5).map(r => r ? r.length : 0));
  const previewRows = aoa.slice(pu.headerRow ? 1 : 0).slice(0, 5);
  if (!pu.mapping || Object.keys(pu.mapping).length === 0) {
    pu.mapping = pu.headerRow ? autoDetectMapping(pu.headerRow, slot.roles) : {};
  }
  const mapped = new Set(Object.values(pu.mapping).filter(Boolean));
  const needsSku = pu.slot !== 'orders' || true;
  const hasSku = mapped.has('sku');
  const hasQty = pu.slot === 'skuMaster' ? true
    : pu.slot === 'inventory' ? (mapped.has('onHandUnits') || mapped.has('onHandCases') || mapped.has('onHandPallets'))
    : (mapped.has('qtyUnits') || mapped.has('qtyCases'));
  const valid = hasSku && hasQty;
  const needMsg = pu.slot === 'skuMaster' ? 'a SKU column'
    : pu.slot === 'inventory' ? 'a SKU column AND an on-hand column'
    : 'a SKU column AND a qty column';
  const statusMsg = valid
    ? `<span style="color:var(--c-success-strong);font-weight:600;">✓ Ready — ${aoa.length - (pu.headerRow ? 1 : 0)} data rows</span>`
    : `<span style="color:var(--c-danger-strong);font-weight:600;">⚠ Need ${needMsg}</span>`;
  container.style.display = 'block';
  container.innerHTML = `
    <div class="hub-card" style="margin-top:14px;padding:14px 16px;background:var(--c-warn-soft);border-left:3px solid var(--c-warn);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--c-warn-ink);">
            ${slot.label} — column mapping for "${esc(pu.fileName)}"</div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">Assign each column a role. Auto-detected roles are pre-selected.</div>
        </div>
        <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="wsc-wiz-has-header" ${pu.headerRow ? 'checked' : ''} style="cursor:pointer;">
          Row 1 is a header
        </label>
      </div>
      <div style="overflow-x:auto;margin-bottom:10px;">
        <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:480px;">
          <thead><tr style="background:#fde68a;">
            ${Array.from({ length: ncol }, (_, i) => `
              <th style="padding:6px 8px;text-align:left;border:1px solid #fcd34d;font-weight:700;min-width:120px;">
                <div style="font-size:10px;color:#78350f;letter-spacing:0.3px;text-transform:uppercase;margin-bottom:2px;">Col ${String.fromCharCode(65 + i)}${pu.headerRow ? ' · ' + esc(pu.headerRow[i] || '') : ''}</div>
                <select data-basis-wiz-col="${i}" style="width:100%;padding:4px 6px;border:1px solid var(--c-warn-strong);border-radius:4px;font-size:12px;font-weight:600;background:#fff;">
                  ${slot.roles.map(r => `<option value="${r.value}"${(pu.mapping[i] || '') === r.value ? ' selected' : ''}>${r.label}</option>`).join('')}
                </select>
              </th>`).join('')}
          </tr></thead>
          <tbody>
            ${previewRows.map(row => `
              <tr>${Array.from({ length: ncol }, (_, i) => `
                <td style="padding:5px 8px;border:1px solid #fde68a;background:#fff;color:var(--ies-gray-700);font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:11px;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${row && row[i] != null ? esc(row[i]) : ''}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div class="u-12">${statusMsg}</div>
        <div class="u-flex">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="wsc-wiz-cancel">Cancel</button>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-wiz-confirm" ${valid ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>Confirm & Profile</button>
        </div>
      </div>
    </div>
  `;
  container.querySelectorAll('[data-basis-wiz-col]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.basisWizCol, 10);
      pu.mapping[idx] = e.target.value;
      _renderWizard(container, ctx);
    });
  });
  container.querySelector('#wsc-wiz-has-header')?.addEventListener('change', (e) => {
    pu.headerRow = e.target.checked ? (pu.aoa[0] || []).map(v => String(v ?? '')) : null;
    pu.mapping = {};
    _renderWizard(container, ctx);
  });
  container.querySelector('#wsc-wiz-cancel')?.addEventListener('click', () => {
    _pending = null;
    container.style.display = 'none';
    container.innerHTML = '';
  });
  container.querySelector('#wsc-wiz-confirm')?.addEventListener('click', () => {
    if (!valid) return;
    _commitPending(ctx);
  });
}

function _commitPending(ctx) {
  const pu = _pending;
  if (!pu) return;
  const rows = pu.aoa.slice(pu.headerRow ? 1 : 0);
  let meta;
  if (pu.slot === 'skuMaster') {
    const r = parseSkuMaster(rows, pu.mapping);
    _data.skus = r.skus;
    meta = { fileName: pu.fileName, rows: r.rowCount, skipped: r.skipped };
  } else if (pu.slot === 'inventory') {
    const r = parseInventory(rows, pu.mapping);
    _data.inventory = r.inventory;
    meta = { fileName: pu.fileName, rows: r.rowCount, skipped: r.skipped };
  } else {
    const r = parseOrders(rows, pu.mapping);
    _data.orders = r.lines;
    meta = { fileName: pu.fileName, rows: r.rowCount, skipped: r.skipped };
  }
  _sources[pu.slot] = meta;
  _pending = null;
  _recomputeDataProfile(ctx);
}

function _recomputeDataProfile(ctx) {
  const profile = computeProfile({ skus: _data.skus, inventory: _data.inventory, orders: _data.orders });
  profile.sources = { ..._sources };
  ctx.setProfile(profile);
  ctx.rerender();
}

// ============================================================
// MEDIA SELECTION (N3) — engineered portfolio + Apply-to-design
// ============================================================

const _fmtUsd = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`;

function _renderMediaCard(profile, ctx) {
  const applied = ctx.getMediaPlan?.();
  if (applied?.policy?.rotation) _rotationPolicy = _rotationPolicy || applied.policy.rotation;
  const plan = selectMedia({
    profile,
    pinnedFactors: ctx.getPinnedFactors?.(),
    policy: { rotation: _rotationPolicy },
  });
  if (!plan) {
    return `
      <div class="hub-card" style="padding:14px 16px;margin-top:14px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:4px;">Media Selection</div>
        <div style="font-size:12px;color:var(--ies-gray-500);">Needs a depth-of-holding signal — upload an inventory snapshot or assert pallets-per-SKU in the sparse form.</div>
      </div>`;
  }
  const a = plan.allocation;
  const isApplied = !!applied;
  return `
    <div class="hub-card" style="padding:14px 16px;margin-top:14px;border-left:3px solid #6366f1;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div class="u-12 u-bold">Media Selection ${provChip(plan.provenance)}
          ${isApplied ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:#e0e7ff;color:#4338ca;">APPLIED ${esc(applied.createdAt)}</span>` : ''}
        </div>
        <div class="u-row">
          <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:flex;align-items:center;gap:5px;">
            Rotation
            <select id="wsc-media-rotation" style="padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:5px;font-size:11px;">
              <option value="none"${_rotationPolicy === 'none' ? ' selected' : ''}>No constraint</option>
              <option value="fifo_strict"${_rotationPolicy === 'fifo_strict' ? ' selected' : ''}>Strict FIFO / lot control</option>
            </select>
          </label>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-media-apply"
                  title="Persist this plan and set the design's storage mix from it. The mix stays editable in Configure.">
            ${isApplied ? 'Re-apply to design' : 'Apply to design'}</button>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        <thead><tr style="color:var(--ies-gray-500);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;">
          <th style="text-align:left;padding:3px 0;">Depth band</th><th class="u-right">SKUs</th>
          <th class="u-right">Pallets</th><th style="text-align:left;padding-left:12px;">Medium</th>
          <th class="u-right">Occ.</th><th class="u-right">Positions</th><th class="u-right">Rack cost</th>
        </tr></thead>
        <tbody>
          ${plan.bands.map(b => `
            <tr class="wsc-rule-top" title="${esc(b.rationale)}&#10;&#10;${esc((b.checks || []).join('\n'))}">
              <td style="padding:5px 0;font-weight:600;">${esc(b.bucket)}</td>
              <td class="u-right">${fmt(b.skuCount)}</td>
              <td class="u-right">${fmt(b.pallets)}</td>
              <td style="padding-left:12px;">${esc(b.mediaLabel)}</td>
              <td class="u-right">${b.occupancyPct}%</td>
              <td style="text-align:right;font-weight:600;">${fmt(b.positions)}</td>
              <td style="text-align:right;color:var(--ies-gray-600);">${_fmtUsd(b.costBand.min)}–${_fmtUsd(b.costBand.max)}</td>
            </tr>`).join('')}
          ${plan.shelving ? `
            <tr class="wsc-rule-top" title="${esc(plan.shelving.rationale)}">
              <td style="padding:5px 0;font-weight:600;">&lt;1 plt/SKU</td>
              <td class="u-right">${fmt(plan.shelving.skuCount)}</td>
              <td class="u-right">${fmt(plan.shelving.pallets)}</td>
              <td style="padding-left:12px;">Carton shelving / bins</td>
              <td class="u-right">—</td><td class="u-right">—</td><td class="u-right">—</td>
            </tr>` : ''}
          <tr style="border-top:2px solid var(--ies-gray-200);font-weight:700;">
            <td style="padding:5px 0;">Total · ${plan.totals.mediaCount} media</td>
            <td></td>
            <td class="u-right">${fmt(plan.totals.pallets)}</td>
            <td></td><td></td>
            <td class="u-right">${fmt(plan.totals.positions)}</td>
            <td class="u-right">${_fmtUsd(plan.totals.costBand.min)}–${_fmtUsd(plan.totals.costBand.max)}</td>
          </tr>
        </tbody>
      </table>
      <div style="font-size:10.5px;color:var(--ies-gray-600);margin-top:8px;" title="${esc(a.rationale)}">
        Derived storage mix → Full-pallet <b>${a.fullPallet}%</b> · Carton-on-pallet <b>${a.cartonOnPallet}%</b> · Shelving <b>${a.cartonOnShelving}%</b>
        <span class="u-muted">(replaces the asserted mix on Apply; hover for basis)</span>
      </div>
      ${plan.gaps.length ? plan.gaps.map(g => `
        <div style="font-size:10.5px;color:${g.severity === 'warn' ? 'var(--c-warn-deep)' : 'var(--ies-gray-500)'};margin-top:4px;">
          ${g.severity === 'warn' ? '⚠' : 'ℹ'} ${esc(g.message)}</div>`).join('') : ''}
      <div style="font-size:10px;color:var(--ies-gray-500);margin-top:8px;">
        Hover any row for the full selection audit (candidates considered, Rule-of-3 checks, rejections). Factor citations ride each band into the Design Basis doc.
      </div>
    </div>
  `;
}

function _bindMediaEvents(container, ctx) {
  container.querySelector('#wsc-media-rotation')?.addEventListener('change', (e) => {
    _rotationPolicy = e.target.value;
    ctx.rerender();
  });
  container.querySelector('#wsc-media-apply')?.addEventListener('click', () => {
    const profile = ctx.getProfile();
    const plan = selectMedia({
      profile,
      pinnedFactors: ctx.getPinnedFactors?.(),
      policy: { rotation: _rotationPolicy },
    });
    if (!plan) { ctx.toast?.('No plan to apply — profile lacks a depth signal.', 'error'); return; }
    ctx.applyMediaPlan(plan);
    ctx.rerender();
    ctx.toast?.(`Media plan applied — storage mix now ${plan.allocation.fullPallet}/${plan.allocation.cartonOnPallet}/${plan.allocation.cartonOnShelving} (derived).`, 'success');
  });
}

// ============================================================
// DYNAMICS (N4) — docks / staging / MHE from throughput
// ============================================================

function _computeDynPreview(ctx) {
  return computeDynamics({
    profile: ctx.getProfile(),
    mediaPlan: ctx.getMediaPlan?.(),
    volumes: ctx.getVolumes?.() || {},
    facility: ctx.getFacility?.() || {},
    pinnedFactors: ctx.getPinnedFactors?.(),
    policy: _dynPolicy,
  });
}

function _renderDynamicsCard(profile, ctx) {
  const applied = ctx.getDynamicsPlan?.();
  const plan = _computeDynPreview(ctx);
  if (!plan) {
    return `
      <div class="hub-card" style="padding:14px 16px;margin-top:14px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:4px;">Dynamics — Docks · Staging · MHE</div>
        <div style="font-size:12px;color:var(--ies-gray-500);">Needs a flow signal — enter daily inbound/outbound pallets in Configure, or provide on-hand pallets so flow can be estimated.</div>
      </div>`;
  }
  const isApplied = !!applied;
  const d = plan.docks; const s = plan.staging;
  const polInput = (id, label, value, step) => `
    <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:flex;align-items:center;gap:5px;">
      ${label}
      <input type="number" id="${id}" value="${value}" min="0" step="${step}" style="width:58px;padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:5px;font-size:11px;">
    </label>`;
  return `
    <div class="hub-card" style="padding:14px 16px;margin-top:14px;border-left:3px solid #0ea5e9;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div class="u-12 u-bold">Dynamics — Docks · Staging · MHE ${provChip(plan.provenance)}
          ${isApplied ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:#e0f2fe;color:#0369a1;">APPLIED ${esc(applied.createdAt)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          ${polInput('wsc-dyn-window', 'Arrival window (hr)', _dynPolicy.arrivalWindowHrs, 1)}
          ${polInput('wsc-dyn-dwell-in', 'Dwell in (days)', _dynPolicy.dwellDaysIn, 0.5)}
          ${polInput('wsc-dyn-dwell-out', 'Dwell out (days)', _dynPolicy.dwellDaysOut, 0.5)}
          <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--ies-gray-500);"
                 title="Aisle-width assumption only — MHE selection is finalized in MOST / direct-labor template development.">Storage MHE
            <select id="wsc-dyn-mhe" style="padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:5px;font-size:11px;">
              <option value="">Default (from media)</option>
              <option value="reach"${_dynPolicy.mheStorageType === 'reach' ? ' selected' : ''}>Reach truck</option>
              <option value="double_deep_reach"${_dynPolicy.mheStorageType === 'double_deep_reach' ? ' selected' : ''}>Double-deep reach</option>
              <option value="vna"${_dynPolicy.mheStorageType === 'vna' ? ' selected' : ''}>VNA / turret</option>
              <option value="counterbalance"${_dynPolicy.mheStorageType === 'counterbalance' ? ' selected' : ''}>Counterbalance</option>
            </select>
          </label>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-dyn-apply"
                  title="Persist this plan and write dock doors, staging SF, and the governing storage aisle into the design.">
            ${isApplied ? 'Re-apply to design' : 'Apply to design'}</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;">
        <div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:4px;">Dock doors — rate method</div>
          <div class="u-12" title="${esc(d.rationale)}">
            Flow ${fmt(plan.flow.peakIn)} in / ${fmt(plan.flow.peakOut)} out peak plt/day (×${plan.flow.peakFactor} peak) →
            <b>${d.inbound.doors} inbound + ${d.outbound.doors} outbound = ${d.totalDoors} doors</b>
          </div>
          <div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:3px;">
            Dwell-method cross-check: ${d.dwellCheck.doors} doors (${d.dwellCheck.trucksPerPeakDay} trucks/peak-day)
            ${d.methodsDiverge ? '<span style="color:var(--c-danger-strong);font-weight:700;">— DIVERGES</span>' : '— agrees'}
          </div>
          ${d.sanityNote ? `<div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:3px;">${esc(d.sanityNote)}</div>` : ''}
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin:10px 0 4px;">Staging</div>
          <div class="u-12">
            Receive <b>${fmt(s.inbound.sqft)} sqft</b> <span class="u-muted">(${s.inbound.governedBy}, ${fmt(s.inbound.stagedPallets)} plt)</span> ·
            Ship <b>${fmt(s.outbound.sqft)} sqft</b> <span class="u-muted">(${s.outbound.governedBy})</span>
          </div>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:4px;">MHE assumption → aisles${plan.mhe.source === 'asserted' ? ' <span style="color:var(--c-warn-deep);">(asserted)</span>' : ''}</div>
          ${plan.mhe.fleet.map(f => `
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:11.5px;padding:3px 0;border-top:1px solid var(--ies-gray-100);" title="${esc(f.rationale)}">
              <span>${esc(f.label)} <span class="u-muted">· ${esc(f.role)}</span></span>
              <span style="font-weight:600;white-space:nowrap;">${f.aisleFt} ft</span>
            </div>`).join('')}
          <div style="font-size:11px;margin-top:4px;">Governing storage aisle: <b>${plan.mhe.governingAisleFt} ft</b></div>
          <div style="font-size:10px;color:var(--ies-gray-500);margin-top:3px;">Assumption for aisle sizing only — MHE selection is finalized in MOST / direct-labor work.</div>
          ${plan.mhe.vnaAdvisory ? `<div style="font-size:10.5px;color:#7e22ce;margin-top:5px;">◆ ${esc(plan.mhe.vnaAdvisory)}</div>` : ''}
        </div>
      </div>
      ${plan.gaps.length ? plan.gaps.map(g => `
        <div style="font-size:10.5px;color:${g.severity === 'warn' ? 'var(--c-warn-deep)' : 'var(--ies-gray-500)'};margin-top:4px;">
          ${g.severity === 'warn' ? '⚠' : 'ℹ'} ${esc(g.message)}</div>`).join('') : ''}
    </div>
  `;
}

function _bindDynamicsEvents(container, ctx) {
  const num = (id, fallback) => {
    const n = parseFloat(container.querySelector('#' + id)?.value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  container.querySelector('#wsc-dyn-mhe')?.addEventListener('change', (e) => {
    _dynPolicy = { ..._dynPolicy, mheStorageType: e.target.value || null };
    ctx.rerender();
  });
  for (const [id, key] of [['wsc-dyn-window', 'arrivalWindowHrs'], ['wsc-dyn-dwell-in', 'dwellDaysIn'], ['wsc-dyn-dwell-out', 'dwellDaysOut']]) {
    container.querySelector('#' + id)?.addEventListener('change', () => {
      _dynPolicy = { ..._dynPolicy, [key]: num(id, _dynPolicy[key]) };
      ctx.rerender();
    });
  }
  container.querySelector('#wsc-dyn-apply')?.addEventListener('click', () => {
    const plan = _computeDynPreview(ctx);
    if (!plan) { ctx.toast?.('No dynamics plan — missing a flow signal.', 'error'); return; }
    ctx.applyDynamicsPlan(plan);
    ctx.rerender();
    ctx.toast?.(`Dynamics applied — ${plan.docks.inbound.doors}+${plan.docks.outbound.doors} doors, ${(plan.staging.totalSqft).toLocaleString()} sqft staging, ${plan.mhe.governingAisleFt} ft aisles (derived).`, 'success');
  });
}

// ============================================================
// LAYOUT & COMPLIANCE (N5) — grid-fit + standards checklist
// ============================================================

const _STATUS_CHIP = {
  PASS: ['var(--c-success-bg)', 'var(--c-success-strong)'], FAIL: ['var(--c-danger-bg)', 'var(--c-danger-strong)'], 'N/A': ['#f3f4f6', 'var(--c-muted)'],
};
function _statusChip(status) {
  const [bg, fg] = _STATUS_CHIP[status] || _STATUS_CHIP['N/A'];
  return `<span style="display:inline-block;padding:1px 8px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:0.4px;background:${bg};color:${fg};">${status}</span>`;
}

function _computeLayoutPreview(ctx) {
  return synthesizeLayout({
    facility: ctx.getFacility?.() || {},
    zones: ctx.getZones?.() || {},
    dynamicsPlan: ctx.getDynamicsPlan?.(),
    flueStandard: _flueStd,
    pinnedFactors: ctx.getPinnedFactors?.(),
  });
}

function _renderLayoutCard(ctx) {
  const applied = ctx.getLayoutPlan?.();
  if (applied?.flueStandard && _flueStd === null) _flueStd = applied.flueStandard;
  const plan = _computeLayoutPreview(ctx);
  const isApplied = !!applied;
  const g = plan.gridFit;
  return `
    <div class="hub-card" style="padding:14px 16px;margin-top:14px;border-left:3px solid var(--c-success);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div class="u-12 u-bold">Layout & Compliance
          <span style="font-weight:400;color:var(--ies-gray-500);font-size:11px;">· ${esc(plan.flow.pattern)}</span>
          ${plan.compliance.failCount > 0 ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:var(--c-danger-bg);color:var(--c-danger-strong);">${plan.compliance.failCount} FAILING</span>` : '<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:var(--c-success-bg);color:var(--c-success-strong);">ALL CLEAR</span>'}
          ${isApplied ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:var(--c-success-bg);color:var(--c-success-ink);">APPLIED ${esc(applied.createdAt)}</span>` : ''}
        </div>
        <div class="u-row">
          <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:flex;align-items:center;gap:5px;">
            Flue standard
            <select id="wsc-layout-flue" style="padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:5px;font-size:11px;">
              <option value=""${_flueStd === null ? ' selected' : ''}>Catalog default (FM)</option>
              <option value="FM"${_flueStd === 'FM' ? ' selected' : ''}>FM Global DS 8-9</option>
              <option value="NFPA"${_flueStd === 'NFPA' ? ' selected' : ''}>NFPA 13</option>
            </select>
          </label>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-layout-apply"
                  title="Persist this plan; writes the recommended column grid and raises flue space to the standard's minimum (never shrinks it).">
            ${isApplied ? 'Re-apply to design' : 'Apply to design'}</button>
        </div>
      </div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:3px;">Column grid ↔ rack-bay fit</div>
      <div style="font-size:11.5px;" title="${esc(g.rationale)}">
        ${g.spanXFt} ft span → <b>${g.baysPerModule} bays/module</b>, ${g.slackIn}" slack
        ${g.flueConflict ? '<span style="color:var(--c-danger-strong);font-weight:700;"> — flue conflict at column line</span>' : ''}
        ${g.recommended && g.recommended.spanFt !== g.spanXFt ? ` · <span style="color:var(--c-success-ink);font-weight:600;">recommend ${g.recommended.spanFt} ft (${g.recommended.baysPerModule} bays, ${g.recommended.slackIn}" slack)</span>` : ''}
      </div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin:10px 0 3px;">Standards checklist — ${esc(plan.flueStandard)} governing</div>
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        ${plan.compliance.checks.map(c => `
          <tr class="wsc-rule-top"${c.note ? ` title="${esc(c.note)}"` : ''}>
            <td style="padding:4px 0;">${esc(c.label)}</td>
            <td style="text-align:right;color:var(--ies-gray-600);white-space:nowrap;padding:0 10px;">${esc(c.required)}</td>
            <td style="text-align:right;font-weight:600;white-space:nowrap;padding-right:10px;">${esc(c.actual)}</td>
            <td style="text-align:right;width:52px;">${_statusChip(c.status)}</td>
            <td style="text-align:right;color:var(--ies-gray-500);font-size:10px;white-space:nowrap;padding-left:10px;">${esc(c.citation)}</td>
          </tr>`).join('')}
      </table>
      <div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:6px;">${esc(plan.flow.advisory)}</div>
      ${plan.gaps.map(gp => `
        <div style="font-size:10.5px;color:${gp.severity === 'warn' ? 'var(--c-warn-deep)' : 'var(--ies-gray-500)'};margin-top:4px;">
          ${gp.severity === 'warn' ? '⚠' : 'ℹ'} ${esc(gp.message)}</div>`).join('')}
    </div>
  `;
}

function _bindLayoutEvents(container, ctx) {
  container.querySelector('#wsc-layout-flue')?.addEventListener('change', (e) => {
    _flueStd = e.target.value || null;
    ctx.rerender();
  });
  container.querySelector('#wsc-layout-apply')?.addEventListener('click', () => {
    const plan = _computeLayoutPreview(ctx);
    ctx.applyLayoutPlan(plan);
    ctx.rerender();
    ctx.toast?.(`Layout applied — ${plan.flueStandard} flues, ${plan.gridFit.recommended && plan.gridFit.recommended.spanFt !== plan.gridFit.spanXFt ? plan.gridFit.recommended.spanFt : plan.gridFit.spanXFt} ft grid, ${plan.compliance.failCount} check(s) failing.`, plan.compliance.failCount > 0 ? 'info' : 'success');
  });
}

// ============================================================
// HOUSE FACTORS (N2) — pinned catalog + drift badge + explicit adopt
// ============================================================

const _SRC_CHIP = {
  'standard':        ['var(--c-success-bg)', 'var(--c-success-strong)'],
  'industry method': ['var(--c-info-bg)', 'var(--c-info-strong)'],
  'vendor heuristic':['var(--c-warn-bg)', 'var(--c-warn-deep)'],
  'IES assumption':  ['#f3e8ff', '#7e22ce'],
};
function _srcChip(source) {
  const [bg, fg] = _SRC_CHIP[source] || ['#f3f4f6', '#374151'];
  return `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:0.4px;background:${bg};color:${fg};white-space:nowrap;">${esc(source || '?')}</span>`;
}
function _factorValueLabel(r) {
  if (r.numeric_value != null) return `${fmt(r.numeric_value, 2)}${r.value_unit ? ' ' + esc(r.value_unit) : ''}`;
  const j = r.value_jsonb;
  if (j && typeof j === 'object' && !Array.isArray(j) && 'min' in j && 'max' in j) {
    return `${fmt(j.min, 2)}–${fmt(j.max, 2)}${r.value_unit ? ' ' + esc(r.value_unit) : ''}`;
  }
  return '<span class="u-muted">structured</span>';
}

async function _renderFactorsCard(el, ctx) {
  if (!el) return;
  const pinned = ctx.getPinnedFactors?.();
  el.innerHTML = `<div class="hub-card" style="padding:14px 16px;margin-top:14px;font-size:12px;color:var(--ies-gray-500);">Loading design-factor catalog…</div>`;
  if (_liveFactors === null) {
    try { _liveFactors = await ctx.fetchFactors(); }
    catch (_) { _liveFactors = []; }
  }
  const live = _liveFactors;
  if ((!live || live.length === 0) && !pinned) {
    el.innerHTML = `<div class="hub-card" style="padding:14px 16px;margin-top:14px;font-size:12px;color:var(--ies-gray-500);">Design-factor catalog unavailable (offline or empty) — factors pin at first save once reachable.</div>`;
    return;
  }
  const drift = pinned ? wscFactorsDrift(pinned, live) : null;
  const rows = pinned ? drift.rows : live.map(r => ({ ...r, changed: false, missing: false }));
  const byCat = {};
  for (const r of rows) (byCat[r.category_code] = byCat[r.category_code] || []).push(r);
  const CAT_LABEL = {
    wsc_media_selection: 'Media selection', wsc_dynamics: 'Dock / staging / aisles',
    wsc_layout_compliance: 'Layout & compliance', wsc_profile_defaults: 'Profile & height',
  };
  el.innerHTML = `
    <div class="hub-card" style="padding:14px 16px;margin-top:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div class="u-12 u-bold">Design Factors
          <span style="font-weight:400;color:var(--ies-gray-500);font-size:11px;">
            · ${pinned ? `pinned ${esc(pinned.pinnedAt)}` : 'not pinned yet — pins at first save'}</span>
          ${drift?.anyDrift ? '<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:var(--c-danger-bg);color:var(--c-danger-strong);">CATALOG MOVED</span>' : ''}
        </div>
        ${drift?.anyDrift ? '<button class="hub-btn hub-btn-sm hub-btn-secondary" id="wsc-factors-adopt" title="Re-pin this scenario to today\'s catalog. Nothing else about the design changes.">Adopt current catalog</button>' : ''}
      </div>
      ${Object.entries(byCat).map(([cat, list]) => `
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin:10px 0 2px;">${CAT_LABEL[cat] || esc(cat)}</div>
        ${list.map(r => `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--ies-gray-100);font-size:11.5px;">
            <span style="flex:1;" title="${esc(r.source_detail || '')}">${esc(r.display_name)}</span>
            ${_srcChip(r.source)}
            <span style="width:120px;text-align:right;font-weight:600;">${_factorValueLabel(r)}</span>
            ${r.changed ? `<span style="color:var(--c-danger-strong);font-size:10px;font-weight:700;" title="Catalog now: ${esc(_factorValueLabel(r.current).replace(/<[^>]*>/g, ''))}">Δ</span>` : r.missing ? '<span style="color:var(--c-warn-deep);font-size:10px;font-weight:700;" title="Removed from catalog">✕</span>' : '<span style="width:10px;"></span>'}
          </div>
        `).join('')}
      `).join('')}
      ${drift?.added?.length ? `<div style="font-size:10.5px;color:var(--c-warn-deep);margin-top:8px;">＋ ${drift.added.length} new factor(s) in the catalog since this scenario pinned — adopt to include.</div>` : ''}
      <div style="font-size:10px;color:var(--ies-gray-500);margin-top:8px;">
        Org-wide guidance pinned per scenario — catalog changes never silently alter a saved design. Sources cited per factor (hover names).
      </div>
    </div>
  `;
  el.querySelector('#wsc-factors-adopt')?.addEventListener('click', () => {
    ctx.adoptFactors(live);
    _renderFactorsCard(el, ctx);
    ctx.toast?.('Scenario re-pinned to the current factor catalog.', 'success');
  });
}

// ============================================================
// EVENTS
// ============================================================

function _bindEvents(container, ctx) {
  const fileInput = container.querySelector('#wsc-basis-file');
  _bindMediaEvents(container, ctx);   // N3 — rotation select + Apply
  _bindDynamicsEvents(container, ctx);   // N4 — policy inputs + Apply
  _bindLayoutEvents(container, ctx);   // N5 — flue toggle + Apply
  // N6 — Design Basis document (print popup → browser Save-as-PDF, COG F4 pattern)
  container.querySelector('#wsc-basis-doc')?.addEventListener('click', () => {
    const model = buildDesignBasisModel({
      facility: ctx.getFacility?.() || {},
      zones: ctx.getZones?.() || {},
      volumes: ctx.getVolumes?.() || {},
      profile: ctx.getProfile(),
      pinnedFactors: ctx.getPinnedFactors?.(),
      mediaPlan: ctx.getMediaPlan?.(),
      dynamicsPlan: ctx.getDynamicsPlan?.(),
      layoutPlan: ctx.getLayoutPlan?.(),
      sized: ctx.computeSized?.(),
    });
    const win = window.open('', '_blank');
    if (!win) { ctx.toast?.('Popup blocked — allow popups for this site to generate the document.', 'error'); return; }
    win.document.write(renderDesignBasisHtml(model));
    win.document.close();
  });

  container.querySelectorAll('[data-basis-upload]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.dataset.basisUpload;
      fileInput.dataset.slot = slot;
      fileInput.value = '';
      fileInput.click();
    });
  });

  container.querySelectorAll('[data-basis-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.dataset.basisClear;
      if (slot === 'skuMaster') _data.skus = null;
      if (slot === 'inventory') _data.inventory = null;
      if (slot === 'orders') _data.orders = null;
      _sources[slot] = null;
      if (_data.skus || _data.inventory || _data.orders) _recomputeDataProfile(ctx);
      else { ctx.setProfile(null); ctx.rerender(); }
    });
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const XLSX_ = typeof window !== 'undefined' ? window.XLSX : null;
    if (!XLSX_ || !XLSX_.read) {
      ctx.toast?.('Spreadsheet parser not loaded — refresh the page and retry.', 'error');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX_.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX_.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      const dataRows = aoa.filter(r => r && r.some(c => c !== '' && c != null));
      if (dataRows.length === 0) { ctx.toast?.('File appears to be empty.', 'error'); return; }
      // Assume a header row when the first row is mostly non-numeric strings.
      const first = dataRows[0];
      const looksHeader = first.filter(c => c !== '' && isNaN(parseFloat(String(c).replace(/[,$\s]/g, '')))).length >= first.filter(c => c !== '').length / 2;
      _pending = {
        slot: fileInput.dataset.slot,
        fileName: file.name,
        aoa: dataRows,
        headerRow: looksHeader ? first.map(v => String(v ?? '')) : null,
        mapping: {},
      };
      _renderWizard(container.querySelector('#wsc-basis-wizard'), ctx);
    } catch (err) {
      ctx.toast?.(`Could not read "${file.name}": ${err.message}`, 'error');
    }
  });

  container.querySelector('#wsc-basis-sparse-apply')?.addEventListener('click', () => {
    const g = (id) => {
      const el = container.querySelector('#' + id);
      const n = parseFloat(el?.value);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const inputs = {
      skuCount: g('sp-skuCount'),
      onHandPallets: g('sp-onHandPallets'),
      annualOutboundUnits: g('sp-annualOutboundUnits'),
      avgPalletsPerSku: g('sp-avgPalletsPerSku'),
      avgCasesPerPallet: g('sp-avgCasesPerPallet'),
      peakFactor: g('sp-peakFactor'),
    };
    if (!inputs.skuCount) { ctx.toast?.('SKU count is required for a sparse profile.', 'error'); return; }
    const profile = computeSparseProfile(inputs);
    // Switching to sparse mode clears session file state (one active basis at a time).
    resetBasisState();
    ctx.setProfile(profile);
    ctx.rerender();
  });
}
