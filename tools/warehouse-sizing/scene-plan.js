/**
 * IES Hub v3 — WSC 3D scene plan (N7 slice A/B/C, 2026-07-05)
 *
 * Pure translation layer: the engineered design (media plan N3, dynamics
 * plan N4, sized engine output) → a declarative scene spec the 3D renderer
 * (ui-3d.js) can place without doing any engineering math of its own.
 *
 *   runs[]    — one per storage medium, in placement order (deep lanes
 *               first, selective last, shelving at the end). Each run
 *               carries laneDepth, target positions, levels, and which
 *               aisle band serves it.
 *   aisles    — storage aisle from the dynamics plan's governing MHE
 *               assumption (falls back to facility.aisleWidth, then 12 ft
 *               legacy default); pick aisle for shelving runs.
 *   staging   — dwell-derived sqft from the dynamics plan (falls back to
 *               configured zone sqft, then the legacy 30 ft strip).
 *   recon     — required pallet positions (media plan) for the renderer's
 *               ghost-rack shortfall pass; provided is filled in by the
 *               placer after it walks the floor.
 *
 * When there is no media plan the spec degrades to source:'legacy' and
 * ui-3d.js keeps its pre-N7 fullPallet/cartonPallet/shelving path — old
 * scenarios render exactly as before.
 *
 * Pure module — zero DOM, zero THREE. Tested by test-wsc-scene-plan.mjs.
 *
 * @module tools/warehouse-sizing/scene-plan
 */

import { MEDIA_DEFS } from './media-calc.js?v=20260704-n3a';

/**
 * Visual identity per media family. Colors chosen to stay readable at 18%
 * opacity against the concrete floor and to keep the legacy orange/amber/
 * teal trio for selective / carton / shelving so long-time users aren't
 * re-learning the palette.
 */
export const FAMILY_STYLE = {
  selective:   { color: 0xea580c, label: 'Selective' },
  double_deep: { color: 0x7c3aed, label: 'Double-deep' },
  pushback:    { color: 0x2563eb, label: 'Push-back' },
  drive_in:    { color: 0x475569, label: 'Drive-in' },
  pallet_flow: { color: 0x16a34a, label: 'Pallet flow' },
  cartonPallet:{ color: 0xf59e0b, label: 'Carton on pallet' },
  shelving:    { color: 0x0d9488, label: 'Shelving' },
};

/**
 * Deep-lane media rarely run full building height — push-back rails and
 * flow lanes are practically capped ~4 load levels in most ambient DCs.
 * Visualization assumption only (the position math upstream in media-calc
 * already accounted for occupancy; this just keeps the render honest-looking).
 */
const DEEP_LANE_MAX_LEVELS = 4;

/** Positions on one rack face of one segment: bays × levels × laneDepth. */
export function positionsPerFaceSegment({ segLenFt, bayWidthFt = 4.33, levels = 5, laneDepth = 1 }) {
  const bays = Math.floor(Math.max(0, segLenFt) / (bayWidthFt || 4.33));
  return bays * Math.max(1, levels) * Math.max(1, laneDepth);
}

/**
 * @param {Object} args
 * @param {Object|null} args.mediaPlan   — N3 MediaPlan (config_data.mediaPlan)
 * @param {Object|null} args.dynamicsPlan — N4 DynamicsPlan
 * @param {Object|null} args.sized       — calc.sizeFacility output
 * @param {Object} args.facility
 * @param {Object} args.zones
 * @returns {ScenePlan}
 */
