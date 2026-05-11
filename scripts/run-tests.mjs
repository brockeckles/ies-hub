#!/usr/bin/env node
// scripts/run-tests.mjs — run every test-*.mjs at the repo root.
//
// Pure Node, no extra deps. Each test file is run as its own child process so
// state and listeners don't leak between tests. Exits 0 if all pass, 1 if any
// file fails.
//
// Usage:
//   node scripts/run-tests.mjs              # run every test
//   node scripts/run-tests.mjs --filter wsc # only test-*wsc*.mjs files
//   npm test                                # via package.json

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;

const files = readdirSync(REPO_ROOT)
  .filter(f => /^test-.*\.mjs$/.test(f))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`No test files matched${filter ? ` filter "${filter}"` : ''}.`);
  process.exit(1);
}

console.log(`Running ${files.length} test file${files.length === 1 ? '' : 's'}...\n`);

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
