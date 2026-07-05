/**
 * IES Hub v3 — WSC media-selection engine (N3, 2026-07-04)
 *
 * THE pivot of the re-founding: storage media becomes an ENGINEERED
 * CONCLUSION instead of a user-asserted mix. Consumes the DesignProfile
 * (N1) + pinned factor catalog (N2) and produces a mixed-media portfolio
 * with citable rationale per velocity/depth band.
 *
 * Chain per depth bucket:
 *   depth→media map (wsc.media.depth_to_media_map)
 *   → rotation constraint filter (FIFO policy)
 *   → Rule of 3 check on the bucket's ACTUAL avg depth (wsc.media.rule_of_3)
 *   → densest passing medium wins (fallback: selective)
 *   → positions = pallets ÷ occupancy target (85% selective / 75% deep-lane)
 *   → cost band (wsc.media.cost_per_position_usd)
 *
 * Sub-pallet SKUs (0 < depth < 1 plt — excluded from the pallet buckets)
 * route to carton shelving. Sparse profiles collapse to one pseudo-bucket
 * at avgPalletsPerSku, marked 'estimated'.
 *
 * Pure module — zero DOM, zero imports. Tested by test-wsc-media.mjs.
 *
 * @module tools/warehouse-sizing/media-calc
 */

import { wscFactorValue } from './factors-calc.js?v=20260704-n2a';

// ============================================================
// MEDIA DEFINITIONS — keys match wsc.media.depth_to_media_map exactly
// ============================================================

/**
 * fifoOk: medium can honestly serve strict-FIFO / lot-control rotation.
 *   Push-back CAN do FIFO with ≥3 lanes/SKU + oldest-part-lane discipline,
 *   but that's an ops commitment, not a default — marked false here.
 * costKey: band key inside wsc.media.cost_per_position_usd value_jsonb.
 * deepLane: subject to the Rule-of-3 + deep-lane occupancy floor.
 */
export const MEDIA_DEFS = {
  selective:      { label: 'Single-deep selective', family: 'selective',   laneDepth: 1,  fifoOk: true,  deepLane: false, costKey: 'selective' },
  double_deep:    { label: 'Double-deep',           family: 'double_deep', laneDepth: 2,  fifoOk: true,  deepLane: true,  costKey: 'selective', costNote: 'selective band + deep-reach truck premium not included' },
  pushback_2d:    { label: 'Push-back 2-deep',      family: 'pushback',    laneDepth: 2,  fifoOk: false, deepLane: true,  costKey: 'pushback' },
  pushback_2_3d:  { label: 'Push-back 2–3-deep',    family: 'pushback',    laneDepth: 3,  fifoOk: false, deepLane: true,  costKey: 'pushback' },
  pushback_3_4d:  { label: 'Push-back 3–4-deep',    family: 'pushback',    laneDepth: 4,  fifoOk: false, deepLane: true,  costKey: 'pushback' },
  pushback_4_5d:  { label: 'Push-back 4–5-deep',    family: 'pushback',    laneDepth: 5,  fifoOk: false, deepLane: true,  costKey: 'pushback' },
  pushback_6d:    { label: 'Push-back 6-deep',      family: 'pushback',    laneDepth: 6,  fifoOk: false, deepLane: true,  costKey: 'pushback' },
  drive_in_2d:    { label: 'Drive-in 2-deep',       family: 'drive_in',    laneDepth: 2,  fifoOk: false, deepLane: true,  costKey: 'drive_in' },
  drive_in_3d:    { label: 'Drive-in 3-deep',       family: 'drive_in',    laneDepth: 3,  fifoOk: false, deepLane: true,  costKey: 'drive_in' },
  drive_in_4_5d:  { label: 'Drive-in 4–5-deep',     family: 'drive_in',    laneDepth: 5,  fifoOk: false, deepLane: true,  costKey: 'drive_in' },
  drive_in_6d:    { label: 'Drive-in 6-deep',       family: 'drive_in',    laneDepth: 6,  fifoOk: false, deepLane: true,  costKey: 'drive_in' },
  flow_8d:        { label: 'Pallet flow 8-deep',    family: 'pallet_flow', laneDepth: 8,  fifoOk: true,  deepLane: true,  costKey: 'pallet_flow' },
  flow_12d:       { label: 'Pallet flow 12-deep',   family: 'pallet_flow', laneDepth: 12, fifoOk: true,  deepLane: true,  costKey: 'pallet_flow' },
  flow_20d:       { label: 'Pallet flow 20-deep',   family: 'pallet_flow', laneDepth: 20, fifoOk: true,  deepLane: true,  costKey: 'pallet_flow' },
  flow_24d:       { label: 'Pallet flow 24-deep',   family: 'pallet_flow', laneDepth: 24, fifoOk: true,  deepLane: true,  costKey: 'pallet_flow' },
};

