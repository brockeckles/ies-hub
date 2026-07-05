// test-ui-tokens.mjs — U0 UI-overhaul foundation coverage (2026-07-05).
// Pins: (1) hub.css token hygiene — semantic set present, no duplicate
// definitions, every var(--x) reference without a fallback resolves to a
// defined token, braces balanced; (2) button dialect — .hub-btn--sm alias
// and .hub-btn--ghost exist (were used by ui-3d.js but never defined);
// (3) U0 utility/component classes present; (4) icons.js — every icon
// renders valid, well-formed SVG with currentColor stroke.
import { readFileSync } from 'node:fs';
import { ICONS, icon } from './shared/icons.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const css = readFileSync('./css/hub.css', 'utf8');

// ── token definitions ──
{
  const defs = [...css.matchAll(/^\s*(--[a-z][a-z0-9-]*)\s*:/gm)].map(m => m[1]);
  const dupes = defs.filter((d, i) => defs.indexOf(d) !== i);
  t('no duplicate token definitions', dupes.length === 0, dupes.join(','));

  const required = [
    '--c-success', '--c-success-strong', '--c-success-bright', '--c-success-bg', '--c-success-ink',
    '--c-danger', '--c-danger-strong', '--c-danger-bg', '--c-danger-ink',
    '--c-warn', '--c-warn-strong', '--c-warn-bg', '--c-warn-ink',
    '--c-info', '--c-info-bg', '--c-info-ink',
    '--c-muted', '--c-ink-deep', '--c-purple', '--c-ink',
    '--c-success-soft', '--c-danger-soft', '--c-warn-soft', '--c-info-soft',
    '--c-info-border', '--c-danger-border', '--c-info-strong', '--c-info-deep',
    '--c-warn-deep', '--c-muted-light', '--c-purple-bright',
    '--accent-primary', '--accent-info',
  ];
  for (const r of required) t(`semantic token ${r} defined`, defs.includes(r));

  // Every var(--x) used in hub.css WITHOUT a fallback must be defined here.
  const used = [...css.matchAll(/var\((--[a-z][a-z0-9-]*)\)/g)].map(m => m[1]);
  const undef = [...new Set(used.filter(u => !defs.includes(u)))];
  t('all no-fallback var() refs resolve', undef.length === 0, undef.join(','));

  // Accent semantics: primary = orange, info = blue (Brock 2026-07-05).
  t('accent-primary -> ies-orange', /--accent-primary:\s*var\(--ies-orange\)/.test(css));
  t('accent-info -> ies-blue', /--accent-info:\s*var\(--ies-blue\)/.test(css));
}

// ── structural sanity ──
{
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  t('braces balanced', open === close, `${open} vs ${close}`);
}

// ── button dialect ──
{
  t('.hub-btn--sm alias defined', /\.hub-btn--sm\b/.test(css));
  t('.hub-btn--ghost defined', /\.hub-btn--ghost\s*{/.test(css));
  t('.hub-btn-sm canonical still defined', /\.hub-btn-sm\b/.test(css));
}

// ── U0 utility/component classes ──
{
  const classes = ['u-right', 'u-left', 'u-center', 'u-semibold', 'u-bold', 'u-cap',
    'u-muted', 'u-faint', 'u-dim', 'u-m0', 'u-mt-2', 'u-mb-4', 'u-p-4', 'u-full',
    'u-row', 'u-row-tight', 'u-inline-row', 'u-flex', 'u-between',
    'u-table', 'u-td-num', 'u-th-rule',
    'hub-field-label', 'hub-kv', 'hub-icon'];
  for (const c of classes) t(`.${c} defined`, new RegExp(`\\.${c}\\s*[,{]|\\.${c}\\s+{`).test(css));
}

// ── icons.js ──
{
  const names = Object.keys(ICONS);
  t('>= 20 icons', names.length >= 20, String(names.length));
  t('names unique', new Set(names).size === names.length);
  for (const n of names) {
    const svg = icon(n);
    const ok = svg.startsWith('<svg') && svg.endsWith('</svg>')
      && svg.includes('stroke="currentColor"') && svg.includes('viewBox="0 0 24 24"')
      && svg.includes('aria-hidden="true"');
    t(`icon(${n}) valid svg`, ok);
  }
  // element tags self-close or balance inside each body
  for (const [n, body] of Object.entries(ICONS)) {
    const unclosed = /<(path|circle|rect|line|polyline|polygon)\b[^>]*[^/]>/.test(body);
    t(`icon(${n}) body self-closed`, !unclosed);
  }
  t('size opt', icon('check', { size: 20 }).includes('width="20"'));
  t('className opt', icon('check', { className: 'x9' }).includes('class="hub-icon x9"'));
  t('title -> role=img', icon('check', { title: 'Done' }).includes('role="img"') && icon('check', { title: 'Done' }).includes('<title>Done</title>'));
  let threw = false;
  try { icon('nope-not-real'); } catch { threw = true; }
  t('unknown icon throws', threw);
}

console.log(`\ntest-ui-tokens: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
