// test-totp-grace.mjs — TOTP member grace window (UX decision #4, 2026-07-04)
//
// Posture pins (source + migration scans — auth.js imports supabase, so no
// direct import here):
//   1. Admins hard-gated: mfaGraceInfo returns ineligible on isAdmin()
//      BEFORE any RPC call; enrolled users never grace-eligible.
//   2. Fail-closed: RPC error / null data → ineligible.
//   3. Window = 14 days, anchored server-side via mfa_grace_start RPC.
//   4. Migration: stamp-once (coalesce), admin-excluded, SECURITY DEFINER
//      with pinned search_path, execute revoked from public/anon.
//   5. UI: skip button only renders when grace.eligible; challenge modal
//      has NO skip; requiresMfa untouched (gate re-appears every login).
//
// Run:  node test-totp-grace.mjs

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const auth = readFileSync('./shared/auth.js', 'utf8');
const mfaUi = readFileSync('./shared/mfa-ui.js', 'utf8');
const indexHtml = readFileSync('./index.html', 'utf8');
const mig = readFileSync('./supabase/migrations/20260704150000_totp_member_grace_window.sql', 'utf8');

// Extract mfaGraceInfo body.
function fnBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert(start !== -1, `${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

// ---- 1. admin hard gate + enrolled exclusion, ordered before the RPC ----

t('mfaGraceInfo exists, is exported, and MFA_GRACE_DAYS = 14', () => {
  assert(/const MFA_GRACE_DAYS = 14;/.test(auth), 'MFA_GRACE_DAYS must be 14');
  assert(/mfaGraceInfo,/.test(auth), 'mfaGraceInfo must be exported on the auth object');
});

t('admin check and enrolled-factor check both precede the RPC call', () => {
  const b = fnBody(auth, 'mfaGraceInfo');
  const admin = b.indexOf('isAdmin()');
  const enrolled = b.indexOf('hasEnrolledFactors()');
  const rpc = b.indexOf("rpc('mfa_grace_start')");
  assert(admin !== -1 && enrolled !== -1 && rpc !== -1, 'missing one of the three gates');
  assert(admin < rpc && enrolled < rpc, 'admin/enrolled short-circuits must run BEFORE the RPC');
});

t('fail-closed: RPC error or null data returns ineligible', () => {
  const b = fnBody(auth, 'mfaGraceInfo');
  assert(/if \(error \|\| !data\) return none;/.test(b), 'must return none on error/null');
  assert(/const none = \{ eligible: false, daysLeft: 0 \};/.test(b), 'none literal');
});

t('requiresMfa untouched — still a pure aal2 check (gate re-appears each login)', () => {
  const b = fnBody(auth, 'requiresMfa');
  assert(/lvl !== 'aal2'/.test(b), 'requiresMfa must remain the aal2 check');
  assert(!/grace/i.test(b), 'requiresMfa must NOT consult grace state');
});

// ---- 2. migration posture ----

t('migration: stamp-once via coalesce, admin excluded', () => {
  assert(/coalesce\(mfa_grace_started_at, now\(\)\)/.test(mig), 'stamp-once coalesce missing');
  assert(/coalesce\(role, 'member'\) <> 'admin'/.test(mig), 'admin exclusion missing');
});

t('migration: SECURITY DEFINER with pinned search_path, anon/public revoked', () => {
  assert(/security definer/i.test(mig), 'must be SECURITY DEFINER');
  assert(/set search_path = public/.test(mig), 'search_path must be pinned');
  assert(/revoke all on function public\.mfa_grace_start\(\) from public;/.test(mig), 'revoke public');
  assert(/revoke all on function public\.mfa_grace_start\(\) from anon;/.test(mig), 'revoke anon');
  assert(/grant execute on function public\.mfa_grace_start\(\) to authenticated;/.test(mig), 'grant authenticated');
});

// ---- 3. UI wiring ----

t('enroll modal renders skip ONLY when grace.eligible', () => {
  assert(/\$\{grace && grace\.eligible \? `/.test(mfaUi), 'skip must be conditional on grace.eligible');
  assert(/id="mfa-grace-skip"/.test(mfaUi), 'skip button id');
});

t('challenge modal has no skip path', () => {
  const start = mfaUi.indexOf('function renderChallengeModal');
  assert(start !== -1, 'renderChallengeModal not found');
  const challenge = mfaUi.slice(start);
  assert(!challenge.includes('mfa-grace-skip'), 'challenge modal must never offer skip');
});

t('index.html: grace fetched in afterLogin and passed to openMfaGate', () => {
  assert(/await auth\.mfaGraceInfo\(\)/.test(indexHtml), 'afterLogin must call mfaGraceInfo');
  const gate = indexHtml.indexOf('openMfaGate(authOverlay, {');
  assert(gate !== -1 && /openMfaGate\(authOverlay, \{\s*grace,/.test(indexHtml),
    'grace must be passed into openMfaGate');
});

t('SECURITY.md documents the posture for GXO IT', () => {
  const sec = readFileSync('./SECURITY.md', 'utf8');
  assert(/## Authentication posture/.test(sec), 'posture section missing');
  assert(/14-day enrollment grace window/.test(sec), 'grace window undocumented');
  assert(/Admin tier: hard-gated/.test(sec), 'admin hard gate undocumented');
});

process.stdout.write('\n');
if (failed) {
  console.error(failures.join('\n'));
  console.error(`test-totp-grace: ${passed} passed, ${failed} FAILED.`);
  process.exit(1);
}
console.log(`test-totp-grace: ${passed} passed, 0 failed.`);
