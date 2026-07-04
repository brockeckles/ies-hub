/**
 * IES Hub v3 — WSC Design-Basis Profiler (N1, 2026-07-04)
 *
 * Pure calculation module for the re-founded WSC's data-first spine:
 *   customer data → profile → derived requirements.
 *
 * Two first-class modes (Brock 2026-07-04: "both equally well"):
 *   - 'data'   : parsed SKU master / inventory snapshot / order history
 *   - 'sparse' : RFP-summary aggregates (SKU count, outbound, pallets…)
 *
 * Both produce the SAME DesignProfile shape. Every field carries
 * provenance: 'derived' (from customer rows), 'asserted' (user-entered
 * aggregate), or 'estimated' (defaulted — always paired with a dataGap).
 *
 * Zero DOM, zero imports — pure functions, fully unit-tested
 * (test-wsc-profile.mjs).
 *
 * @module tools/warehouse-sizing/profile-calc
 */

// ============================================================
// COLUMN ROLES (per file type) — consumed by the ui-basis wizard
// ============================================================

export const SKU_MASTER_ROLES = [
  { value: '',              label: 'Ignore' },
  { value: 'sku',           label: 'SKU / Item #' },
  { value: 'description',   label: 'Description' },
  { value: 'unitsPerCase',  label: 'Units per Case' },
  { value: 'casesPerPallet',label: 'Cases per Pallet (Ti×Hi)' },
  { value: 'caseLengthIn',  label: 'Case Length (in)' },
  { value: 'caseWidthIn',   label: 'Case Width (in)' },
  { value: 'caseHeightIn',  label: 'Case Height (in)' },
  { value: 'caseCubeFt',    label: 'Case Cube (ft³)' },
  { value: 'caseWeightLb',  label: 'Case Weight (lb)' },
];

export const INVENTORY_ROLES = [
  { value: '',              label: 'Ignore' },
  { value: 'sku',           label: 'SKU / Item #' },
  { value: 'onHandUnits',   label: 'On-Hand Units' },
  { value: 'onHandCases',   label: 'On-Hand Cases' },
  { value: 'onHandPallets', label: 'On-Hand Pallets' },
];

export const ORDER_ROLES = [
  { value: '',              label: 'Ignore' },
  { value: 'date',          label: 'Order Date' },
  { value: 'orderId',       label: 'Order #' },
  { value: 'sku',           label: 'SKU / Item #' },
  { value: 'qtyUnits',      label: 'Qty (units)' },
  { value: 'qtyCases',      label: 'Qty (cases)' },
];

