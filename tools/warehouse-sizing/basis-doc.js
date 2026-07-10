/**
 * IES Hub v3 — WSC Design Basis document (N6, 2026-07-04)
 *
 * The customer-facing payoff of the re-founding: assembles everything the
 * N1–N5 chain produces — profile provenance, pinned factor citations, media
 * rationale + selection audit, dynamics math, compliance checklist — into
 * the 12-section basis-of-design document that integrator practice expects
 * (North Star §3.6). Every number in the doc traces to customer data, a
 * cited factor, or a disclosed assumption.
 *
 * buildDesignBasisModel() is pure and fully tested (test-wsc-basis-doc.mjs);
 * renderDesignBasisHtml() turns the model into a print-friendly page for
 * the popup → browser Save-as-PDF path (COG F4 pattern).
 *
 * @module tools/warehouse-sizing/basis-doc
 */

import { printFontCss, FONT_UI, FONT_DISPLAY, FONT_MONO } from '../../shared/print-fonts.js?v=20260710-r3';
import { icon } from '../../shared/icons.js?v=20260710-r2';

const fmt = (n, d = 0) => n == null || !Number.isFinite(Number(n)) ? '—'
  : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ============================================================
// MODEL
// ============================================================

/**
 * @param {Object} args — { facility, zones, volumes, profile, pinnedFactors,
 *                          mediaPlan, dynamicsPlan, layoutPlan, sized, meta }
 * @returns {Object} DesignBasisModel — { title, generatedAt, sections: [{ id, title, ... }] }
 */
