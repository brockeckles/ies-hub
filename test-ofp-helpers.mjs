// test-ofp-helpers.mjs — S20 (2026-05-11). Pin the contract for the
// pure OFP helpers extracted from cost-model/ui.js into ofp-helpers.js.
//
//   OFP_MHE_OPTIONS / OFP_IT_OPTIONS / OFP_UOMS — canonical option lists
//   OFP_MHE_ICONS  / OFP_IT_ICONS               — inline-SVG path catalog
//   ofpMheIconKey / ofpItIconKey                — fuzzy type → key
//   ofpEquipLabel / ofpEquipBadge               — display rendering
//   ofpUomIn / ofpUomOut                        — legacy-fallback accessors
//   ofpSlugifyForFlow                           — activity-name slug
//
// Each function is meant to be pure: no closure state, no model
// mutation. These tests run without DOM / network / fixtures.
//
// Run:  node test-ofp-helpers.mjs

import {
  OFP_MHE_OPTIONS,
  OFP_IT_OPTIONS,
  OFP_MHE_ICONS,
  OFP_IT_ICONS,
  OFP_UOMS,
  ofpMheIconKey,
  ofpItIconKey,
  ofpEquipLabel,
  ofpEquipBadge,
  ofpUomIn,
  ofpUomOut,
  ofpSlugifyForFlow,
} from './tools/cost-model/ofp-helpers.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
function eq(a, b) {
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

// ============================================================
// Option lists — shape contract
// ============================================================
ok('OFP_MHE_OPTIONS has 12 entries (None + 11 types)', OFP_MHE_OPTIONS.length === 12);
ok('OFP_MHE_OPTIONS[0] is the empty/None entry',
  OFP_MHE_OPTIONS[0][0] === '' && OFP_MHE_OPTIONS[0][1] === 'None');
ok('OFP_MHE_OPTIONS includes reach_truck → "Reach Truck"',
  OFP_MHE_OPTIONS.some(([v, l]) => v === 'reach_truck' && l === 'Reach Truck'));
ok('OFP_IT_OPTIONS has 8 entries (None + 7 devices)', OFP_IT_OPTIONS.length === 8);
ok('OFP_IT_OPTIONS includes rf_scanner → "RF Scanner"',
  OFP_IT_OPTIONS.some(([v, l]) => v === 'rf_scanner' && l === 'RF Scanner'));
ok('OFP_UOMS is exactly [pallet, case, each, layer, other]',
  eq(OFP_UOMS, ['pallet', 'case', 'each', 'layer', 'other']));

// ============================================================
// Icon catalogs — every option that should have an icon does
// ============================================================
ok('OFP_MHE_ICONS has forklift / reach_truck / order_picker keys',
  ['forklift', 'reach_truck', 'order_picker'].every(k => typeof OFP_MHE_ICONS[k] === 'string'));
ok('OFP_IT_ICONS has rf_scanner / voice / tablet keys',
  ['rf_scanner', 'voice', 'tablet'].every(k => typeof OFP_IT_ICONS[k] === 'string'));

// ============================================================
// ofpMheIconKey — fuzzy mapping
// ============================================================
ok('mhe key: "reach_truck" → "reach_truck"', ofpMheIconKey('reach_truck') === 'reach_truck');
ok('mhe key: "Reach Truck" → "reach_truck"', ofpMheIconKey('Reach Truck') === 'reach_truck');
ok('mhe key: "REACH-TRUCK" → "reach_truck"', ofpMheIconKey('REACH-TRUCK') === 'reach_truck');
ok('mhe key: "sit_down_forklift" → "forklift"', ofpMheIconKey('sit_down_forklift') === 'forklift');
ok('mhe key: "stand_up_forklift" → "forklift"', ofpMheIconKey('stand_up_forklift') === 'forklift');
ok('mhe key: "order_picker" → "order_picker"', ofpMheIconKey('order_picker') === 'order_picker');
ok('mhe key: "order picking" → "order_picker"', ofpMheIconKey('order picking') === 'order_picker');
ok('mhe key: "amr" → "amr"', ofpMheIconKey('amr') === 'amr');
ok('mhe key: "Robot Fleet" → "amr"', ofpMheIconKey('Robot Fleet') === 'amr');
ok('mhe key: "epj" → "epj"', ofpMheIconKey('epj') === 'epj');
ok('mhe key: "electric pallet jack" → "epj"', ofpMheIconKey('electric pallet jack') === 'epj');
ok('mhe key: "turret_truck" → "turret"', ofpMheIconKey('turret_truck') === 'turret');
ok('mhe key: "VNA" → "turret"', ofpMheIconKey('VNA') === 'turret');
ok('mhe key: "walkie_rider" → "walkie"', ofpMheIconKey('walkie_rider') === 'walkie');
ok('mhe key: "manual" → "manual"', ofpMheIconKey('manual') === 'manual');
ok('mhe key: "" → null', ofpMheIconKey('') === null);
ok('mhe key: null → null', ofpMheIconKey(null) === null);
ok('mhe key: "none" → null', ofpMheIconKey('none') === null);
ok('mhe key: unknown "xyzzy" → null', ofpMheIconKey('xyzzy') === null);

// ============================================================
// ofpItIconKey — fuzzy mapping
// ============================================================
ok('it key: "rf_scanner" → "rf_scanner"', ofpItIconKey('rf_scanner') === 'rf_scanner');
ok('it key: "RF Scanner" → "rf_scanner"', ofpItIconKey('RF Scanner') === 'rf_scanner');
ok('it key: "voice_pick" → "voice"', ofpItIconKey('voice_pick') === 'voice');
ok('it key: "vision_system" → "vision"', ofpItIconKey('vision_system') === 'vision');
ok('it key: "camera" → "vision"', ofpItIconKey('camera') === 'vision');
ok('it key: "pick_to_light" → "pick_to_light"', ofpItIconKey('pick_to_light') === 'pick_to_light');
ok('it key: "pick to display" → "pick_to_display"', ofpItIconKey('pick to display') === 'pick_to_display');
ok('it key: "tablet" → "tablet"', ofpItIconKey('tablet') === 'tablet');
ok('it key: "rdt" → "tablet"', ofpItIconKey('rdt') === 'tablet');
ok('it key: "wearable" → "wearable"', ofpItIconKey('wearable') === 'wearable');
ok('it key: "manual" → "manual"', ofpItIconKey('manual') === 'manual');
ok('it key: "" → null', ofpItIconKey('') === null);
ok('it key: "none" → null', ofpItIconKey('none') === null);

// ============================================================
// ofpEquipLabel — option-list lookup + humanize fallback
// ============================================================
ok('label: ("reach_truck","mhe") → "Reach Truck"', ofpEquipLabel('reach_truck', 'mhe') === 'Reach Truck');
ok('label: ("amr","mhe") → "AMR / Robot"', ofpEquipLabel('amr', 'mhe') === 'AMR / Robot');
ok('label: ("rf_scanner","it") → "RF Scanner"', ofpEquipLabel('rf_scanner', 'it') === 'RF Scanner');
ok('label: unknown "xyzzy_thing","mhe" → humanized "Xyzzy Thing"',
  ofpEquipLabel('xyzzy_thing', 'mhe') === 'Xyzzy Thing');
ok('label: empty → ""', ofpEquipLabel('', 'mhe') === '');
ok('label: null → ""', ofpEquipLabel(null, 'it') === '');

// ============================================================
// ofpEquipBadge — HTML rendering contract
// ============================================================
const badgeReach = ofpEquipBadge('reach_truck', 'mhe');
ok('badge: reach_truck includes mhe class', badgeReach.includes('ofp-badge--mhe'));
ok('badge: reach_truck includes data-tip with kind label',
  badgeReach.includes('Material Handling: Reach Truck'));
ok('badge: reach_truck includes svg icon (path from catalog)',
  badgeReach.includes('<svg') && badgeReach.includes('viewBox="0 0 24 24"'));
ok('badge: reach_truck includes label text', badgeReach.includes('Reach Truck'));

const badgeRf = ofpEquipBadge('rf_scanner', 'it');
ok('badge: rf_scanner includes it class', badgeRf.includes('ofp-badge--it'));
ok('badge: rf_scanner data-tip says "IT Device"', badgeRf.includes('IT Device: RF Scanner'));

ok('badge: empty type → ""', ofpEquipBadge('', 'mhe') === '');
ok('badge: "none" type → ""', ofpEquipBadge('none', 'mhe') === '');

// Unknown type → falls through to monogram chip + humanized label
const badgeUnknown = ofpEquipBadge('xyzzy_thing', 'mhe');
ok('badge: unknown type uses monogram fallback class',
  badgeUnknown.includes('ofp-badge__mono'));
ok('badge: unknown type monogram is first letters "XT"',
  badgeUnknown.includes('>XT<'));
ok('badge: unknown type still shows humanized label',
  badgeUnknown.includes('Xyzzy Thing'));

// XSS-safety smoke: a hostile type string is escaped, not injected
const badgeHostile = ofpEquipBadge('<script>alert(1)</script>', 'mhe');
ok('badge: hostile type escapes < and >',
  !badgeHostile.includes('<script>') && badgeHostile.includes('&lt;'));

// ============================================================
// ofpUomIn / ofpUomOut — fallback chain
// ============================================================
ok('uomIn: explicit uom_in wins', ofpUomIn({ uom_in: 'CASE', uom: 'each' }) === 'case');
ok('uomIn: falls back to legacy uom', ofpUomIn({ uom: 'Pallet' }) === 'pallet');
ok('uomIn: empty line → ""', ofpUomIn({}) === '');
ok('uomIn: null safe', ofpUomIn(null) === '');
ok('uomOut: explicit uom_out wins',
  ofpUomOut({ uom_out: 'CASE', uom_in: 'each' }) === 'case');
ok('uomOut: falls back to uom_in', ofpUomOut({ uom_in: 'Each' }) === 'each');
ok('uomOut: falls back to legacy uom', ofpUomOut({ uom: 'Pallet' }) === 'pallet');
ok('uomOut: empty line → ""', ofpUomOut({}) === '');

// ============================================================
// ofpSlugifyForFlow — activity-name → flow-tag slug
// ============================================================
ok('slug: "Receive & Unload pallets" → "receive-unload"',
  ofpSlugifyForFlow('Receive & Unload pallets') === 'receive-unload');
ok('slug: "Each pick" → "each-pick"',
  ofpSlugifyForFlow('Each pick') === 'each-pick');
ok('slug: "VAS — kitting" → "vas-kitting"',
  ofpSlugifyForFlow('VAS — kitting') === 'vas-kitting');
ok('slug: "" → null', ofpSlugifyForFlow('') === null);
ok('slug: null → null', ofpSlugifyForFlow(null) === null);
ok('slug: non-string → null', ofpSlugifyForFlow(123) === null);
ok('slug: stopwords-only "the a of and" → null',
  ofpSlugifyForFlow('the a of and') === null);
ok('slug: caps at 24 chars',
  (ofpSlugifyForFlow('Receiving outbound pallets and casework').length <= 24));

// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failed:', fails);
  process.exit(1);
}
