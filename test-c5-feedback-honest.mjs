// test-c5-feedback-honest.mjs — C5 feedback-module honesty pins (Wave C5, 2026-07-22)
//
// Pins the C5 trim pass on hub/feedback via source scan (pure, no network,
// no DOM):
//   1. No "voting" claim: no vote write exists anywhere, so the ui.js
//      docstring must not claim voting, the board must not render a
//      vote-count column, and the "Most Voted" sort option is gone.
//   2. DEMO_FEEDBACK (fabricated demo rows incl. invented comments) is
//      deleted from calc.js and imported nowhere.
//   3. Status chips cover every status the DB enum can actually produce
//      (open, in-review, in-progress, completed, declined) and the phantom
//      'planned' status (unreachable per feedback_status enum in
//      supabase/migrations/20260330123655_create_feedback_table.sql) is
//      gone from calc.js/types.js.
//   4. Single write path: the global FAB routes through api.submitFeedback
//      instead of a second raw db.insert('hub_feedback', ...).

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + name); }
}

const uiSrc    = readFileSync(new URL('./hub/feedback/ui.js', import.meta.url), 'utf8');
const calcSrc  = readFileSync(new URL('./hub/feedback/calc.js', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('./hub/feedback/types.js', import.meta.url), 'utf8');
const apiSrc   = readFileSync(new URL('./hub/feedback/api.js', import.meta.url), 'utf8');
const fabSrc   = readFileSync(new URL('./shared/feedback-fab.js', import.meta.url), 'utf8');

// ── 1. No voting claim / no vote UI ─────────────────────────────────────
const uiDocstring = uiSrc.slice(0, uiSrc.indexOf('*/'));
check('ui docstring: no "voting" claim (no vote write exists)', !/voting/i.test(uiDocstring));
check('ui: no "Most Voted" sort option', !uiSrc.includes('Most Voted'));
check('ui: default sort is date, not upvotes', !/sortBy = 'upvotes'/.test(uiSrc));
check('ui: board rows carry no vote-count column', !/>votes</.test(uiSrc));
check('ui: detail view shows no vote count', !uiSrc.includes('${item.upvotes}'));
check('ui: no vote write anywhere (honest — read-only upvotes)',
  !/upvote/i.test(uiSrc.replace(/sortBy/g, '')));

// ── 2. DEMO_FEEDBACK deleted ─────────────────────────────────────────────
check('calc: DEMO_FEEDBACK export deleted', !calcSrc.includes('DEMO_FEEDBACK'));
check('calc: fabricated demo comments gone', !calcSrc.includes('Brock Eckles'));
check('ui/api: no DEMO_FEEDBACK importers',
  !uiSrc.includes('DEMO_FEEDBACK') && !apiSrc.includes('DEMO_FEEDBACK'));

// ── 3. Status chips complete; phantom 'planned' dropped ─────────────────
check('ui: status filter includes in-review chip', uiSrc.includes("'in-review'"));
check('ui: status filter includes declined chip', uiSrc.includes("'declined'"));
check('ui: status filter row covers all five DB-reachable statuses',
  /\['all', 'open', 'in-review', 'in-progress', 'completed', 'declined'\]/.test(uiSrc));
check('calc: phantom planned status dropped', !/['"]?planned['"]?\s*[:,\]]/.test(calcSrc));
check('types: phantom planned status dropped from FeedbackItem', !typesSrc.includes("'planned'"));

// ── 4. Single write path (FAB → api.submitFeedback) ─────────────────────
check('fab: imports submitFeedback from hub/feedback/api.js',
  /import \{ submitFeedback \} from '\.\.\/hub\/feedback\/api\.js\?v=/.test(fabSrc));
check('fab: no raw db.insert into hub_feedback', !/db\.insert\('hub_feedback'/.test(fabSrc));
check('api: submitFeedback is the single hub_feedback insert',
  (apiSrc.match(/db\.insert\('hub_feedback'/g) || []).length === 1);

console.log(`test-c5-feedback-honest: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
