// test-c3-netopt-no-alerts.mjs — Wave C3 UI-honesty sweep (2026-07-22).
//
// Lock: tools/network-opt/* contains ZERO native alert() calls. The five
// pre-C3 alert()s in ui.js became showToast('...', 'warning'|'error')
// (validation "do X first" → warning; recommend-failure → error), matching
// the H0 toast-level convention. Native dialogs suspend the renderer and
// freeze CDP/MCP automation (same bug class as the EVE confirm() sweep),
// so this scan keeps them out for good.
//
// Scan pattern follows test-dm-star-authority.mjs: read every .js under
// tools/network-opt, strip block + line comments, then flag any remaining
// bare `alert(` / `window.alert(` / `globalThis.alert(`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const ROOT = new URL('.', import.meta.url).pathname;
const DIR = 'tools/network-opt';
const walk = (dir) => {
  let out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

const files = walk(DIR);
t('NetOpt module files found', files.length >= 4, files.join(', '));

const offenders = [];
for (const f of files) {
  const src = readFileSync(join(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')            // block comments
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');     // line comments (not ://)
  // Bare alert( — not preceded by a word char / $ / . (so showAlert(,
  // foo.alert( custom members don't trip) — plus explicit window./globalThis.
  const re = /(?:\b(?:window|globalThis)\s*\.\s*alert\s*\(|(^|[^\w$.])alert\s*\()/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const ctx = src.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, ' ');
    offenders.push(`${f}: …${ctx.trim()}…`);
  }
}
t('zero native alert() calls in tools/network-opt', offenders.length === 0,
  offenders.slice(0, 5).join(' | '));

// The replacements landed as toasts with explicit levels (not silent drops).
const ui = readFileSync(join(ROOT, DIR, 'ui.js'), 'utf8');
t('demand-first guards toast at warning level',
  ui.includes("showToast('Add demand points first.', 'warning')"));
t('candidate-activation guard toasts at warning level',
  ui.includes("showToast('Activate at least one facility candidate to consider in the optimization.', 'warning')"));
t('export guard toasts at warning level',
  ui.includes("showToast('Run a scenario first to export data.', 'warning')"));
t('recommend-failure toasts at error level',
  ui.includes("showToast('Could not recommend locations — check that demand points have lat/lng coordinates.', 'error')"));

console.log(`\ntest-c3-netopt-no-alerts: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