export function buildDesignBasisModel({ facility = {}, zones = {}, volumes = {}, profile = null,
  pinnedFactors = null, mediaPlan = null, dynamicsPlan = null, layoutPlan = null, sized = null, meta = {} } = {}) {

  const sections = [];

  // ── 1. Scope & constraints ──
  sections.push({
    id: 'scope', title: '1. Scope & Facility Constraints',
    rows: [
      ['Facility', facility.name || 'Untitled'],
      ['Sizing mode', facility.sizingMode === 'constraint' ? 'Constraint — building given, capacity checked' : 'Design — inventory drives the building'],
      ['Building', facility.buildingWidth > 0 && facility.buildingDepth > 0
        ? `${fmt(facility.buildingWidth)} × ${fmt(facility.buildingDepth)} ft · ${fmt(facility.totalSqft)} sqft` : 'derived by engine'],
      ['Clear height', `${fmt(facility.clearHeight)} ft`],
      ['Storage type', facility.storageType || 'single'],
      ['Prepared', `${meta.preparedBy || 'IES Solutions Design'} · ${new Date().toISOString().slice(0, 10)}`],
    ],
  });

  // ── 2. Data basis ──
  const srcRows = [];
  if (profile?.sources) {
    for (const [slot, s] of Object.entries(profile.sources)) {
      if (s) srcRows.push([{ skuMaster: 'SKU master', inventory: 'Inventory snapshot', orders: 'Order history' }[slot] || slot,
        `${s.fileName} — ${fmt(s.rows)} rows${s.skipped ? ` (${s.skipped} skipped)` : ''}`]);
    }
  }
  sections.push({
    id: 'data', title: '2. Data Basis',
    rows: [
      ['Basis mode', profile ? (profile.mode === 'data' ? 'Customer data (derived profile)' : 'Sparse / RFP aggregates (asserted profile)') : 'None — engine inputs only'],
      ...srcRows,
      ...(profile?.peak?.weeksObserved ? [['Order history span', `${fmt(profile.peak.weeksObserved)} ISO weeks`]] : []),
    ],
  });

  // ── 3. Assumptions register ──
  const register = [];
  const PROV_LABEL = { derived: 'Derived from data', asserted: 'Asserted by analyst', estimated: 'Estimated (default)' };
  if (profile?.provenance) {
    const FIELD_VALUE = {
      skuCount: () => fmt(profile.skuCount),
      velocityBands: () => profile.velocityBands ? `A ${fmt(profile.velocityBands.A?.skuPct, 1)}% SKUs / ${fmt(profile.velocityBands.A?.linePct, 1)}% lines` : '—',
      depthOfHolding: () => `${fmt(profile.depthOfHolding?.avgPalletsPerSku, 1)} avg plt/SKU`,
      onHandPallets: () => fmt(profile.volumes?.onHandPallets),
      tiHi: () => `${fmt(profile.tiHi?.avgCasesPerPallet, 1)} cases/plt`,
      peak: () => `×${fmt(profile.peak?.peakFactor, 2)}`,
      volumes: () => `${fmt(profile.volumes?.annualOutboundUnits)} units/yr`,
      cubeMovement: () => 'cube axis',
    };
    for (const [field, prov] of Object.entries(profile.provenance)) {
      register.push({ item: `Profile · ${field}`, value: (FIELD_VALUE[field] || (() => '—'))(), basis: PROV_LABEL[prov] || prov });
    }
  }
  if (mediaPlan) register.push({ item: 'Media plan · rotation policy', value: mediaPlan.policy?.rotation === 'fifo_strict' ? 'Strict FIFO / lot control' : 'No constraint', basis: 'Asserted by analyst' });
  if (dynamicsPlan) {
    register.push({ item: 'Dynamics · arrival window', value: `${dynamicsPlan.policy.arrivalWindowHrs} hr`, basis: 'Asserted by analyst' });
    register.push({ item: 'Dynamics · dwell (in / out)', value: `${dynamicsPlan.policy.dwellDaysIn} / ${dynamicsPlan.policy.dwellDaysOut} days`, basis: 'Asserted by analyst' });
    if (dynamicsPlan.mhe?.fleet?.length) {
      const st = dynamicsPlan.mhe.fleet.find(f => (f.role || '').startsWith('storage'));
      register.push({ item: 'Dynamics · storage MHE (aisle basis)', value: `${st?.label || 'Reach truck'} → ${dynamicsPlan.mhe.governingAisleFt} ft aisles`,
        basis: dynamicsPlan.mhe.source === 'asserted' ? 'Asserted by analyst (selection finalized in MOST)' : 'Estimated (default; selection finalized in MOST)' });
    }
  }
  if (layoutPlan) register.push({ item: 'Compliance · flue standard', value: layoutPlan.flueStandard, basis: 'Project decision (insurer governs)' });
  register.push(pinnedFactors?.pinnedAt
    ? { item: 'Factor catalog', value: `${(pinnedFactors.rows || []).length} factors pinned ${pinnedFactors.pinnedAt}`, basis: 'Org guidance, pinned per scenario' }
    : { item: 'Factor catalog', value: 'NOT PINNED — seed defaults in effect', basis: 'Estimated (default)' });
  sections.push({ id: 'assumptions', title: '3. Assumptions Register', register });

  // ── 4. Design-year volumes & peak ──
  sections.push({
    id: 'volumes', title: '4. Design-Year Volumes & Peak',
    rows: [
      ['Annual outbound units', fmt(profile?.volumes?.annualOutboundUnits ?? volumes.annualOutboundUnits)],
      ['On-hand pallets', fmt(profile?.volumes?.onHandPallets ?? volumes.totalPallets)],
      ['Daily flow (in / out, pallets)', dynamicsPlan ? `${fmt(dynamicsPlan.flow.inPerDay)} / ${fmt(dynamicsPlan.flow.outPerDay)} (${dynamicsPlan.flow.provenance})` : '—'],
      ['Peak factor', `×${fmt(profile?.peak?.peakFactor ?? volumes.peakMultiplier, 2)}${profile?.peak?.basis ? ` (${profile.peak.basis})` : ''}`],
      ['Days on hand', fmt(volumes.daysOnHand)],
    ],
  });

  // ── 5. SKU / inventory profile ──
  const profRows = [];
  if (profile?.velocityBands) {
    for (const k of ['A', 'B', 'C']) {
      const b = profile.velocityBands[k];
      if (b) profRows.push([`Velocity band ${k}`, `${fmt(b.skuCount)} SKUs (${fmt(b.skuPct, 1)}%) → ${fmt(b.linePct, 1)}% of pick lines`]);
    }
  }
  if (profile?.depthOfHolding) profRows.push(['Depth of holding', `${fmt(profile.depthOfHolding.avgPalletsPerSku, 1)} avg plt/SKU` +
    (profile.depthOfHolding.p50 != null ? ` · median ${fmt(profile.depthOfHolding.p50, 1)} · p90 ${fmt(profile.depthOfHolding.p90, 1)}` : '')]);
  if (profile?.tiHi) profRows.push(['Ti-Hi', `${fmt(profile.tiHi.avgCasesPerPallet, 1)} avg cases/pallet`]);
  sections.push({ id: 'profile', title: '5. SKU & Inventory Profile', rows: profRows.length ? profRows : [['Profile', 'not built']] });

  // ── 6. Storage media allocation ──
  sections.push({
    id: 'media', title: '6. Storage Media Selection (engineered)',
    mediaBands: mediaPlan ? mediaPlan.bands.map(b => ({
      bucket: b.bucket, skus: b.skuCount, pallets: b.pallets, media: b.mediaLabel,
      occupancyPct: b.occupancyPct, positions: b.positions,
      cost: `$${fmt(b.costBand.min / 1000)}K–$${fmt(b.costBand.max / 1000)}K`,
      rationale: b.rationale, citations: b.citations,
    })) : null,
    shelving: mediaPlan?.shelving || null,
    totals: mediaPlan?.totals || null,
    allocation: mediaPlan?.allocation || null,
    note: mediaPlan ? `Provenance: ${mediaPlan.provenance}. Selection audit available per band in the tool.` : 'No media plan — storage mix is analyst-asserted.',
  });

  // ── 7. Description of operations ──
  sections.push({
    id: 'ops', title: '7. Description of Operations',
    rows: [
      ['Flow pattern', layoutPlan ? `${layoutPlan.flow.pattern} — ${layoutPlan.flow.advisory}` : 'not evaluated'],
      ['Dock operations', dynamicsPlan ? dynamicsPlan.docks.rationale : 'not derived'],
      ['Receiving staging', dynamicsPlan ? `${fmt(dynamicsPlan.staging.inbound.sqft)} sqft (${dynamicsPlan.staging.inbound.governedBy}-governed, ${dynamicsPlan.policy.dwellDaysIn}-day dwell)` : '—'],
      ['Shipping staging', dynamicsPlan ? `${fmt(dynamicsPlan.staging.outbound.sqft)} sqft (${dynamicsPlan.staging.outbound.governedBy}-governed)` : '—'],
    ],
  });

  // ── 8. Equipment ──
  sections.push({
    id: 'equipment', title: '8. Equipment (MHE & Storage)',
    fleet: dynamicsPlan?.mhe?.fleet?.map(f => ({ label: f.label, role: f.role, aisleFt: f.aisleFt, rationale: f.rationale })) || null,
    vnaAdvisory: dynamicsPlan?.mhe?.vnaAdvisory || null,
    mheNote: dynamicsPlan?.mhe ? `MHE fleet shown is an aisle-width planning assumption (${dynamicsPlan.mhe.source === 'asserted' ? 'analyst-asserted' : 'default from media plan'}) — equipment selection is finalized in the MOST / direct-labor template development.` : null,
    rackCost: mediaPlan?.totals ? `Rack investment (equipment only): $${fmt(mediaPlan.totals.costBand.min / 1000)}K – $${fmt(mediaPlan.totals.costBand.max / 1000)}K for ${fmt(mediaPlan.totals.positions)} positions` : null,
  });

  // ── 9. Dynamics detail ──
  sections.push({
    id: 'dynamics', title: '9. Dock & Staging Engineering',
    rows: dynamicsPlan ? [
      ['Rate method', dynamicsPlan.docks.rationale],
      ['Dwell-method cross-check', `${dynamicsPlan.docks.dwellCheck.doors} doors (${dynamicsPlan.docks.dwellCheck.trucksPerPeakDay} trucks/peak-day) — ${dynamicsPlan.docks.methodsDiverge ? 'DIVERGES >50%, review inputs' : 'methods agree'}`],
      ...(dynamicsPlan.docks.sanityNote ? [['Ratio sanity check', dynamicsPlan.docks.sanityNote]] : []),
    ] : [['Dynamics', 'not derived — dock/staging values are analyst-asserted']],
  });

  // ── 10. Standards & citations ──
  sections.push({
    id: 'standards', title: '10. Standards & Compliance',
    flueStandard: layoutPlan?.flueStandard || null,
    checks: layoutPlan?.compliance?.checks?.map(c => ({ label: c.label, required: c.required, actual: c.actual, status: c.status, citation: c.citation, note: c.note })) || null,
    gridFit: layoutPlan?.gridFit ? layoutPlan.gridFit.rationale : null,
    factorSources: pinnedFactors?.rows ? Object.entries((pinnedFactors.rows || []).reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1; return acc;
    }, {})).map(([source, count]) => `${source} × ${count}`) : null,
  });

  // ── 11. Reconciliation ──
  const recon = [];
  if (mediaPlan?.totals && sized?.positions) {
    const req = mediaPlan.totals.positions;
    const prov = sized.positions.grossPositions || 0;
    recon.push({ item: 'Pallet positions', required: req, provided: prov, status: prov >= req ? 'OK' : 'SHORT', basis: 'media plan vs sized design' });
  }
  if (dynamicsPlan) {
    const reqDoors = dynamicsPlan.docks.totalDoors;
    const provDoors = (zones.dockConfig?.inboundDoors || 0) + (zones.dockConfig?.outboundDoors || 0);
    recon.push({ item: 'Dock doors', required: reqDoors, provided: provDoors, status: provDoors >= reqDoors ? 'OK' : 'SHORT', basis: 'rate method vs configured' });
    const reqStage = dynamicsPlan.staging.totalSqft;
    const provStage = (Number(zones.receiveStagingSqft) || 0) + (Number(zones.shipStagingSqft) || 0);
    recon.push({ item: 'Staging sqft', required: reqStage, provided: provStage, status: provStage >= reqStage ? 'OK' : 'SHORT', basis: 'dwell model vs configured' });
    if (dynamicsPlan.mhe?.governingAisleFt && Number(facility.aisleWidth) > 0) {
      recon.push({ item: 'Storage aisle (ft)', required: dynamicsPlan.mhe.governingAisleFt, provided: Number(facility.aisleWidth),
        status: Number(facility.aisleWidth) >= dynamicsPlan.mhe.governingAisleFt ? 'OK' : 'SHORT', basis: 'MHE aisle assumption vs configured' });
    }
  }
  if (sized?.requirementsDriven?.totalSfRequired > 0 && Number(facility.totalSqft) > 0) {
    recon.push({ item: 'Building sqft', required: sized.requirementsDriven.totalSfRequired, provided: Number(facility.totalSqft),
      status: Number(facility.totalSqft) >= sized.requirementsDriven.totalSfRequired ? 'OK' : 'SHORT', basis: 'requirements-driven vs building' });
  }
  sections.push({ id: 'reconciliation', title: '11. Reconciliation — Required vs Provided', recon });

  // ── 12. Gaps & exclusions ──
  const allGaps = []
    .concat((profile?.dataGaps || []).map(g => ({ ...g, origin: 'Profile' })))
    .concat((mediaPlan?.gaps || []).map(g => ({ ...g, origin: 'Media' })))
    .concat((dynamicsPlan?.gaps || []).map(g => ({ ...g, origin: 'Dynamics' })))
    .concat((layoutPlan?.gaps || []).map(g => ({ ...g, origin: 'Layout' })));
  sections.push({
    id: 'gaps', title: '12. Data Gaps, Exclusions & Next Steps',
    gaps: allGaps,
    exclusions: [
      'Rack seismic engineering, permits, and installation costs excluded (equipment-only bands).',
      'Labor staffing rides the MOST tool; transport network rides COG — linked, not duplicated here.',
      'Egress travel is a rectilinear planning estimate — code path analysis by the AHJ governs.',
    ],
  });

  return {
    title: `Design Basis — ${facility.name || 'Untitled Facility'}`,
    generatedAt: new Date().toISOString().slice(0, 10),
    sections,
  };
}

