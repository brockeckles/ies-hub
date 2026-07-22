// test-wsc-3d-hotspots.mjs — Concept-B on-model hotspots (2026-07-22).
//
// The last graft from Brock's 2026-07-15 blend ruling: engineered figures
// float ON the 3D model as clickable chips, each opening its W3 inspector
// derivation chain. Locks:
//   1. Pure hotspot list — one chip per rail cell WITH an inspector chain
//      (positions/storageSf/doors/clearHt/sizedSf), values formatted from
//      the sized output, anchors inside the building envelope, dock chip
//      on the dock face (+Z), empty/blank designs → no chips.
//   2. The wiring trick — chips carry data-wsw-cell so the EXISTING
//      shell-w capture delegation + inspector selection refresh work on
//      them with zero new event wiring.
//   3. ui-3d integration — layer div rendered, projection hooked into the
//      animate loop, Hotspots toggle follows the Walls/Roof/HUD pattern,
//      chips are interactive while the layer is click-through.

import { readFileSync } from 'node:fs';
import { buildHotspots } from './tools/warehouse-sizing/hotspot-calc.js';
import { sizeFacility, formStateToInputs } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Fixture: a real sized design (dims in scene units, scale-agnostic) ──
const sized = sizeFacility(formStateToInputs({
  facility: { totalSqft: 100000, sizingMode: 'design', clearHeight: 32 },
  zones: {
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    dockConfig: { inboundDoors: 3, outboundDoors: 3 },
  },
  volumes: { totalPallets: 9000, avgDailyInbound: 400, avgDailyOutbound: 400, daysOnHand: 30 },
}));
const DIMS = { W: 40, D: 26, H: 3.2, rackTop: 2.4 };

// ── 1. Pure list ──
{
  const hs = buildHotspots({ sized, facility: { clearHeight: 32 }, dims: DIMS });
  t('five chips for a fully-sized design',
    hs.length === 5, `got ${hs.length}: ${hs.map(h => h.cell).join(',')}`);
  const cells = hs.map(h => h.cell);
  for (const c of ['positions', 'storageSf', 'doors', 'clearHt', 'sizedSf']) {
    t(`cell ${c} present (has an inspector chain)`, cells.includes(c));
  }
  t('utilization deliberately absent (no model anchor)', !cells.includes('utilization'));
  const pos = hs.find(h => h.cell === 'positions');
  t('positions value formatted from sized',
    pos.value === Math.round(sized.positions.grossPositions).toLocaleString() + ' pos',
    `got "${pos.value}"`);
  const clear = hs.find(h => h.cell === 'clearHt');
  t('clear height reads the facility', clear.value === '32 ft', `got "${clear.value}"`);
  const dock = hs.find(h => h.cell === 'doors');
  t('dock chip anchors ON the dock face (+Z, WSC long-edge convention)',
    dock.anchor.z === DIMS.D / 2, `got z=${dock.anchor.z}`);
  for (const h of hs) {
    const ok = Math.abs(h.anchor.x) <= DIMS.W / 2 && h.anchor.y >= 0
      && h.anchor.y <= DIMS.H * 1.1 && Math.abs(h.anchor.z) <= DIMS.D / 2;
    t(`anchor for ${h.cell} inside the envelope`, ok, JSON.stringify(h.anchor));
  }
}

// ── 2. Degenerate inputs ──
{
  t('no sized → no chips', buildHotspots({ sized: null, dims: DIMS }).length === 0);
  t('no dims → no chips', buildHotspots({ sized }).length === 0);
  const blank = buildHotspots({ sized: { positions: {}, dock: {} }, facility: {}, dims: DIMS });
  t('blank design → no chips (nothing to defend)', blank.length === 0, `got ${blank.length}`);
}

// ── 3. Source pins — the wiring trick + integration ──
{
  const ui3d = readFileSync(new URL('./tools/warehouse-sizing/ui-3d.js', import.meta.url), 'utf8');
  t('ui-3d imports hotspot-calc with a cache-bust pin',
    /from '\.\/hotspot-calc\.js\?v=[\w.-]+'/.test(ui3d));
  t('hotspot layer rendered inside the 3D container',
    ui3d.includes('id="wsc-3d-hotspots"'));
  t('chips carry data-wsw-cell — the shell-w inspector delegation contract',
    /data-wsw-cell="\$\{s\.cell\}"/.test(ui3d));
  t('projection hooked into the animate loop',
    /if \(_projectHotspots\) _projectHotspots\(\);\s*\n\s*renderer\.render\(scene, camera\);/.test(ui3d));
  t('behind-camera chips hide, never mirror',
    ui3d.includes('_pv.z > 1'));
  t('Hotspots toggle follows the Walls/Roof/HUD pattern',
    ui3d.includes("kind === 'hotspots'") && ui3d.includes('_wscShowHotspots'));
  t('toggle state honored across scene rebuilds',
    /hsLayer\.style\.display = _wscShowHotspots \? '' : 'none';/.test(ui3d));

  const evSrc = readFileSync(new URL('./tools/warehouse-sizing/ui-shell-events.js', import.meta.url), 'utf8');
  t('capture delegation still routes [data-wsw-cell] → inspector (chips ride it)',
    evSrc.includes("closest('[data-wsw-cell]')") && evSrc.includes('setWswCell'));

  const css = readFileSync(new URL('./tools/warehouse-sizing/ui-styles.js', import.meta.url), 'utf8');
  t('layer is click-through, chips are interactive',
    /\.wsc-3d-hs-layer \{[^}]*pointer-events: none/.test(css)
    && /\.wsc-3d-hs \{[^}]*pointer-events: auto/s.test(css));
  t('selection sync styled via the shared wsw-krow--sel class',
    css.includes('.wsc-3d-hs.wsw-krow--sel'));
  t('hotspot dot is flex:none (fixed-size-in-flex class)',
    /\.wsc-3d-hs__dot \{[^}]*flex: none/s.test(css));
}

console.log(`\ntest-wsc-3d-hotspots: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
