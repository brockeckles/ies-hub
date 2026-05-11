// test-cost-model-state.mjs — S21 (2026-05-11). Pin the contract for
// tools/cost-model/state.js (state-layer-lite Phase 1).
//
// Contract:
//   - cmState is a stable object reference (do NOT reassign)
//   - 8 setters mirror values to cmState, return the new value
//   - 8 getters return the current cmState value
//   - resetAll(initialModel) wipes all 8 bindings to defaults
//
// Run:  node test-cost-model-state.mjs

import {
  cmState,
  setModel, getModel,
  setRefData, getRefData,
  setUserHasInteracted, getUserHasInteracted,
  setWhatIfTransient, getWhatIfTransient,
  setCurrentScenario, getCurrentScenario,
  setCurrentScenarioSnapshots, getCurrentScenarioSnapshots,
  setHeuristicOverrides, getHeuristicOverrides,
  setCurrentMarketLaborProfile, getCurrentMarketLaborProfile,
  resetAll,
} from './tools/cost-model/state.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

// Initial state
resetAll();
ok('initial: model is null', getModel() === null);
ok('initial: refData is {}', JSON.stringify(getRefData()) === '{}');
ok('initial: userHasInteracted is false', getUserHasInteracted() === false);
ok('initial: whatIfTransient is {}', JSON.stringify(getWhatIfTransient()) === '{}');
ok('initial: currentScenario is null', getCurrentScenario() === null);
ok('initial: currentScenarioSnapshots is null', getCurrentScenarioSnapshots() === null);
ok('initial: heuristicOverrides is {}', JSON.stringify(getHeuristicOverrides()) === '{}');
ok('initial: currentMarketLaborProfile is null', getCurrentMarketLaborProfile() === null);

// Setters: write + read parity
const m1 = { id: 'm1', a: 1 };
ok('setModel returns the new value', setModel(m1) === m1);
ok('getModel returns the new value', getModel() === m1);
ok('cmState.model is the same reference', cmState.model === m1);

setRefData({ markets: ['atl'] });
ok('refData round-trips through cmState', cmState.refData.markets[0] === 'atl');

setUserHasInteracted(true);
ok('userHasInteracted true', getUserHasInteracted() === true);
setUserHasInteracted(0);
ok('userHasInteracted coerces 0 to false', getUserHasInteracted() === false);
setUserHasInteracted('yes');
ok('userHasInteracted coerces truthy string to true', getUserHasInteracted() === true);

setWhatIfTransient({ laborMult: 1.05 });
ok('whatIfTransient round-trips', getWhatIfTransient().laborMult === 1.05);

const scen = { id: 'scen-1', name: 'Baseline' };
setCurrentScenario(scen);
ok('currentScenario round-trips', getCurrentScenario() === scen);

const snaps = { labor: [], facility: [] };
setCurrentScenarioSnapshots(snaps);
ok('currentScenarioSnapshots round-trips', getCurrentScenarioSnapshots() === snaps);

setHeuristicOverrides({ 'cm.labor.uph': 1.2 });
ok('heuristicOverrides round-trips', getHeuristicOverrides()['cm.labor.uph'] === 1.2);

const profile = { market: 'atl', baseWage: 18.5 };
setCurrentMarketLaborProfile(profile);
ok('currentMarketLaborProfile round-trips', getCurrentMarketLaborProfile() === profile);

// cmState live-reference contract
ok('cmState reflects latest model via direct .field access', cmState.model === m1);
ok('cmState reflects latest scenario', cmState.currentScenario === scen);
ok('cmState reflects latest heuristics', cmState.heuristicOverrides['cm.labor.uph'] === 1.2);

// resetAll wipes everything
resetAll();
ok('resetAll: model back to null', getModel() === null);
ok('resetAll: refData back to {}', JSON.stringify(getRefData()) === '{}');
ok('resetAll: userHasInteracted back to false', getUserHasInteracted() === false);
ok('resetAll: whatIfTransient back to {}', JSON.stringify(getWhatIfTransient()) === '{}');
ok('resetAll: currentScenario back to null', getCurrentScenario() === null);
ok('resetAll: currentScenarioSnapshots back to null', getCurrentScenarioSnapshots() === null);
ok('resetAll: heuristicOverrides back to {}', JSON.stringify(getHeuristicOverrides()) === '{}');
ok('resetAll: currentMarketLaborProfile back to null', getCurrentMarketLaborProfile() === null);

// resetAll with seed
const seed = { id: 'seed-1' };
resetAll(seed);
ok('resetAll(seed): model is seed', getModel() === seed);
ok('resetAll(seed): other fields still default', getCurrentScenario() === null && getUserHasInteracted() === false);

// cmState is stable across resets — same object reference
const cmStateRefBefore = cmState;
resetAll();
ok('cmState reference is stable across resetAll', cmState === cmStateRefBefore);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failed:', fails);
  process.exit(1);
}
