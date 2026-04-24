// test-ci-red-smoke-DELETEME.mjs — Slice 4.5 red-PR smoke test
//
// Deliberately fails. Used once to prove the PR gate blocks merges on
// red CI. Closed and deleted immediately after the gate is verified.
let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, why) { fail++; console.log(`  ✗ ${name} — ${why}`); }
ok('sanity: 1 + 1 = 2');
bad('deliberate failure for CI red-gate smoke', 'this is expected to fail');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