// ============================================================
// PRINT HTML
// ============================================================

/** @returns {string} complete standalone HTML document */
export function renderDesignBasisHtml(model) {
  const kv = (rows) => `<table class="kv">${(rows || []).map(([k, v]) =>
    `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

  const sec = (s) => {
    let body = '';
    if (s.rows) body = kv(s.rows);
    if (s.register) body = `<table class="grid"><tr><th>Item</th><th>Value</th><th>Basis</th></tr>${s.register.map(r =>
      `<tr class="${r.basis.startsWith('Estimated') ? 'warn' : ''}"><td>${esc(r.item)}</td><td>${esc(r.value)}</td><td>${esc(r.basis)}</td></tr>`).join('')}</table>`;
    if (s.id === 'media') {
      body = s.mediaBands ? `<table class="grid"><tr><th>Depth band</th><th>SKUs</th><th>Pallets</th><th>Medium</th><th>Occ.</th><th>Positions</th><th>Rack cost</th></tr>${s.mediaBands.map(b =>
        `<tr><td>${esc(b.bucket)}</td><td>${fmt(b.skus)}</td><td>${fmt(b.pallets)}</td><td>${esc(b.media)}</td><td>${b.occupancyPct}%</td><td>${fmt(b.positions)}</td><td>${esc(b.cost)}</td></tr>
         <tr class="rationale"><td colspan="7">↳ ${esc(b.rationale)} <span class="cite">[${b.citations.join(', ')}]</span></td></tr>`).join('')}
        ${s.shelving ? `<tr><td>&lt;1 plt/SKU</td><td>${fmt(s.shelving.skuCount)}</td><td>${fmt(s.shelving.pallets)}</td><td>Carton shelving</td><td>—</td><td>—</td><td>—</td></tr>` : ''}
        ${s.totals ? `<tr class="total"><td>Total</td><td></td><td>${fmt(s.totals.pallets)}</td><td>${s.totals.mediaCount} media</td><td></td><td>${fmt(s.totals.positions)}</td><td></td></tr>` : ''}
        </table>
        ${s.allocation ? `<p class="note">Derived storage mix: full-pallet ${s.allocation.fullPallet}% · carton-on-pallet ${s.allocation.cartonOnPallet}% · shelving ${s.allocation.cartonOnShelving}%. ${esc(s.allocation.rationale)}</p>` : ''}
        <p class="note">${esc(s.note)}</p>` : `<p class="note">${esc(s.note)}</p>`;
    }
    if (s.id === 'equipment') {
      body = (s.fleet ? `<table class="grid"><tr><th>Unit</th><th>Role</th><th>Aisle</th></tr>${s.fleet.map(f =>
        `<tr><td>${esc(f.label)}</td><td>${esc(f.role)}</td><td>${f.aisleFt} ft</td></tr>
         <tr class="rationale"><td colspan="3">↳ ${esc(f.rationale)}</td></tr>`).join('')}</table>` : '<p class="note">No dynamics plan — fleet not derived.</p>')
        + (s.mheNote ? `<p class="note">${esc(s.mheNote)}</p>` : '')
        + (s.vnaAdvisory ? `<p class="note">◆ ${esc(s.vnaAdvisory)}</p>` : '')
        + (s.rackCost ? `<p class="note">${esc(s.rackCost)}</p>` : '');
    }
    if (s.id === 'standards') {
      body = (s.flueStandard ? `<p><b>Governing flue standard: ${esc(s.flueStandard)}</b> (project decision — client's insurer governs)</p>` : '<p class="note">Layout plan not run.</p>')
        + (s.gridFit ? `<p class="note">Grid fit: ${esc(s.gridFit)}</p>` : '')
        + (s.checks ? `<table class="grid"><tr><th>Check</th><th>Required</th><th>Actual</th><th>Status</th><th>Citation</th></tr>${s.checks.map(c =>
          `<tr class="${c.status === 'FAIL' ? 'fail' : ''}"><td>${esc(c.label)}${c.note ? `<div class="cite">${esc(c.note)}</div>` : ''}</td><td>${esc(c.required)}</td><td>${esc(c.actual)}</td><td>${c.status}</td><td class="cite">${esc(c.citation)}</td></tr>`).join('')}</table>` : '')
        + (s.factorSources ? `<p class="note">Factor catalog provenance: ${s.factorSources.map(esc).join(' · ')}</p>` : '');
    }
    if (s.recon) {
      body = s.recon.length ? `<table class="grid"><tr><th>Item</th><th>Required</th><th>Provided</th><th>Status</th><th>Basis</th></tr>${s.recon.map(r =>
        `<tr class="${r.status === 'SHORT' ? 'fail' : ''}"><td>${esc(r.item)}</td><td>${fmt(r.required)}</td><td>${fmt(r.provided)}</td><td>${r.status}</td><td class="cite">${esc(r.basis)}</td></tr>`).join('')}</table>`
        : '<p class="note">Nothing to reconcile yet — apply the media, dynamics, and layout plans.</p>';
    }
    if (s.gaps) {
      body = (s.gaps.length ? `<table class="grid"><tr><th></th><th>Origin</th><th>Finding</th></tr>${s.gaps.map(g =>
        `<tr class="${g.severity === 'warn' || g.severity === 'error' ? 'warn' : ''}"><td style="color:${g.severity === 'error' ? '#b42318' : g.severity === 'warn' ? '#b54708' : '#667085'};">${icon(g.severity === 'error' ? 'warn' : g.severity === 'warn' ? 'warn' : 'info', { size: 12 })}</td><td>${esc(g.origin)}</td><td>${esc(g.message)}</td></tr>`).join('')}</table>`
        : '<p class="note">No open gaps — fully derived basis.</p>')
        + `<p class="note"><b>Exclusions:</b></p><ul>${s.exclusions.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`;
    }
    return `<section><h2>${esc(s.title)}</h2>${body}</section>`;
  };

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(model.title)}</title>
<style>
  ${printFontCss()}
  body { font: 12px/1.45 ${FONT_UI}; color: #1f2430; margin: 40px 48px; }
  h1 { font-family: ${FONT_DISPLAY}; font-size: 22px; letter-spacing: -0.015em; margin: 0 0 2px; } .sub { color: #667085; font-size: 11px; margin-bottom: 18px; }
  h2 { font-family: ${FONT_DISPLAY}; font-size: 14px; letter-spacing: -0.01em; border-bottom: 2px solid #1f2430; padding-bottom: 3px; margin: 22px 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  .kv td { padding: 3px 8px 3px 0; vertical-align: top; } .kv .k { font-weight: 600; width: 220px; color: #475069; }
  .grid th { text-align: left; background: #f2f4f7; padding: 4px 8px; border: 1px solid #d8dde6; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
  .grid td { padding: 4px 8px; border: 1px solid #e4e7ec; vertical-align: top; }
  .rationale td { background: #fafbfc; color: #667085; font-size: 10px; border-top: none; }
  .total td { font-weight: 700; background: #f2f4f7; }
  .warn td { background: #fff8eb; } .fail td { background: #fef1f1; }
  .cite { color: #98a2b3; font-size: 9.5px; } .note { color: #667085; font-size: 10.5px; margin: 6px 0; }
  ul { margin: 4px 0 0 18px; color: #667085; font-size: 10.5px; }
  .print-btn { position: fixed; top: 14px; right: 16px; padding: 8px 18px; background: #1f2430; color: #fff; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }
  @media print { .print-btn { display: none; } body { margin: 0; } section { break-inside: avoid; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>${esc(model.title)}</h1>
  <div class="sub">Basis of Design · generated ${esc(model.generatedAt)} · IES Intelligence Hub — every value traces to customer data, a cited factor, or a disclosed assumption</div>
  ${model.sections.map(sec).join('\n')}
</body></html>`;
}
