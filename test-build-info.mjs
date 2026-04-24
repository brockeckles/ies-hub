// test-build-info.mjs — Slice 4.4e — shared/build-info.js unit tests
//
// Pure unit test. Mocks fetch() globally, imports the module, and asserts:
//   - happy path: parses JSON, caches on repeat call
//   - dev stub: 404 / non-ok / throw → tag === "dev", no throw
//   - caching: fetch only hit once across N concurrent getBuildInfo() calls
//   - _resetForTesting(): next call refetches
//   - getBuildInfoSync(): null before resolve, populated after
//   - field defaults: missing fields fall back to stub values
//   - cache-bust: fetch URL carries ?t=<timestamp>
//
// No network. Run: node test-build-info.mjs

let passed = 0;
let failed = 0;
const fails = [];

function eq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const msg = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    fails.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function truthy(label, v) {
  eq(label, Boolean(v), true);
}

// ── fetch mock ────────────────────────────────────────────────────────
// Each test sets globalThis.fetch to whatever behavior it needs.

let fetchCalls = [];

function makeFetchOk(payload) {
  return (url) => {
    fetchCalls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => payload
    });
  };
}

function makeFetch404() {
  return (url) => {
    fetchCalls.push(url);
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => { throw new Error('no body'); }
    });
  };
}

function makeFetchThrow() {
  return (url) => {
    fetchCalls.push(url);
    return Promise.reject(new Error('network down'));
  };
}

// Silence the [build-info] warn noise from the fall-back paths.
const origWarn = console.warn;
console.warn = () => {};

// Dynamic import so we can _resetForTesting between blocks.
const mod = await import('./shared/build-info.js');
const { getBuildInfo, getBuildInfoSync, _resetForTesting } = mod;

// ── happy path ────────────────────────────────────────────────────────
console.log('\n── happy path: valid build-info.json ─────────────────────────');
{
  _resetForTesting();
  fetchCalls = [];
  const payload = {
    tag: '2026.04.24-5f3dfcf',
    sha: '5f3dfcf',
    shaFull: '5f3dfcfca727a59fc888a8fc1b9d891cef768421',
    date: '2026-04-24',
    timestamp: '2026-04-24T14:52:07Z',
    builtBy: 'host@user'
  };
  globalThis.fetch = makeFetchOk(payload);

  eq('sync accessor returns null before first fetch', getBuildInfoSync(), null);

  const info = await getBuildInfo();
  eq('tag parsed', info.tag, '2026.04.24-5f3dfcf');
  eq('sha parsed', info.sha, '5f3dfcf');
  eq('shaFull parsed', info.shaFull, '5f3dfcfca727a59fc888a8fc1b9d891cef768421');
  eq('date parsed', info.date, '2026-04-24');
  eq('timestamp parsed', info.timestamp, '2026-04-24T14:52:07Z');
  eq('builtBy parsed', info.builtBy, 'host@user');

  const sync = getBuildInfoSync();
  eq('sync accessor returns cached after resolve', sync && sync.tag, '2026.04.24-5f3dfcf');

  truthy('cache-bust ?t= present in URL', fetchCalls[0] && /\?t=\d+/.test(fetchCalls[0]));
  truthy('fetch URL is relative to page', fetchCalls[0] && fetchCalls[0].startsWith('./build-info.json'));
}

// ── caching: repeat call does not refetch ─────────────────────────────
console.log('\n── caching: single fetch across N calls ──────────────────────');
{
  _resetForTesting();
  fetchCalls = [];
  globalThis.fetch = makeFetchOk({ tag: '2026.04.24-abc1234', sha: 'abc1234' });

  // Fire five in parallel — all should share the same in-flight promise.
  const results = await Promise.all([
    getBuildInfo(), getBuildInfo(), getBuildInfo(), getBuildInfo(), getBuildInfo()
  ]);
  eq('5 parallel calls → exactly 1 fetch', fetchCalls.length, 1);
  eq('all 5 return same tag', results.every((r) => r.tag === '2026.04.24-abc1234'), true);

  // Another after resolve — still no new fetch.
  await getBuildInfo();
  eq('post-resolve call → still 1 fetch', fetchCalls.length, 1);
}

// ── dev stub: 404 ─────────────────────────────────────────────────────
console.log('\n── dev stub: HTTP 404 ────────────────────────────────────────');
{
  _resetForTesting();
  fetchCalls = [];
  globalThis.fetch = makeFetch404();

  const info = await getBuildInfo();
  eq('tag falls back to "dev"', info.tag, 'dev');
  eq('sha falls back to "unknown"', info.sha, 'unknown');
  eq('shaFull empty', info.shaFull, '');
  eq('timestamp empty', info.timestamp, '');
  eq('getBuildInfoSync returns the stub after fallback', getBuildInfoSync().tag, 'dev');
}

// ── dev stub: fetch throws ────────────────────────────────────────────
console.log('\n── dev stub: fetch throws (offline / network error) ──────────');
{
  _resetForTesting();
  fetchCalls = [];
  globalThis.fetch = makeFetchThrow();

  const info = await getBuildInfo();
  eq('tag falls back to "dev" on throw', info.tag, 'dev');
  eq('sha falls back to "unknown" on throw', info.sha, 'unknown');
}

// ── dev stub: malformed JSON ──────────────────────────────────────────
console.log('\n── dev stub: json() throws ───────────────────────────────────');
{
  _resetForTesting();
  fetchCalls = [];
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => { throw new Error('bad JSON'); }
  });

  const info = await getBuildInfo();
  eq('malformed response → dev stub', info.tag, 'dev');
}

// ── field defaults: partial payload ───────────────────────────────────
console.log('\n── partial payload: missing fields fall back ─────────────────');
{
  _resetForTesting();
  fetchCalls = [];
  // Only tag + sha. Everything else should fall back to stub values.
  globalThis.fetch = makeFetchOk({ tag: '2026.04.24-deadbee', sha: 'deadbee' });

  const info = await getBuildInfo();
  eq('tag present', info.tag, '2026.04.24-deadbee');
  eq('sha present', info.sha, 'deadbee');
  eq('shaFull defaults to empty', info.shaFull, '');
  eq('date defaults to empty', info.date, '');
  eq('timestamp defaults to empty', info.timestamp, '');
  eq('builtBy defaults to empty', info.builtBy, '');
}

// ── _resetForTesting: next call refetches ─────────────────────────────
console.log('\n── _resetForTesting clears cache ─────────────────────────────');
{
  _resetForTesting();
  fetchCalls = [];
  globalThis.fetch = makeFetchOk({ tag: 'first', sha: 'aaa' });
  const a = await getBuildInfo();
  eq('first fetch tag', a.tag, 'first');

  _resetForTesting();
  globalThis.fetch = makeFetchOk({ tag: 'second', sha: 'bbb' });
  const b = await getBuildInfo();
  eq('after reset, fetch hits again with new payload', b.tag, 'second');
  eq('total fetches across reset = 2', fetchCalls.length, 2);
}

// ── summary ───────────────────────────────────────────────────────────
console.warn = origWarn;
console.log(`\n── test-build-info.mjs: ${passed} passed, ${failed} failed ──`);
if (failed > 0) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