/** Fallback map if the pinned catalog is unavailable — mirrors the N2 seed. */
export const FALLBACK_DEPTH_MAP = [
  { minPltPerSku: 1,  maxPltPerSku: 5,    media: ['selective'] },
  { minPltPerSku: 6,  maxPltPerSku: 8,    media: ['double_deep', 'pushback_2d'] },
  { minPltPerSku: 9,  maxPltPerSku: 14,   media: ['pushback_2_3d'] },
  { minPltPerSku: 15, maxPltPerSku: 23,   media: ['pushback_3_4d'] },
  { minPltPerSku: 24, maxPltPerSku: 35,   media: ['drive_in_2d', 'pushback_4_5d', 'flow_8d'] },
  { minPltPerSku: 36, maxPltPerSku: 47,   media: ['drive_in_3d', 'flow_12d'] },
  { minPltPerSku: 48, maxPltPerSku: 71,   media: ['drive_in_4_5d', 'flow_20d'] },
  { minPltPerSku: 72, maxPltPerSku: null, media: ['drive_in_6d', 'pushback_6d', 'flow_24d'] },
];

const DEFAULTS = {
  ruleOf3: 3,
  deepOccupancyPct: 75,
  selectiveOccupancyPct: 85,
  costBands: {
    selective: { min: 80, max: 120 }, drive_in: { min: 60, max: 110 },
    pushback: { min: 150, max: 400 }, pallet_flow: { min: 250, max: 500 },
  },
};

function _factor(pinned, code, fallback) {
  const v = wscFactorValue(pinned, code);
  return v == null ? fallback : v;
}

// ============================================================
// SELECTION
// ============================================================

/**
 * Pick the medium for one bucket.
 * @returns {{ key: string, def: Object, checks: string[] }} chosen + audit trail
 */
export function pickMedium({ avgDepth, candidates, ruleOf3, fifoStrict }) {
  const checks = [];
  const ranked = candidates
    .map(k => ({ key: k, def: MEDIA_DEFS[k] }))
    .filter(c => !!c.def)
    .sort((a, b) => b.def.laneDepth - a.def.laneDepth);   // densest first
  for (const c of ranked) {
    if (fifoStrict && !c.def.fifoOk) {
      checks.push(`${c.def.label}: rejected — LIFO medium under strict-FIFO policy`);
      continue;
    }
    if (c.def.deepLane && avgDepth < ruleOf3 * c.def.laneDepth) {
      checks.push(`${c.def.label}: rejected — Rule of 3 (${avgDepth.toFixed(1)} < ${ruleOf3}×${c.def.laneDepth})`);
      continue;
    }
    checks.push(`${c.def.label}: PASS${c.def.deepLane ? ` — Rule of 3 (${avgDepth.toFixed(1)} ≥ ${ruleOf3}×${c.def.laneDepth})` : ''}`);
    return { key: c.key, def: c.def, checks };
  }
  checks.push('Selective: fallback — no deep-lane candidate passed');
  return { key: 'selective', def: MEDIA_DEFS.selective, checks };
}

/**
 * Engineer a media portfolio from a DesignProfile + pinned factors.
 *
 * @param {Object} args
 * @param {import('./types.js').DesignProfile} args.profile
 * @param {{rows: Object[]}|null} [args.pinnedFactors] — N2 pin; falls back to seed defaults
 * @param {{ rotation?: 'none'|'fifo_strict' }} [args.policy]
 * @returns {Object|null} MediaPlan, or null if the profile can't support one
 */
