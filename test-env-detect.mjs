// test-env-detect.mjs — Slice 4.2 env detection (shared/supabase.js)
//
// Pure-function test of detectEnv(loc). No network, no supabase-js
// required — we import directly and feed synthetic location shapes.
//
// Run: node test-env-detect.mjs

// Shim the things the module touches at top level. detectEnv itself is
// pure when passed a `loc` arg, but the module also references `window`
// and defines other exports — give it a minimal environment to load.
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const mod = await import('./shared/supabase.js');
const { detectEnv } = mod;

let passed = 0;
let failed = 0;
const fails = [];

function eq(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    fails.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\n── detectEnv — prod defaults ─────────────────────────────────');

eq(
  'GitHub Pages prod path → prod',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '' }),
  'prod'
);
eq(
  'GitHub Pages prod subpath → prod',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/index.html', search: '' }),
  'prod'
);
eq(
  'GitHub Pages prod with #hash ignored → prod',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '' }),
  'prod'
);
eq(
  'unknown host + unknown path → prod',
  detectEnv({ hostname: 'example.com', pathname: '/', search: '' }),
  'prod'
);

console.log('\n── detectEnv — local dev ─────────────────────────────────────');

eq(
  'localhost → staging',
  detectEnv({ hostname: 'localhost', pathname: '/', search: '' }),
  'staging'
);
eq(
  '127.0.0.1 → staging',
  detectEnv({ hostname: '127.0.0.1', pathname: '/ies-hub/', search: '' }),
  'staging'
);
eq(
  '0.0.0.0 → staging',
  detectEnv({ hostname: '0.0.0.0', pathname: '/', search: '' }),
  'staging'
);
eq(
  'file:// (empty hostname) → staging',
  detectEnv({ hostname: '', pathname: '/Users/x/ies-hub/index.html', search: '' }),
  'staging'
);
eq(
  'LOCALHOST uppercase → staging',
  detectEnv({ hostname: 'LOCALHOST', pathname: '/', search: '' }),
  'staging'
);

console.log('\n── detectEnv — dedicated staging Pages path ──────────────────');

eq(
  '/ies-hub-staging/ subpath → staging',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub-staging/', search: '' }),
  'staging'
);
eq(
  '/ies-hub-staging/index.html → staging',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub-staging/index.html', search: '' }),
  'staging'
);
eq(
  '/ies-hub-staging with trailing slash missing → staging',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub-staging', search: '' }),
  'staging'
);

console.log('\n── detectEnv — ?env= query override ──────────────────────────');

eq(
  '?env=staging on prod URL → staging',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '?env=staging' }),
  'staging'
);
eq(
  '?env=prod on localhost → prod (explicit override wins over localhost)',
  detectEnv({ hostname: 'localhost', pathname: '/', search: '?env=prod' }),
  'prod'
);
eq(
  '?env=STAGING uppercase → staging',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '?env=STAGING' }),
  'staging'
);
eq(
  '?env=prod with other params → prod',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '?foo=1&env=prod&bar=2' }),
  'prod'
);
eq(
  '?env=bogus → falls through to hostname logic (prod)',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '?env=gibberish' }),
  'prod'
);
eq(
  '?env=bogus on localhost → still staging via hostname rule',
  detectEnv({ hostname: 'localhost', pathname: '/', search: '?env=gibberish' }),
  'staging'
);

console.log('\n── detectEnv — precedence ────────────────────────────────────');

eq(
  '?env=prod + /ies-hub-staging path → prod (query wins)',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub-staging/', search: '?env=prod' }),
  'prod'
);
eq(
  '?env=staging + /ies-hub path → staging (query wins)',
  detectEnv({ hostname: 'brockeckles.github.io', pathname: '/ies-hub/', search: '?env=staging' }),
  'staging'
);
eq(
  'localhost + /ies-hub path → staging (localhost wins over path default)',
  detectEnv({ hostname: 'localhost', pathname: '/ies-hub/', search: '' }),
  'staging'
);

console.log('\n── Exports sanity ────────────────────────────────────────────');

eq('detectEnv is a function', typeof detectEnv, 'function');
eq('getEnv is a function', typeof mod.getEnv, 'function');
eq('getEnvLabel is a function', typeof mod.getEnvLabel, 'function');
eq('getProjectRef is a function', typeof mod.getProjectRef, 'function');
eq('db has getEnv helper', typeof mod.db.getEnv, 'function');
eq('db has getEnvLabel helper', typeof mod.db.getEnvLabel, 'function');

console.log('\n──────────────────────────────────────────────────────────────');
console.log(`  ${passed} passed · ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
