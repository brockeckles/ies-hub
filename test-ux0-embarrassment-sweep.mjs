/**
 * UX0-4 (2026-07-03) — embarrassment/ghost-feature sweep.
 * (1) No literal ctx.X / pctx.X identifiers rendered to users in WSC.
 * (2) Dead #training link removed (route never existed).
 * (3) COG multi-year (E3) inputs actually rendered — handlers had nothing
 *     to bind to since 2026-05-29.
 * (4) COG k defaults to Auto (recommended) and adopts the sweep's k.
 */
import { DEFAULT_CONFIG, sensitivityAnalysis } from './tools/center-of-gravity/calc.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// (1) ctx leakage — scan every user-visible string container in WSC modules.
const wscFiles = ['ui-config.js', 'ui-dashboard.js', 'ui-plan.js', 'ui-elevation.js', 'ui-3d.js']
  .map(f => [f, readFileSync(`./tools/warehouse-sizing/${f}`, 'utf8')]);

t('no ctx./pctx. identifiers in rendered text or titles', () => {
  const bad = [];
  for (const [f, src] of wscFiles) {
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // comments are fine
      // Strip \${...} interpolations — JS inside them is not user-visible text.
      // Strip ${...} interpolations (JS, not user-visible); if a ${ opens
      // without closing on this line, drop the tail — it's a multi-line
      // JS argument list, not rendered text.
      const visible = line.replace(/\$\{[^}]*\}/g, '').replace(/\$\{.*$/, '');
      if (/title="[^"]*\b(p?ctx)\.(zones|facility|volumes)/.test(visible)) bad.push(`${f}:${i + 1} (title)`);
      if (/title='[^']*\b(p?ctx)\.(zones|facility|volumes)/.test(visible)) bad.push(`${f}:${i + 1} (title)`);
      if (/tooltip: '[^']*\b(p?ctx)\./.test(visible)) bad.push(`${f}:${i + 1} (tooltip)`);
      if (/[a-zA-Z"']>[^<]*\b(p?ctx)\.(zones|facility|volumes)/.test(visible)) bad.push(`${f}:${i + 1} (text)`);
    }
  }
  if (bad.length) throw new Error(bad.join(', '));
});

// (2) dead #training link
t('#training href gone from index.html', () =>
  !readFileSync('./index.html', 'utf8').includes('#training'));

// (3) COG horizon inputs rendered
const cogUi = readFileSync('./tools/center-of-gravity/ui.js', 'utf8');
t('all 4 planning-horizon inputs rendered', () =>
  ['cog-horizon-years', 'cog-annual-growth', 'cog-annual-escalation', 'cog-discount-rate']
    .every(id => cogUi.includes(`id="${id}"`)));

t('horizon handlers still bound (render + handler pair)', () =>
  cogUi.includes("querySelector('#cog-horizon-years')") && cogUi.includes("querySelector('#cog-discount-rate')"));

// (4) k Auto
t('DEFAULT_CONFIG.kAuto is true', () => DEFAULT_CONFIG.kAuto === true);

t('_resolveAutoK wired into both solve paths', () =>
  (cogUi.match(/_resolveAutoK\(/g) || []).length >= 3); // def + 2 call sites

t('manual k edit pins auto off', () => /config\.kAuto = false; \/\/ manual k pins/.test(cogUi));

t('sweep recommendation adoption logic present', () =>
  /rec && rec\.k >= 1\) config\.numCenters = rec\.k/.test(cogUi));

// sanity: the sweep actually produces an isRecommended entry to adopt
t('sensitivityAnalysis flags a recommended k on a real sweep', () => {
  const pts = [
    { lat: 35.1, lng: -90.0, weight: 4000000 }, { lat: 41.9, lng: -87.6, weight: 3200000 },
    { lat: 33.7, lng: -84.4, weight: 3600000 }, { lat: 40.7, lng: -74.0, weight: 4800000 },
    { lat: 39.7, lng: -104.9, weight: 2000000 }, { lat: 34.0, lng: -118.2, weight: 4400000 },
    { lat: 29.7, lng: -95.3, weight: 3000000 }, { lat: 47.6, lng: -122.3, weight: 1500000 },
  ];
  const sweep = sensitivityAnalysis(pts, 6, { transportCostPerMile: 2.85, fixedCostPerDC: 1500000, unitsPerTruck: 25000 });
  return (sweep || []).some(d => d.isRecommended);
});

console.log(`test-ux0-embarrassment-sweep: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
