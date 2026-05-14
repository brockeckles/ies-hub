// test-wsc-kpis.mjs — locks the KPI-strip contract for the WSC chrome.
// Body extracted 2026-05-14 from tools/warehouse-sizing/ui.js (function
// _computeWscKpis) into calc.computeWscKpis. Pre-extraction this was a
// closure-captured ui-only function with no unit coverage; pinning its
// public shape + mode-aware SF logic here so future ui.js shrinks don't
// silently break the chrome strip.

import { computeWscKpis } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Shape: always returns 4 items in canonical order ──
{
  const items = computeWscKpis({});
  t('empty state returns 4 items', items.length === 4, `got ${items.length}`);
  t('item[0] is SF',     items[0].label === 'Sized SF',     `got "${items[0].label}"`);
  t('item[1] is Doors',  items[1].label === 'Dock Doors',   `got "${items[1].label}"`);
  t('item[2] is Racks',  items[2].label === 'Rack Positions', `got "${items[2].label}"`);
  t('item[3] is Util',   items[3].label === 'Utilization',  `got "${items[3].label}"`);
  t('empty SF value is dash',    items[0].value === '—', `got "${items[0].value}"`);
  t('empty doors value is dash', items[1].value === '—', `got "${items[1].value}"`);
  t('empty util value is dash',  items[3].value === '—', `got "${items[3].value}"`);
}

// ── Design mode: empty form → all dashes; user-typed W/D ignored ──
{
  // In design mode the engine sizes from volumes; user W/D should NOT
  // surface as Built SF (chip should still read "Sized SF").
  const items = computeWscKpis({
    facility: { sizingMode: 'design', buildingWidth: 500, buildingDepth: 400 },
    zones: {},
    volumes: {},
  });
  t('design mode shows "Sized SF" label', items[0].label === 'Sized SF', `got "${items[0].label}"`);
}

// ── Constraint mode: user W/D drives Built SF ──
{
  const items = computeWscKpis({
    facility: { sizingMode: 'constraint', buildingWidth: 500, buildingDepth: 400 },
    zones: {},
    volumes: {},
  });
  t('constraint mode shows "Built SF" label', items[0].label === 'Built SF', `got "${items[0].label}"`);
  // 500 × 400 = 200,000 → "200K"
  t('constraint SF uses user W×D', items[0].value === '200K', `got "${items[0].value}"`);
  t('constraint hint cites the W × D', items[0].hint.includes('500 × 400'), `got "${items[0].hint}"`);
}

// ── Constraint mode but no user W/D: falls back to engine sized SF ──
{
  const items = computeWscKpis({
    facility: { sizingMode: 'constraint' },
    zones: {},
    volumes: {},
  });
  // No engine inputs → sizedSf is 0 → dash.
  t('constraint w/o W/D falls back (dash on empty)', items[0].value === '—', `got "${items[0].value}"`);
}

// ── Dock-doors hint formats inbound + outbound ──
{
  const items = computeWscKpis({
    facility: {},
    zones: { dockConfig: { inboundDoors: 8, outboundDoors: 12 } },
    volumes: {},
  });
  t('doors value sums inbound+outbound', items[1].value === '20', `got "${items[1].value}"`);
  t('doors hint shows split',            items[1].hint === '8 inbound + 12 outbound', `got "${items[1].hint}"`);
}

// ── Zero doors render as dash (not "0") ──
{
  const items = computeWscKpis({
    facility: {},
    zones: { dockConfig: { inboundDoors: 0, outboundDoors: 0 } },
    volumes: {},
  });
  t('zero doors → dash', items[1].value === '—', `got "${items[1].value}"`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