/** Header-regex auto-detection, COG-C1 pattern. Order matters (first hit wins). */
const AUTO_DETECT = {
  sku:            /^(sku|item|part|product)[\s_#-]*(no|num|number|id|code)?$/i,
  description:    /desc/i,
  unitsPerCase:   /(units?|ea(ch)?)[\s_/-]*(per)?[\s_/-]*(case|ctn|carton)/i,
  casesPerPallet: /(cases?|ctns?|cartons?)[\s_/-]*(per)?[\s_/-]*(pallet|plt)|ti[\s_×x-]*hi/i,
  caseLengthIn:   /(case|ctn)?[\s_-]*l(en(gth)?)?[\s_-]*\(?(in|")?\)?$/i,
  caseWidthIn:    /(case|ctn)?[\s_-]*w(id(th)?)?[\s_-]*\(?(in|")?\)?$/i,
  caseHeightIn:   /(case|ctn)?[\s_-]*h(e?ight)?[\s_-]*\(?(in|")?\)?$/i,
  caseCubeFt:     /cube/i,
  caseWeightLb:   /w(eigh)?t/i,
  onHandUnits:    /(on[\s_-]*hand|oh|qty|quantity)[\s_-]*(units?|ea)?$/i,
  onHandCases:    /(on[\s_-]*hand|oh)[\s_-]*(cases?|ctns?)/i,
  onHandPallets:  /(on[\s_-]*hand|oh)?[\s_-]*(pallets?|plts?)/i,
  date:           /date|day|shipped/i,
  orderId:        /order[\s_#-]*(no|num|number|id)?$/i,
  qtyUnits:       /qty|quantity|units?/i,
  qtyCases:       /(qty|quantity)[\s_-]*(cases?|ctns?)|cases?$/i,
};

/**
 * Auto-detect a column→role mapping from a header row.
 * @param {string[]} header
 * @param {{value:string}[]} roles — the role set for this file type
 * @returns {Object<number,string>}
 */
export function autoDetectMapping(header, roles) {
  const allowed = new Set(roles.map(r => r.value).filter(Boolean));
  const mapping = {};
  const taken = new Set();
  (header || []).forEach((h, i) => {
    const label = String(h || '').trim();
    if (!label) return;
    for (const [role, rx] of Object.entries(AUTO_DETECT)) {
      if (!allowed.has(role) || taken.has(role)) continue;
      if (rx.test(label)) { mapping[i] = role; taken.add(role); break; }
    }
  });
  return mapping;
}

// ============================================================
// PARSERS — rows (array-of-arrays) + mapping → typed records
// ============================================================

const num = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[,$%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null ? '' : String(v).trim());

function roleCols(mapping) {
  const rc = {};
  for (const [ci, role] of Object.entries(mapping || {})) {
    if (role) rc[role] = parseInt(ci, 10);
  }
  return rc;
}

/** @returns {{ skus: Object<string,Object>, rowCount: number, skipped: number }} */
export function parseSkuMaster(rows, mapping) {
  const rc = roleCols(mapping);
  const skus = {};
  let skipped = 0;
  for (const row of rows || []) {
    if (!row || row.every(c => c === '' || c == null)) continue;
    const sku = str(row[rc.sku]);
    if (!sku) { skipped++; continue; }
    const rec = {
      sku,
      description:    'description'    in rc ? str(row[rc.description]) : '',
      unitsPerCase:   'unitsPerCase'   in rc ? num(row[rc.unitsPerCase])   : null,
      casesPerPallet: 'casesPerPallet' in rc ? num(row[rc.casesPerPallet]) : null,
      caseCubeFt:     'caseCubeFt'     in rc ? num(row[rc.caseCubeFt])     : null,
      caseWeightLb:   'caseWeightLb'   in rc ? num(row[rc.caseWeightLb])   : null,
    };
    if (rec.caseCubeFt == null && 'caseLengthIn' in rc && 'caseWidthIn' in rc && 'caseHeightIn' in rc) {
      const L = num(row[rc.caseLengthIn]), W = num(row[rc.caseWidthIn]), H = num(row[rc.caseHeightIn]);
      if (L != null && W != null && H != null) rec.caseCubeFt = (L * W * H) / 1728;
    }
    skus[sku] = rec;
  }
  return { skus, rowCount: Object.keys(skus).length, skipped };
}

/** @returns {{ inventory: Object<string,Object>, rowCount: number, skipped: number }} */
export function parseInventory(rows, mapping) {
  const rc = roleCols(mapping);
  const inventory = {};
  let skipped = 0;
  for (const row of rows || []) {
    if (!row || row.every(c => c === '' || c == null)) continue;
    const sku = str(row[rc.sku]);
    if (!sku) { skipped++; continue; }
    const prev = inventory[sku] || { sku, onHandUnits: 0, onHandCases: 0, onHandPallets: 0,
      _hasUnits: false, _hasCases: false, _hasPallets: false };
    const u = 'onHandUnits'   in rc ? num(row[rc.onHandUnits])   : null;
    const c = 'onHandCases'   in rc ? num(row[rc.onHandCases])   : null;
    const p = 'onHandPallets' in rc ? num(row[rc.onHandPallets]) : null;
    if (u != null) { prev.onHandUnits   += u; prev._hasUnits = true; }
    if (c != null) { prev.onHandCases   += c; prev._hasCases = true; }
    if (p != null) { prev.onHandPallets += p; prev._hasPallets = true; }
    inventory[sku] = prev;
  }
  return { inventory, rowCount: Object.keys(inventory).length, skipped };
}

/** @returns {{ lines: Array, rowCount: number, skipped: number }} */
export function parseOrders(rows, mapping) {
  const rc = roleCols(mapping);
  const lines = [];
  let skipped = 0;
  for (const row of rows || []) {
    if (!row || row.every(c => c === '' || c == null)) continue;
    const sku = str(row[rc.sku]);
    if (!sku) { skipped++; continue; }
    let date = null;
    if ('date' in rc) {
      const raw = row[rc.date];
      const d = raw instanceof Date ? raw : new Date(str(raw));
      if (!isNaN(d.getTime())) date = d;
    }
    lines.push({
      sku,
      date,
      orderId: 'orderId' in rc ? str(row[rc.orderId]) : '',
      qtyUnits: 'qtyUnits' in rc ? (num(row[rc.qtyUnits]) ?? 0) : 0,
      qtyCases: 'qtyCases' in rc ? (num(row[rc.qtyCases]) ?? 0) : 0,
    });
  }
  return { lines, rowCount: lines.length, skipped };
}

// ============================================================
// PROFILE COMPUTATION — 'data' mode
// ============================================================

/** Depth-of-holding buckets mirror the media map in the North Star doc §3.2. */
export const DEPTH_BUCKETS = [
  { key: '1-5',   min: 1,  max: 5 },
  { key: '6-8',   min: 6,  max: 8 },
  { key: '9-14',  min: 9,  max: 14 },
  { key: '15-23', min: 15, max: 23 },
  { key: '24-35', min: 24, max: 35 },
  { key: '36-47', min: 36, max: 47 },
  { key: '48-71', min: 48, max: 71 },
  { key: '72+',   min: 72, max: Infinity },
];

export const DEFAULT_UNITS_PER_CASE = 12;
export const DEFAULT_CASES_PER_PALLET = 60;

function isoWeekKey(d) {
  // Thursday-anchored ISO week: stable across year boundaries. UTC getters —
  // date-only strings parse as UTC midnight; local getters would shift them
  // a calendar day in any western timezone (caught by test-wsc-profile).
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function pct(part, whole) { return whole > 0 ? (part / whole) * 100 : 0; }

/**
 * Compute a DesignProfile from parsed customer data. Any subset of the three
 * inputs is accepted — missing inputs degrade gracefully into dataGaps.
 *
 * @param {Object} args
 * @param {Object<string,Object>} [args.skus]      — from parseSkuMaster
 * @param {Object<string,Object>} [args.inventory] — from parseInventory
 * @param {Array}                 [args.orders]    — from parseOrders (lines)
 * @returns {import('./types.js').DesignProfile}
 */
export function computeProfile({ skus = null, inventory = null, orders = null } = {}) {
  const gaps = [];
  const provenance = {};
  const hasSkus = skus && Object.keys(skus).length > 0;
  const hasInv = inventory && Object.keys(inventory).length > 0;
  const hasOrders = orders && orders.length > 0;

  if (!hasSkus) gaps.push({ code: 'NO_SKU_MASTER', severity: 'warn',
    message: 'No SKU master loaded — unit-load conversions use defaults.' });
  if (!hasInv) gaps.push({ code: 'NO_INVENTORY', severity: 'warn',
    message: 'No inventory snapshot — depth-of-holding cannot be derived.' });
  if (!hasOrders) gaps.push({ code: 'NO_ORDERS', severity: 'warn',
    message: 'No order history — velocity banding and peak factor cannot be derived.' });

  // ── SKU universe ──
  const skuSet = new Set([
    ...(hasSkus ? Object.keys(skus) : []),
    ...(hasInv ? Object.keys(inventory) : []),
    ...(hasOrders ? orders.map(l => l.sku) : []),
  ]);
  const skuCount = skuSet.size;
  provenance.skuCount = 'derived';

  // ── Unit-load conversion helpers (per SKU, with default fallbacks) ──
  let missingConv = 0;
  const unitsPerPallet = (sku) => {
    const rec = hasSkus ? skus[sku] : null;
    const upc = rec?.unitsPerCase ?? null;
    const cpp = rec?.casesPerPallet ?? null;
    if (upc != null && cpp != null && upc > 0 && cpp > 0) return upc * cpp;
    missingConv++;
    return DEFAULT_UNITS_PER_CASE * DEFAULT_CASES_PER_PALLET;
  };

  // ── Ti-Hi ──
  let tiHi = null;
  if (hasSkus) {
    const withCpp = Object.values(skus).filter(r => r.casesPerPallet != null && r.casesPerPallet > 0);
    if (withCpp.length > 0) {
      tiHi = {
        avgCasesPerPallet: withCpp.reduce((s, r) => s + r.casesPerPallet, 0) / withCpp.length,
        skusWithData: withCpp.length,
        skusMissing: Object.keys(skus).length - withCpp.length,
      };
      provenance.tiHi = 'derived';
      if (tiHi.skusMissing > 0) gaps.push({ code: 'TIHI_PARTIAL', severity: 'info',
        message: `${tiHi.skusMissing} SKU(s) missing cases-per-pallet — defaults applied.`, count: tiHi.skusMissing });
    } else {
      gaps.push({ code: 'TIHI_MISSING', severity: 'warn',
        message: 'SKU master has no cases-per-pallet data — Ti-Hi unavailable.' });
    }
  }

  // ── Missing-dims gap (the #1 real-world data gap per research §3.1) ──
  if (hasSkus) {
    const noDims = Object.values(skus).filter(r => r.caseCubeFt == null).length;
    if (noDims > 0) gaps.push({ code: 'DIMS_MISSING', severity: noDims > Object.keys(skus).length / 2 ? 'warn' : 'info',
      message: `${noDims} SKU(s) missing case dimensions/cube.`, count: noDims });
  }

  // ── Velocity banding (ABC by pick LINES — research §3.1) + cube movement ──
  let velocityBands = null;
  let cubeMovement = null;
  if (hasOrders) {
    const bySku = {};
    for (const l of orders) {
      const b = bySku[l.sku] || (bySku[l.sku] = { lines: 0, units: 0 });
      b.lines++;
      b.units += l.qtyUnits > 0 ? l.qtyUnits
        : (l.qtyCases > 0 ? l.qtyCases * ((hasSkus && skus[l.sku]?.unitsPerCase) || DEFAULT_UNITS_PER_CASE) : 0);
    }
    const ranked = Object.entries(bySku).sort((a, b) => b[1].lines - a[1].lines);
    const totalLines = ranked.reduce((s, [, v]) => s + v.lines, 0);
    const bands = { A: { skus: [], lines: 0 }, B: { skus: [], lines: 0 }, C: { skus: [], lines: 0 } };
    let cum = 0;
    for (const [sku, v] of ranked) {
      cum += v.lines;
      const band = cum <= totalLines * 0.80 ? 'A' : cum <= totalLines * 0.95 ? 'B' : 'C';
      bands[band].skus.push(sku);
      bands[band].lines += v.lines;
    }
    // Guarantee A is non-empty (a single dominant SKU can overshoot 80% on line 1).
    if (bands.A.skus.length === 0 && ranked.length > 0) {
      const [sku, v] = ranked[0];
      bands.A.skus.push(sku); bands.A.lines += v.lines;
      const from = bands.B.skus.length ? 'B' : 'C';
      bands[from].skus = bands[from].skus.filter(s => s !== sku);
      bands[from].lines -= v.lines;
    }
    const orderSkuCount = ranked.length;
    velocityBands = {};
    for (const k of ['A', 'B', 'C']) {
      velocityBands[k] = {
        skuCount: bands[k].skus.length,
        skuPct: pct(bands[k].skus.length, orderSkuCount),
        linePct: pct(bands[k].lines, totalLines),
        skus: bands[k].skus,
      };
    }
    provenance.velocityBands = 'derived';

    // Cube movement (second axis) — needs case cube from the master.
    if (hasSkus) {
      let totalCube = 0;
      const cubeBySku = {};
      let cubeCovered = 0;
      for (const [sku, v] of ranked) {
        const rec = skus[sku];
        if (rec?.caseCubeFt != null && rec?.unitsPerCase > 0) {
          const cube = (v.units / rec.unitsPerCase) * rec.caseCubeFt;
          cubeBySku[sku] = cube;
          totalCube += cube;
          cubeCovered++;
        }
      }
      if (totalCube > 0) {
        cubeMovement = {};
        for (const k of ['A', 'B', 'C']) {
          const cube = velocityBands[k].skus.reduce((s, sku) => s + (cubeBySku[sku] || 0), 0);
          cubeMovement[k] = { cubePct: pct(cube, totalCube) };
        }
        cubeMovement.skuCoveragePct = pct(cubeCovered, orderSkuCount);
        provenance.cubeMovement = 'derived';
      } else {
        gaps.push({ code: 'CUBE_UNAVAILABLE', severity: 'info',
          message: 'Cube-movement axis unavailable — no case cube data in SKU master.' });
      }
    }

    // SKUs ordered but absent from master — classic reconciliation gap.
    if (hasSkus) {
      const unknown = ranked.filter(([sku]) => !skus[sku]).length;
      if (unknown > 0) gaps.push({ code: 'ORDER_SKUS_NOT_IN_MASTER', severity: 'warn',
        message: `${unknown} SKU(s) appear in orders but not in the SKU master.`, count: unknown });
    }
  }

  // ── Peak factor (weekly, ISO-anchored — research §3.1 avg vs peak week) ──
  let peak = null;
  if (hasOrders) {
    const dated = orders.filter(l => l.date);
    if (dated.length >= orders.length * 0.5 && dated.length > 0) {
      const weeks = {};
      for (const l of dated) {
        const k = isoWeekKey(l.date);
        weeks[k] = (weeks[k] || 0) + 1;
      }
      const counts = Object.values(weeks);
      const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
      const max = Math.max(...counts);
      peak = {
        weeksObserved: counts.length,
        avgWeeklyLines: avg,
        peakWeeklyLines: max,
        peakFactor: avg > 0 ? max / avg : 1,
        basis: 'lines/ISO-week',
      };
      provenance.peak = 'derived';
      if (counts.length < 26) gaps.push({ code: 'HISTORY_SHORT', severity: counts.length < 13 ? 'warn' : 'info',
        message: `Only ${counts.length} week(s) of order history — 26+ preferred to capture seasonality (12–24 months ideal).`, count: counts.length });
    } else {
      gaps.push({ code: 'ORDER_DATES_MISSING', severity: 'warn',
        message: 'Order history lacks usable dates — peak factor cannot be derived.' });
    }
  }

  // ── Depth of holding (governs media selection — research §3.2) ──
  let depthOfHolding = null;
  let onHandPalletsTotal = null;
  if (hasInv) {
    const palletsBySku = {};
    let converted = 0;
    for (const [sku, rec] of Object.entries(inventory)) {
      let pallets = null;
      if (rec._hasPallets) pallets = rec.onHandPallets;
      else if (rec._hasCases) {
        const cpp = (hasSkus && skus[sku]?.casesPerPallet) || DEFAULT_CASES_PER_PALLET;
        pallets = rec.onHandCases / cpp;
        converted++;
      } else if (rec._hasUnits) {
        pallets = rec.onHandUnits / unitsPerPallet(sku);
        converted++;
      }
      if (pallets != null && pallets > 0) palletsBySku[sku] = pallets;
    }
    const vals = Object.values(palletsBySku);
    if (vals.length > 0) {
      const sorted = [...vals].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      onHandPalletsTotal = vals.reduce((s, v) => s + v, 0);
      depthOfHolding = {
        avgPalletsPerSku: onHandPalletsTotal / vals.length,
        p50: q(0.50),
        p90: q(0.90),
        skusMeasured: vals.length,
        distribution: DEPTH_BUCKETS.map(b => ({
          bucket: b.key,
          skuCount: vals.filter(v => v >= b.min && v <= b.max).length,
          pallets: vals.filter(v => v >= b.min && v <= b.max).reduce((s, v) => s + v, 0),
        })),
      };
      provenance.depthOfHolding = 'derived';
      provenance.onHandPallets = converted === 0 ? 'derived' : 'estimated';
      if (provenance.onHandPallets === 'estimated') gaps.push({ code: 'PALLETS_CONVERTED', severity: 'info',
        message: 'On-hand pallets converted from units/cases via Ti-Hi (or defaults where missing).' });
    }
  }
  if (missingConv > 0) gaps.push({ code: 'CONVERSION_DEFAULTED', severity: 'warn',
    message: `Unit→pallet conversion defaulted (${DEFAULT_UNITS_PER_CASE}×${DEFAULT_CASES_PER_PALLET}) for SKUs lacking Ti-Hi.`, count: missingConv });

  // ── Volumes rollup ──
  let volumes = null;
  if (hasOrders) {
    const totalUnits = orders.reduce((s, l) => s + (l.qtyUnits > 0 ? l.qtyUnits
      : l.qtyCases * ((hasSkus && skus[l.sku]?.unitsPerCase) || DEFAULT_UNITS_PER_CASE)), 0);
    const dated = orders.filter(l => l.date);
    let annualized = null;
    if (dated.length > 0) {
      const ts = dated.map(l => l.date.getTime());
      const spanDays = Math.max(1, (Math.max(...ts) - Math.min(...ts)) / 86400000 + 1);
      annualized = totalUnits * (365 / spanDays) * (dated.length / orders.length);
    }
    volumes = {
      observedUnits: totalUnits,
      observedLines: orders.length,
      annualOutboundUnits: annualized,
      onHandPallets: onHandPalletsTotal,
    };
    provenance.volumes = 'derived';
  } else if (onHandPalletsTotal != null) {
    volumes = { observedUnits: null, observedLines: null, annualOutboundUnits: null, onHandPallets: onHandPalletsTotal };
    provenance.volumes = 'derived';
  }

  return {
    mode: 'data',
    skuCount,
    velocityBands,
    cubeMovement,
    depthOfHolding,
    tiHi,
    peak,
    volumes,
    dataGaps: gaps,
    provenance,
  };
}

// ============================================================
// PROFILE COMPUTATION — 'sparse' mode (RFP-summary aggregates)
// ============================================================

/** Pareto defaults used when the RFP gives no ABC split. */
export const DEFAULT_ABC = { A: { skuPct: 20, linePct: 80 }, B: { skuPct: 30, linePct: 15 }, C: { skuPct: 50, linePct: 5 } };
export const DEFAULT_PEAK_FACTOR = 1.35;

/**
 * Compute a DesignProfile from RFP-grade aggregates. Same shape as 'data'
 * mode; provenance marks 'asserted' (user gave it) vs 'estimated' (default).
 *
 * @param {Object} inputs
 * @param {number}  inputs.skuCount
 * @param {number} [inputs.onHandPallets]
 * @param {number} [inputs.annualOutboundUnits]
 * @param {number} [inputs.avgPalletsPerSku]   — else derived pallets/SKUs, else estimated
 * @param {number} [inputs.avgCasesPerPallet]
 * @param {number} [inputs.peakFactor]
 * @param {{A:{skuPct:number,linePct:number},B:Object,C:Object}} [inputs.abcSplit]
 * @returns {import('./types.js').DesignProfile}
 */
export function computeSparseProfile(inputs = {}) {
  const gaps = [];
  const provenance = {};
  const skuCount = inputs.skuCount > 0 ? inputs.skuCount : null;
  if (skuCount == null) gaps.push({ code: 'SKU_COUNT_MISSING', severity: 'error',
    message: 'SKU count is required for a sparse profile.' });
  provenance.skuCount = 'asserted';

  // ABC
  const abc = inputs.abcSplit || DEFAULT_ABC;
  provenance.velocityBands = inputs.abcSplit ? 'asserted' : 'estimated';
  if (!inputs.abcSplit) gaps.push({ code: 'ABC_DEFAULTED', severity: 'info',
    message: 'ABC split defaulted to Pareto 20/30/50 — replace when pick data arrives.' });
  const velocityBands = skuCount == null ? null : Object.fromEntries(['A', 'B', 'C'].map(k => [k, {
    skuCount: Math.round(skuCount * abc[k].skuPct / 100),
    skuPct: abc[k].skuPct,
    linePct: abc[k].linePct,
    skus: null,  // not enumerable in sparse mode
  }]));

  // Depth of holding
  let avgPalletsPerSku = inputs.avgPalletsPerSku > 0 ? inputs.avgPalletsPerSku : null;
  if (avgPalletsPerSku != null) provenance.depthOfHolding = 'asserted';
  else if (inputs.onHandPallets > 0 && skuCount > 0) {
    avgPalletsPerSku = inputs.onHandPallets / skuCount;
    provenance.depthOfHolding = 'derived';
  } else {
    gaps.push({ code: 'DEPTH_UNKNOWN', severity: 'warn',
      message: 'No pallets-per-SKU signal — media selection will need this before it can be defended.' });
  }
  const depthOfHolding = avgPalletsPerSku == null ? null : {
    avgPalletsPerSku,
    p50: null, p90: null,
    skusMeasured: null,
    distribution: null,  // sparse mode has no per-SKU distribution
  };

  // Ti-Hi
  let tiHi = null;
  if (inputs.avgCasesPerPallet > 0) {
    tiHi = { avgCasesPerPallet: inputs.avgCasesPerPallet, skusWithData: null, skusMissing: null };
    provenance.tiHi = 'asserted';
  } else {
    gaps.push({ code: 'TIHI_MISSING', severity: 'info',
      message: 'No Ti-Hi given — case↔pallet conversions will use defaults.' });
  }

  // Peak
  const peakFactor = inputs.peakFactor > 0 ? inputs.peakFactor : DEFAULT_PEAK_FACTOR;
  provenance.peak = inputs.peakFactor > 0 ? 'asserted' : 'estimated';
  if (!(inputs.peakFactor > 0)) gaps.push({ code: 'PEAK_DEFAULTED', severity: 'warn',
    message: `Peak factor defaulted to ${DEFAULT_PEAK_FACTOR} — a real peak-week analysis should replace this.` });
  const peak = { weeksObserved: null, avgWeeklyLines: null, peakWeeklyLines: null, peakFactor, basis: 'sparse' };

  // Volumes
  const volumes = {
    observedUnits: null,
    observedLines: null,
    annualOutboundUnits: inputs.annualOutboundUnits > 0 ? inputs.annualOutboundUnits : null,
    onHandPallets: inputs.onHandPallets > 0 ? inputs.onHandPallets : null,
  };
  provenance.volumes = 'asserted';
  if (volumes.annualOutboundUnits == null) gaps.push({ code: 'OUTBOUND_MISSING', severity: 'warn',
    message: 'No annual outbound volume — throughput-driven sizing (docks, staging) unavailable.' });

  return {
    mode: 'sparse',
    skuCount,
    velocityBands,
    cubeMovement: null,
    depthOfHolding,
    tiHi,
    peak,
    volumes,
    dataGaps: gaps,
    provenance,
  };
}

// ============================================================
// SHARED — profile completeness score (drives the UI readiness chip)
// ============================================================

/**
 * 0–100 readiness score + blocking-gap list. Both modes.
 * @param {import('./types.js').DesignProfile|null} profile
 */
export function profileReadiness(profile) {
  if (!profile) return { score: 0, blocking: ['No profile yet'], label: 'Not started' };
  const checks = [
    ['skuCount',        !!profile.skuCount,                          20],
    ['velocityBands',   !!profile.velocityBands,                     20],
    ['depthOfHolding',  !!profile.depthOfHolding?.avgPalletsPerSku,  25],
    ['tiHi',            !!profile.tiHi?.avgCasesPerPallet,           10],
    ['peak',            !!profile.peak?.peakFactor,                  10],
    ['volumes',         !!(profile.volumes?.annualOutboundUnits || profile.volumes?.onHandPallets), 15],
  ];
  const score = checks.reduce((s, [, ok, w]) => s + (ok ? w : 0), 0);
  const blocking = profile.dataGaps.filter(g => g.severity === 'error').map(g => g.message);
  const label = score >= 85 ? 'Design-ready' : score >= 50 ? 'Partial' : 'Sparse';
  return { score, blocking, label };
}
