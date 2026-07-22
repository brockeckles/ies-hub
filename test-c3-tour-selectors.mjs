/**
 * C3 (2026-07-22) — tour honesty: every selector + route the guided tour
 * targets must exist in CURRENT markup/source. The pre-revamp tour narrated
 * screens that no longer exist (.hub-deal-kanban, .cm-nav, NetOpt, wiki
 * search); this test keeps the rewritten tour anchored to reality.
 *
 * Method: source-text scan (same pattern as test-ux0-netopt-shelved.mjs).
 * Selector strings are extracted from the TOURS steps in shared/tour.js and
 * decomposed into literals — #id, .class, [attr="value"] — each of which
 * must appear in index.html or a .js file under hub/, shared/, or tools/.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// ---- Gather source corpus: index.html + all .js under hub/shared/tools ----
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = ['./index.html', ...walk('./hub'), ...walk('./shared'), ...walk('./tools')];
const corpus = files.map(f => readFileSync(f, 'utf8')).join('\n');
const tourSrc = readFileSync('./shared/tour.js', 'utf8');

// ---- Extract the TOURS definition block and its steps ----
const toursBlock = (() => {
  const m = tourSrc.match(/const TOURS = \{[\s\S]*?\n\};/);
  return m ? m[0] : '';
})();
t('TOURS block found in shared/tour.js', () => toursBlock.length > 0);

const selectors = [...toursBlock.matchAll(/selector:\s*'([^']+)'/g)].map(m => m[1]);
const routes    = [...toursBlock.matchAll(/route:\s*'([^']+)'/g)].map(m => m[1]);
const steps     = [...toursBlock.matchAll(/title:\s*'/g)].length;

t('tour is tight: 6-10 steps', () => steps >= 6 && steps <= 10);
t('at least 5 steps anchor to a selector', () => selectors.length >= 5);

// ---- Every selector literal must exist in current source ----
for (const sel of selectors) {
  // Strip [attr="..."] parts first so their values (e.g. href="#deals")
  // aren't misread as #id / .class tokens.
  const bare = sel.replace(/\[[^\]]*\]/g, '');
  // ID literals: #dm-content → id="dm-content"
  for (const [, id] of bare.matchAll(/#([A-Za-z0-9_-]+)/g)) {
    t(`selector "${sel}": id "${id}" exists in source`, () =>
      corpus.includes(`id="${id}"`));
  }
  // Class literals: .hub-dt-card → the token appears in a class attribute
  for (const [, cls] of bare.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    t(`selector "${sel}": class "${cls}" exists in source`, () =>
      new RegExp(`class="[^"]*\\b${cls}\\b`).test(corpus) ||
      new RegExp(`class='[^']*\\b${cls}\\b`).test(corpus) ||
      corpus.includes(`classList.add('${cls}')`));
  }
  // Attribute literals: [href="#deals"] / [data-route="deals"] → exact
  // attr="value" text must appear in rendered markup source.
  for (const [, attr, val] of sel.matchAll(/\[([A-Za-z-]+)="([^"]*)"\]/g)) {
    t(`selector "${sel}": attribute ${attr}="${val}" exists in source`, () =>
      corpus.includes(`${attr}="${val}"`));
  }
  // Bare attribute selectors: [data-foo] (no value)
  for (const [, attr] of sel.matchAll(/\[([A-Za-z-]+)\](?!=)/g)) {
    t(`selector "${sel}": attribute ${attr} exists in source`, () =>
      corpus.includes(attr));
  }
}

// ---- Every route a step navigates to must be registered ----
const html = readFileSync('./index.html', 'utf8');
for (const r of new Set(routes)) {
  t(`route "${r}" is registered in index.html`, () =>
    html.includes(`'${r}'`) || html.includes(`"${r}"`) ||
    html.includes(`router.register('${r}'`));
}

// ---- Pre-revamp lies must stay gone ----
const DEAD = ['hub-deal-kanban', 'hub-rfp-tile', 'hub-wage-chart', 'cm-nav',
              'cm-summary-kpis', 'wsc-view-toggle', 'netopt-map', 'netopt-solver',
              'most-library', 'admin-tables', 'wiki'];
for (const d of DEAD) {
  t(`tour no longer references dead anchor/term "${d}"`, () =>
    !toursBlock.includes(d));
}
t('tour does not feature shelved NetOpt', () =>
  !/netopt|network.opt/i.test(toursBlock));

// ---- Fallback keeps the header button working from any route ----
t("start() falls back to 'welcome' for unknown tour names", () =>
  /if \(!steps \|\| !steps\.length\) \{[\s\S]*?name = 'welcome';/.test(tourSrc));

console.log(`test-c3-tour-selectors: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
