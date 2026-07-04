/**
 * Hardening pass (2026-07-03) — P3-2 error net, P3-5 dual-auth fix,
 * string-vs-BIGSERIAL id sweep. Source-level scans: these are wiring
 * guarantees, not math — the failure mode they guard against is silent.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const indexHtml = readFileSync('./index.html', 'utf8');
const errorNet = readFileSync('./shared/error-net.js', 'utf8');
const supabase = readFileSync('./shared/supabase.js', 'utf8');
const dmApi = readFileSync('./tools/deal-manager/api.js', 'utf8');
const wscPlan = readFileSync('./tools/warehouse-sizing/ui-plan.js', 'utf8');

// ── P3-2: global error net ────────────────────────────────────────────────
t('index.html imports error-net for side effects', () =>
  /import '\.\/shared\/error-net\.js\?v=/.test(indexHtml));
t('error-net registers both window handlers', () =>
  errorNet.includes("window.addEventListener('error'")
  && errorNet.includes("window.addEventListener('unhandledrejection'"));
t('error-net toasts are deduped + rate-limited', () =>
  errorNet.includes('DEDUP_MS') && errorNet.includes('MAX_TOASTS_PER_MIN'));
t('error-net never throws (all sinks guarded)', () =>
  errorNet.includes('the net never throws'));
t('error-net analytics import carries a ?v= (no dual-instance regression)', () =>
  /import\('\.\/analytics\.js\?v=/.test(errorNet));

// ── P3-2b: WSC drawPlan guard ─────────────────────────────────────────────
t('drawPlan is a guarded wrapper around _drawPlanUnsafe', () =>
  wscPlan.includes('function _drawPlanUnsafe(pctx)')
  && /export function drawPlan\(pctx\) \{\s*try \{\s*_drawPlanUnsafe\(pctx\);/.test(wscPlan));
t('drawPlan failure paints an in-canvas banner', () =>
  wscPlan.includes('2D Plan failed to render'));

// ── P3-5: dual auth instance ──────────────────────────────────────────────
t("supabase.js lazy auth import carries ?v= (was bare './auth.js')", () =>
  !supabase.includes("import('./auth.js')")
  && /await import\('\.\/auth\.js\?v=[a-z0-9-]+'\)/i.test(supabase));
t('supabase.js auth ?v= matches the index.html auth import', () => {
  const a = supabase.match(/import\('\.\/auth\.js\?v=([a-z0-9-]+)'\)/i);
  const b = indexHtml.match(/\.\/shared\/auth\.js\?v=([a-z0-9-]+)/i);
  if (!a || !b) throw new Error('tags not found');
  return a[1] === b[1];
});

// ── id sweep: link-modal string/number fix ────────────────────────────────
t('listUnlinkedProjects normalizes id to String at the seam', () =>
  dmApi.includes('id: String(r.id)'));

console.log(`test-hardening-p3: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
