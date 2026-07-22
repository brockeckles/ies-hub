/**
 * IES Hub v3 — WSC 3D Hotspots (Concept B graft, 2026-07-22)
 *
 * The last piece of Brock's 2026-07-15 blend ruling: Concept A's chassis
 * shipped as shell-w (W0–W7); Concept C became Review mode; Concept B's
 * "engineered numbers as clickable hotspots ON the model" was parked for
 * the post-flip Building canvas. This module is that graft.
 *
 * Pure: derives the hotspot list — which engineered figures float over the
 * 3D scene, what they say, and WHERE they anchor in scene units — from the
 * sized output + scene dims. No DOM, no THREE. ui-3d.js owns projection
 * (world → screen each frame) and the chip DOM.
 *
 * THE WIRING TRICK (W2 hosting-contract lineage): each chip carries
 * `data-wsw-cell="<rail cell>"` — the SAME attribute the shell-w rail rows
 * use — so the EXISTING bound-once capture delegation in ui-shell-events
 * routes a chip click straight into the W3 inspector (setWswCell →
 * derivation chain), and the inspector's selection refresh toggles the
 * same selected class on the chip. Zero new event wiring.
 *
 * Anchor space: the ui-3d scene — building centered at origin, X spans the
 * long edge (±W/2), Z the short edge (±D/2, dock face at +Z), Y up, all in
 * SCALED scene units (callers pass W/D/H/rackTop already scaled).
 *
 * Cells are limited to the rail cells that HAVE inspector chains
 * (rail-inspector.js): positions · storageSf · sizedSf · doors · clearHt.
 * Utilization is deliberately skipped — it has no natural point on the
 * model to anchor to.
 *
 * @module tools/warehouse-sizing/hotspot-calc
 */

const _n = (v) => Math.round(Number(v) || 0).toLocaleString();

/**
 * @param {Object} args
 * @param {Object} args.sized — calc.sizeFacility output
 * @param {Object} [args.facility] — WSC facility (clearHeight)
 * @param {{W:number, D:number, H:number, rackTop?:number}} args.dims —
 *   scene-unit building envelope (+ optional top-of-steel height)
 * @returns {Array<{cell:string, label:string, value:string, anchor:{x:number,y:number,z:number}}>}
 */
export function buildHotspots({ sized, facility = {}, dims } = {}) {
  if (!sized || !dims || !(dims.W > 0) || !(dims.D > 0) || !(dims.H > 0)) return [];
  const { W, D, H } = dims;
  const rackTop = dims.rackTop > 0 ? Math.min(dims.rackTop, H) : H * 0.6;

  const hotspots = [];

  // Gross positions — floats just above the rack field, left-of-center so
  // it doesn't fight the HUD (top-right) or the dock chip (front).
  const gross = sized.positions?.grossPositions || 0;
  if (gross > 0) {
    hotspots.push({
      cell: 'positions', label: 'Positions', value: _n(gross) + ' pos',
      anchor: { x: -W * 0.18, y: rackTop * 1.08, z: -D * 0.05 },
    });
  }

  // Storage SF — on the floor plane inside the storage zone.
  if (sized.storageSqft > 0) {
    hotspots.push({
      cell: 'storageSf', label: 'Storage', value: _n(sized.storageSqft) + ' SF',
      anchor: { x: W * 0.22, y: H * 0.12, z: -D * 0.18 },
    });
  }

  // Dock doors — centered on the dock face (+Z long edge, WSC convention).
  const doors = sized.dock?.totalDoors || 0;
  if (doors > 0) {
    hotspots.push({
      cell: 'doors', label: 'Dock doors', value: _n(doors),
      anchor: { x: 0, y: H * 0.28, z: D / 2 },
    });
  }

  // Clear height — at the top of the west wall, where the dimension reads.
  const clearFt = Number(facility.clearHeight) || 0;
  if (clearFt > 0) {
    hotspots.push({
      cell: 'clearHt', label: 'Clear height', value: clearFt + ' ft',
      anchor: { x: -W * 0.48, y: H * 0.98, z: 0 },
    });
  }

  // Sized total — pinned at the far back corner of the footprint.
  if (sized.totalSqft > 0) {
    hotspots.push({
      cell: 'sizedSf', label: 'Sized total', value: _n(sized.totalSqft) + ' SF',
      anchor: { x: W * 0.44, y: H * 0.08, z: -D * 0.44 },
    });
  }

  return hotspots;
}
