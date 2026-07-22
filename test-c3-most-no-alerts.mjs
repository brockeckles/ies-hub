// test-c3-most-no-alerts.mjs — Wave C3 UI-honesty sweep (2026-07-22).
//
// Pin: tools/most-standards/* is alert()-free. The 8 blocking alert() calls
// in ui.js were replaced with shared/toast.js showToast (error/warning
// levels); blocking questions already went through shared/confirm-modal.js
// showConfirm. This scan (repo-scan pattern, test-dm-star-authority style)
// walks every .js under tools/most-standards/, strips comments, and requires
// zero bare alert( / window.alert( / confirm( / prompt( calls so the
// blocking-native-dialog ban can't silently regress.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const ROOT = new URL('.', import.meta.url).pathname;
const DIR = 'tools/most-standards';
const files = readdirSync(join(ROOT, DIR), { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.js'))
  .map(e => join(DIR, e.name));

t('most-standards has the expected module set', files.length >= 4,
  `found: ${files.join(', ')}`);

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')            // block comments
  .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');     // line comments (not ://)

// Bare native blocking dialogs. `(?<![.\w$])` keeps qualified calls like
// foo.alert( / showAlert( out; window./globalThis.-qualified are matched
// explicitly since the lookbehind alone would let them through.
const BANNED = [
  ['alert(',   /(?<![.\w$])alert\s*\(|(?:window|globalThis)\s*\.\s*alert\s*\(/g],
  ['confirm(', /(?<![.\w$])confirm\s*\(|(?:window|globalThis)\s*\.\s*confirm\s*\(/g],
  ['prompt(',  /(?<![.\w$])prompt\s*\(|(?:window|globalThis)\s*\.\s*prompt\s*\(/g],
];

for (const [label, re] of BANNED) {
  const offenders = [];
  for (const f of files) {
    const src = stripComments(readFileSync(join(ROOT, f), 'utf8'));
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const ctx = src.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ');
      offenders.push(`${f}: …${ctx.trim()}…`);
    }
  }
  t(`zero bare ${label} calls in tools/most-standards/*`,
    offenders.length === 0, offenders.slice(0, 5).join(' | '));
}

// The replacements route through the shared primitives — pin the imports so
// a future refactor can't drop back to natives without tripping this file.
const ui = readFileSync(join(ROOT, DIR, 'ui.js'), 'utf8');
t('ui.js imports showToast from shared/toast.js',
  /import \{ showToast \} from '\.\.\/\.\.\/shared\/toast\.js\?v=/.test(ui));
t('ui.js imports showConfirm from shared/confirm-modal.js',
  /import \{ showConfirm, showPrompt \} from '\.\.\/\.\.\/shared\/confirm-modal\.js\?v=/.test(ui));
t('failure toasts use the error level', ui.includes("'error')"));
t('validation toasts use the warning level', ui.includes("'warning')"));

console.log(`\ntest-c3-most-no-alerts: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
