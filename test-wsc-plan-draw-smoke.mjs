// test-wsc-plan-draw-smoke.mjs — 2026-05-26
//
// Smoke test that drawPlan() runs to completion without ReferenceError on
// a realistic sized scenario. Born from a 2026-05-26 incident: the Phase 1
// drag-engine commit (HEAD fe287ab, 2026-05-14) referenced an undefined
// `columnRanges` variable inside the rack-column loop, throwing mid-render
// and leaving the 2D Plan canvas blank for every scenario with racks. The
// pure suite never imported ui-plan.js so it didn't catch the regression
// (see feedback_extraction_live_walk_classes.md).
//
// This test provides minimal canvas + DOM stubs and calls drawPlan with a
// pctx whose toSizingInputs returns SizingInputs that produce real
// positions (positive rack columns) — necessary to actually enter the loop
// at ui-plan.js:~500 where the bug lives.

import { drawPlan, addMeasurePoint, toggleMeasureMode, setMeasureCursor, clearMeasurements } from './tools/warehouse-sizing/ui-plan.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; process.stdout.write('.'); }
  catch (e) { fail++; console.error(`\n  ✗ ${name} — ${e.message}\n    ${e.stack?.split('\n').slice(1,4).join('\n    ')}`); }
};

// ── Stubs ──
function makeCanvasStub(w = 900, h = 520) {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'canvas') return canvas;
      if (typeof prop === 'string' && /Style$|^font$|Width$|Align$|Baseline$|Alpha$|DashOffset$/.test(prop)) return '';
      return function(...args) {
        calls.push({ m: prop, args: args.slice(0, 4) });
        if (prop === 'measureText') return { width: (args[0]||'').length * 6 };
        if (prop === 'getImageData') return { data: new Uint8ClampedArray(4) };
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
          return { addColorStop: () => {} };
        }
        return undefined;
      };
    },
    set() { return true; },
  });
  const canvas = { width: w, height: h, getContext: () => ctx, style: {} };
  return { canvas, calls };
}

// Direct SizingInputs that produce real positions + a meaningful
// requirementsDriven block (so renderFacility returns a building size and
// the rack loop has columns to iterate).
function makeRealInputs() {
  return {
    peakUnits: 80000, avgUnits: 40000, outboundUnitsYr: 12_000_000, operatingDaysYr: 250,
    fullPalletPct: 0.6, cartonOnPalletPct: 0.3, cartonOnShelvingPct: 0.1,
    unitsPerPallet: 60, unitsPerCartonPal: 30, cartonsPerPallet: 30,
    unitsPerCartonShelv: 8, cartonsPerLocation: 20,
    clearHeightFt: 36, loadHeightIn: 48, sprinklerClearanceIn: 18,
    storeType: 'single', aisleType: 'narrow', bulkDepth: 4, stackHi: 3,
    mixRackPct: 0.7, honeycombPct: 10, surgePct: 20,
    inPalletsDay: 200, outPalletsDay: 400, palletsPerDoorHour: 12,
    dockHours: 16, dockConfig: 'one',
    officePct: 0.05, optionalZones: [], customZones: [],
    palletType: 'GMA', palletLengthIn: 48, palletWidthIn: 40,
    cartonLengthIn: 12, cartonWidthIn: 9, cartonHeightIn: 12,
    cartonOrientation: 'L-along-rack',
    fullPalletSkus: 1000, cartonPalletSkus: 500, shelvingSkus: 500,
    palletsPerTruck: 26, dwellHoursPerTruck: 1.5, shiftHoursPerDay: 16,
    surgePctDock: 0.2,
  };
}

function makePctx(zonesOverrides = {}) {
  const facility = {
    totalSqft: 600000, buildingWidth: 1200, buildingDepth: 500,
    clearHeight: 36, storageType: 'pallet', aisleWidth: 12,
    sizingMode: 'design', daysOnHand: 30,
  };
  const zones = {
    dockConfig: { sided: 'one', inboundDoors: 8, outboundDoors: 14 },
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    layoutOverrides: {},
    peakUnitsPerDay: 80000, avgUnitsPerDay: 40000,
    forwardPick: { enabled: false },
    ...zonesOverrides,
  };
  const { canvas, calls } = makeCanvasStub();
  const rootEl = { querySelector: (sel) => sel === '#wsc-plan-canvas' ? canvas : null };
  return {
    facility, zones, volumes: {}, rootEl,
    _planEditMode: false,
    _planZoneRects: {},
    resetPlanZoneRects() { this._planZoneRects = {}; },
    _planMeta: null,
    renderFacility: (f, s) => ({
      ...f,
      buildingWidth: s?.requirementsDriven?.suggestedLongFt || f.buildingWidth,
      buildingDepth: s?.requirementsDriven?.suggestedShortFt || f.buildingDepth,
    }),
    toSizingInputs: makeRealInputs,
    canvasMouseCoords: () => ({ x: 0, y: 0 }),
    drawDimH: () => {}, drawDimV: () => {},
    _calls: calls,
  };
}

