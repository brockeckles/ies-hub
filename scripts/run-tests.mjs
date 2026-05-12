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
// PHASE 1.5 — Shared-module cache-bust consistency check
// ============================================================
//
// This codebase cache-busts ES module imports by appending ?v=TAG to the
// URL: `import { foo } from './shared/auth.js?v=port1'`. The browser
// caches ES modules by FULL URL including the query string — so if one
// consumer imports `./auth.js?v=port1` and another imports
// `./auth.js?v=auth1`, the browser loads auth.js TWICE as two separate
// module instances. Top-level state (singletons like `cmState`, `auth`,
// `bus`) splits silently.
//
// This bit the codebase three times before this guard existed:
//   - event-bus.js drift (see feedback_event_bus_cache_bust_drift.md)
//   - auth.js drift broke user_id stamping for ~a week
//     (see feedback_auth_js_drift_lesson.md)
//   - state.js drift broke OFP rendering after S24a/b
//     (see feedback_state_js_cache_bust_drift.md)
//
// The guard walks every .js under tools/+hub/+shared/ and index.html,
// extracts `./module.js?v=TAG` import URLs, resolves each to a
// repo-root-relative path, and fails if any single module is imported
// with more than one distinct cache-bust across the codebase.
//
// **Pre-existing drift** is tracked in CACHE_BUST_ALLOWLIST below — those
// 15 cases predate the guard and need targeted cleanup. They log a
// deprecation reminder per run; new drift fails immediately.

// Pre-existing drift carried over from before this guard shipped (S25).
// Each entry MUST cite the consumers + drifted tags so cleanup is
// possible without re-running the scanner.
//
// CLEANUP PLAN: pick the newest cache-bust for each module, update
// every consumer to match, AND cascade-bump the consumer's own
// cache-bust in its parent importer (so the browser re-fetches the
// consumer with the corrected import URL). After cleaning a module,
// remove its entry from this allowlist.
const CACHE_BUST_ALLOWLIST = new Set([
  // shared/* modules — singleton-ish, higher risk (singletons in browser)
  'shared/toast.js',           // 3 versions; widely consumed
  // S26 (2026-05-12) cleaned up shared/auth.js — was 2 versions, now 1 (?v=port27)
  'shared/export.js',          // 3 versions; mostly stateless helpers
  'shared/router.js',          // 2 versions; singleton router instance
  'shared/search.js',          // 2 versions; module-level state
  'shared/unsaved-guard.js',   // 3 versions; self-wires listeners
  'shared/scenario-landing.js',// 3 versions
  // Per-tool drifts — types/api/calc only, no live state singletons
  'tools/center-of-gravity/types.js',
  'tools/most-standards/types.js',
  'tools/warehouse-sizing/types.js',
  'tools/warehouse-sizing/calc.js',
  'tools/fleet-modeler/api.js',
  'tools/cost-model/api.js',
  'tools/cost-model/ofp-helpers.js',
  'tools/cost-model/ui.js',
]);

function cacheBustConsistencyCheck() {
  const dirs = ['tools', 'hub', 'shared'].map(d => join(REPO_ROOT, d));
  const jsFiles = dirs.flatMap(walkJs);
  const htmlFiles = [join(REPO_ROOT, 'index.html')];
  const targets = [...jsFiles, ...htmlFiles];

  // Capture relative `./path.js?v=TAG` and `../path.js?v=TAG` imports across
  // every shape they appear in: ES module static + dynamic + side-effect
  // imports, HTML `path: '...'` router registrations, HTML `<script src=>`,
  // HTML `<link href=>` for modulepreload. Third-party https:// URLs are
  // out of scope.
  const RE = /(?:from\s+|import\s*\(?\s*|src=|href=|path:\s*)['"](\.{1,2}\/[^'"?]+\.js)\?v=([^'"]+)['"]/g;

  const moduleImports = new Map();
  let totalImports = 0;
  for (const f of targets) {
    const src = readFileSync(f, 'utf8');
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) !== null) {
      totalImports++;
      const [, relPath, tag] = m;
      const absTarget = resolve(dirname(f), relPath);
      const targetKey = relative(REPO_ROOT, absTarget);
      const lineNo = src.slice(0, m.index).split('\n').length;
      if (!moduleImports.has(targetKey)) moduleImports.set(targetKey, new Map());
      const tagMap = moduleImports.get(targetKey);
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push({ consumer: relative(REPO_ROOT, f), line: lineNo });
    }
  }

  const newDrifts = [];
  const allowlistedDrifts = [];
  for (const [target, tagMap] of moduleImports.entries()) {
    if (tagMap.size > 1) {
      (CACHE_BUST_ALLOWLIST.has(target) ? allowlistedDrifts : newDrifts).push({ target, tags: tagMap });
    }
  }

  console.log(
    `Cache-bust consistency: ${targets.length} files, ${totalImports} relative .js imports, ` +
    `${moduleImports.size} unique modules`
  );
  if (allowlistedDrifts.length > 0) {
    console.log(`  ${allowlistedDrifts.length} pre-existing drifts (allowlisted in run-tests.mjs — cleanup pending):`);
    for (const { target, tags } of allowlistedDrifts) {
      console.log(`    - ${target} (${tags.size} versions)`);
    }
  }
  if (newDrifts.length > 0) {
    console.error(`\nCache-bust drift FAILED — ${newDrifts.length} module(s) have inconsistent cache-busts:\n`);
    for (const { target, tags } of newDrifts) {
      console.error(`  ✗ ${target} imported with ${tags.size} different cache-busts:`);
      for (const [tag, sites] of tags.entries()) {
        console.error(`      ?v=${tag}`);
        for (const { consumer, line } of sites) {
          console.error(`        ${consumer}:${line}`);
        }
      }
      console.error('');
    }
    console.error(
      'Fix: align every consumer to one cache-bust. The browser caches ES modules by full\n' +
      'URL, so distinct ?v= tags load as separate singletons — splitting state silently.\n' +
      'If this drift is intentional, add it to CACHE_BUST_ALLOWLIST in scripts/run-tests.mjs.\n'
    );
    return false;
  }
  return true;
}

if (!skipParse) {
  if (!cacheBustConsistencyCheck()) process.exit(1);
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
