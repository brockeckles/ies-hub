#!/usr/bin/env node
// scripts/run-tests.mjs — ES-module parse pass + run every test-*.mjs.
//
// Two phases:
//   1. Parse pass — every .js under tools/ + hub/ + shared/ is fed through
//      `node --input-type=module --check`. This catches duplicate-binding
//      regressions (S9/S11 class) that the test suite alone can't, since
//      the suite never imports UI modules. Plain `node --check` parses as
//      CommonJS and misses ES-module-specific errors — the
//      `--input-type=module` flag is non-negotiable.
//   2. Test pass — each test-*.mjs runs as its own child process so state
//      and listeners don't leak between tests.
//
// Exits 0 if both phases pass, 1 if either fails.
//
// Usage:
//   node scripts/run-tests.mjs              # parse + run every test
//   node scripts/run-tests.mjs --filter wsc # only test-*wsc*.mjs files
//   node scripts/run-tests.mjs --skip-parse # skip parse pass (debug only)
//   npm test                                # via package.json

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
const skipParse = args.includes('--skip-parse');

// ============================================================
// PHASE 1 — ES-module parse check
// ============================================================
//
// Walks tools/ + hub/ + shared/ recursively and validates each .js file
// as an ES module. Catches the S9/S11 class of bug — duplicate top-level
// bindings (e.g. `import { showToast }` colliding with a local
// `function showToast`) — without needing the DOM.

function walkJs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function parsePass() {
  const dirs = ['tools', 'hub', 'shared'].map(d => join(REPO_ROOT, d));
  const targets = dirs.flatMap(walkJs).sort();
  const start = Date.now();
  const failed = [];
  for (const f of targets) {
    const src = readFileSync(f, 'utf8');
    const r = spawnSync('node', ['--input-type=module', '--check'], {
      input: src,
      encoding: 'utf8',
    });
    if (r.status !== 0) failed.push({ f, stderr: r.stderr || '' });
  }
  const ms = Date.now() - start;
  if (failed.length === 0) {
    console.log(`ES-module parse: ${targets.length} files OK in ${ms}ms`);
    return true;
  }
  console.error(`\nES-module parse FAILED — ${failed.length} of ${targets.length} files broke (${ms}ms)\n`);
  for (const { f, stderr } of failed) {
    console.error(`  ✗ ${relative(REPO_ROOT, f)}`);
    const lines = stderr.trim().split('\n').slice(0, 4);
    for (const line of lines) {
      // Strip the [stdin]: prefix node prints because we piped via stdin —
      // it's a distraction since the user already knows the file.
      console.error(`      ${line.replace(/^\[stdin\]:/, 'line ')}`);
    }
    console.error('');
  }
  return false;
}

if (!skipParse) {
  if (!parsePass()) process.exit(1);
}

// ============================================================
// PHASE 2 — Test pass
// ============================================================

const files = readdirSync(REPO_ROOT)
  .filter(f => /^test-.*\.mjs$/.test(f))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`No test files matched${filter ? ` filter "${filter}"` : ''}.`);
  process.exit(1);
}

console.log(`\nRunning ${files.length} test file${files.length === 1 ? '' : 's'}...\n`);

let passed = 0;
let failed = 0;
const failures = [];
const start = Date.now();

for (const file of files) {
  const fileStart = Date.now();
  const result = spawnSync('node', [join(REPO_ROOT, file)], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const ms = Date.now() - fileStart;
  if (result.status === 0) {
    passed++;
    // Pull the last non-empty line, which is typically "<suite>: N/M passed".
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
    const summary = lines[lines.length - 1] || '(no output)';
    console.log(`  ✓ ${file.padEnd(46)} ${String(ms).padStart(5)}ms  ${summary}`);
  } else {
    failed++;
    failures.push({ file, code: result.status, stdout: result.stdout, stderr: result.stderr });
    console.log(`  ✗ ${file.padEnd(46)} ${String(ms).padStart(5)}ms  EXIT ${result.status}`);
  }
}

const total = Date.now() - start;
console.log(`\n${passed}/${files.length} files passed in ${total}ms`);

if (failed > 0) {
  console.log('\n=== Failures ===');
  for (const f of failures) {
    console.log(`\n--- ${f.file} (exit ${f.code}) ---`);
    if (f.stdout) console.log(f.stdout);
    if (f.stderr) console.log('STDERR:', f.stderr);
  }
  process.exit(1);
}
process.exit(0);
