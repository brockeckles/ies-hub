/**
 * IES Hub v3 — Warehouse Sizing — 3D View (extracted from ui.js 2026-05-13)
 *
 * Owns the Three.js 3D walkthrough: scene build, camera, lighting, walls,
 * floor, rack instancing, FP, dock stripe, achievements HUD. Plus the
 * wall-visibility toggle and floor-texture generator.
 *
 * Extraction note: `scene3d` and `_wscShowWalls` are module-local here
 * (previously module-state in ui.js). ui.js calls `disposeScene3d()` from
 * its unmount + view-switch paths. All other outer-scope reads (facility,
 * zones, volumes, rootEl) come in via the `ctx` arg on render3DView.
 *
 * @module tools/warehouse-sizing/ui-3d
 */

import * as calc from './calc.js?v=20260722-s2';
import { buildScenePlan, positionsPerFaceSegment } from './scene-plan.js?v=20260705-n7a';
import { buildHotspots } from './hotspot-calc.js?v=20260722-h1';

// P3-1: single-live window.mouseup for the no-OrbitControls drag fallback
let _wsc3dPrevMouseUp = null;

// ============================================================
// MODULE-LOCAL 3D STATE
// ============================================================

/** @type {{ dispose?: () => void } | null} */
let scene3d = null;

/** Phase F.12 — 3D wall visibility toggle. Persists between scene rebuilds. */
let _wscShowWalls = true;
// Phase B.B22 (2026-05-26) — Roof-Off toggle. Conceptually separate from
// "Hide Walls" — Roof-Off keeps the walls but drops the apex line + any
// future ceiling geometry so a high-angle camera can see rack tops without
// the visual clutter of an overhead beam. Default ON.
let _wscShowRoof = true;
// Phase B (2026-05-26 evening) — Show/Hide the achieved-vs-target HUD
// table that overlays the top-right of the 3D canvas. Some users want
// an unobstructed view of the rendered layout for screenshots / demos.
// Default ON; toggle button in the View: row alongside Walls / Roof.
let _wscShowHud = true;
// Concept-B hotspots (2026-07-22) — engineered figures floating ON the
// model, each opening its W3 inspector chain. Default ON; toggle persists
// across scene rebuilds like Walls/Roof/HUD.
let _wscShowHotspots = true;

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Dispose any active 3D scene + null the reference. Called by ui.js on
 * unmount and when switching away from the 3D view.
 */
export function disposeScene3d() {
  if (scene3d?.dispose) {
    try { scene3d.dispose(); } catch (_) {}
  }
  scene3d = null;
}


export function render3DView(container, ctx) {
  // Dispose prior scene before clobbering DOM, so re-renders triggered by
  // data-field commits don't leak WebGL contexts or leave the old animate
  // loop spinning against a detached canvas. (Was a latent leak; surfaced
  // by the P0-2 HUD work because the HUD is recomputed on every rebuild.)
  if (scene3d) {
    try { scene3d.dispose(); } catch (_) {}
    scene3d = null;
  }
  const sized = calc.sizeFacility(ctx.toSizingInputs());
  // Phase A: header dims read from mode-aware facility shape so they match
  // the rendered geometry (Design = sized footprint; Constraint = user W×D).
  const _hdrFac = ctx.renderFacility(ctx.facility, sized);
  container.innerHTML = `
    <div class="hub-card" style="padding:16px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
        <h3 class="text-subtitle u-m0">3D Walkthrough</h3>
        <span class="text-caption text-muted">
          ${calc.formatSqft(sized.totalSqft)} sized  ·  ${_hdrFac.buildingWidth || '—'} × ${_hdrFac.buildingDepth || '—'} ft  ·  clear ht ${ctx.facility.clearHeight || 0} ft  ·  ${sized.dock.totalDoors} dock doors
        </span>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;flex-wrap:wrap;">
        <span class="text-caption text-muted" style="margin-right:4px;">View:</span>
        <button type="button" class="hub-btn hub-btn-sm ${_wscShowWalls ? '' : 'hub-btn--ghost'}" data-3d-toggle="walls" title="Toggle facility walls. Hide them to see inside the building more clearly.">
          ${_wscShowWalls ? 'Hide Walls' : 'Show Walls'}
        </button>
        <button type="button" class="hub-btn hub-btn-sm ${_wscShowRoof ? '' : 'hub-btn--ghost'}" data-3d-toggle="roof" title="Toggle the roof apex line. Off lets a high-angle camera see rack tops without the overhead beam in the way.">
          ${_wscShowRoof ? 'Hide Roof' : 'Show Roof'}
        </button>
        <button type="button" class="hub-btn hub-btn-sm ${_wscShowHud ? '' : 'hub-btn--ghost'}" data-3d-toggle="hud" title="Toggle the achieved-vs-target HUD table that overlays the top-right of the 3D canvas. Hide for a clean view of the rendered layout.">
          ${_wscShowHud ? 'Hide HUD' : 'Show HUD'}
        </button>
        <button type="button" class="hub-btn hub-btn-sm ${_wscShowHotspots ? '' : 'hub-btn--ghost'}" data-3d-toggle="hotspots" title="Toggle the engineered-figure hotspots anchored to the model. Click a hotspot to open that figure's derivation chain in the inspector.">
          ${_wscShowHotspots ? 'Hide Hotspots' : 'Show Hotspots'}
        </button>
        <!-- Phase A.A5 (2026-05-26) — Camera presets. Click tweens the
             camera+target via cubic ease-out. OrbitControls take over again
             once the tween completes. -->
        <span class="text-caption text-muted" style="margin-left:8px;margin-right:2px;">Camera:</span>
        <button type="button" class="hub-btn hub-btn-sm hub-btn--ghost" data-3d-camera="overview" title="Iso-style front-left-above view (default)">Overview</button>
        <button type="button" class="hub-btn hub-btn-sm hub-btn--ghost" data-3d-camera="iso-right" title="Iso-style front-right-above view">Iso ↻</button>
        <button type="button" class="hub-btn hub-btn-sm hub-btn--ghost" data-3d-camera="aisle" title="Eye-level inside the building looking down the long aisle">Aisle</button>
        <button type="button" class="hub-btn hub-btn-sm hub-btn--ghost" data-3d-camera="dock" title="Outside the dock face looking toward the building">Dock</button>
        <button type="button" class="hub-btn hub-btn-sm hub-btn--ghost" data-3d-camera="topdown" title="Bird's-eye plan view from straight above">Top-Down</button>
      </div>
      <div id="wsc-3d-container" style="position:relative; width:100%; height:520px; background:#e9eef5; border-radius:6px; overflow:hidden;">
        <div id="wsc-3d-hud" class="wsc-3d-hud" aria-live="polite"></div>
        <!-- Concept-B hotspots (2026-07-22): chips projected from 3D anchors
             each frame; layer is click-through, the chips are not. -->
        <div id="wsc-3d-hotspots" class="wsc-3d-hs-layer"></div>
      </div>
      <div style="font-size:11px; color:var(--ies-gray-500); margin-top:8px;">
        Drag to orbit  ·  Scroll to zoom  ·  Racks shown at 50% opacity for floor visibility  ·  HUD shows achieved vs sized target
      </div>
    </div>
  `;
  // Phase F.12 (2026-05-06) — wire wall-visibility toggle. We don't rebuild
  // the scene; just walk for the wallsGroup and flip its `visible` flag.
  // State persists in `_wscShowWalls` so future scene rebuilds (mode/FP
  // toggles etc.) honor it.
  // Phase B.B22 (2026-05-26) — generic data-3d-toggle delegation. Handles
  // both walls (legacy) + roof (new) by mapping the toggle key to a module
  // state var + a userData marker on the scene group to traverse.
  // 2026-06-10 (assessment WSC #1): #wsc-content survives every
  // renderContentView, but render3DView previously added these two click
  // listeners on EVERY invocation — each config keystroke in 3D view stacked
  // another pair, and with an even count the Walls/Roof/HUD toggles visibly
  // did nothing. Same idempotent-bind discipline as ui-shell-events.
  if (!container.__wsc3dToggleBound) {
  container.__wsc3dToggleBound = true;
  container.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-3d-toggle]');
    if (!btn) return;
    const kind = btn.getAttribute('data-3d-toggle');
    const cont = container.querySelector('#wsc-3d-container');
    const sc = cont && cont.__wscScene;
    if (kind === 'walls') {
      _wscShowWalls = !_wscShowWalls;
      if (sc) sc.traverse((obj) => { if (obj.userData?.isFacilityWalls) obj.visible = _wscShowWalls; });
      btn.textContent = _wscShowWalls ? 'Hide Walls' : 'Show Walls';
      btn.classList.toggle('hub-btn--ghost', !_wscShowWalls);
    } else if (kind === 'roof') {
      _wscShowRoof = !_wscShowRoof;
      if (sc) sc.traverse((obj) => { if (obj.userData?.isFacilityRoof) obj.visible = _wscShowRoof; });
      btn.textContent = _wscShowRoof ? 'Hide Roof' : 'Show Roof';
      btn.classList.toggle('hub-btn--ghost', !_wscShowRoof);
    } else if (kind === 'hud') {
      _wscShowHud = !_wscShowHud;
      const hudEl = container.querySelector('#wsc-3d-hud');
      if (hudEl) hudEl.style.display = _wscShowHud ? '' : 'none';
      btn.textContent = _wscShowHud ? 'Hide HUD' : 'Show HUD';
      btn.classList.toggle('hub-btn--ghost', !_wscShowHud);
    } else if (kind === 'hotspots') {
      _wscShowHotspots = !_wscShowHotspots;
      const hsEl = container.querySelector('#wsc-3d-hotspots');
      if (hsEl) hsEl.style.display = _wscShowHotspots ? '' : 'none';
      btn.textContent = _wscShowHotspots ? 'Hide Hotspots' : 'Show Hotspots';
      btn.classList.toggle('hub-btn--ghost', !_wscShowHotspots);
    }
  });

  // Phase A.A5 (2026-05-26) — preset click delegation. The actual tween
  // function lives inside build3DScene's closure (where the camera +
  // controls are scoped); we reach it via the cached el.__wsc3d hook that
  // build3DScene populates on the container element.
  container.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-3d-camera]');
    // (second listener of the idempotent-bound pair — see guard above)
    if (!btn) return;
    const preset = btn.getAttribute('data-3d-camera');
    const cont = container.querySelector('#wsc-3d-container');
    const handle = cont && cont.__wsc3d;
    if (handle && typeof handle.tweenTo === 'function') handle.tweenTo(preset);
  });
  } // end __wsc3dToggleBound idempotent-bind guard

  // Defer 3D scene build so the flex layout settles first.
  setTimeout(() => build3DScene(ctx), 80);
}

/**
 * Render the achieved-vs-target HUD overlay shown in the top-right corner of
 * the 3D canvas. P0-2 from the 2026-05-04 WSC deep audit (Lens I — data
 * fidelity). `facts` is the output of calc.rollupRenderedFacts(); the second
 * arg is the per-type rack-level context so the HUD can show "5 lvls" etc.
 */
function renderRenderedFactsHud(facts, ctx = {}) {
  if (!facts) return '';
  const { byType = {}, totalPositions = 0, totalColumns = 0, totalSegments = 0, targets = {}, deltaPct = 0, status = 'on_target' } = facts;
  const palletLv = +ctx.palletLevels || 0;
  const shelvLv  = +ctx.shelvingLevels || 0;

  const fmt = (n) => (Number(n) || 0).toLocaleString();
  const fmtDelta = (d) => {
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}%`;
  };
  // Phase F.2 (2026-05-05) — mode-aware status copy. In Design mode the
  // rack zone pads to fill the engineered footprint (Phase F.1 fillMode
  // 'fill'), so "over-built" mis-frames an intentional design choice.
  // Reframe as "Padded to fill footprint" with a neutral status chip.
  const _hudMode = ctx.sizingMode || 'design';
  const statusLabel = status === 'on_target' ? 'On target (within 5%)'
    : status === 'under_built' ? 'Under-built — footprint too small'
    : (_hudMode === 'design' ? 'Padded to fill footprint' : 'Over-built — building above sized need');
  const statusClass = status === 'on_target' ? 'wsc-3d-hud-status--on'
    : status === 'under_built' ? 'wsc-3d-hud-status--under'
    : (_hudMode === 'design' ? 'wsc-3d-hud-status--on' : 'wsc-3d-hud-status--over');

  const rowFor = (label, key, levelsLabel) => {
    const b = byType[key] || { columns: 0, positions: 0 };
    const tgt = targets[key] || 0;
    const tgtTxt = tgt > 0 ? ` / ${fmt(tgt)}` : '';
    return `
      <div class="wsc-3d-hud-row">
        <span>${label}${levelsLabel ? ` <span class="wsc-3d-hud-meta" style="display:inline">(${levelsLabel})</span>` : ''}</span>
        <span>${fmt(b.positions)}${tgtTxt}</span>
      </div>`;
  };

  // Phase 2 redesign — surface shelving demand-bound vs sku-bound mode tag
  // + cartons-per-pallet + cartons-per-shelf when sized is passed in.
  const sized = ctx.sized || null;
  const shelvingDetail = (() => {
    if (!sized?.locations?.shelving) return '';
    const sh = sized.locations.shelving;
    const cp = sized.cartonProfile || {};
    const modeColor = sh.mode === 'sku-bound'
      ? 'color:#fb923c;'
      : sh.mode === 'demand-bound'
      ? 'color:#34d399;'
      : 'color:#94a3b8;';
    return `
      <div class="wsc-3d-hud-divider"></div>
      <div class="wsc-3d-hud-meta" style="font-weight:700;color:#e2e8f0;letter-spacing:.04em;text-transform:uppercase;font-size:9.5px;margin-bottom:2px;">Shelving detail</div>
      <div class="wsc-3d-hud-row"><span>Mode</span><strong style="${modeColor}">${sh.mode}</strong></div>
      <div class="wsc-3d-hud-row"><span>Locations required</span><strong>${fmt(sh.locationsRequired)}</strong></div>
      <div class="wsc-3d-hud-row"><span>Demand · SKU floor</span><strong>${fmt(sh.demandLocations)} · ${fmt(sh.skuMinLocations)}</strong></div>
      ${cp.cartonsPerPallet ? `<div class="wsc-3d-hud-row"><span>Cartons/pallet · /shelf</span><strong>${fmt(cp.cartonsPerPallet)} · ${fmt(cp.cartonsPerShelf)}</strong></div>` : ''}
    `;
  })();

  return `
    <div class="wsc-3d-hud-title">Achieved · live</div>
    <div class="wsc-3d-hud-row"><span>Total positions</span><strong>${fmt(totalPositions)}${targets.total > 0 ? ` / ${fmt(targets.total)}` : ''}</strong></div>
    ${targets.total > 0 ? `<div class="wsc-3d-hud-row"><span>Delta</span><strong>${fmtDelta(deltaPct)}</strong></div>` : ''}
    <div class="wsc-3d-hud-divider"></div>
    ${rowFor('Full pallet', 'fullPallet', palletLv ? `${palletLv} lvls` : '')}
    ${rowFor('Carton on pallet', 'cartonPallet', palletLv ? `${palletLv} lvls` : '')}
    ${rowFor('Shelving', 'shelving', shelvLv ? `${shelvLv} lvls` : '')}
    ${shelvingDetail}
    <div class="wsc-3d-hud-divider"></div>
    <div class="wsc-3d-hud-meta">${fmt(totalColumns)} rack pairs &middot; ${fmt(totalSegments)} segments</div>
    ${targets.total > 0 ? `<div class="wsc-3d-hud-status ${statusClass}">${statusLabel}</div>` : ''}
  `;
}

/**
 * N7 — media-mode HUD. One row per engineered run (placed / target),
 * aisle + staging provenance lines, and a SHORT banner when the floor
 * couldn't absorb the media plan (pairs with the red ghost columns).
 */
function renderMediaFactsHud({ runs = [], required = 0, shortfall = 0, aisles = {}, staging = {} } = {}) {
  const fmt = (n) => (Number(n) || 0).toLocaleString();
  const placedTotal = runs.filter(r => r.kind === 'pallet').reduce((s, r) => s + r.placed, 0);
  const rows = runs.map(r => `
    <div class="wsc-3d-hud-row">
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.labelColor};margin-right:5px;"></span>${r.label} <span class="wsc-3d-hud-meta" style="display:inline">(${r.levels} lvl${r.laneDepth > 1 ? ` · ${r.laneDepth}-deep` : ''})</span></span>
      <span>${fmt(r.placed)}${r.target ? ` / ${fmt(r.target)}` : ''}</span>
    </div>`).join('');
  const statusHtml = shortfall > 0
    ? `<div class="wsc-3d-hud-status wsc-3d-hud-status--under">SHORT ${fmt(shortfall)} positions — building can't absorb the media plan</div>`
    : `<div class="wsc-3d-hud-status wsc-3d-hud-status--on">Media plan placed in full</div>`;
  return `
    <div class="wsc-3d-hud-title">Engineered media · live</div>
    <div class="wsc-3d-hud-row"><span>Pallet positions</span><strong>${fmt(placedTotal)}${required > 0 ? ` / ${fmt(required)}` : ''}</strong></div>
    <div class="wsc-3d-hud-divider"></div>
    ${rows}
    <div class="wsc-3d-hud-divider"></div>
    <div class="wsc-3d-hud-meta">Aisle ${aisles.storageFt} ft (${aisles.source}) · staging ${aisles.stagingNote || staging.source}</div>
    ${statusHtml}
  `;
}

