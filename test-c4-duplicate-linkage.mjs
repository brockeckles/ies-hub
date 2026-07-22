// test-c4-duplicate-linkage.mjs — C4 follow-up pins on the C1 (2026-07-22)
// duplicate/copy linkage fixes in WSC + COG:
//
//   * saveConfig / saveScenario INSERT path: explicit linkage on the passed
//     object WINS over the active-deal-context stamp (a copy keeps its
//     SOURCE row's deal/site/CM linkage instead of stealing the active
//     deal's), and updates NEVER rebind (ctx stamp is insert-only).
//   * duplicateConfig / duplicateScenario: strip row identity/ownership
//     from the copied snapshot (id, created_at, updated_at, owner_id,
//     team_id, visibility) and pass the SOURCE row's parent_deal_id /
//     site_id / parent_cost_model_id through the save path.
//
// Source-scan pins against tools/warehouse-sizing/api.js and
// tools/center-of-gravity/api.js — pins what the C1 code actually does.
//
// Run:  node test-c4-duplicate-linkage.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const wscSrc = readFileSync(new URL('./tools/warehouse-sizing/api.js', import.meta.url), 'utf8');
const cogSrc = readFileSync(new URL('./tools/center-of-gravity/api.js', import.meta.url), 'utf8');

/** Extract an exported function's body (from its declaration to the next export). */
function fnBody(src, name, file) {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`${file}: export async function ${name} not found`);
  let end = src.indexOf('\nexport ', start + 1);
  if (end < 0) end = src.length;
  return src.slice(start, end);
}

// ------------------------------------------------------------------
// WSC — saveConfig insert path
// ------------------------------------------------------------------
const wscSave = fnBody(wscSrc, 'saveConfig', 'wsc/api.js');

t('WSC saveConfig: update branch returns before any ctx/linkage stamping', () => {
  const upd = wscSave.indexOf("db.update('wsc_facility_configs', config.id, payload)");
  const ctx = wscSave.indexOf('dealContext.getActive()');
  assert(upd > -1, 'update branch literal missing');
  assert(ctx > -1, 'ctx stamp missing');
  assert(upd < ctx, 'update branch must return BEFORE the ctx stamp — updates never rebind');
});

t('WSC saveConfig: ctx stamps parent_deal_id + site_id on insert', () => {
  assert(/if \(_ctx\) payload\.parent_deal_id = _ctx\.id;/.test(wscSave), 'ctx deal stamp missing');
  assert(/if \(_ctx && _ctx\.siteId\) payload\.site_id = _ctx\.siteId;/.test(wscSave), 'ctx site stamp missing');
});

t('WSC saveConfig: explicit linkage on config wins over the ctx stamp', () => {
  for (const col of ['parent_deal_id', 'site_id', 'parent_cost_model_id']) {
    const re = new RegExp(
      `if \\(config\\.${col} !== undefined\\) payload\\.${col} = config\\.${col};`);
    assert(re.test(wscSave), `explicit-wins line for ${col} missing`);
  }
  // Explicit override must come AFTER the ctx stamp so it wins by assignment order.
  const ctx = wscSave.indexOf('if (_ctx) payload.parent_deal_id = _ctx.id;');
  const explicit = wscSave.indexOf('if (config.parent_deal_id !== undefined)');
  assert(ctx > -1 && explicit > ctx, 'explicit override must follow the ctx stamp');
  // And the insert happens after both.
  const ins = wscSave.indexOf("db.insert('wsc_facility_configs', payload)");
  assert(ins > explicit, 'insert must follow the explicit override');
});

// ------------------------------------------------------------------
// WSC — duplicateConfig
// ------------------------------------------------------------------
const wscDup = fnBody(wscSrc, 'duplicateConfig', 'wsc/api.js');

