// test-cm-ladder-seed.mjs — 8-role wage-ladder seed (Brock ruling 2026-07-22).
//
// NEW cost models seed a differentiated direct-role ladder (Receiver, Picker,
// Packer, VAS Kitter, Inventory Control, Replenishment, Shipper/Loader,
// Putaway Driver) alongside the 4 generic MHE/non-MHE roles, so labor lines
// land linked and divergence-free from day one (the 07-22 prod-migration
// lesson). Source-scan pins — the catalog lives module-locally in ui.js.
//
// THE CRITICAL PIN: CATALOG_VERSION must stay 4. A bump force-reseeds every
// existing project on next load and would WIPE the 07-22 per-model wage
// migration (prod models 12/116/132/133). The ladder reaches new models via
// the undefined-version seed path only.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const ui = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');

// ── 1. THE pin: no version bump ──
t('CATALOG_VERSION stays 4 (a bump would wipe the 07-22 prod migration)',
  ui.includes('const CATALOG_VERSION = 4;'));
t('the no-bump decision is documented at the constant',
  /WITHOUT a version bump, ON PURPOSE/.test(ui));

// ── 2. Ladder entries present at the precedent rates ──
const LADDER = [
  ['Receiver', 19.50], ['Picker', 18.75], ['Packer', 18.50], ['VAS Kitter', 19.00],
  ['Inventory Control', 22.50], ['Replenishment', 20.00], ['Shipper/Loader', 20.25],
  ['Putaway Driver', 21.50],
];
const stdBlock = ui.slice(ui.indexOf('const STANDARD_POSITIONS'), ui.indexOf('const CATALOG_VERSION'));
for (const [name, rate] of LADDER) {
  const re = new RegExp(`name: '${name.replace('/', '\\/')}'[^\\n]*hourly_wage: ${rate.toFixed(2)}`);
  t(`ladder role ${name} @ $${rate.toFixed(2)}`, re.test(stdBlock));
}
t('generic 4 survive (MHE delineator taxonomy intact)',
  ['Equipment Operator', 'Equipment Operator (Temp)', 'Material Handler', 'Temp Material Handler']
    .every(n => stdBlock.includes(`name: '${n}'`)));
t('ladder roles are direct, hourly, permanent (no stray salaried/temp flags)',
  !/Receiver'[^\n]*(is_salaried: true|temp_agency)/.test(stdBlock));

// ── 3. Hint rules: ladder before the generic catch-alls ──
const rules = ui.slice(ui.indexOf('const ROLE_HINT_RULES'), ui.indexOf('/** Return the STANDARD_POSITIONS entry'));
const idx = (s) => rules.indexOf(s);
t('ladder hint rules exist for all 8 roles',
  LADDER.every(([name]) => rules.includes(`'${name}'`)));
t('ladder hints fire BEFORE the generic Equipment Operator / Material Handler rules',
  idx("'Putaway Driver'") < idx("'Equipment Operator'")
  && idx("'Picker'") < idx("'Material Handler'"));
t('pallet picks fall through to Equipment Operator (negative lookahead)',
  rules.includes('(?!.*\\bpallet\\b)'));

// Behavioral spot-checks of the rule regexes themselves (extracted + executed).
{
  const ruleRe = /\[(\/(?:[^/\\]|\\.)+\/i),\s*'direct',\s*'([^']+)'\]/g;
  const directRules = [];
  let m;
  while ((m = ruleRe.exec(rules)) !== null) {
    try { directRules.push([eval(m[1]), m[2]]); } catch { /* skip unparsable */ }
  }
  const match = (name) => {
    for (const [re, role] of directRules) if (re.test(name)) return role;
    return null;
  };
  t('extracted a plausible direct rule set', directRules.length >= 10, `got ${directRules.length}`);
  t("'Receive & unload' → Receiver", match('Receive & unload') === 'Receiver', `got ${match('Receive & unload')}`);
  t("'Each pick' → Picker", match('Each pick') === 'Picker', `got ${match('Each pick')}`);
  t("'Pack & label' → Packer", match('Pack & label') === 'Packer', `got ${match('Pack & label')}`);
  t("'Putaway to reserve' → Putaway Driver", match('Putaway to reserve') === 'Putaway Driver', `got ${match('Putaway to reserve')}`);
  t("'Replen to forward pick' → Replenishment", match('Replen to forward pick') === 'Replenishment', `got ${match('Replen to forward pick')}`);
  t("'Load outbound trailer' → Shipper/Loader", match('Load outbound trailer') === 'Shipper/Loader', `got ${match('Load outbound trailer')}`);
  t("'Cycle counts / audits' → Inventory Control", match('Cycle counts / audits') === 'Inventory Control', `got ${match('Cycle counts / audits')}`);
  t("'Value-added kitting' → VAS Kitter", match('Value-added kitting') === 'VAS Kitter', `got ${match('Value-added kitting')}`);
  t("'Full pallet pick' → Equipment Operator (MHE fall-through)",
    match('Full pallet pick') === 'Equipment Operator', `got ${match('Full pallet pick')}`);
}

console.log(`\ntest-cm-ladder-seed: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
