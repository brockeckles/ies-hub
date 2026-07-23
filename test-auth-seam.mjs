// test-auth-seam.mjs — the Supabase Auth seam (GCP-transition identity prep,
// 2026-07-23). Companion inventory: docs/auth-map.md.
//
// The rule this test enforces: **shared/auth.js is the ONLY place that talks
// to Supabase Auth.** Everything else consumes the seam module
// (`import { auth } from shared/auth.js` → auth.getUser(), auth.listFactors(),
// …). When identity moves to the corporate IdP (GCP Identity Platform), the
// swap happens inside the seam files; nothing outside them may grow a direct
// `client.auth.*` touchpoint in the meantime.
//
// Survey of reality (2026-07-23) that produced the allowlist:
//   - shared/auth.js        — the seam. All sign-in/out, session, MFA/TOTP,
//                             recovery, password flows (client.auth.*).
//   - shared/supabase.js    — creates the client and owns the auth SESSION
//                             CONFIG (persistSession, storageKey namespacing);
//                             calls back into the seam for ensureSession.
//   - shared/search.js      — TODO(seam): one direct
//                             `getClient().auth.getSession()` session-presence
//                             check before live lookups. Should route through
//                             auth.getSession()/ensureSession() someday.
//   - hub/market-explorer/api.js — TODO(seam): same session-presence pattern
//                             (gates deal counts so anon doesn't read empty
//                             RLS results as "0 deals"). Same future fix.
//   Everything else (index.html boot gate, shared/mfa-ui.js, hub/admin,
//   tools/*) consumes the seam module only — deliberately NOT allowlisted.
//
// Scope: index.html + every .js/.mjs/.html under shared/, hub/, tools/,
// scripts/. Excluded: supabase/functions/ (server-side edge functions verify
// JWTs by design — a different seam), root test-*.mjs files and docs (dev
// tooling, not browser-served app code; live-net tests sign in on purpose).
//
// Matching note: patterns target the *Supabase client's* auth namespace
// (`X.auth.<method>`, `supabase.auth`, `getClient().auth`). Calls on the seam
// module itself (`auth.getUser()` — no leading dot) do not match; that is the
// sanctioned way to consume identity.
//
// Run:  node test-auth-seam.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const ROOT = new URL('.', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ============================================================
// The allowlist — the auth seam, plus two TODO(seam) stragglers
// ============================================================
//
// 'full'        — may use any Supabase Auth API (the seam itself).
// 'getSession'  — may ONLY do a session-presence check; any other auth
//                 method appearing in the file fails this test.
const ALLOWLIST = new Map([
  ['shared/auth.js', 'full'],           // the seam
  ['shared/supabase.js', 'full'],       // client factory + auth session config
  ['shared/search.js', 'getSession'],   // TODO(seam): route through auth.getSession()
  ['hub/market-explorer/api.js', 'getSession'], // TODO(seam): route through auth.getSession()
]);

// Supabase Auth surface — method names that only exist on the client's
// auth namespace. `\.auth\.<one of these>` is a direct touchpoint.
const AUTH_METHODS = [
  'getSession', 'getUser', 'setSession', 'refreshSession', 'getClaims',
  'onAuthStateChange', 'signInWithPassword', 'signInWithOtp',
  'signInWithOAuth', 'signInWithIdToken', 'signInWithSSO', 'signOut',
  'signUp', 'updateUser', 'resetPasswordForEmail', 'verifyOtp',
  'exchangeCodeForSession', 'reauthenticate', 'mfa', 'admin',
  'getAuthenticatorAssuranceLevel', 'startAutoRefresh', 'stopAutoRefresh',
];
const FORBIDDEN = [
  { name: 'client auth namespace', re: new RegExp(`\\.auth\\.(${AUTH_METHODS.join('|')})\\b`) },
  { name: 'global supabase.auth', re: /\bsupabase\.auth\b/ },
  { name: 'raw client auth', re: /getClient\(\)\s*\.auth\b/ },
];

// ============================================================
// 1. Allowlist files still exist (a deletion forces a test update)
// ============================================================
for (const file of ALLOWLIST.keys()) {
  t(`allowlist file exists: ${file}`, existsSync(join(ROOT, file)));
}

// ============================================================
// 2. The seam is real — shared/auth.js actually owns the auth calls
// ============================================================
{
  const src = read('shared/auth.js');
  for (const marker of [
    '.auth.getSession()', '.auth.onAuthStateChange(', '.auth.signInWithPassword(',
    '.auth.signOut()', '.auth.mfa.',
  ]) {
    t(`shared/auth.js owns ${marker}`, src.includes(marker));
  }
}

// ============================================================
// 3. Scan — no auth touchpoint outside the allowlist
// ============================================================
function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else if (e.isFile() && /\.(js|mjs|html)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const scanned = ['index.html'];
for (const dir of ['shared', 'hub', 'tools', 'scripts']) scanned.push(...walk(dir));

t('scan walked a plausible file set (walker not silently broken)',
  scanned.length >= 100, `saw ${scanned.length}`);

const violations = [];
for (const file of scanned) {
  if (ALLOWLIST.get(file) === 'full') continue;
  const src = read(file);
  for (const { name, re } of FORBIDDEN) {
    const m = src.match(re);
    if (!m) continue;
    // 'getSession'-scoped files may keep exactly their session-presence check.
    if (ALLOWLIST.get(file) === 'getSession' && /\.auth\.getSession\b|getClient\(\)\s*\.auth\b/.test(m[0])) {
      continue;
    }
    const line = src.slice(0, m.index).split('\n').length;
    violations.push(`${file}:${line} [${name}] ${m[0]}`);
  }
}
t('no Supabase Auth touchpoint outside the seam allowlist',
  violations.length === 0, violations.join('; '));

// ============================================================
// 4. TODO(seam) files stay confined to the session-presence check
// ============================================================
for (const [file, scope] of ALLOWLIST) {
  if (scope !== 'getSession') continue;
  const src = read(file);
  const others = AUTH_METHODS.filter((mth) => mth !== 'getSession')
    .filter((mth) => new RegExp(`\\.auth\\.${mth}\\b`).test(src));
  t(`${file}: no auth surface beyond .auth.getSession (TODO(seam) not growing)`,
    others.length === 0, `found .auth.${others.join(', .auth.')}`);
  t(`${file}: still contains its session-presence check (else tighten the allowlist)`,
    /\.auth\.getSession\(/.test(src));
}

console.log(`\ntest-auth-seam: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