export function selectMedia({ profile, pinnedFactors = null, policy = {} } = {}) {
  if (!profile) return null;
  const d = profile.depthOfHolding;
  if (!d || !(d.avgPalletsPerSku > 0)) return null;

  const fifoStrict = policy.rotation === 'fifo_strict';
  const ruleOf3 = Number(_factor(pinnedFactors, 'wsc.media.rule_of_3', DEFAULTS.ruleOf3));
  const deepOcc = Number(_factor(pinnedFactors, 'wsc.media.occupancy_floor_pct', DEFAULTS.deepOccupancyPct)) / 100;
  const selOcc = Number(_factor(pinnedFactors, 'wsc.media.selective_planning_occupancy_pct', DEFAULTS.selectiveOccupancyPct)) / 100;
  const depthMap = _factor(pinnedFactors, 'wsc.media.depth_to_media_map', FALLBACK_DEPTH_MAP);
  const costBands = _factor(pinnedFactors, 'wsc.media.cost_per_position_usd', DEFAULTS.costBands);
  const usedFallbackFactors = !pinnedFactors || !(pinnedFactors.rows || []).length;

  const mapRowFor = (avg) => (Array.isArray(depthMap) ? depthMap : FALLBACK_DEPTH_MAP)
    .find(r => avg >= r.minPltPerSku && (r.maxPltPerSku == null || avg <= r.maxPltPerSku)) || null;

  // ── Buckets: real distribution (data mode) or one pseudo-bucket (sparse) ──
  let buckets;
  let estimated = false;
  if (Array.isArray(d.distribution) && d.distribution.some(b => b.skuCount > 0)) {
    buckets = d.distribution.filter(b => b.skuCount > 0)
      .map(b => ({ bucket: b.bucket, skuCount: b.skuCount, pallets: b.pallets, avgDepth: b.pallets / b.skuCount }));
  } else {
    estimated = true;
    const skus = d.skusMeasured || profile.skuCount || 0;
    const pallets = profile.volumes?.onHandPallets ?? (skus * d.avgPalletsPerSku);
    if (!(pallets > 0)) return null;
    buckets = [{ bucket: `~${d.avgPalletsPerSku.toFixed(1)} avg (sparse)`, skuCount: skus, pallets, avgDepth: d.avgPalletsPerSku }];
  }

  // ── Per-bucket selection ──
  const bands = buckets.map(b => {
    const row = mapRowFor(b.avgDepth);
    const candidates = row ? row.media : ['selective'];
    const pick = pickMedium({ avgDepth: b.avgDepth, candidates, ruleOf3, fifoStrict });
    const occ = pick.def.deepLane ? deepOcc : selOcc;
    const positions = Math.ceil(b.pallets / occ);
    const band = costBands[pick.def.costKey] || DEFAULTS.costBands[pick.def.costKey] || { min: 0, max: 0 };
    return {
      bucket: b.bucket,
      skuCount: b.skuCount,
      pallets: Math.round(b.pallets * 100) / 100,
      avgDepth: Math.round(b.avgDepth * 100) / 100,
      media: pick.key,
      mediaLabel: pick.def.label,
      family: pick.def.family,
      laneDepth: pick.def.laneDepth,
      occupancyPct: Math.round(occ * 100),
      positions,
      costBand: { min: positions * band.min, max: positions * band.max },
      rationale: `${b.skuCount} SKU × ${b.avgDepth.toFixed(1)} avg plt/SKU → ${pick.def.label}` +
        `${pick.def.deepLane ? ` (Rule of 3: ${b.avgDepth.toFixed(1)} ≥ ${ruleOf3}×${pick.def.laneDepth})` : ''}` +
        ` · ${Math.round(occ * 100)}% occupancy → ${positions.toLocaleString()} positions` +
        `${fifoStrict ? ' · strict-FIFO constrained' : ''}${pick.def.costNote ? ` · ${pick.def.costNote}` : ''}`,
      checks: pick.checks,
      citations: ['wsc.media.depth_to_media_map']
        .concat(pick.def.deepLane ? ['wsc.media.rule_of_3', 'wsc.media.occupancy_floor_pct'] : ['wsc.media.selective_planning_occupancy_pct'])
        .concat(['wsc.media.cost_per_position_usd']),
    };
  });

  // ── Sub-pallet SKUs (data mode only) → carton shelving ──
  let shelving = null;
  if (!estimated && d.skusMeasured != null) {
    const bucketSkus = buckets.reduce((s, b) => s + b.skuCount, 0);
    const bucketPallets = buckets.reduce((s, b) => s + b.pallets, 0);
    const subSkus = Math.max(0, d.skusMeasured - bucketSkus);
    const subPallets = Math.max(0, (profile.volumes?.onHandPallets || bucketPallets) - bucketPallets);
    if (subSkus > 0) {
      shelving = {
        skuCount: subSkus,
        pallets: Math.round(subPallets * 100) / 100,
        rationale: `${subSkus} SKU hold <1 pallet each (${subPallets.toFixed(1)} plt-equivalent) → carton shelving / bin storage`,
      };
    }
  }

  // ── Aggregates ──
  const totals = {
    positions: bands.reduce((s, b) => s + b.positions, 0),
    pallets: Math.round(bands.reduce((s, b) => s + b.pallets, 0) * 100) / 100,
    costBand: {
      min: bands.reduce((s, b) => s + b.costBand.min, 0),
      max: bands.reduce((s, b) => s + b.costBand.max, 0),
    },
    mediaCount: new Set(bands.map(b => b.family)).size + (shelving ? 1 : 0),
  };

  const gaps = [];
  if (estimated) gaps.push({ code: 'MEDIA_FROM_SPARSE', severity: 'warn',
    message: 'Media plan built from a single average depth — upload an inventory snapshot for per-SKU banding.' });
  if (usedFallbackFactors) gaps.push({ code: 'FACTORS_UNPINNED', severity: 'info',
    message: 'Factor catalog not pinned yet — plan used seed defaults; save the scenario to pin.' });
  if (fifoStrict) gaps.push({ code: 'FIFO_CONSTRAINED', severity: 'info',
    message: 'Strict-FIFO policy excluded push-back and drive-in candidates.' });

  return {
    engine: 'wsc-media-v1',
    createdAt: new Date().toISOString().slice(0, 10),
    policy: { rotation: fifoStrict ? 'fifo_strict' : 'none' },
    provenance: estimated ? 'estimated' : 'derived',
    bands,
    shelving,
    totals,
    gaps,
    allocation: allocationBridge({ bands, shelving }, profile),
  };
}