t('WSC duplicateConfig: strips identity/ownership from config_data snapshot', () => {
  for (const key of ['id', 'created_at', 'updated_at', 'owner_id', 'team_id', 'visibility']) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${key}: _cd`);
    assert(re.test(wscDup), `config_data destructure does not strip '${key}'`);
  }
  assert(/\.\.\.copyData/.test(wscDup), 'stripped rest (...copyData) not spread into the copy');
});

t('WSC duplicateConfig: copy keeps SOURCE linkage and routes through saveConfig', () => {
  assert(/return saveConfig\(\{/.test(wscDup), 'must route through saveConfig');
  assert(/parent_deal_id: original\.parent_deal_id \?\? null/.test(wscDup), 'source parent_deal_id not passed');
  assert(/site_id: original\.site_id \?\? null/.test(wscDup), 'source site_id not passed');
  assert(/parent_cost_model_id: original\.parent_cost_model_id \?\? null/.test(wscDup), 'source parent_cost_model_id not passed');
  assert(/\(Copy\)/.test(wscDup), 'copy must be renamed with (Copy)');
});

t('WSC duplicateConfig: does not spread the raw row (id would route to UPDATE)', () => {
  assert(!/\.\.\.original(?![A-Za-z0-9_])/.test(wscDup),
    'spreading ...original would carry row id/owner into saveConfig');
});

// ------------------------------------------------------------------
// COG — saveScenario insert path
// ------------------------------------------------------------------
const cogSave = fnBody(cogSrc, 'saveScenario', 'cog/api.js');

t('COG saveScenario: update branch returns before any ctx/linkage stamping', () => {
  const upd = cogSave.indexOf("db.update('cog_scenarios', scenario.id, payload)");
  const ctx = cogSave.indexOf('dealContext.getActive()');
  assert(upd > -1 && ctx > -1 && upd < ctx,
    'update branch must complete BEFORE the ctx stamp — updates never rebind');
});

t('COG saveScenario: ctx stamps parent_deal_id + site_id on insert', () => {
  assert(/if \(_ctx\) payload\.parent_deal_id = _ctx\.id;/.test(cogSave), 'ctx deal stamp missing');
  assert(/if \(_ctx && _ctx\.siteId\) payload\.site_id = _ctx\.siteId;/.test(cogSave), 'ctx site stamp missing');
});

t('COG saveScenario: explicit linkage on scenario wins over the ctx stamp', () => {
  for (const col of ['parent_deal_id', 'site_id', 'parent_cost_model_id']) {
    const re = new RegExp(
      `if \\(scenario\\.${col} !== undefined\\) payload\\.${col} = scenario\\.${col};`);
    assert(re.test(cogSave), `explicit-wins line for ${col} missing`);
  }
  const ctx = cogSave.indexOf('if (_ctx) payload.parent_deal_id = _ctx.id;');
  const explicit = cogSave.indexOf('if (scenario.parent_deal_id !== undefined)');
  assert(ctx > -1 && explicit > ctx, 'explicit override must follow the ctx stamp');
  const ins = cogSave.indexOf("db.insert('cog_scenarios', payload)");
  assert(ins > explicit, 'insert must follow the explicit override');
});

// ------------------------------------------------------------------
// COG — duplicateScenario
// ------------------------------------------------------------------
const cogDup = fnBody(cogSrc, 'duplicateScenario', 'cog/api.js');

t('COG duplicateScenario: whitelist rebuild — never spreads raw row or snapshot', () => {
  assert(!/\.\.\.scenario(?![A-Za-z0-9_])/.test(cogDup), 'spreading ...scenario would carry id/owner_id');
  assert(!/\.\.\.sd(?![A-Za-z0-9_])/.test(cogDup), 'spreading ...sd would carry snapshot identity fields');
  assert(!/owner_id\s*:/.test(cogDup), 'copy must not set owner_id — db.insert stamps the new owner');
  assert(!/(?<![A-Za-z0-9_.])id\s*:/.test(cogDup), 'copy must not pass id — would route saveScenario to UPDATE');
});

t('COG duplicateScenario: copy keeps SOURCE linkage and routes through saveScenario', () => {
  assert(/return saveScenario\(\{/.test(cogDup), 'must route through saveScenario');
  assert(/parent_deal_id: scenario\.parent_deal_id \?\? null/.test(cogDup), 'source parent_deal_id not passed');
  assert(/site_id: scenario\.site_id \?\? null/.test(cogDup), 'source site_id not passed');
  assert(/parent_cost_model_id: scenario\.parent_cost_model_id \?\? null/.test(cogDup), 'source parent_cost_model_id not passed');
  assert(/\(Copy\)/.test(cogDup), 'copy must be renamed with (Copy)');
});

// ------------------------------------------------------------------
console.log(`\ntest-c4-duplicate-linkage: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