// ─────────────────────────────────────────────────────────────────────
// Procedural concrete-floor texture (P1-5 2026-05-04). Generated as a
// CanvasTexture so we don't depend on external image assets. Warm gray
// base + subtle noise + faint scratches reads as polished concrete.
// ─────────────────────────────────────────────────────────────────────
let _wsc3dFloorTexture = null;
function _wscGetFloorTexture(THREE) {
  if (_wsc3dFloorTexture) return _wsc3dFloorTexture;
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  // Base — warm light gray concrete
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#d6d3d1');
  grad.addColorStop(0.5, '#c8c5c2');
  grad.addColorStop(1, '#d2cfcc');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Speckle noise — small dots at varying alpha
  for (let i = 0; i < 1800; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = Math.random() * 0.18;
    const shade = Math.random() < 0.5 ? '0,0,0' : '255,255,255';
    ctx.fillStyle = `rgba(${shade},${a})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  // Faint scratches — short diagonal lines
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 6 + Math.random() * 18;
    const ang = Math.random() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // Joint lines at quarter marks (suggests slab pours)
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  for (let q of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(q * size, 0); ctx.lineTo(q * size, size); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, q * size); ctx.lineTo(size, q * size); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  _wsc3dFloorTexture = tex;
  return tex;
}

function build3DScene(ctx) {
  const el = ctx.rootEl?.querySelector('#wsc-3d-container');
  if (!el) return;

  try {
    const THREE = /** @type {any} */ (window).THREE;
    if (!THREE) {
      el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">Three.js not loaded. 3D view unavailable.</div>';
      return;
    }

    const width  = el.clientWidth || 800;
    const height = el.clientHeight || 520;

    const scene = new THREE.Scene();
    // Subtle gradient sky-ish background (was flat #e9eef5).
    scene.background = new THREE.Color('#dde4ee');
    scene.fog = new THREE.Fog(0xdde4ee, 600, 2400);
    // Phase F.12 (2026-05-06) — expose the scene on the container element so
    // the wall-visibility toggle (above the canvas) can find it without a
    // full scene rebuild. The toggle just flips wallsGroup.visible.
    el.__wscScene = scene;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // P1-5: enable soft shadow mapping. Without shadows the rectilinear
    // rack masses had no visual depth — the "racks shown at 50% opacity"
    // crutch was a workaround for that.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    // Phase A.A1 (2026-05-26) — ACES Filmic tone mapping. Maps the
    // linear-space PBR lighting through the same filmic curve every modern
    // archviz renderer (Twinmotion / Enscape / UE5) uses, replacing the
    // flat clamped-sRGB look that read as "MVP" to the 3D persona review.
    // Exposure 1.0 keeps mid-tones where the existing materials expect them.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // Phase A.A2 (2026-05-26) — physically-correct light falloff so the
    // PMREMGenerator-built envmap reads with the right brightness next to
    // the direct lights. Has no visible effect on existing flat MeshStandard
    // surfaces but lets future PBR materials behave correctly.
    renderer.physicallyCorrectLights = true;
    el.appendChild(renderer.domElement);

    // ---------- Image-based lighting (Phase A.A2, 2026-05-26) ----------
    // Build a PMREM-prefiltered environment map from Three.js's stock
    // RoomEnvironment (a procedural scene with a few colored lights that
    // simulates a typical interior). Assigning to scene.environment makes
    // every MeshStandardMaterial sample diffuse + specular probes from it,
    // which unlocks real reflections on the steel rack uprights and a
    // proper diffuse fill on the walls — the step-change the 3D persona
    // review called out as "one IBL away from credible."
    /** @type {THREE.PMREMGenerator|null} */ let pmremGenerator = null;
    /** @type {THREE.Texture|null} */        let envMap = null;
    if (typeof THREE.RoomEnvironment === 'function') {
      pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();
      const roomScene = new THREE.RoomEnvironment();
      envMap = pmremGenerator.fromScene(roomScene, 0.04).texture;
      scene.environment = envMap;
      roomScene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }

    // ---------- Lighting ----------
    // Phase A.A2 (2026-05-26) — with scene.environment seeded by the
    // PMREM-built RoomEnvironment, AmbientLight's flat contribution is
    // largely redundant. Drop its intensity from 0.55 → 0.20 (kept non-zero
    // to backstop the envmap on browsers where PMREMGenerator silently
    // fails) and let the directional + hemisphere do the heavy lifting.
    scene.add(new THREE.AmbientLight(0xffffff, 0.20));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(180, 320, 200);
    dirLight.castShadow = true;
    // Configure shadow camera frustum to cover the building
    const shadowSpan = 600;
    dirLight.shadow.camera.left   = -shadowSpan;
    dirLight.shadow.camera.right  =  shadowSpan;
    dirLight.shadow.camera.top    =  shadowSpan;
    dirLight.shadow.camera.bottom = -shadowSpan;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far  = 1500;
    // Phase A.A3 (2026-05-26) — bump shadow map 1024 → 2048 for crisper
    // rack-frame shadows + tune normalBias to kill peter-panning that gets
    // more visible at the higher resolution. Bias stays at -0.0005.
    dirLight.shadow.mapSize.width  = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.bias = -0.0005;
    dirLight.shadow.normalBias = 0.02;
    scene.add(dirLight);
    scene.add(dirLight.target);

    // Cool sky-fill (no shadow) to lift dark sides
    const fillLight = new THREE.DirectionalLight(0xb6c8e3, 0.30);
    fillLight.position.set(-160, 120, -180);
    scene.add(fillLight);

    // Hemisphere light (Phase A.A2 bump 2026-05-26): warm-ground / cool-sky
    // pair at 0.55 intensity gives the floor an honest brown bounce + a
    // sky-blue rim that reads as outdoor light spilling in. Replaces the
    // 0.25-intensity / black-ground version that was nearly invisible.
    scene.add(new THREE.HemisphereLight(0xb4c6dc, 0x8a7e6e, 0.55));

    // ---------- Geometry inputs ----------
    // WSC-O1 (2026-05-04): always map longFt -> world X axis (left-to-right
    // on screen, facing camera at default azimuth) and shortFt -> world Z
    // axis (depth into screen). orientFacility() pins the dock-on-long-edge
    // convention shared with the Plan view + Elevation.
    //
    // Phase A (2026-05-05): mode-aware footprint. Design mode renders the
    // sized footprint exactly (no empty-building visual); Constraint mode
    // renders the user's W×D and lets rack-allocation downstream cap to
    // inventory need (leftover floor = capacity slack).
    // Phase A (2026-05-05): mode-aware footprint via _renderFacility helper.
    // Design mode → engine's suggested long/short. Constraint mode → user W×D
    // (with a fallback to sized totalSqft when user hasn't entered dims yet).
    let _sized3d = null;
    try { _sized3d = calc.sizeFacility(ctx.toSizingInputs()); } catch {}
    const _facFor3d = ctx.renderFacility(ctx.facility, _sized3d);
    let _orient3d = calc.orientFacility(_facFor3d);
    if (!(_orient3d.longFt > 0 && _orient3d.shortFt > 0)) {
      const sT = (_sized3d && _sized3d.totalSqft) || 0;
      _orient3d = calc.orientFacility({ totalSqft: sT });
    }
    const bwFt = _orient3d.longFt  || 500;       // long edge -> X axis
    const bdFt = _orient3d.shortFt || 300;       // short edge -> Z axis
    const ch   = ctx.facility.clearHeight || 32;
    const scale = 0.5;                          // 1 ft = 0.5 units

    const W = bwFt * scale;
    const D = bdFt * scale;
    const H = ch * scale;

    // ---------- Floor: textured concrete + safety stripes + aisle striping ----------
    // P1-5: concrete floor with procedural texture. Receives shadows so the
    // racks/pallets cast soft contact shadows that read as physical depth.
    const floorTex = _wscGetFloorTexture(THREE);
    floorTex.repeat.set(Math.max(2, bwFt / 60), Math.max(2, bdFt / 60));
    const floorGeo = new THREE.BoxGeometry(W, 0.4, D);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      color: 0xe8e4df,
      roughness: 0.92,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Yellow safety stripe along the dock face (front, -Z edge).
    // Width = dock-face-width minus safety setback; visual cue you'd see
    // painted on the slab in a real DC.
    const stripeWFt = 6;          // 6 ft wide painted strip
    const stripeOffsetFt = 12;    // offset from front wall
    const stripeGeo = new THREE.BoxGeometry(W * 0.96, 0.05, stripeWFt * scale);
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 });
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.set(0, 0.06, -D / 2 + (stripeOffsetFt + stripeWFt / 2) * scale);
    stripe.receiveShadow = true;
    scene.add(stripe);

    // ---------- Building shell: tilt-up perimeter panels + truss roof line ----------
    // P1-5: replace edges-only wireframe with light-gray flat panels around
    // the perimeter (suggests precast tilt-up or insulated metal panel) and
    // add a dark line at the roof apex to suggest exposed truss/joist.
    const wallH = H;
    const wallThk = 1.2;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.85, metalness: 0.0 });
    // Phase F.12 (2026-05-06) — group walls under a parent Object3D so the
    // visibility toggle can hide all four perimeter walls + reveal joints + roof
    // line in one operation. Tagged with userData.isFacilityWalls so build3DScene
    // can find this group on rebuild and apply the persisted toggle state.
    const wallsGroup = new THREE.Group();
    wallsGroup.userData.isFacilityWalls = true;
    wallsGroup.visible = _wscShowWalls;
    scene.add(wallsGroup);
    // Long walls (run along X, +/-Z faces)
    const longWallGeo = new THREE.BoxGeometry(W, wallH, wallThk);
    const wN = new THREE.Mesh(longWallGeo, wallMat); wN.position.set(0, wallH / 2,  D / 2 - wallThk / 2); wN.receiveShadow = true; wallsGroup.add(wN);
    const wS = new THREE.Mesh(longWallGeo, wallMat); wS.position.set(0, wallH / 2, -D / 2 + wallThk / 2); wS.receiveShadow = true; wallsGroup.add(wS);
    // Short walls (run along Z, +/-X faces)
    const shortWallGeo = new THREE.BoxGeometry(wallThk, wallH, D);
    const wE = new THREE.Mesh(shortWallGeo, wallMat); wE.position.set( W / 2 - wallThk / 2, wallH / 2, 0); wE.receiveShadow = true; wallsGroup.add(wE);
    const wW = new THREE.Mesh(shortWallGeo, wallMat); wW.position.set(-W / 2 + wallThk / 2, wallH / 2, 0); wW.receiveShadow = true; wallsGroup.add(wW);
    // Reveal joint lines on the long walls every ~30 ft (added to wallsGroup
    // so they hide together with the wall meshes when Brock toggles walls off).
    const jointMat = new THREE.LineBasicMaterial({ color: 0xb1b6bd });
    for (let panelX = -W / 2 + 30 * scale; panelX < W / 2 - 1; panelX += 30 * scale) {
      const a1 = [ panelX, 0,  D / 2 - wallThk / 2 - 0.05];
      const b1 = [ panelX, wallH,  D / 2 - wallThk / 2 - 0.05];
      const g1 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a1), new THREE.Vector3(...b1)]);
      wallsGroup.add(new THREE.Line(g1, jointMat));
      const a2 = [ panelX, 0, -D / 2 + wallThk / 2 + 0.05];
      const b2 = [ panelX, wallH, -D / 2 + wallThk / 2 + 0.05];
      const g2 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a2), new THREE.Vector3(...b2)]);
      wallsGroup.add(new THREE.Line(g2, jointMat));
    }
    // Roof apex line (suggests exposed truss/joist). Phase B.B22 (2026-05-26)
    // moved out of wallsGroup into its own roofGroup so the "Roof On / Off"
    // toggle can hide it independently of the walls.
    const roofGroup = new THREE.Group();
    roofGroup.userData.isFacilityRoof = true;
    roofGroup.visible = _wscShowRoof;
    scene.add(roofGroup);
    const roofLineMat = new THREE.LineBasicMaterial({ color: 0x6b7280 });
    const roofPts = [
      new THREE.Vector3(-W / 2, wallH + 0.05,  0),
      new THREE.Vector3( W / 2, wallH + 0.05,  0),
    ];
    roofGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(roofPts), roofLineMat));

    // ---------- Storage geometry inputs ----------
    const sized = calc.sizeFacility(ctx.toSizingInputs());
    // Phase A: route elevation params through mode-aware facility shape so the
    // 3D scene uses the same dock-on-long-edge dims as the 2D plan + dashboard.
    const elev = calc.elevationParams(ctx.renderFacility(ctx.facility, sized));

    const rackDepthFt = elev.rackDepthFt || 4.3;
    // ── N7: engineered scene plan (media→racks, dynamics→aisles/staging) ──
    // Pure translation of the N3/N4 plans; when no media plan exists the
    // spec says source:'legacy' and every pre-N7 path below runs unchanged.
    const _scenePlan = buildScenePlan({
      mediaPlan: ctx.getMediaPlan?.() || null,
      dynamicsPlan: ctx.getDynamicsPlan?.() || null,
      sized, facility: ctx.facility, zones: ctx.zones,
    });
    // Storage aisle: dynamics governing MHE assumption → facility → 12 ft.
    const aisleFt     = _scenePlan.aisles.storageFt || ctx.facility.aisleWidth || elev.aisleWidth || 12;
    const rackHeightFt= calc.topOfSteelFt(elev.rackLevels || 5);
    const moduleFt    = (2 * rackDepthFt) + aisleFt;

    const rackDepthU  = rackDepthFt * scale;
    const moduleU     = moduleFt * scale;
    const rackHeightU = rackHeightFt * scale;

    // Reserve front (-Z, dock face) and back (+Z) margins for staging.
    // N7 slice B: depths derive from the dynamics plan's dwell-driven sqft
    // (or the configured zone sqft) spread along ~80% of the dock wall;
    // legacy 30 ft strip only when no staging signal exists at all.
    const _twoSidedStg = (ctx.zones.dockConfig?.sided || 'two') === 'two';
    const _stgWallFt = Math.max(60, bwFt * 0.8);
    const _stgDepthFt = (sqft) => Math.min(100, Math.max(20, sqft / _stgWallFt));
    let stagingFt = 30, stagingBackFt = 30;
    if (_scenePlan.staging.source !== 'default') {
      const sIn = _scenePlan.staging.inboundSqft || 0;
      const sOut = _scenePlan.staging.outboundSqft || 0;
      if (_twoSidedStg) { stagingFt = _stgDepthFt(sIn); stagingBackFt = _stgDepthFt(sOut); }
      else { stagingFt = _stgDepthFt(sIn + sOut); stagingBackFt = 12; }
    }
    const stagingU  = stagingFt * scale;
    const stagingBackU = stagingBackFt * scale;
    const rackZStart = -D / 2 + stagingU;
    const rackZEnd   =  D / 2 - stagingBackU;

    // Soft volume materials (lower opacity now that uprights/beams/pallets
    // do the heavy visual lifting). The colored box hints "this zone is
    // full-pallet vs carton-pallet vs shelving" — structure makes it read
    // as a real rack.
    // Rack-type colored volumes: low opacity so the structural detail
    // (uprights + beams + pallets at correct front-face positions) carries
    // the visual reading. depthWrite:false prevents the colored volumes
    // from masking the InstancedMesh structural elements behind them.
    const matFullPallet   = new THREE.MeshStandardMaterial({ color: 0xea580c, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.7 });
    const matCartonPallet = new THREE.MeshStandardMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.7 });
    const matShelving     = new THREE.MeshStandardMaterial({ color: 0x0d9488, transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.7 });
    // Steel structural color for uprights + beams (instanced).
    const matSteel = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.55, metalness: 0.45 });
    // Wood pallet color (instanced).
    const matPallet = new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.78, metalness: 0.0 });
    // Corrugated carton color for shelving (instanced).
    const matCarton = new THREE.MeshStandardMaterial({ color: 0xb88a52, roughness: 0.92, metalness: 0.0 });
    // Light steel for shelf decks (instanced) — slightly brighter than upright steel
    // so the discrete shelves read clearly against the dim teal volume.
    const matShelfDeck = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6, metalness: 0.4 });

    // Office footprint
    const officeFt = Math.sqrt(Math.max(1, sized.officeSqft));
    const officeU  = officeFt * scale;
    const officeX0 = -W / 2 + 2;
    const officeX1 = officeX0 + officeU;
    const officeZ0 = -D / 2 + stagingU;
    const officeZ1 = officeZ0 + officeU;

    // Forward Pick footprint
    const fpEnabled3D = !!ctx.zones.forwardPick?.enabled;
    const fpDepthFt   = fpEnabled3D ? Math.min(60, Math.max(20, (ctx.zones.forwardPick?.daysInventory || 3) * 8 + 16)) : 0;
    const fpDepthU    = fpDepthFt * scale;
    const fpZ0        = rackZStart;
    const fpZ1        = fpZ0 + fpDepthU;
    const fpX0        = officeX1 + 2;
    const fpX1        = W / 2 - 2;

    // Count columns available across the building footprint.
    let totalCols = 0;
    {
      let mxScan = -W / 2 + 6 * scale;
      while (mxScan + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
        totalCols += 2;
        mxScan += moduleU;
      }
    }
    const palletLevels   = sized.rackLevels  || 5;
    const shelvingLevels = sized.shelfLevels || 5;
    // Target-driven col allocation. Pre-fix this used inventory-unit mix
    // percentages (mix.fullPalletPct etc.), which over-fills shelving by
    // ~6× on typical buildings because shelving bays are 1.4× denser than
    // pallet bays AND shelving levels usually exceed pallet levels — so a
    // 15% inventory-unit share routes to ~25% of POSITIONS at a 15% col
    // allocation. New helper sizes cols to per-type GROSS targets so
    // rendered counts ≈ engine-derived targets; leftover cols become
    // empty floor (visual signature of an over-built building).
    const _3dPlanFullRunFt = (rackZEnd - rackZStart) / scale;
    const _3dPlanXa        = calc.crossAisleLayoutFt(_3dPlanFullRunFt);
    const _3dPlanSegLensFt = Array.from(
      { length: _3dPlanXa.segmentCount },
      () => _3dPlanXa.segmentLenFt,
    );
    const _alloc3D = calc.allocateRackColsByTarget({
      totalCols,
      segmentLensFt: _3dPlanSegLensFt,
      palletLevels,
      shelvingLevels,
      fullPalletTarget:   +sized.positions?.fullPalletGrossPositions   || 0,
      cartonPalletTarget: +sized.positions?.cartonPalletGrossPositions || 0,
      shelvingTarget:     +sized.positions?.shelvingGrossPositions     || 0,
      // Phase F (2026-05-05) — Design mode pads leftover cols across types
      // (matches the 2D plan logic). Constraint mode = target-only.
      fillMode: (ctx.facility.sizingMode || 'design') === 'design' ? 'fill' : 'target',
    });
    const fullPalletCols   = _alloc3D.fullPalletCols;
    const cartonPalletCols = _alloc3D.cartonPalletCols;
    const shelvingCols     = _alloc3D.shelvingCols;
    // Phase 3 redesign (2026-05-04): structuralBayWidthFt = upright-to-upright
    // spacing (real selective rack: 9 ft for GMA, 2 pallets per crossbeam).
    // bayWidthFt = position-width convention (4.33 ft = single pallet position),
    // kept for placedRacks → rackPairCapacity → HUD math so HUD position counts
    // stay consistent. The two values are semantically distinct: structuralBayWidthFt
    // governs how often we instance uprights and how long each beam is; bayWidthFt
    // governs how positions are counted. For shelving they're equal (3 ft).
    const _structuralPalletBay = (sized?.unitLoad?.bayWidthFt) || (calc.PALLET_BAY_WIDTH_FT * 2);
    const _structuralShelvingBay = (sized?.cartonProfile?.shelfBayWidthFt) || calc.SHELVING_BAY_WIDTH_FT;
    const TYPES = [
      { typeKey: 'fullPallet',   count: fullPalletCols,   mat: matFullPallet,   heightU: rackHeightU,        kind: 'pallet',   levels: palletLevels,   bayWidthFt: calc.PALLET_BAY_WIDTH_FT,   structuralBayWidthFt: _structuralPalletBay },
      { typeKey: 'cartonPallet', count: cartonPalletCols, mat: matCartonPallet, heightU: rackHeightU * 0.85, kind: 'pallet',   levels: palletLevels,   bayWidthFt: calc.PALLET_BAY_WIDTH_FT,   structuralBayWidthFt: _structuralPalletBay },
      { typeKey: 'shelving',     count: shelvingCols,     mat: matShelving,     heightU: 6.5 * scale,         kind: 'shelving', levels: shelvingLevels, bayWidthFt: calc.SHELVING_BAY_WIDTH_FT, structuralBayWidthFt: _structuralShelvingBay },
    ];

    // ── N7 slice A: media-accurate runs ──
    // One run per engineered medium. Each run owns its lane depth (rack
    // depth = laneDepth × pallet depth), aisle band, level count, color,
    // and gross-position target; the media placement walk below places
    // columns for a run until its target is met, then moves to the next.
    const _isMediaScene = _scenePlan.source === 'media' && _scenePlan.runs.length > 0;
    const RUNS3D = !_isMediaScene ? null : _scenePlan.runs.map(r => {
      const isShelf = r.kind === 'shelving';
      return {
        typeKey: r.key,
        label: r.label,
        family: r.family,
        mat: new THREE.MeshStandardMaterial({
          color: r.style.color, transparent: true,
          opacity: isShelf ? 0.22 : 0.18, depthWrite: false, roughness: 0.7,
        }),
        heightU: isShelf ? 6.5 * scale : calc.topOfSteelFt(r.levels) * scale,
        kind: r.kind,
        levels: r.levels,
        laneDepth: r.laneDepth,
        bayWidthFt: isShelf ? calc.SHELVING_BAY_WIDTH_FT : calc.PALLET_BAY_WIDTH_FT,
        structuralBayWidthFt: isShelf ? _structuralShelvingBay : _structuralPalletBay,
        rackDepthU: (isShelf ? rackDepthFt : rackDepthFt * Math.max(1, r.laneDepth)) * scale,
        aisleU: (r.aisleFt || aisleFt) * scale,
        fillPct: Math.max(0.3, Math.min(0.95, r.fillPct || 0.85)),
        target: Math.max(0, r.targetPositions || 0),
        placed: 0,
        extents: { minX: Infinity, maxX: -Infinity },
        labelColor: '#' + r.style.color.toString(16).padStart(6, '0'),
      };
    });

    /** @type {Array<{typeKey:string,colKey:number,segmentLenFt:number,levels:number,bayWidthFt:number}>} */
    const placedRacks = [];

    // ─────────────────────────────────────────────────────────────────
    // Two-pass placement:
    //  Pass 1: walk the building footprint, emit (colored volume per segment,
    //          placedRacks record). Tracks segment metadata for instancing.
    //  Pass 2: build InstancedMesh of uprights + beams + pallets in one go.
    // ─────────────────────────────────────────────────────────────────
    /** @type {Array<{t:any, mx:number, segCenter:number, segLenU:number, side:number, levels:number, bayWidthFt:number, fillPct:number}>} */
    const segmentMeta = [];

    // ─────────────────────────────────────────────────────────────────
    // Master cross-aisle plan (3D): same pattern as the 2D plan view —
    // compute ONCE for the full rack run (rackZStart → rackZEnd) and
    // share segment Z-bands across every column. Cross-aisles align
    // through the entire building instead of jagging at zone boundaries.
    // ─────────────────────────────────────────────────────────────────
    const _3dFullRunFt    = (rackZEnd - rackZStart) / scale;
    const _3dXaMaster     = calc.crossAisleLayoutFt(_3dFullRunFt);
    const _3dSegLenU      = _3dXaMaster.segmentLenFt * scale;
    const _3dGapU         = _3dXaMaster.crossAisleClearFt * scale;
    /** Master segment Z-bands shared by every column (each {z0, z1} in world units). */
    const _3dMasterSegments = [];
    {
      let cz = rackZStart;
      for (let s = 0; s < _3dXaMaster.segmentCount; s++) {
        _3dMasterSegments.push({ z0: cz, z1: cz + _3dSegLenU });
        cz += _3dSegLenU + _3dGapU;
      }
    }

    let mx = -W / 2 + 6 * scale;
    let typeIdx = 0;
    let typeUsed = 0;
    // Phase F.4 (2026-05-05) — track per-type X-extent for floating zone labels.
    const _zone3dXExtents = TYPES.map(() => ({ minX: Infinity, maxX: -Infinity }));

    // ─────────────────────────────────────────────────────────────────
    // N7 media placement walk — column module width varies per run
    // (flow 8-deep is a far deeper module than selective), so the walk
    // recomputes the module for the CURRENT run each step and advances
    // to the next run once its position target is placed.
    // ─────────────────────────────────────────────────────────────────
    if (_isMediaScene) {
      let runIdx = 0;
      while (runIdx < RUNS3D.length) {
        const t = RUNS3D[runIdx];
        if (t.target <= 0) { runIdx++; continue; }
        const moduleUThis = 2 * t.rackDepthU + t.aisleU;
        if (mx + moduleUThis >= W / 2 - 6 * scale) break; // floor exhausted

        const colLeft  = mx;
        const colRight = mx + 2 * t.rackDepthU + 0.5;
        const overlapsOfficeX = colRight > officeX0 && colLeft < officeX1;
        const overlapsFpX     = fpEnabled3D && colRight > fpX0 && colLeft < fpX1;
        let thisZStart = rackZStart;
        const thisZEnd = rackZEnd;
        if (overlapsOfficeX) thisZStart = Math.max(thisZStart, officeZ1 + 2);
        if (overlapsFpX)     thisZStart = Math.max(thisZStart, fpZ1 + 2);
        const thisLen = Math.max(0, thisZEnd - thisZStart);

        if (thisLen > 4) {
          for (const mseg of _3dMasterSegments) {
            const segZ0Eff = Math.max(mseg.z0, thisZStart);
            const segZ1Eff = Math.min(mseg.z1, thisZEnd);
            const segLenU  = segZ1Eff - segZ0Eff;
            if (segLenU <= 4) continue;
            const segCenter = segZ0Eff + segLenU / 2;

            const rackGeo = new THREE.BoxGeometry(t.rackDepthU, t.heightU, segLenU);
            const r1 = new THREE.Mesh(rackGeo, t.mat);
            r1.position.set(mx + t.rackDepthU / 2, t.heightU / 2, segCenter);
            r1.castShadow = true;
            scene.add(r1);
            const r2 = new THREE.Mesh(rackGeo, t.mat);
            r2.position.set(mx + t.rackDepthU + 0.5 + t.rackDepthU / 2, t.heightU / 2, segCenter);
            r2.castShadow = true;
            scene.add(r2);

            const perFace = positionsPerFaceSegment({
              segLenFt: segLenU / scale, bayWidthFt: t.bayWidthFt,
              levels: t.levels, laneDepth: t.laneDepth,
            });
            t.placed += perFace * 2;

            segmentMeta.push({
              t, mx, segCenter, segLenU, side: 'A',
              faceX: mx + t.rackDepthU / 2, frontFaceX: mx, intoRackDir: +1,
              levels: t.levels, bayWidthFt: t.bayWidthFt,
              structuralBayWidthFt: t.structuralBayWidthFt,
              rackDepthU: t.rackDepthU, heightU: t.heightU, fillPct: t.fillPct,
            });
            segmentMeta.push({
              t, mx, segCenter, segLenU, side: 'B',
              faceX: mx + t.rackDepthU + 0.5 + t.rackDepthU / 2,
              frontFaceX: mx + 2 * t.rackDepthU + 0.5, intoRackDir: -1,
              levels: t.levels, bayWidthFt: t.bayWidthFt,
              structuralBayWidthFt: t.structuralBayWidthFt,
              rackDepthU: t.rackDepthU, heightU: t.heightU, fillPct: t.fillPct,
            });
            placedRacks.push({
              typeKey: t.typeKey, colKey: mx, segmentLenFt: segLenU / scale,
              levels: t.levels, bayWidthFt: t.bayWidthFt,
            });
          }
        }
        t.extents.minX = Math.min(t.extents.minX, mx);
        t.extents.maxX = Math.max(t.extents.maxX, mx + 2 * t.rackDepthU + t.aisleU);
        mx += moduleUThis;
        if (t.placed >= t.target) runIdx++;
      }
    } else
    while (mx + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
      while (typeIdx < TYPES.length && typeUsed >= TYPES[typeIdx].count) {
        typeIdx++;
        typeUsed = 0;
      }
      // Stop placing once every type's col budget is spent — leftover
      // cols become empty floor (over-built building). Pre-fix this
      // clamped to the last type and silently expanded shelving until
      // the building was full.
      if (typeIdx >= TYPES.length) break;
      const t = TYPES[typeIdx];

      const colLeft  = mx;
      const colRight = mx + 2 * rackDepthU + 0.5;
      const overlapsOfficeX = colRight > officeX0 && colLeft < officeX1;
      const overlapsFpX     = fpEnabled3D && colRight > fpX0 && colLeft < fpX1;

      let thisZStart = rackZStart;
      const thisZEnd = rackZEnd;
      if (overlapsOfficeX) thisZStart = Math.max(thisZStart, officeZ1 + 2);
      if (overlapsFpX)     thisZStart = Math.max(thisZStart, fpZ1 + 2);
      const thisLen = Math.max(0, thisZEnd - thisZStart);

      if (thisLen > 4) {
        // Intersect each master segment with this column's [thisZStart, thisZEnd]
        // window. Truncated columns simply drop the master segments that don't fit.
        for (const mseg of _3dMasterSegments) {
          const segZ0Eff = Math.max(mseg.z0, thisZStart);
          const segZ1Eff = Math.min(mseg.z1, thisZEnd);
          const segLenU  = segZ1Eff - segZ0Eff;
          if (segLenU <= 4) continue;
          const segCenter = segZ0Eff + segLenU / 2;

          // Soft colored volume per rack pair
          const rackGeo = new THREE.BoxGeometry(rackDepthU, t.heightU, segLenU);
          const r1 = new THREE.Mesh(rackGeo, t.mat);
          r1.position.set(mx + rackDepthU / 2, t.heightU / 2, segCenter);
          r1.castShadow = true;
          scene.add(r1);
          const r2 = new THREE.Mesh(rackGeo, t.mat);
          r2.position.set(mx + rackDepthU + 0.5 + rackDepthU / 2, t.heightU / 2, segCenter);
          r2.castShadow = true;
          scene.add(r2);

          // Record both faces for instanced uprights + beams + pallets.
          // fillPct sets how many bays render a pallet (front-of-aisle
          // shows occupancy without saturating the canvas).
          //
          // Phase F.3.1 (2026-05-05) — fix Brock's "why is a big percentage
          // of the racking empty?" callout. Pre-fix: fillPct = utilizationPct
          // / 100 with 30% floor clamp. utilizationPct collapses to ~10% on
          // the totalPalletsOverride path because designedPositions honors
          // the override (65k) but avgPositions still derives from
          // avgUnits/unitsPerPallet (~900 equivalent), giving a 1.4% ratio
          // → clamped to 30% floor → 70% of bays drawn empty. That made the
          // 3D scene read as a chronically under-loaded warehouse, which is
          // a calc bug surfacing as a visualization disaster.
          //
          // New behavior: in Design mode, fillPct = designedPositions /
          // grossPositions (typically 0.80–0.85 because gross = designed ×
          // surge factor). This is the IE-correct "operating fill" — every
          // engineered position is shown occupied, the surge buffer is
          // shown empty. In Constraint mode, fall through to legacy
          // utilizationPct behavior so genuinely under-loaded buildings
          // still surface as empty bays.
          let utilFrac;
          const _modeForFill = ctx.facility.sizingMode || 'design';
          if (_modeForFill === 'design') {
            const designedP = +sized.positions?.designedPositions || 0;
            const grossP    = +sized.positions?.grossPositions    || 0;
            const ratio = (grossP > 0) ? designedP / grossP : 0.83;
            utilFrac = Math.max(0.50, Math.min(0.95, ratio));
          } else {
            utilFrac = Math.max(0.30, Math.min(0.95, (sized.utilization?.utilizationPct || 75) / 100));
          }
          // Side A's aisle-facing front sits at mx (left edge of the
          // back-to-back pair). intoRackDir +1 → rack extends to +X.
          // Side B's front sits at the right edge of the pair, extending
          // back into -X. faceX retained as rack-volume center for the
          // soft colored mesh; frontFaceX is the actual structural face
          // where uprights, beams, and pallets attach.
          segmentMeta.push({
            t, mx, segCenter, segLenU,
            side: 'A',
            faceX: mx + rackDepthU / 2,
            frontFaceX: mx,
            intoRackDir: +1,
            levels: t.levels,
            bayWidthFt: t.bayWidthFt,
            structuralBayWidthFt: t.structuralBayWidthFt,
            rackDepthU: rackDepthU,
            heightU: t.heightU,
            fillPct: utilFrac,
          });
          segmentMeta.push({
            t, mx, segCenter, segLenU,
            side: 'B',
            faceX: mx + rackDepthU + 0.5 + rackDepthU / 2,
            frontFaceX: mx + 2 * rackDepthU + 0.5,
            intoRackDir: -1,
            levels: t.levels,
            bayWidthFt: t.bayWidthFt,
            structuralBayWidthFt: t.structuralBayWidthFt,
            rackDepthU: rackDepthU,
            heightU: t.heightU,
            fillPct: utilFrac,
          });

          placedRacks.push({
            typeKey: t.typeKey,
            colKey: mx,
            segmentLenFt: segLenU / scale,
            levels: t.levels,
            bayWidthFt: t.bayWidthFt,
          });
        }
      }
      // Track per-type X-extent for floating labels.
      if (typeIdx < _zone3dXExtents.length) {
        const ex = _zone3dXExtents[typeIdx];
        ex.minX = Math.min(ex.minX, mx);
        ex.maxX = Math.max(ex.maxX, mx + 2 * rackDepthU + (aisleFt * scale));
      }
      typeUsed += 2;
      mx += moduleU;
    }

    // Phase F.4 (2026-05-05) — Brock callout: "floating labels in 3D" for
    // storage types. Sprite-based labels positioned above each zone center.
    // Sprites always face the camera so labels stay readable from any angle.
    function _make3dZoneLabel(text, color) {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const cx = c.getContext('2d');
      cx.fillStyle = 'rgba(255,255,255,0.94)';
      cx.fillRect(0, 0, 256, 64);
      cx.strokeStyle = color;
      cx.lineWidth = 3;
      cx.strokeRect(2, 2, 252, 60);
      cx.fillStyle = color;
      cx.font = 'bold 24px sans-serif';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      cx.fillText(text, 128, 34);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(60 * scale, 15 * scale, 1);
      return sprite;
    }
    if (_isMediaScene) {
      // N7 — one label per media run, colored to the family volume.
      for (const t of RUNS3D) {
        const ex = t.extents;
        if (!Number.isFinite(ex.minX) || !Number.isFinite(ex.maxX)) continue;
        const sprite = _make3dZoneLabel(t.label, t.labelColor);
        sprite.position.set((ex.minX + ex.maxX) / 2, rackHeightU + 8 * scale, 0);
        sprite.renderOrder = 999;
        scene.add(sprite);
      }
    } else
    for (let i = 0; i < TYPES.length; i++) {
      const ex = _zone3dXExtents[i];
      if (!Number.isFinite(ex.minX) || !Number.isFinite(ex.maxX)) continue;
      const t = TYPES[i];
      const labelText = t.typeKey === 'fullPallet' ? 'Full Pallet'
        : t.typeKey === 'cartonPallet' ? 'Carton on Pallet'
        : 'Carton Shelving';
      // Color match: dark orange / amber / teal
      const labelColor = t.typeKey === 'fullPallet' ? '#9a3412'
        : t.typeKey === 'cartonPallet' ? '#b45309'
        : '#0f766e';
      const cxWorld = (ex.minX + ex.maxX) / 2;
      const sprite = _make3dZoneLabel(labelText, labelColor);
      // Float ABOVE the rack height so labels don't clip into rack tops
      sprite.position.set(cxWorld, rackHeightU + 8 * scale, 0);
      sprite.renderOrder = 999; // always on top
      scene.add(sprite);
    }

    // ─────────────────────────────────────────────────────────────────
    // N7 slice B — staging slabs. Tinted floor zones sized to the
    // dwell-derived (or configured) staging sqft, labeled with the value
    // so the 3D scene shows the engineered staging, not a fixed strip.
    // ─────────────────────────────────────────────────────────────────
    if (_scenePlan.staging.source !== 'default') {
      const _stgSlab = (depthU, zCenter, color) => {
        const g = new THREE.BoxGeometry(W * 0.9, 0.06, depthU);
        const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
          color, transparent: true, opacity: 0.12, depthWrite: false, roughness: 0.8,
        }));
        m.position.set(0, 0.08, zCenter);
        m.receiveShadow = true;
        scene.add(m);
      };
      const fmtSf = (n) => (Math.round(n) || 0).toLocaleString();
      const sIn = _scenePlan.staging.inboundSqft || 0;
      const sOut = _scenePlan.staging.outboundSqft || 0;
      _stgSlab(stagingU, -D / 2 + stagingU / 2, 0x16a34a);
      const inLabel = _make3dZoneLabel(
        _twoSidedStg ? `Receive · ${fmtSf(sIn)} sf` : `Staging · ${fmtSf(sIn + sOut)} sf`, '#15803d');
      inLabel.position.set(-W / 4, 6 * scale, -D / 2 + stagingU / 2);
      inLabel.renderOrder = 999;
      scene.add(inLabel);
      if (_twoSidedStg && sOut > 0) {
        _stgSlab(stagingBackU, D / 2 - stagingBackU / 2, 0x2563eb);
        const outLabel = _make3dZoneLabel(`Ship · ${fmtSf(sOut)} sf`, '#1d4ed8');
        outLabel.position.set(-W / 4, 6 * scale, D / 2 - stagingBackU / 2);
        outLabel.renderOrder = 999;
        scene.add(outLabel);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // N7 slice C — reconciliation ghosts. Any pallet-run positions the
    // floor could not absorb render as red wireframe columns marching
    // past the +X wall: the building is visibly too small for the
    // engineered media plan, and the HUD says by how much.
    // ─────────────────────────────────────────────────────────────────
    let _ghostShortfall = 0;
    if (_isMediaScene) {
      _ghostShortfall = RUNS3D.reduce((sum, r) => sum + Math.max(0, r.target - r.placed), 0);
      if (_ghostShortfall > 0) {
        const ghostRun = RUNS3D.find(r => r.placed < r.target) || RUNS3D[RUNS3D.length - 1];
        const ghostMat = new THREE.MeshBasicMaterial({
          color: 0xdc2626, wireframe: true, transparent: true, opacity: 0.35,
        });
        const gDepthU = ghostRun.rackDepthU;
        const gModule = 2 * gDepthU + ghostRun.aisleU;
        const gLenU = Math.min((rackZEnd - rackZStart), 120 * scale);
        const gCols = Math.min(6, Math.max(1, Math.ceil(_ghostShortfall
          / Math.max(1, positionsPerFaceSegment({ segLenFt: gLenU / scale, bayWidthFt: ghostRun.bayWidthFt, levels: ghostRun.levels, laneDepth: ghostRun.laneDepth }) * 2))));
        let gx = W / 2 + 8 * scale;
        for (let i = 0; i < gCols; i++) {
          const gGeo = new THREE.BoxGeometry(2 * gDepthU + 0.5, ghostRun.heightU, gLenU);
          const gMesh = new THREE.Mesh(gGeo, ghostMat);
          gMesh.position.set(gx + gDepthU + 0.25, ghostRun.heightU / 2, (rackZStart + rackZEnd) / 2);
          scene.add(gMesh);
          gx += gModule;
        }
        const shortLabel = _make3dZoneLabel(`SHORT ${_ghostShortfall.toLocaleString()} positions`, '#b91c1c');
        shortLabel.position.set(W / 2 + (gx - W / 2) / 2, ghostRun.heightU + 10 * scale, 0);
        shortLabel.renderOrder = 999;
        scene.add(shortLabel);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Instanced structural detail (uprights + horizontal members + load).
    // Pallet and shelving racks have different scale + load shapes:
    //   • PALLET: ~28 ft tall, 4.33 ft bays, 6 levels, beam + 4 ft pallet
    //   • SHELVING: 6.5 ft tall, 3 ft bays, 7 levels, shelf deck + small carton
    // Mixing them in one loop (pre-fix behavior) put 4 ft pallet boxes into
    // 0.93 ft shelving level slots — the boxes overlapped 4+ levels of
    // shelving and visually merged into horizontal stripes. Splitting by
    // kind keeps each kind's geometry sized correctly.
    // One InstancedMesh per kind-kind → at most 6 extra draw calls total.
    // ─────────────────────────────────────────────────────────────────
    // Phase F.5 (2026-05-05) — Brock callout: "for the carton storage in
    // pallet rack, what part of the configuration panel determines the
    // carton sizing for these cartons? why don't they look any different
    // sized than pallets?". Pre-fix Full Pallet and Carton-on-Pallet zones
    // both rendered with the same wood-color palletGeo, looking identical.
    // Now split palletMeta into fpMeta (Full Pallet) and cpMeta
    // (Carton-on-Pallet), rendered with different geometry + material.
    // FP: full-height wood-color pallet load. CP: shorter brown-carton
    // stack profile (represents cartons stacked on a low-profile pallet
    // base). Drives off facility.cartonHeightIn × cartonProfile.hi for
    // CP carton-stack height (so Step 2 carton dims now visibly affect
    // the Carton-on-Pallet rendering, not just shelving).
    /** @type {Array<typeof segmentMeta[number]>} */
    const palletMeta = [];   // combined FP + CP — used for uprights/beams (same structural rack for both)
    /** @type {Array<typeof segmentMeta[number]>} */
    const fpMeta = [];       // FP only — for full-pallet load rendering
    /** @type {Array<typeof segmentMeta[number]>} */
    const cpMeta = [];       // CP only — for carton-on-pallet load rendering (Phase F.6)
    /** @type {Array<typeof segmentMeta[number]>} */
    const shelvingMeta = [];
    for (const m of segmentMeta) {
      if (!m || !m.t) continue;
      if (m.t.kind === 'shelving') {
        shelvingMeta.push(m);
      } else {
        palletMeta.push(m);
        if (m.t.typeKey === 'cartonPallet') cpMeta.push(m);
        else fpMeta.push(m);
      }
    }

    // ── Pallet structural detail (uprights + beams + pallets) ──────────
    // Phase 3 redesign (2026-05-04) — IE-correct selective rack:
    //   • Uprights bracket PAIRS of pallets — instanced every structuralBayWidthFt
    //     (9 ft for GMA), not every position-width (4.33 ft). Each upright frame
    //     sits at the bay boundary; pallets sit between them at quarter-points.
    //   • Beams come from sized.rackingStructure[zoneKey].beamRowHeightsFt which
    //     drops the orphan top beam (real selective rack: top pallet load has
    //     nothing above it; beam at level N is structurally pointless) and
    //     respects per-zone bottom-beam toggle (FP off / CP on by default).
    //   • Pallets render TWO per bay — side-by-side along the 9 ft beam at
    //     quarter-points (so each pallet is at bayCenter ± 2.25 ft along Z).
    //     Real selective rack: 2 × 48" pallet + 12" inter/outboard clearances
    //     = 108" beam clear.
    const _rackingStruct = sized?.rackingStructure || {};
    let totalUprights = 0, totalBeams = 0;
    // Phase F.6 (2026-05-05) — separate FP and CP pallet load counts so
    // each renders with its own InstancedMesh + material + geometry.
    let totalPalletsFP = 0;
    let totalPalletsCP = 0;
    for (const m of palletMeta) {
      const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
      const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
      // Uprights: bays + 1 vertical posts at each bay boundary, TWO per
      // boundary (front-of-aisle + back-of-rack).
      totalUprights += (baysPerFace + 1) * 2;
      // Beams: one per level boundary that the engine says to instance.
      // Default (no bottom beam, no top beam): N-1 beams for N levels.
      // With bottom beam:                     N beams for N levels.
      const rs = _rackingStruct[m.t.typeKey];
      const beamsThisFace = rs
        ? Math.max(0, m.levels - 1 + (rs.bottomBeam ? 1 : 0) + (rs.topBeam ? 1 : 0))
        : Math.max(0, m.levels - 1);
      totalBeams += beamsThisFace;
      // Pallets: bays × 2 (per bay) × levels × fillPct
      const palletsThisFace = Math.floor(baysPerFace * 2 * m.levels * m.fillPct);
      if (m.t.typeKey === 'cartonPallet') totalPalletsCP += palletsThisFace;
      else totalPalletsFP += palletsThisFace;
    }
    const totalPallets = totalPalletsFP + totalPalletsCP; // legacy alias

    if (totalUprights > 0) {
      const uprightW = 0.18, uprightDepthSlice = 0.18;
      const uprightGeo = new THREE.BoxGeometry(uprightW, 1, uprightDepthSlice);
      const uprightMesh = new THREE.InstancedMesh(uprightGeo, matSteel, totalUprights);
      uprightMesh.castShadow = true;
      uprightMesh.receiveShadow = false;
      const dummy = new THREE.Object3D();
      let ui = 0;
      for (const m of palletMeta) {
        const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
        const bayU = sBay * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const frontX = m.frontFaceX;
        const backX  = m.frontFaceX + m.intoRackDir * m.rackDepthU;
        for (let b = 0; b <= baysPerFace; b++) {
          const z = segZ0 + b * bayU;
          dummy.position.set(frontX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          uprightMesh.setMatrixAt(ui++, dummy.matrix);
          dummy.position.set(backX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          uprightMesh.setMatrixAt(ui++, dummy.matrix);
        }
      }
      uprightMesh.instanceMatrix.needsUpdate = true;
      scene.add(uprightMesh);
    }

    if (totalBeams > 0) {
      const beamGeo = new THREE.BoxGeometry(0.45, 0.18, 1);
      const beamMesh = new THREE.InstancedMesh(beamGeo, matSteel, totalBeams);
      beamMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let bi = 0;
      for (const m of palletMeta) {
        const beamX = m.frontFaceX + m.intoRackDir * 0.25;
        const levelHeightU = m.heightU / m.levels;
        const rs = _rackingStruct[m.t.typeKey];
        // Build the list of level-boundary indices to instance beams at:
        //   Default (no bottom, no top): k = 1..N-1 (between each level pair)
        //   Bottom beam on:              also include 0 (floor beam)
        //   Top beam on:                 also include N (orphan above top — legacy compat only)
        /** @type {number[]} */
        const levelIndicesForBeams = [];
        if (rs && rs.bottomBeam) levelIndicesForBeams.push(0);
        for (let k = 1; k <= m.levels - 1; k++) levelIndicesForBeams.push(k);
        if (rs && rs.topBeam) levelIndicesForBeams.push(m.levels);
        for (const k of levelIndicesForBeams) {
          const yU = levelHeightU * k;
          dummy.position.set(beamX, yU, m.segCenter);
          dummy.scale.set(1, 1, m.segLenU);
          dummy.updateMatrix();
          beamMesh.setMatrixAt(bi++, dummy.matrix);
        }
      }
      beamMesh.instanceMatrix.needsUpdate = true;
      scene.add(beamMesh);
    }

    // Phase F.6 (2026-05-05) — split pallet load rendering into two passes:
    // FP (wood-color full pallet load, 3.5 ft Y) and CP (brown carton-stack
    // profile, derived from cartonHeightIn × cartonProfile.hi for
    // representative carton-stack height). Pre-fix both rendered with the
    // same wood pallet box so Carton-on-Pallet was visually indistinguishable
    // from Full Pallet. Now the user can see at a glance which positions
    // hold full pallets vs cartons-stacked-on-pallets, and the carton
    // dimensions from Step 2 (Carton L/W/H) drive the CP appearance.
    const palletDepthU = 3.33 * scale; // X — into rack
    const _zFractionsInBay = [0.25, 0.75];

    function _renderPalletLoadPass(meta, totalCount, mat, loadHeightU, widthU) {
      if (totalCount <= 0 || meta.length === 0) return;
      const geo = new THREE.BoxGeometry(palletDepthU, loadHeightU, widthU);
      const mesh = new THREE.InstancedMesh(geo, mat, totalCount);
      mesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let pi = 0;
      for (const m of meta) {
        const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
        if (baysPerFace === 0) continue;
        const bayU = sBay * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const palletCenterX = m.frontFaceX + m.intoRackDir * (palletDepthU / 2);
        const levelHeightU  = m.heightU / m.levels;
        const fillCount = Math.floor(baysPerFace * m.levels * m.fillPct);
        const seed = ((Math.floor(m.mx * 1000) ^ Math.floor(m.segCenter * 1000)) >>> 0) ^ (m.side === 'A' ? 0x12345 : 0xABCD9);
        const order = ctx.shuffledBayLevelOrder(baysPerFace, m.levels, seed);
        for (let i = 0; i < fillCount; i++) {
          const [b, lv] = order[i];
          const beamY = levelHeightU * lv;
          const yU = beamY + loadHeightU / 2 + 0.05;
          const bayBaseZ = segZ0 + b * bayU;
          for (const zFrac of _zFractionsInBay) {
            const z = bayBaseZ + zFrac * bayU;
            dummy.position.set(palletCenterX, yU, z);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            mesh.setMatrixAt(pi++, dummy.matrix);
          }
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }

    // FP pass: full pallet wood box (~5 ft load height, slightly under level pitch).
    _renderPalletLoadPass(fpMeta, totalPalletsFP, matPallet, 3.5 * scale, 3.5 * scale);

    // Phase F.8 + F.9 (2026-05-05) — Brock callouts:
    //   F.8: "I still don't understand the pallet vs cartons in pallet
    //   racking differences. visually they look the same except for the
    //   color. this is extremely confusing".
    //   F.9: "carton pallets still don't show the pallets... just cartons.
    //   does the carton dims in the configure panel impact the 3D rendering?".
    //
    // CP now renders as the IE-correct stack profile:
    //   • Wooden pallet base (taller, darker, slightly wider than the
    //     carton stack so the pallet edges stick out clearly underneath).
    //   • Carton-layer slabs stacked on top — N=hi visible slabs, each
    //     shorter than the previous (flattens at the top to suggest a
    //     real stack), in saturated cardboard tan distinct from FP wood.
    //   • Slab footprint (Z × X) now tied to actual pallet dims
    //     (facility.palletDepth × facility.palletWidth) so changing pallet
    //     type or pallet dims visibly flows to the carton slab footprint.
    //   • Slab height = (cartonHeightIn × hi) / visibleLayers so total
    //     stack height matches the engineering reality.
    if (cpMeta.length > 0 && totalPalletsCP > 0) {
      const _cp = sized?.cartonProfile || {};
      const _hi = Math.max(1, +_cp.hi || 4);
      const _cartonHIn = +(_cp.cartonHeightIn || ctx.facility.cartonHeightIn) || 12;
      const visibleLayers = Math.min(_hi, 5);
      const realStackFt = (_hi * _cartonHIn) / 12;
      const totalStackFt = Math.max(1.5, Math.min(realStackFt, 3.0));
      // Pallet base — taller (0.6 ft = 7", visibly thick) and slightly
      // wider than the carton stack above so pallet edges stick out from
      // under the cartons.
      const palletBaseFt = 0.6;
      // Pallet footprint (real GMA-style: 48" along rack × 40" into rack).
      // Pull from facility.palletDepth (= along-rack length, default 48")
      // and facility.palletWidth (= into-rack width, default 40").
      const palletAlongRackFt = (+ctx.facility.palletDepth || 48) / 12;  // historical naming: palletDepth = pallet length along the beam
      const palletIntoRackFt  = (+ctx.facility.palletWidth || 40) / 12;  // palletWidth = pallet's into-rack dim

      // Pass 1: wooden pallet bases (one per CP position).
      const baseW = palletAlongRackFt * scale;          // along the rack run (Z axis)
      const baseH = palletBaseFt * scale;
      const baseD = palletIntoRackFt * scale;           // into the rack (X axis)
      // Darker wood material (existing matPallet 0x9a6b3f) but expose more
      // by making it taller AND wider than the cartons above.
      const palletBaseGeo = new THREE.BoxGeometry(baseD, baseH, baseW);
      const palletBaseMesh = new THREE.InstancedMesh(palletBaseGeo, matPallet, totalPalletsCP);
      palletBaseMesh.castShadow = true;
      const dummy1 = new THREE.Object3D();
      let bi = 0;
      for (const m of cpMeta) {
        const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
        if (baysPerFace === 0) continue;
        const bayU = sBay * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const palletCenterX = m.frontFaceX + m.intoRackDir * (palletDepthU / 2);
        const levelHeightU  = m.heightU / m.levels;
        const fillCount = Math.floor(baysPerFace * m.levels * m.fillPct);
        const seed = ((Math.floor(m.mx * 1000) ^ Math.floor(m.segCenter * 1000)) >>> 0) ^ (m.side === 'A' ? 0x12345 : 0xABCD9);
        const order = ctx.shuffledBayLevelOrder(baysPerFace, m.levels, seed);
        for (let i = 0; i < fillCount; i++) {
          const [b, lv] = order[i];
          const beamY = levelHeightU * lv;
          const yU = beamY + baseH / 2 + 0.05;
          const bayBaseZ = segZ0 + b * bayU;
          for (const zFrac of _zFractionsInBay) {
            const z = bayBaseZ + zFrac * bayU;
            dummy1.position.set(palletCenterX, yU, z);
            dummy1.scale.set(1, 1, 1);
            dummy1.updateMatrix();
            palletBaseMesh.setMatrixAt(bi++, dummy1.matrix);
          }
        }
      }
      palletBaseMesh.instanceMatrix.needsUpdate = true;
      scene.add(palletBaseMesh);

      // Pass 2: visible carton-layer slabs stacked on top of each pallet base.
      // F.9 (2026-05-05) — slab footprint is now slightly smaller than the
      // wooden pallet base in BOTH dims (Z and X), so the pallet edges
      // stick out around the bottom of the carton stack. This is the
      // primary visual cue that there's a pallet underneath the cartons.
      const layerH = (totalStackFt / visibleLayers) * scale;
      const layerGapU = 0.08 * scale; // visible thin gap between layers
      const layerSlabH = Math.max(0.05 * scale, layerH - layerGapU);
      // Slab Z (along rack) = pallet Z × 0.88 → pallet edges visible on each end
      // Slab X (into rack) = pallet X × 0.88 → pallet edges visible front + back
      const slabW = baseW * 0.88;
      const slabD = baseD * 0.88;
      const slabGeo = new THREE.BoxGeometry(slabD, layerSlabH, slabW);
      // Saturated cardboard tan — clearly different from FP's wood color.
      const matCartonStack = new THREE.MeshStandardMaterial({ color: 0xc8966b, roughness: 0.85, metalness: 0.0 });
      const totalCpSlabs = totalPalletsCP * visibleLayers;
      const cartonSlabMesh = new THREE.InstancedMesh(slabGeo, matCartonStack, totalCpSlabs);
      cartonSlabMesh.castShadow = true;
      const dummy2 = new THREE.Object3D();
      let si = 0;
      for (const m of cpMeta) {
        const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
        if (baysPerFace === 0) continue;
        const bayU = sBay * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const palletCenterX = m.frontFaceX + m.intoRackDir * (palletDepthU / 2);
        const levelHeightU  = m.heightU / m.levels;
        const fillCount = Math.floor(baysPerFace * m.levels * m.fillPct);
        const seed = ((Math.floor(m.mx * 1000) ^ Math.floor(m.segCenter * 1000)) >>> 0) ^ (m.side === 'A' ? 0x12345 : 0xABCD9);
        const order = ctx.shuffledBayLevelOrder(baysPerFace, m.levels, seed);
        for (let i = 0; i < fillCount; i++) {
          const [b, lv] = order[i];
          const beamY = levelHeightU * lv;
          // Stack starts at beamY + baseH (top of wooden pallet base).
          const stackBaseY = beamY + baseH + 0.05;
          const bayBaseZ = segZ0 + b * bayU;
          for (const zFrac of _zFractionsInBay) {
            const z = bayBaseZ + zFrac * bayU;
            for (let ly = 0; ly < visibleLayers; ly++) {
              const yU = stackBaseY + ly * layerH + layerSlabH / 2;
              dummy2.position.set(palletCenterX, yU, z);
              dummy2.scale.set(1, 1, 1);
              dummy2.updateMatrix();
              cartonSlabMesh.setMatrixAt(si++, dummy2.matrix);
            }
          }
        }
      }
      cartonSlabMesh.instanceMatrix.needsUpdate = true;
      scene.add(cartonSlabMesh);
    }

    // ── Shelving structural detail (short uprights + shelf decks + cartons) ──
    // Shelving units are ~6.5 ft tall, 3 ft bays, 7 levels. Decks are
    // continuous horizontal planes (wire-mesh shelf, not single beam) and
    // cartons are small boxes (~12"×8"×18") that sit on the shelf deck —
    // not 48" pallets. Pre-fix shelving racks reused the pallet upright
    // logic but loaded with 4-ft pallet geometry that overlapped 4+
    // levels and merged into stripes.
    // Phase 3 redesign (2026-05-04): carton geometry + grid count comes from
    // sized.cartonProfile (real ti×hi math) rather than hardcoded 2×2.
    // cartonsPerShelfAcross × cartonsPerShelfDeep are computed at the user's
    // chosen orientation (L-along-rack vs W-along-rack) against shelf bay
    // width × deck depth. Default 12×9×12 carton on 36" bay × 24" deep deck
    // L-along-rack: 3 across × 2 deep = 6 cartons/shelf.
    const _cartonProfile = sized?.cartonProfile || {};
    const _cartonAcross = Math.max(1, +_cartonProfile.cartonsPerShelfAcross || 2);
    const _cartonDeep   = Math.max(1, +_cartonProfile.cartonsPerShelfDeep   || 2);
    const _cartonsPerShelfBay = _cartonAcross * _cartonDeep;
    let totalShUprights = 0, totalShDecks = 0, totalShCartons = 0;
    for (const m of shelvingMeta) {
      const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / m.bayWidthFt));
      totalShUprights += (baysPerFace + 1) * 2;
      // One deck per level per face (faces share the deck thickness but
      // are visually distinct because uprights split them at the aisle).
      totalShDecks += m.levels;
      // Cartons: bays × levels × fillPct × cartonsPerShelfBay.
      totalShCartons += Math.floor(baysPerFace * m.levels * m.fillPct) * _cartonsPerShelfBay;
    }

    if (totalShUprights > 0) {
      const uprightGeo = new THREE.BoxGeometry(0.12, 1, 0.12);
      const shUprightMesh = new THREE.InstancedMesh(uprightGeo, matSteel, totalShUprights);
      shUprightMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let si = 0;
      for (const m of shelvingMeta) {
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / m.bayWidthFt));
        const bayU = m.bayWidthFt * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const frontX = m.frontFaceX;
        const backX  = m.frontFaceX + m.intoRackDir * m.rackDepthU;
        for (let b = 0; b <= baysPerFace; b++) {
          const z = segZ0 + b * bayU;
          dummy.position.set(frontX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          shUprightMesh.setMatrixAt(si++, dummy.matrix);
          dummy.position.set(backX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          shUprightMesh.setMatrixAt(si++, dummy.matrix);
        }
      }
      shUprightMesh.instanceMatrix.needsUpdate = true;
      scene.add(shUprightMesh);
    }

    if (totalShDecks > 0) {
      // Shelf deck: spans the FULL rack depth (front face → back face) and
      // the FULL segment length, ~½" thick. Default unit; scaled per-
      // instance to (rackDepthU + 0.04, 1, segLenU).
      const deckGeo = new THREE.BoxGeometry(1, 0.04, 1);
      const shDeckMesh = new THREE.InstancedMesh(deckGeo, matShelfDeck, totalShDecks);
      shDeckMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let di = 0;
      for (const m of shelvingMeta) {
        // Deck X: midway between front and back uprights, centered in
        // the rack depth (frontFaceX → frontFaceX + intoRackDir * rackDepthU).
        const deckX = m.frontFaceX + m.intoRackDir * (m.rackDepthU / 2);
        const deckXU = m.rackDepthU + 0.04;
        for (let lv = 1; lv <= m.levels; lv++) {
          const yU = (m.heightU / m.levels) * lv;
          dummy.position.set(deckX, yU, m.segCenter);
          dummy.scale.set(deckXU, 1, m.segLenU);
          dummy.updateMatrix();
          shDeckMesh.setMatrixAt(di++, dummy.matrix);
        }
      }
      shDeckMesh.instanceMatrix.needsUpdate = true;
      scene.add(shDeckMesh);
    }

    if (totalShCartons > 0) {
      // Phase 3 redesign — carton geometry sized from cartonProfile dims
      // and laid out on the shelf in cartonsPerShelfAcross × cartonsPerShelfDeep
      // grid (depends on user's L/W-along-rack orientation choice).
      // L-along-rack default: 3 across × 2 deep = 6 cartons/shelf for 12×9×12
      // carton on 36"-bay × 24"-deck shelving.
      const cartonLIn = +_cartonProfile.cartonLengthIn || 12;
      const cartonWIn = +_cartonProfile.cartonWidthIn  || 9;
      const cartonHIn = +_cartonProfile.cartonHeightIn || 12;
      const orientation = _cartonProfile.orientation || 'L-along-rack';
      // Map carton dims to (X = into rack, Y = up, Z = along rack run) per orientation.
      // L-along-rack: long edge along rack run (Z), short edge into rack (X).
      // W-along-rack: short edge along rack run (Z), long edge into rack (X).
      const cartonZIn = orientation === 'L-along-rack' ? cartonLIn : cartonWIn;
      const cartonXIn = orientation === 'L-along-rack' ? cartonWIn : cartonLIn;
      // Phase F.5 (2026-05-05) — Brock callout: "carton shelving in 3D looks
      // overly basic. one block per level". Cartons placed edge-to-edge at
      // bayU/acrossN spacing merged visually into a single brown stripe per
      // shelf. Scale each carton box down 12% so visible gaps appear between
      // adjacent cartons in both Z (along the bay) and X (deep into rack).
      const _cartonShrink = 0.88;
      const cartonZU = (cartonZIn / 12) * scale * _cartonShrink;
      const cartonXU = (cartonXIn / 12) * scale * _cartonShrink;
      const cartonYU = (cartonHIn / 12) * scale * _cartonShrink;
      const cartonGeo = new THREE.BoxGeometry(cartonXU, cartonYU, cartonZU);
      const shCartonMesh = new THREE.InstancedMesh(cartonGeo, matCarton, totalShCartons);
      shCartonMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      // Grid layout within each shelf bay: cartonsPerShelfAcross along Z
      // (rack run), cartonsPerShelfDeep along X (into rack). Cartons start
      // from the aisle face and extend back into the rack at cartonXU spacing.
      const acrossN = _cartonAcross;
      const deepN   = _cartonDeep;
      let ci = 0;
      for (const m of shelvingMeta) {
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / m.bayWidthFt));
        if (baysPerFace === 0) continue;
        const bayU = m.bayWidthFt * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const levelHeightU = m.heightU / m.levels;
        // Center the across-grid in the bay; center deep-grid against the rack depth.
        const acrossSpacing = bayU / acrossN;
        const deepSpacing = m.rackDepthU / Math.max(1, deepN);
        // Phase F.3.3 (2026-05-05) — same shuffle logic as pallet rack.
        // Empty shelving bays scatter across the rack instead of clustering.
        const fillCount = Math.floor(baysPerFace * m.levels * m.fillPct);
        const seed = ((Math.floor(m.mx * 1000) ^ Math.floor(m.segCenter * 1000)) >>> 0) ^ (m.side === 'A' ? 0x55AA1 : 0x55AA9);
        const order = ctx.shuffledBayLevelOrder(baysPerFace, m.levels, seed);
        for (let i = 0; i < fillCount; i++) {
          const [b, lv] = order[i];
          const deckY = levelHeightU * lv;
          const yU = deckY + cartonYU / 2 + 0.04;
          const bayBaseZ = segZ0 + b * bayU;
          for (let a = 0; a < acrossN; a++) {
            const z = bayBaseZ + (a + 0.5) * acrossSpacing;
            for (let d = 0; d < deepN; d++) {
              // X position: from aisle face, step back by deepSpacing,
              // centered within each step. d=0 → closest to aisle.
              const cartonCenterX = m.frontFaceX + m.intoRackDir * ((d + 0.5) * deepSpacing);
              dummy.position.set(cartonCenterX, yU, z);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              shCartonMesh.setMatrixAt(ci++, dummy.matrix);
            }
          }
        }
      }
      shCartonMesh.instanceMatrix.needsUpdate = true;
      scene.add(shCartonMesh);
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase F.11 (2026-05-06) — Forward Pick 3D structural detail.
    // Pre-F.11 FP rendered as a flat 10-ft purple box: no internal
    // structure, read as a placeholder. Brock's parked Phase F backlog:
    // "Forward Pick 3D structural detail polish."
    //
    // Now: rebuild as IE-correct rack structure based on FP type:
    //   • carton_flow : 3 levels, 4 ft bays, gravity-flow rails, brown
    //                   carton boxes at front of each lane
    //   • light_case  : 4 levels, 3 ft bays, shelf decks, small cartons on each shelf
    //   • heavy_case  : 4 levels, 4.33 ft bays, beams + pallets (2 pick + 2 reserve)
    // Plus: floating "FORWARD PICK · N faces" sprite overhead.
    // ─────────────────────────────────────────────────────────────────
    if (fpEnabled3D && fpX1 > fpX0 + 4 && fpDepthU > 4) {
      // Phase F.12 (2026-05-06) — Brock callout: "the forward pick area
      // seems to be very wide". Pre-fix we rendered the FP visual across
      // the FULL X-extent the engine reserved (= building-width minus
      // office, ~880 ft on Wayfair). Real forward-pick zones are 50-200 ft
      // wide compact blocks; large FP areas use multiple parallel aisles
      // (which we don't render). Clamp the rendered width to a realistic
      // 200 ft block centered within the engine's X-extent. The engine's
      // overlap logic still reserves the wider strip so adjacent racks
      // don't run through where carton-flow staging would actually live.
      const fpEngineX0 = fpX0;
      const fpEngineX1 = fpX1;
      const fpEngineW  = fpEngineX1 - fpEngineX0;
      const fpRenderMaxFt = 200;
      const fpRenderWidthU = Math.min(fpEngineW, fpRenderMaxFt * scale);
      const fpRenderCx = (fpEngineX0 + fpEngineX1) / 2;
      const fpRenderX0 = fpRenderCx - fpRenderWidthU / 2;
      const fpRenderX1 = fpRenderCx + fpRenderWidthU / 2;
      const fpW = fpRenderWidthU;
      const fpZc = (fpZ0 + fpZ1) / 2;
      const fpType = ctx.zones.forwardPick?.type || 'carton_flow';
      const fpStruct = calc.forwardPickStructure({
        type: fpType,
        skuCount: +ctx.zones.forwardPick?.skuCount || 0,
        velocityTierAPct: +ctx.facility.velocityTierAPct || 20,
        daysInventory: +ctx.zones.forwardPick?.daysInventory || 3,
        fpWidthFt: fpW / scale,
        fpDepthFt: fpDepthU / scale,
      });
      const fpLevels       = fpStruct.levels;
      const fpPickLevels   = fpStruct.pickLevels;
      const fpBayWidthFt   = fpStruct.bayWidthFt;
      const fpLevelHeightFt= fpStruct.levelHeightFt;
      const fpTotalHeightU = fpStruct.totalHeightFt * scale;
      const fpBayWidthU    = fpBayWidthFt * scale;
      const fpLevelHeightU = fpLevelHeightFt * scale;
      const fpBays         = fpStruct.bays;

      // Color palette per type — distinct from FP/CP/Reserve so the user
      // can read which kind of forward-pick at a glance.
      const fpColors = {
        carton_flow: 0x7c3aed, // violet (matches legacy)
        light_case:  0x0ea5e9, // sky-blue
        heavy_case:  0xdb2777, // pink-magenta
      };
      const fpColor = fpColors[fpType] || fpColors.carton_flow;

      // Soft colored volume — lower opacity than pre-F.11 (0.5 → 0.18)
      // because structural detail will carry visual reading from now on.
      // F.12 (2026-05-06) — sized to the clamped render width, not the
      // engine X-extent, so the soft volume doesn't span the whole building.
      const fpVolMat = new THREE.MeshStandardMaterial({
        color: fpColor, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.7,
      });
      const fpVolGeo = new THREE.BoxGeometry(fpW, fpTotalHeightU, fpDepthU);
      const fpVolMesh = new THREE.Mesh(fpVolGeo, fpVolMat);
      fpVolMesh.position.set(fpRenderCx, fpTotalHeightU / 2, fpZc);
      fpVolMesh.castShadow = false;
      scene.add(fpVolMesh);

      // Steel material for FP uprights + beams (matches selective rack
      // visual language so user reads "rack structure" not "abstract box").
      const fpSteelMat = new THREE.MeshStandardMaterial({
        color: 0x4b5563, roughness: 0.55, metalness: 0.45,
      });
      // Carton material for pick faces + replen — saturated cardboard tan
      // with slight type tint so each FP type is visually distinct.
      const fpCartonMat = new THREE.MeshStandardMaterial({
        color: 0xc8966b, roughness: 0.85, metalness: 0.0,
      });

      // Uprights: bay-boundary posts × 2 sides (front + back of FP rack).
      // The rack "depth" along Z = fpDepthU. Posts at Z = fpZ0 (front-of-aisle)
      // and Z = fpZ1 (back). Posts at every bay boundary along X.
      // F.12 (2026-05-06) — uprights pinned to fpRenderX0 (clamped render
      // origin), not fpX0 (engine extent), so they sit inside the visible
      // FP block.
      if (fpBays > 0) {
        const fpUprightGeo = new THREE.BoxGeometry(0.18, fpTotalHeightU, 0.18);
        const fpUprightCount = (fpBays + 1) * 2;
        const fpUprightMesh = new THREE.InstancedMesh(fpUprightGeo, fpSteelMat, fpUprightCount);
        fpUprightMesh.castShadow = true;
        const dummy = new THREE.Object3D();
        let ui = 0;
        for (let b = 0; b <= fpBays; b++) {
          const x = fpRenderX0 + b * fpBayWidthU;
          // Front upright (at fpZ0)
          dummy.position.set(x, fpTotalHeightU / 2, fpZ0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          fpUprightMesh.setMatrixAt(ui++, dummy.matrix);
          // Back upright (at fpZ1)
          dummy.position.set(x, fpTotalHeightU / 2, fpZ1);
          dummy.updateMatrix();
          fpUprightMesh.setMatrixAt(ui++, dummy.matrix);
        }
        fpUprightMesh.instanceMatrix.needsUpdate = true;
        scene.add(fpUprightMesh);

        // Phase F.12 (2026-05-06) — Brock callout: "metallic looking roof
        // over [the FP], which is not consistent with FP designs in
        // reality." Pre-F.12 we rendered a continuous deck slab at every
        // level boundary spanning fpW × fpDepthU — that read as a steel
        // roof over the whole FP zone. Real carton-flow + selective rack
        // have NARROW front + back load beams (~6 in × full lane length),
        // not full-width decks. Only light_case shelving has continuous
        // shelf decks (case-pick from the deck face).
        //
        // New rendering by type:
        //   • carton_flow : front + back beams at each level (no deck)
        //   • light_case  : continuous shelf decks (correct for shelving)
        //   • heavy_case  : front + back beams (selective rack)
        const fpBeamMat = new THREE.MeshStandardMaterial({
          color: 0x4b5563, roughness: 0.6, metalness: 0.4,
        });
        for (let lv = 0; lv <= fpLevels; lv++) {
          const yU = lv * fpLevelHeightU;
          if (yU > fpTotalHeightU + 0.001) continue;
          // Top-most level (lv === fpLevels) only gets a deck for light_case.
          if (lv === fpLevels && fpType !== 'light_case') continue;
          // Bottom (floor, lv === 0) skipped unless light_case.
          if (lv === 0 && fpType !== 'light_case') continue;

          if (fpType === 'light_case') {
            // Continuous shelf deck — IE-correct for case-pick shelving
            const deckGeo = new THREE.BoxGeometry(fpW, 0.08 * scale, fpDepthU);
            const deck = new THREE.Mesh(deckGeo, fpBeamMat);
            deck.position.set(fpRenderCx, yU, fpZc);
            deck.castShadow = true;
            deck.receiveShadow = true;
            scene.add(deck);
          } else {
            // Narrow front + back load beams — IE-correct for carton-flow
            // and selective rack. ~6 in tall × full lane length × ~3 in
            // deep. Sit just inboard of the uprights so they connect.
            const beamH = 0.5 * scale; // 6 inches
            const beamD = 0.25 * scale; // 3 inches
            const beamGeo = new THREE.BoxGeometry(fpW, beamH, beamD);
            // Front beam at fpZ0
            const fb = new THREE.Mesh(beamGeo, fpBeamMat);
            fb.position.set(fpRenderCx, yU, fpZ0 + beamD / 2);
            fb.castShadow = true;
            scene.add(fb);
            // Back beam at fpZ1
            const bb = new THREE.Mesh(beamGeo, fpBeamMat);
            bb.position.set(fpRenderCx, yU, fpZ1 - beamD / 2);
            bb.castShadow = true;
            scene.add(bb);
          }
        }

        // Pick-face cartons + replen depth. Render brown carton cubes at
        // the front face of each bay × each pickable level. Replen depth
        // (along Z, into the rack) = cartonsPerFace × small carton size.
        // Reserve cartons (heavy_case) get 1-2 pallet boxes above the pick
        // levels (drawn with matPallet wood color).
        const cartonW = Math.min(fpBayWidthU * 0.7, 2.5 * scale); // along X
        const cartonH = Math.min(fpLevelHeightU * 0.6, 1.5 * scale); // along Y
        const cartonD = Math.min(2.0 * scale, fpDepthU / Math.max(2, fpStruct.cartonsPerFace + 1)); // along Z
        const fpCartonGeo = new THREE.BoxGeometry(cartonW, cartonH, cartonD);
        // Total carton count: bays × pickLevels × cartonsPerFace
        const totalFpCartons = fpBays * fpPickLevels * fpStruct.cartonsPerFace;
        if (totalFpCartons > 0) {
          const fpCartonMesh = new THREE.InstancedMesh(fpCartonGeo, fpCartonMat, totalFpCartons);
          fpCartonMesh.castShadow = true;
          const dummy = new THREE.Object3D();
          let ci = 0;
          for (let b = 0; b < fpBays; b++) {
            const xCenter = fpRenderX0 + (b + 0.5) * fpBayWidthU;
            for (let lv = 0; lv < fpPickLevels; lv++) {
              const yCenter = lv * fpLevelHeightU + cartonH / 2 + 0.1 * scale;
              for (let d = 0; d < fpStruct.cartonsPerFace; d++) {
                // Replen stack along Z: carton 0 = pick face (front), then
                // 1..N = replen depth (toward back).
                const zCenter = fpZ0 + cartonD / 2 + 0.2 * scale + d * (cartonD + 0.05 * scale);
                if (zCenter > fpZ1 - cartonD / 2) break; // out of FP depth
                dummy.position.set(xCenter, yCenter, zCenter);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                fpCartonMesh.setMatrixAt(ci++, dummy.matrix);
              }
            }
          }
          fpCartonMesh.count = ci; // trim unused slots
          fpCartonMesh.instanceMatrix.needsUpdate = true;
          scene.add(fpCartonMesh);
        }

        // Reserve pallets (heavy_case only): wood pallet boxes above pick
        // levels. Two reserve levels × bays.
        if (fpType === 'heavy_case' && fpLevels > fpPickLevels) {
          const reserveLevels = fpLevels - fpPickLevels;
          const palMat = new THREE.MeshStandardMaterial({
            color: 0x9a6b3f, roughness: 0.78, metalness: 0.0,
          });
          const palW = Math.min(fpBayWidthU * 0.8, 4.0 * scale);
          const palH = Math.min(fpLevelHeightU * 0.7, 4.0 * scale);
          const palD = Math.min(fpDepthU * 0.7, 3.5 * scale);
          const palGeo = new THREE.BoxGeometry(palW, palH, palD);
          const palCount = fpBays * reserveLevels;
          if (palCount > 0) {
            const palMesh = new THREE.InstancedMesh(palGeo, palMat, palCount);
            palMesh.castShadow = true;
            const dummy = new THREE.Object3D();
            let pi = 0;
            for (let b = 0; b < fpBays; b++) {
              const xCenter = fpRenderX0 + (b + 0.5) * fpBayWidthU;
              for (let lv = fpPickLevels; lv < fpLevels; lv++) {
                const yCenter = lv * fpLevelHeightU + palH / 2 + 0.1 * scale;
                dummy.position.set(xCenter, yCenter, fpZc);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                palMesh.setMatrixAt(pi++, dummy.matrix);
              }
            }
            palMesh.instanceMatrix.needsUpdate = true;
            scene.add(palMesh);
          }
        }
      }

      // Floating "FORWARD PICK · N faces" sprite overhead — matches the
      // Phase F.4 zone-label pattern for FP/CP/Reserve.
      const _fpLabelText = `FORWARD PICK · ${fpStruct.activeFaces.toLocaleString()} faces`;
      const _fpLabelColor = fpType === 'carton_flow' ? '#5b21b6'
        : fpType === 'light_case' ? '#0369a1'
        : '#9d174d';
      const _fpSprite = _make3dZoneLabel(_fpLabelText, _fpLabelColor);
      _fpSprite.scale.set(80 * scale, 15 * scale, 1);
      _fpSprite.position.set(fpRenderCx, fpTotalHeightU + 6 * scale, fpZc);
      _fpSprite.renderOrder = 999;
      scene.add(_fpSprite);
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase F.11 (2026-05-06) — labeled cross-aisle floor strips (3D).
    // Same intent as the 2D plan view: render the cross-aisle bands
    // explicitly as light-gray floor planes + overhead sprite labels so
    // the user reads them as engineered circulation, not as gaps.
    // Engine source of truth: calc.circulationLayoutFt.
    // Master Z-bands already computed as `_3dMasterSegments`; gaps
    // between them ARE the cross-aisles.
    // ─────────────────────────────────────────────────────────────────
    if (_3dMasterSegments.length > 1 && _3dGapU > 0.5) {
      const _xaFloorMat = new THREE.MeshStandardMaterial({
        color: 0xd1d5db, roughness: 0.9, metalness: 0.0,
      });
      const _3dRackLeftX = -W / 2 + 6 * scale;
      const _3dRackRightX = W / 2 - 6 * scale;
      const _xaWidthX = _3dRackRightX - _3dRackLeftX;
      for (let i = 0; i < _3dMasterSegments.length - 1; i++) {
        const segA = _3dMasterSegments[i];
        const segB = _3dMasterSegments[i + 1];
        const z0 = segA.z1;
        const z1 = segB.z0;
        const bandLen = z1 - z0;
        if (bandLen <= 0.5) continue;
        const xaGeo = new THREE.BoxGeometry(_xaWidthX, 0.04 * scale, bandLen);
        const xaMesh = new THREE.Mesh(xaGeo, _xaFloorMat);
        xaMesh.position.set((_3dRackLeftX + _3dRackRightX) / 2, 0.02 * scale, (z0 + z1) / 2);
        xaMesh.receiveShadow = true;
        scene.add(xaMesh);
        // Overhead sprite label
        const _xaSprite = _make3dZoneLabel('CROSS-AISLE', '#4b5563');
        _xaSprite.scale.set(40 * scale, 10 * scale, 1);
        _xaSprite.position.set((_3dRackLeftX + _3dRackRightX) / 2, rackHeightU + 4 * scale, (z0 + z1) / 2);
        _xaSprite.renderOrder = 999;
        scene.add(_xaSprite);
      }
    }

    // ---------- Dock doors ----------
    const twoSided3D = (ctx.zones.dockConfig?.sided === 'two');
    const inDoors  = sized.dock.inboundDoors || 0;
    const outDoors = sized.dock.outboundDoors || 0;
    const totalDoors = sized.dock.totalDoors || 0;
    const doorWU = 8 * scale;
    const doorHU = 9 * scale;
    const outboundMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.7 });
    const inboundMat  = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.7 });

    // Phase F.5 (2026-05-05) — Brock callout: "dock doors are still showing
    // up on 3D in front of office". The 2D fix in F.4 clamped inbound xStart
    // to officeRightX, but the 3D placeDoors distributed evenly across the
    // full building width including the office X-range. Now clamp the 3D
    // door bank to start AFTER the office's X extent on the dock face. The
    // office sits at world X ∈ [-W/2 + 2, -W/2 + 2 + officeU], so the door
    // bank starts at officeX1 + small clearance.
    function placeDoors(count, zEdge, mat, xStartFloor) {
      if (count <= 0) return;
      const xLeft = Math.max(-W / 2 + 12 * scale, xStartFloor);
      const xRight = W / 2 - 12 * scale;
      const usableW = Math.max(0, xRight - xLeft);
      if (usableW <= 0) return;
      const spacing = usableW / (count + 1);
      for (let i = 0; i < count; i++) {
        const dx = xLeft + spacing * (i + 1) - doorWU / 2;
        const door = new THREE.Mesh(
          new THREE.BoxGeometry(doorWU, doorHU, 0.6),
          mat,
        );
        door.position.set(dx + doorWU / 2, doorHU / 2, zEdge);
        door.castShadow = true;
        scene.add(door);
      }
    }

    // Office X-range to skip on the dock face. officeZ0 is at -D/2 + stagingU,
    // so the office sits at the dock-side. Clamp dock-face door bank start
    // past officeX1 + small clearance.
    const _officeBlocksDockFace = sized.officeSqft > 0;
    const _outDockXStart = _officeBlocksDockFace ? officeX1 + 4 * scale : -W / 2 + 12 * scale;
    if (twoSided3D) {
      placeDoors(outDoors, -D / 2 + 0.1, outboundMat, _outDockXStart);
      // Inbound bank lives on the OPPOSITE wall (D/2) — office isn't there
      // by default, so no clamp needed.
      placeDoors(inDoors,   D / 2 - 0.1, inboundMat, -W / 2 + 12 * scale);
    } else if (totalDoors > 0) {
      placeDoors(totalDoors, -D / 2 + 0.1, outboundMat, _outDockXStart);
    }

    // ---------- Office structure ----------
    // Phase F.7 (2026-05-05) — Brock callout: "can you replace the
    // transparent of the office structure with something more visually
    // obvious in 3D?". Pre-fix the office was a single transparent purple
    // box (opacity 0.55) — read as a faint shape, not a building. Now:
    // opaque tan masonry walls (matches typical 3PL office construction)
    // + flat darker-tan roof + horizontal window strip on the dock-facing
    // wall + door-cube on the same wall. Reads unambiguously as an office
    // structure and stays distinct from the rack zones.
    if (sized.officeSqft > 0) {
      const oW = officeU, oD = officeU, oH = 12 * scale;
      const oCenterX = officeX0 + oW / 2;
      const oCenterZ = officeZ0 + oD / 2;

      // Solid masonry walls — light tan, opaque
      const matOfficeWall = new THREE.MeshStandardMaterial({ color: 0xd6c8b0, roughness: 0.85, metalness: 0.0 });
      const officeBody = new THREE.Mesh(new THREE.BoxGeometry(oW, oH, oD), matOfficeWall);
      officeBody.position.set(oCenterX, oH / 2, oCenterZ);
      officeBody.castShadow = true;
      officeBody.receiveShadow = true;
      scene.add(officeBody);

      // Flat darker-tan roof slab (slightly larger than walls for shadow lip)
      const matOfficeRoof = new THREE.MeshStandardMaterial({ color: 0x8b7752, roughness: 0.8, metalness: 0.0 });
      const roofThk = 0.5 * scale;
      const officeRoof = new THREE.Mesh(
        new THREE.BoxGeometry(oW + 0.4 * scale, roofThk, oD + 0.4 * scale),
        matOfficeRoof,
      );
      officeRoof.position.set(oCenterX, oH + roofThk / 2, oCenterZ);
      officeRoof.castShadow = true;
      scene.add(officeRoof);

      // Window strip on the dock-facing wall (toward -Z, inside building).
      // Glass-like dark blue rectangle running ~70% of wall width.
      const matWindow = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.2, metalness: 0.4 });
      const winW = oW * 0.7;
      const winH = 4 * scale;
      const winY = oH * 0.55;
      const winThk = 0.05 * scale;
      const windowMesh = new THREE.Mesh(
        new THREE.BoxGeometry(winW, winH, winThk),
        matWindow,
      );
      // Position on the dock-facing wall (smallest -Z face of the office)
      windowMesh.position.set(oCenterX, winY, oCenterZ - oD / 2 - winThk / 2);
      scene.add(windowMesh);

      // Door cube on the dock-facing wall (right of the window strip)
      const matDoor = new THREE.MeshStandardMaterial({ color: 0x4a3825, roughness: 0.7, metalness: 0.0 });
      const doorW = 3.5 * scale;
      const doorH = 7 * scale;
      const doorMesh = new THREE.Mesh(
        new THREE.BoxGeometry(doorW, doorH, winThk),
        matDoor,
      );
      doorMesh.position.set(oCenterX + winW / 2 + doorW / 2 + 0.5 * scale, doorH / 2, oCenterZ - oD / 2 - winThk / 2);
      scene.add(doorMesh);

      // Office sign on the roof — sprite floating above so it reads from
      // any camera angle (matches the storage zone labels added in F.4).
      const _signCanvas = document.createElement('canvas');
      _signCanvas.width = 256; _signCanvas.height = 64;
      const _sx = _signCanvas.getContext('2d');
      _sx.fillStyle = 'rgba(255,255,255,0.95)';
      _sx.fillRect(0, 0, 256, 64);
      _sx.strokeStyle = '#475569';
      _sx.lineWidth = 3;
      _sx.strokeRect(2, 2, 252, 60);
      _sx.fillStyle = '#1e293b';
      _sx.font = 'bold 24px sans-serif';
      _sx.textAlign = 'center';
      _sx.textBaseline = 'middle';
      _sx.fillText('Office', 128, 34);
      const officeSignMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(_signCanvas), depthTest: false, depthWrite: false });
      const officeSign = new THREE.Sprite(officeSignMat);
      officeSign.scale.set(40 * scale, 10 * scale, 1);
      officeSign.position.set(oCenterX, oH + 8 * scale, oCenterZ);
      officeSign.renderOrder = 999;
      scene.add(officeSign);
    }

    // ---------- Camera + OrbitControls ----------
    // Iso-style 3/4 view from front-LEFT-above, looking at the building center.
    // Phase F.4 (2026-05-05) — Brock callout: "office is on the left-hand side
    // in 2D and the right-hand side in 3D". Pre-fix camTheta = 3π/4 placed
    // camera at front-RIGHT, which made world -X (where office sits at
    // -W/2 + 2) appear on the SCREEN RIGHT, opposite of 2D plan where -X
    // is screen LEFT. Flipped to 5π/4 (camera at front-LEFT) so world -X
    // appears on screen LEFT — office on left in both 2D and 3D now.
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    const dist0 = Math.max(W, D) * 1.4;
    const camTheta = (5 * Math.PI) / 4;
    const camPhi   = Math.PI / 4;
    camera.position.set(
      dist0 * Math.cos(camPhi) * Math.sin(camTheta),
      dist0 * Math.sin(camPhi),
      dist0 * Math.cos(camPhi) * Math.cos(camTheta),
    );
    camera.lookAt(0, H * 0.4, 0);

    // P1-5: replace the previous custom orbit math with THREE.OrbitControls
    // (loaded from jsdelivr in index.html). Adds smooth damping, pan with
    // right-click, native zoom, sane azimuth bounds. Falls back to a tiny
    // shim if OrbitControls failed to load (network blip).
    let controls = null;
    if (typeof THREE.OrbitControls === 'function') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.target.set(0, H * 0.4, 0);
      controls.minDistance = Math.max(W, D) * 0.30;
      controls.maxDistance = Math.max(W, D) * 4.0;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;
      controls.update();

      // ---------- Phase A.A5 (2026-05-26) — Camera presets + tween ----------
      // Five named poses scaled by the active building dims. tweenTo(name)
      // animates camera.position + controls.target from the current values
      // to the preset's via cubic ease-out over TWEEN_MS. While the tween
      // is running, OrbitControls.update() continues to fire each frame
      // (smooth damping respects manual interaction) but our overrides win
      // because we set position + target between update() and render().
      const TWEEN_MS = 600;
      const _ease = (t) => 1 - Math.pow(1 - t, 3);                         // ease-out cubic
      /** @type {Record<string, {pos:THREE.Vector3, tgt:THREE.Vector3}>} */
      const _presets = {
        // Default iso-style 3/4 view from front-LEFT-above.
        overview: {
          pos: new THREE.Vector3(
            dist0 * Math.cos(camPhi) * Math.sin(camTheta),
            dist0 * Math.sin(camPhi),
            dist0 * Math.cos(camPhi) * Math.cos(camTheta),
          ),
          tgt: new THREE.Vector3(0, H * 0.4, 0),
        },
        // Mirror-image iso from front-RIGHT-above (theta = 3π/4).
        'iso-right': {
          pos: new THREE.Vector3(
            dist0 * Math.cos(camPhi) * Math.sin((3 * Math.PI) / 4),
            dist0 * Math.sin(camPhi),
            dist0 * Math.cos(camPhi) * Math.cos((3 * Math.PI) / 4),
          ),
          tgt: new THREE.Vector3(0, H * 0.4, 0),
        },
        // Eye-level inside the building, looking down the long (X) axis.
        // Camera near the west wall at ~6 ft up; target at the east wall
        // same height. Reads as standing in a cross-aisle.
        aisle: {
          pos: new THREE.Vector3(-W * 0.45, Math.min(6, H * 0.18), D * 0.05),
          tgt: new THREE.Vector3( W * 0.45, Math.min(6, H * 0.18), D * 0.05),
        },
        // Outside the dock face looking toward the building. WSC convention
        // is dock-on-long-edge — long edge is X, so dock face is along ±Z.
        // South side (positive Z) so the truck-court reads correctly.
        dock: {
          pos: new THREE.Vector3(0, Math.max(H * 0.45, 18), D * 0.95),
          tgt: new THREE.Vector3(0, H * 0.35, 0),
        },
        // Bird's-eye plan view from straight above (matches 2D Plan).
        topdown: {
          pos: new THREE.Vector3(0.01, Math.max(W, D) * 0.9, 0.01),
          tgt: new THREE.Vector3(0, 0, 0),
        },
      };
      /** @type {{from:THREE.Vector3, to:THREE.Vector3, fromTgt:THREE.Vector3, toTgt:THREE.Vector3, start:number}|null} */
      let _activeTween = null;
      function tweenTo(name) {
        const p = _presets[name];
        if (!p) return;
        _activeTween = {
          from: camera.position.clone(),
          to: p.pos.clone(),
          fromTgt: controls.target.clone(),
          toTgt: p.tgt.clone(),
          start: performance.now(),
        };
      }
      function _stepTween() {
        if (!_activeTween) return;
        const t = (performance.now() - _activeTween.start) / TWEEN_MS;
        const k = _ease(Math.min(1, Math.max(0, t)));
        camera.position.lerpVectors(_activeTween.from, _activeTween.to, k);
        controls.target.lerpVectors(_activeTween.fromTgt, _activeTween.toTgt, k);
        controls.update();
        if (t >= 1) _activeTween = null;
      }
      // Expose for render3DView's click delegation + hook _stepTween into
      // the animation loop below (set up after this block).
      el.__wsc3d = { camera, controls, tweenTo, _stepTween };
    } else {
      // Fallback to a minimal manual handler if OrbitControls didn't load.
      let isDragging = false, lastX = 0, lastY = 0, theta = camTheta, phi = camPhi, dist = dist0;
      function applyCamera() {
        camera.position.set(
          dist * Math.cos(phi) * Math.sin(theta),
          dist * Math.sin(phi),
          dist * Math.cos(phi) * Math.cos(theta),
        );
        camera.lookAt(0, H * 0.4, 0);
      }
      renderer.domElement.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
      // P3-1 listener stacking (2026-07-03): this fallback path runs on
      // every render3DView — a bare window listener accumulated one copy
      // per re-render. Single live handler: remove the previous before
      // adding the next.
      if (typeof _wsc3dPrevMouseUp === 'function') window.removeEventListener('mouseup', _wsc3dPrevMouseUp);
      _wsc3dPrevMouseUp = () => { isDragging = false; };
      window.addEventListener('mouseup', _wsc3dPrevMouseUp);
      renderer.domElement.addEventListener('mousemove', e => {
        if (!isDragging) return;
        theta -= (e.clientX - lastX) * 0.006;
        phi    = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, phi + (e.clientY - lastY) * 0.006));
        lastX = e.clientX; lastY = e.clientY;
        applyCamera();
      });
      renderer.domElement.addEventListener('wheel', e => {
        dist = Math.max(W * 0.5, Math.min(W * 5, dist + e.deltaY * 0.6));
        applyCamera();
        e.preventDefault();
      }, { passive: false });
    }

    // ------------------------------------------------------------
    // Concept-B hotspots (2026-07-22, Brock blend ruling 07-15) —
    // engineered figures anchored ON the model. Pure list from
    // hotspot-calc; chips carry data-wsw-cell so the EXISTING shell-w
    // capture delegation opens the W3 inspector chain on click (and the
    // inspector's selection refresh highlights the chip) — no new wiring.
    // Projection runs each frame in the animate loop below (5 chips ×
    // Vector3.project is negligible next to the render call).
    // ------------------------------------------------------------
    let _projectHotspots = null;
    try {
      const hsLayer = el.querySelector('#wsc-3d-hotspots');
      if (hsLayer) {
        const spots = buildHotspots({
          sized, facility: ctx.facility,
          dims: { W, D, H, rackTop: rackHeightFt * scale },
        });
        hsLayer.innerHTML = spots.map((s, i) =>
          `<button type="button" class="wsc-3d-hs" data-wsw-cell="${s.cell}" data-hs-idx="${i}"`
          + ` title="Open the ${s.label} derivation chain in the inspector">`
          + `<span class="wsc-3d-hs__dot"></span>${s.label} · <strong>${s.value}</strong></button>`).join('');
        // Honor the persistent toggle across scene rebuilds (HUD pattern).
        hsLayer.style.display = _wscShowHotspots ? '' : 'none';
        const anchors = spots.map(s => new THREE.Vector3(s.anchor.x, s.anchor.y, s.anchor.z));
        const chips = Array.from(hsLayer.querySelectorAll('[data-hs-idx]'));
        const _pv = new THREE.Vector3();
        _projectHotspots = () => {
          for (let i = 0; i < chips.length; i++) {
            _pv.copy(anchors[i]).project(camera);
            // Behind the camera or outside the frustum → hide (don't move a
            // stale chip to a mirrored position).
            const off = _pv.z > 1 || _pv.x < -1.05 || _pv.x > 1.05 || _pv.y < -1.05 || _pv.y > 1.05;
            chips[i].style.visibility = off ? 'hidden' : 'visible';
            if (!off) {
              chips[i].style.left = (((_pv.x + 1) / 2) * width).toFixed(1) + 'px';
              chips[i].style.top  = (((1 - _pv.y) / 2) * height).toFixed(1) + 'px';
            }
          }
        };
        _projectHotspots();
      }
    } catch (hsErr) {
      console.warn('[WSC] hotspot layer failed:', hsErr);
    }

    // Animate. Capture a local "alive" flag so the loop stops as soon as
    // dispose() is called (e.g. on re-render from a data-field commit).
    let alive = true;
    function animate() {
      if (!ctx.rootEl || !alive) return;
      requestAnimationFrame(animate);
      // Phase A.A5 — step any active camera tween BEFORE controls.update()
      // so the user-facing damping still feels natural after the tween.
      if (el.__wsc3d && typeof el.__wsc3d._stepTween === 'function') el.__wsc3d._stepTween();
      if (controls) controls.update();
      if (_projectHotspots) _projectHotspots();
      renderer.render(scene, camera);
    }
    animate();

    // ------------------------------------------------------------
    // P0-2: RenderedFacts HUD — paint achieved vs sized counts in the
    // top-right corner of the 3D canvas. Updates every time
    // renderContentView() rebuilds the scene (which fires on any
    // facility/zones/volumes mutation), so counts are always live.
    // ------------------------------------------------------------
    try {
      const hud = el.querySelector('#wsc-3d-hud');
      if (hud) {
        // N7 — media scenes get the engineered-media HUD (per-run placed vs
        // target + SHORT banner); legacy scenes keep the pre-N7 rollup.
        if (_isMediaScene) {
          hud.innerHTML = renderMediaFactsHud({
            runs: RUNS3D, required: _scenePlan.recon.requiredPositions,
            shortfall: _ghostShortfall, aisles: _scenePlan.aisles, staging: _scenePlan.staging,
          });
        } else {
          const facts = calc.rollupRenderedFacts(placedRacks, sized);
          // Phase F.2 (2026-05-05) — pass sizing mode into HUD so the status
          // copy can reframe "Over-built" (which now reads as a bug) into
          // "Padded to footprint" (intentional Phase F.1 fill behavior) when
          // in Design mode.
          hud.innerHTML = renderRenderedFactsHud(facts, { palletLevels, shelvingLevels, sized, sizingMode: ctx.facility.sizingMode || 'design' });
        }
        // Honor the persistent Show/Hide HUD toggle across scene rebuilds.
        hud.style.display = _wscShowHud ? '' : 'none';
      }
    } catch (hudErr) {
      console.warn('[WSC] HUD render failed:', hudErr);
    }

    scene3d = {
      dispose() {
        alive = false;
        // 2026-06-11 (assessment Low-tier leftover): scene-graph geometry/
        // material disposal. renderer.dispose() clears the program/VAO cache
        // but does NOT free per-object GPU buffers — every rebuild (config
        // edit, view switch) leaked ~50-200 geometries/materials until tab
        // close. Traverse while the GL context is still alive. Mirrors the
        // existing roomScene.traverse cleanup in the IBL setup.
        scene.traverse((obj) => {
          if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
          for (const m of mats) if (typeof m.dispose === 'function') m.dispose();
        });
        if (controls && typeof controls.dispose === 'function') controls.dispose();
        // Phase A.A2 — release the PMREM-built envmap + generator before
        // disposing the renderer so the GL context owning the textures is
        // still alive when we tear them down.
        if (envMap && typeof envMap.dispose === 'function') envMap.dispose();
        if (pmremGenerator && typeof pmremGenerator.dispose === 'function') pmremGenerator.dispose();
        scene.environment = null;
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
  } catch (err) {
    console.warn('[WSC] 3D rendering failed:', err);
    el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">3D rendering failed. Check console.</div>';
  }
}