// ============================================================
// BRIDGE — media plan → legacy storageAllocation mix
// ============================================================

/**
 * Collapse the portfolio into the existing engine's three-way mix.
 * fullPallet = pallet-media share (by pallets); cartonOnShelving =
 * sub-pallet share; cartonOnPallet = case-pick share of order lines
 * (data mode, capped) carved from fullPallet. Sums to exactly 100.
 *
 * @param {{ bands: Object[], shelving: Object|null }} plan
 * @param {import('./types.js').DesignProfile} profile
 * @returns {{ fullPallet: number, cartonOnPallet: number, cartonOnShelving: number, rationale: string }}
 */
export function allocationBridge(plan, profile) {
  const bandPallets = (plan.bands || []).reduce((s, b) => s + b.pallets, 0);
  const shelfPallets = plan.shelving?.pallets || 0;
  const total = bandPallets + shelfPallets;
  if (!(total > 0)) return { fullPallet: 100, cartonOnPallet: 0, cartonOnShelving: 0, rationale: 'No pallet signal — defaulted.' };

  let shelfPct = Math.round((shelfPallets / total) * 100);
  // Case-pick share: cases shipped as % of lines → carton-on-pallet forward pick,
  // capped at 35 so reserve never collapses.
  let casePct = 0;
  if (profile?.mode === 'data' && profile.volumes?.observedLines > 0) {
    // cube/case signal unavailable at this layer — use B-band line share as
    // the case-pick proxy, capped. Honest label: proxy, not measurement.
    const bPct = profile.velocityBands?.B?.linePct || 0;
    casePct = Math.min(35, Math.round(bPct));
  }
  let fullPct = 100 - shelfPct - casePct;
  if (fullPct < 0) { fullPct = 0; casePct = 100 - shelfPct; }
  return {
    fullPallet: fullPct,
    cartonOnPallet: casePct,
    cartonOnShelving: shelfPct,
    rationale: `Full-pallet ${fullPct}% (reserve pallets) · carton-on-pallet ${casePct}%` +
      ` (${casePct > 0 ? 'B-band line-share proxy, capped 35%' : 'no case-pick signal'})` +
      ` · shelving ${shelfPct}% (sub-pallet SKUs)`,
  };
}