// ── Tests ──

t('drawPlan: no-FP scenario actually draws racks (catches columnRanges ReferenceError)', () => {
  const pctx = makePctx();
  drawPlan(pctx);
  // A real rack render produces hundreds of calls (per-bay outlines, tick
  // marks, labels). The bug threw at the first rack column — leaving only
  // outer-shell + zone-strip calls. Anything under 50 means the rack loop
  // bailed before completing.
  if (pctx._calls.length < 50) {
    throw new Error(`expected >50 canvas calls (real rack render), got ${pctx._calls.length} — drawPlan likely threw mid-loop`);
  }
});

t('drawPlan: FP-enabled scenario (exercises overlapsFpX branch)', () => {
  const pctx = makePctx({ forwardPick: { enabled: true, skuCount: 3000, type: 'carton_flow' } });
  drawPlan(pctx);
  if (pctx._calls.length < 50) throw new Error(`expected >50 calls, got ${pctx._calls.length}`);
});

t('drawPlan: FP dragged mid-building (exercises FP-split columnRanges path)', () => {
  // User-overridden FP layout puts the carve-out well above the bottom of
  // the rack zone — racks should fill both above AND below it.
  const pctx = makePctx({
    forwardPick: { enabled: true, skuCount: 3000, type: 'carton_flow' },
    layoutOverrides: { forwardPick: { y: 100 } },
  });
  drawPlan(pctx);
  if (pctx._calls.length < 50) throw new Error(`expected >50 calls, got ${pctx._calls.length}`);
});

t('drawPlan: two-sided dock', () => {
  const pctx = makePctx({ dockConfig: { sided: 'two', inboundDoors: 10, outboundDoors: 12 } });
  drawPlan(pctx);
  if (pctx._calls.length < 50) throw new Error(`expected >50 calls, got ${pctx._calls.length}`);
});

t('drawPlan: with committed measurements (Phase B.B17 smoke)', () => {
  // Lay two dimension lines and verify drawPlan + drawMeasurements run
  // to completion. Catches scope-bleed / undefined-var bugs in the new
  // overlay code without needing a real browser.
  clearMeasurements();
  addMeasurePoint({ xFt: 50, yFt: 100 });
  addMeasurePoint({ xFt: 250, yFt: 100 });   // commits a horizontal 200 ft line
  addMeasurePoint({ xFt: 300, yFt: 100 });
  addMeasurePoint({ xFt: 300, yFt: 250 });   // commits a vertical 150 ft line
  const pctx = makePctx();
  drawPlan(pctx);
  if (pctx._calls.length < 50) throw new Error(`expected >50 calls, got ${pctx._calls.length}`);
  clearMeasurements();
});

t('drawPlan: measure-mode preview (anchor + cursor, no commit)', () => {
  // Activate measure mode, lay an anchor, set the cursor — exercises
  // the preview branch of drawMeasurements. Asserts the dashed-line
  // path doesn't throw.
  clearMeasurements();
  toggleMeasureMode();      // → ON
  try {
    addMeasurePoint({ xFt: 100, yFt: 50 });   // sets anchor
    setMeasureCursor({ xPx: 400, yPx: 300 });
    const pctx = makePctx();
    drawPlan(pctx);
    if (pctx._calls.length < 50) throw new Error(`expected >50 calls, got ${pctx._calls.length}`);
  } finally {
    toggleMeasureMode();    // → OFF (also clears anchor/cursor)
    clearMeasurements();
  }
});

if (fail === 0) {
  console.log(`\ntest-wsc-plan-draw-smoke: ${pass} passed, 0 failed.`);
  process.exit(0);
} else {
  console.error(`\ntest-wsc-plan-draw-smoke: ${pass} passed, ${fail} FAILED.`);
  process.exit(1);
}