export function buildScenePlan({ mediaPlan = null, dynamicsPlan = null, sized = null, facility = {}, zones = {} } = {}) {
  // ── Aisles (slice B) ──
  // Governing storage aisle: dynamics preview beats the applied facility
  // value so the 3D view reflects the engineered aisle even before Apply.
  const govFt = Number(dynamicsPlan?.mhe?.governingAisleFt);
  const facFt = Number(facility.aisleWidth);
  const storageFt = govFt > 0 ? govFt : (facFt > 0 ? facFt : 12);
  const opFleet = dynamicsPlan?.mhe?.fleet?.find(f => f.type === 'order_picker');
  const pickFt = Number(opFleet?.aisleFt) > 0 ? Number(opFleet.aisleFt) : 4.5;
  const aisles = {
    storageFt, pickFt,
    source: govFt > 0 ? 'dynamics' : (facFt > 0 ? 'facility' : 'default'),
  };

  // ── Staging (slice B) ──
  const dynIn = Number(dynamicsPlan?.staging?.inbound?.sqft);
  const dynOut = Number(dynamicsPlan?.staging?.outbound?.sqft);
  const cfgIn = Number(zones.receiveStagingSqft);
  const cfgOut = Number(zones.shipStagingSqft);
  const staging = dynIn > 0 || dynOut > 0
    ? { inboundSqft: dynIn || 0, outboundSqft: dynOut || 0, source: 'dynamics' }
    : (cfgIn > 0 || cfgOut > 0
      ? { inboundSqft: cfgIn || 0, outboundSqft: cfgOut || 0, source: 'configured' }
      : { inboundSqft: 0, outboundSqft: 0, source: 'default' });

  const palletLevels = Number(sized?.rackLevels) || 5;
  const shelvingLevels = Number(sized?.shelfLevels) || 5;

  // ── No media plan → legacy spec (renderer keeps pre-N7 path) ──
  if (!mediaPlan?.bands?.length) {
    return {
      source: 'legacy', aisles, staging, runs: [],
      recon: { requiredPositions: 0 },
    };
  }

  // ── Media runs (slice A) ──
  // Merge bands that picked the same medium (several depth buckets can land
  // on one media key); order deep-lanes-first so dense reserve storage sits
  // together and selective ends up nearest the pick/shelving edge.
  const byMedia = new Map();
  for (const b of mediaPlan.bands) {
    const key = b.media || 'selective';
    const def = MEDIA_DEFS[key] || MEDIA_DEFS.selective;
    const cur = byMedia.get(key) || {
      key, family: b.family || def.family, label: b.mediaLabel || def.label,
      laneDepth: Number(b.laneDepth) || def.laneDepth || 1,
      // Honest fill: positions are gross (pallets ÷ occupancy), so rendering
      // occupancy% of positions occupied shows exactly the engineered slack.
      fillPct: Number(b.occupancyPct) > 0 ? Number(b.occupancyPct) / 100 : (def.deepLane ? 0.75 : 0.85),
      targetPositions: 0, buckets: [],
    };
    cur.targetPositions += Number(b.positions) || 0;
    cur.buckets.push(b.bucket);
    byMedia.set(key, cur);
  }
  const runs = [...byMedia.values()]
    .sort((a, b) => b.laneDepth - a.laneDepth)
    .map(r => ({
      ...r,
      kind: 'pallet',
      levels: (MEDIA_DEFS[r.key]?.deepLane && r.family !== 'double_deep')
        ? Math.min(palletLevels, DEEP_LANE_MAX_LEVELS)
        : palletLevels,
      aisleFt: storageFt,
      style: FAMILY_STYLE[r.family] || FAMILY_STYLE.selective,
    }));

  // Shelving run: sub-pallet SKUs (media plan) sized by the engine's
  // shelving-location math — target = engine locations, not pallets.
  const shelvingTarget = Number(sized?.positions?.shelvingGrossPositions)
    || Number(sized?.locations?.shelving?.locationsRequired) || 0;
  if (mediaPlan.shelving && shelvingTarget > 0) {
    runs.push({
      key: 'shelving', family: 'shelving', label: 'Carton shelving',
      laneDepth: 1, targetPositions: shelvingTarget, buckets: ['<1 plt/SKU'],
      kind: 'shelving', levels: shelvingLevels, aisleFt: pickFt, fillPct: 0.85,
      style: FAMILY_STYLE.shelving,
    });
  }

  return {
    source: 'media', aisles, staging, runs,
    recon: {
      // Slice C: pallet positions the media plan requires — renderer compares
      // against what it managed to place on the floor and ghosts the balance.
      requiredPositions: Number(mediaPlan.totals?.positions) || runs
        .filter(r => r.kind === 'pallet')
        .reduce((s, r) => s + r.targetPositions, 0),
    },
  };
}
