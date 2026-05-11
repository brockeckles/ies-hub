/**
 * IES Hub v3 — Cost Model shared state (state-layer-lite Phase 1)
 *
 * Owns the 8 module-level bindings that drive the Cost Model UI plus
 * its renderer cluster. Other modules (renderers, future extractions
 * from cost-model/ui.js) read via `getX()` and write via `setX(v)`.
 *
 * Reads stay ergonomic in ui.js itself — ui.js keeps local `let`
 * bindings as aliases initialized at module-init time, then mirrors
 * every write through `setX(v)` so cmState stays the canonical
 * source of truth.
 *
 * Pattern (in ui.js):
 *   import { setModel, cmState, ... } from './state.js';
 *   let model = createEmptyModel();
 *   setModel(model);                 // seed state.js
 *   // ... later ...
 *   model = setModel(newModel);      // setter returns its arg, so
 *                                    // ui.js's local + cmState
 *                                    // both update in one expression
 *
 * Future renderers extracted from ui.js can do:
 *   import { getModel, getRefData } from './state.js';
 *   const m = getModel();            // always current
 *
 * What this layer does NOT do (yet):
 *   - Subscribe/notify — there's no event channel. Reactivity stays
 *     in ui.js's existing render loop.
 *   - Schema validation — bindings are typed only via JSDoc.
 *   - Persistence — saving/loading is still cost-model/api.js's job.
 *
 * @module tools/cost-model/state
 */

/**
 * @typedef {Object} CmState
 * @property {Object|null} model
 * @property {Object} refData
 * @property {boolean} userHasInteracted
 * @property {Object} whatIfTransient
 * @property {Object|null} currentScenario
 * @property {Object|null} currentScenarioSnapshots
 * @property {Object} heuristicOverrides
 * @property {Object|null} currentMarketLaborProfile
 */

/** @type {CmState} */
const _state = {
  model: null,
  refData: {},
  userHasInteracted: false,
  whatIfTransient: {},
  currentScenario: null,
  currentScenarioSnapshots: null,
  heuristicOverrides: {},
  currentMarketLaborProfile: null,
};

/**
 * Live reference to the state bag. Other modules can read fields
 * directly via `cmState.model`, `cmState.refData`, etc. — always
 * returns the current value because the bag is mutated in place by
 * the setters below.
 *
 * Do NOT reassign `cmState` itself — that would break the live-ref
 * contract for every other module that's imported it. Use the
 * setters, which mutate `_state` in place.
 *
 * @type {CmState}
 */
export const cmState = _state;

// ============================================================
// Setters — each returns its arg so callers can do `x = setX(v)`
// ============================================================

export function setModel(m) { _state.model = m; return m; }
export function setRefData(rd) { _state.refData = rd; return rd; }
export function setUserHasInteracted(v) { _state.userHasInteracted = !!v; return _state.userHasInteracted; }
export function setWhatIfTransient(t) { _state.whatIfTransient = t; return t; }
export function setCurrentScenario(s) { _state.currentScenario = s; return s; }
export function setCurrentScenarioSnapshots(s) { _state.currentScenarioSnapshots = s; return s; }
export function setHeuristicOverrides(h) { _state.heuristicOverrides = h; return h; }
export function setCurrentMarketLaborProfile(p) { _state.currentMarketLaborProfile = p; return p; }

// ============================================================
// Getters — for modules that prefer a function call over .field
// ============================================================

export function getModel() { return _state.model; }
export function getRefData() { return _state.refData; }
export function getUserHasInteracted() { return _state.userHasInteracted; }
export function getWhatIfTransient() { return _state.whatIfTransient; }
export function getCurrentScenario() { return _state.currentScenario; }
export function getCurrentScenarioSnapshots() { return _state.currentScenarioSnapshots; }
export function getHeuristicOverrides() { return _state.heuristicOverrides; }
export function getCurrentMarketLaborProfile() { return _state.currentMarketLaborProfile; }

// ============================================================
// resetAll — wipe to defaults. Caller passes the initial model.
// ============================================================

/**
 * Reset all 8 bindings to their initial state. Used on scenario
 * switch when the caller wants a clean slate but needs to keep
 * the state-layer wired up.
 *
 * state.js doesn't know how to build a fresh model — the model
 * factory lives in ui.js — so the caller passes one in.
 *
 * @param {Object|null} [initialModel] — fresh model, or null
 */
export function resetAll(initialModel = null) {
  _state.model = initialModel;
  _state.refData = {};
  _state.userHasInteracted = false;
  _state.whatIfTransient = {};
  _state.currentScenario = null;
  _state.currentScenarioSnapshots = null;
  _state.heuristicOverrides = {};
  _state.currentMarketLaborProfile = null;
}
