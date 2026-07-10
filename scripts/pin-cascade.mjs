#!/usr/bin/env node
// scripts/pin-cascade.mjs — cache-bust pin resolver (committed R3, 2026-07-10;
// lived only in session history since R2 — this is the durable copy).
//
// Problem: every import/script ref carries a ?v= pin. When a file's bytes
// change, every REFERENCE to it must move to the new pin — which changes the
// referencing file's bytes, which re-pins ITS references, etc. This walks
// that cascade to fixpoint.
//
// Usage:
//   node scripts/pin-cascade.mjs --pin 20260710-r3 --seed shared/print-fonts.js --seed tools/center-of-gravity/ui.js
//   node scripts/pin-cascade.mjs --pin ... --seed ... --dry   # report only
//
// Rules:
//  - Only references TO changed files are re-pinned; unchanged deps keep old
//    pins (their CDN copies are still valid).
//  - Fixpoint: a file whose bytes change (edit or re-pin) joins the changed
//    set; loop until stable. Prints the final changed-file list — that list
//    is what goes in the commit.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';

const args = process.argv.slice(2);
const pin = args[args.indexOf('--pin') + 1];
const dry = args.includes('--dry');
const seeds = args.flatMap((a, i) => a === '--seed' ? [args[i + 1]] : []);
if (!pin || !seeds.length) { console.error('need --pin <PIN> and at least one --seed <repo/path.js>'); process.exit(1); }

const ROOT = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === '.git' || e === 'node_modules' || e === 'assets') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html|css)$/.test(e)) files.push(p.slice(ROOT.length));
  }
})(ROOT);

const REF = /(["'`])([^"'`\n]+?\.(?:js|css|json))\?v=([A-Za-z0-9.-]+)\1/g;
// A ref can resolve two ways: relative to the importing MODULE (static
// imports) or relative to the PAGE/root (index.html tags + runtime
// `toolPath: './tools/...'` strings used by dynamic loaders, e.g. the CM
// slideover). Return both candidates; a hit on either re-pins. (R3 lesson:
// the module-only version missed the CM slideover ref and tripped
// test-ux2-wsc-quick's pin-agreement check.)
const resolveRefs = (fromFile, ref) => {
  const cands = [posix.normalize(ref.replace(/^\.\//, ''))]; // root/page-relative
  if (ref.startsWith('.')) cands.push(posix.normalize(posix.join(posix.dirname(fromFile), ref)));
  return cands;
};

const changed = new Set(seeds);
let grew = true;
while (grew) {
  grew = false;
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const out = src.replace(REF, (m, q, ref, oldPin) =>
      resolveRefs(f, ref).some(r => changed.has(r)) && oldPin !== pin ? `${q}${ref}?v=${pin}${q}` : m);
    if (out !== src) {
      if (!dry) writeFileSync(join(ROOT, f), out);
      if (!changed.has(f)) { changed.add(f); grew = true; }
    }
  }
}
console.log(`pin-cascade → ?v=${pin}\nchanged set (${changed.size}):`);
for (const f of [...changed].sort()) console.log('  ' + f);
