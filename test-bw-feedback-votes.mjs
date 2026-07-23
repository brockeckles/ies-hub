// test-bw-feedback-votes.mjs — real feedback voting (Brock ruling 2026-07-23).
// Successor surface to the retired "no voting UI" pins in
// test-c5-feedback-honest.mjs: voting used to be fictional (the dead
// hub_feedback.upvotes TEXT[] column, never written); now it is real —
// feedback_votes table, one toggleable upvote per user, board sortable by
// votes.
//
// Pins (source scan — pure, no network, no DOM, per test-p2b-binder-ui.mjs):
//   1. Migration 20260723150000_feedback_votes.sql: unique(feedback_id,
//      user_id), cascade FKs, feedback_id index, RLS insert/delete scoped to
//      the caller's own row, NO update policy, NO append-only trigger
//      (deletes ARE the un-vote), grants to authenticated only (anon
//      revoked), legacy column documented as dead.
//   2. api.js: listVotes() → {countsById, myVotes} from a
//      feedback_id,user_id scan; toggleVote() insert/delete via the shared
//      db helpers; identity via the shared/auth.js seam (never
//      supabase.auth); counts ride the existing item shape (item.upvotes /
//      item.hasMyVote) so calc.js sortFeedback('upvotes') + computeStats
//      work unchanged; dbRowToUi no longer reads the dead TEXT[] column.
//   3. ui.js: data-action="toggle-vote" pill on cards + detail, delegated
//      bind-once branch ordered BEFORE the [data-item] card branch,
//      optimistic flip + surgical pill update (no full board re-render) +
//      revert-on-error toast, 'Sign in to vote.' for signed-out, Votes sort
//      option, toasts only (no alert()), ?? for numerics.
//
// Run:  node test-bw-feedback-votes.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const mig = read('./supabase/migrations/20260723150000_feedback_votes.sql');
const apiSrc = read('./hub/feedback/api.js');
const uiSrc = read('./hub/feedback/ui.js');
const calcSrc = read('./hub/feedback/calc.js');

/** Extract a top-level function's source block by name (brace-matched). */
function fnBlock(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

// ============================================================
// 1. Migration — schema + RLS contract
// ============================================================
{
  t('table created if-not-exists in public schema',
    mig.includes('create table if not exists public.feedback_votes'));
  t('one vote per user per item: unique (feedback_id, user_id)',
    /unique \(feedback_id, user_id\)/.test(mig));
  t('feedback FK cascades on item delete',
    /feedback_id\s+uuid not null references public\.hub_feedback\(id\) on delete cascade/.test(mig));
  t('user FK defaults to auth.uid() and cascades on user delete',
    /user_id\s+uuid not null default auth\.uid\(\) references auth\.users\(id\) on delete cascade/.test(mig));
  t('index on feedback_id (board aggregates by item)',
    /create index if not exists feedback_votes_feedback_idx\s+on public\.feedback_votes \(feedback_id\)/.test(mig));
  t('RLS enabled',
    mig.includes('alter table public.feedback_votes enable row level security'));
  t('select policy: any authenticated user sees counts',
    /for select to authenticated using \(true\)/.test(mig));
  t('insert policy: own row only (with check user_id = auth.uid())',
    /for insert to authenticated with check \(user_id = auth\.uid\(\)\)/.test(mig));
  t('delete policy: own row only (using user_id = auth.uid())',
    /for delete to authenticated using \(user_id = auth\.uid\(\)\)/.test(mig));
  t('NO update policy — toggle is insert/delete',
    !/for update/i.test(mig));
  t('NO append-only trigger — deletes are the un-vote (not deal_bid_snapshots)',
    !/create trigger/i.test(mig));
  t('policies are drop-if-exists guarded (re-statable)',
    (mig.match(/drop policy if exists/g) || []).length === 3);
  t('grants: authenticated only; anon revoked on the table',
    /revoke all on table public\.feedback_votes from public, anon/.test(mig)
      && /grant select, insert, delete on table public\.feedback_votes to authenticated/.test(mig));
  t('grants: bigserial sequence usable by authenticated, revoked from anon',
    /revoke all on sequence public\.feedback_votes_id_seq from public, anon/.test(mig)
      && /grant usage, select on sequence public\.feedback_votes_id_seq to authenticated/.test(mig));
  t('legacy hub_feedback.upvotes TEXT[] documented as dead, not resurrected',
    /hub_feedback\.upvotes TEXT\[\]/.test(mig) && /LEGACY \/ DEAD/.test(mig)
      && !/update public\.hub_feedback/i.test(mig));
}

// ============================================================
// 2. api.js — listVotes / toggleVote via db helpers + auth seam
// ============================================================
{
  t('auth seam imported (shared/auth.js, pinned URL)',
    /import \{ auth \} from '\.\.\/\.\.\/shared\/auth\.js\?v=/.test(apiSrc));
  t('no direct Supabase Auth touchpoint (seam only — test-auth-seam contract)',
    !/supabase\.auth/.test(apiSrc) && !/getClient\(\)\s*\.auth/.test(apiSrc)
      && !/\.auth\.getUser\(/.test(apiSrc));

  const lv = fnBlock(apiSrc, 'listVotes');
  t('listVotes exists', !!lv);
  t('listVotes scans feedback_id,user_id from feedback_votes (board-scale)',
    /db\.from\('feedback_votes'\)/.test(lv) && /\.select\('feedback_id,user_id'\)/.test(lv));
  t('listVotes returns countsById + myVotes (Set), identity via auth.getUser()',
    /countsById/.test(lv) && /myVotes = new Set\(\)/.test(lv) && /auth\.getUser\(\)/.test(lv));
  t('listVotes is fail-soft (catch → empty structures, board still renders)',
    /catch \(err\)/.test(lv) && /console\.warn/.test(lv)
      && /return \{ countsById, myVotes \};/.test(lv));
  t('listVotes counts with ?? (not ||)',
    /countsById\[row\.feedback_id\] \?\? 0/.test(lv));

  const tv = fnBlock(apiSrc, 'toggleVote');
  t('toggleVote exists', !!tv);
  t('toggleVote refuses signed-out via seam (typed not_signed_in return)',
    /auth\.getUser\(\)/.test(tv) && /return \{ ok: false, error: 'not_signed_in' \};/.test(tv));
  t('toggleVote checks for existing own vote (maybeSingle on feedback_id+user_id)',
    /\.eq\('feedback_id', feedbackId\)/.test(tv) && /\.eq\('user_id', me\.id\)/.test(tv)
      && /\.maybeSingle\(\)/.test(tv));
  t('un-vote = delete own row via db.remove',
    /db\.remove\('feedback_votes', data\.id\)/.test(tv));
  t('vote = insert via db.insert with feedback_id + user_id',
    /db\.insert\('feedback_votes', \{ feedback_id: feedbackId, user_id: me\.id \}\)/.test(tv));
  t('toggleVote never updates (toggle = insert/delete only)',
    !/db\.update\(/.test(tv) && !/db\.upsert\(/.test(tv));
  t('toggleVote is fail-soft ({ ok:false } tuple, no throw to UI)',
    /catch \(err\)/.test(tv) && /return \{ ok: false, error: err\?\.message/.test(tv));

  // Counts ride the existing item shape → calc.js works unchanged.
  const lf = fnBlock(apiSrc, 'listFeedback');
  t('listFeedback overlays real counts onto item.upvotes (?? 0) + item.hasMyVote',
    /listVotes\(\)/.test(lf) && /item\.upvotes = countsById\[item\.id\] \?\? 0;/.test(lf)
      && /item\.hasMyVote = myVotes\.has\(item\.id\);/.test(lf));
  t('dbRowToUi no longer reads the dead TEXT[] column',
    !/Array\.isArray\(row\.upvotes\)/.test(apiSrc));
  t('calc engine unchanged: sortFeedback upvotes case + computeStats + topVoted intact',
    /case 'upvotes': return mult \* \(\(a\.upvotes \|\| 0\) - \(b\.upvotes \|\| 0\)\);/.test(calcSrc)
      && /totalUpvotes/.test(calcSrc) && /export function topVoted/.test(calcSrc));
}

// ============================================================
// 3. ui.js — pill, delegation, optimistic + surgical, sort
// ============================================================
{
  t('vote pill rendered with data-action="toggle-vote" + data-item id (escapeAttr)',
    uiSrc.includes('data-action="toggle-vote" data-item="${_a(item.id)}"'));
  t('pill active state driven by hasMyVote (filled when voted)',
    /const voted = !!item\.hasMyVote;/.test(uiSrc) && /aria-pressed="\$\{voted \? 'true' : 'false'\}"/.test(uiSrc));
  t('pill count uses ?? for numerics',
    /item\.upvotes \?\? 0/.test(uiSrc));
  t('board card meta row carries the pill (next to comment count)',
    / comment\$\{item\.comments\.length !== 1 \? 's' : ''\}<\/span>\s*\$\{votePill\(item\)\}/.test(uiSrc));
  t('detail view shows the vote count (pill in header row)',
    /\$\{_h\(item\.title\)\}<\/h3>\s*\$\{votePill\(item\)\}/.test(uiSrc));
  t('Votes option wired to sortFeedback upvotes in the fb-sort select',
    uiSrc.includes(`<option value="upvotes" \${sortBy === 'upvotes' ? 'selected' : ''}>Votes</option>`));

  // Delegation: bind-once branch, ordered before the card-open branch.
  t('delegated branch: target.closest toggle-vote in the existing click listener',
    uiSrc.includes(`target.closest('[data-action="toggle-vote"]')`));
  t('vote branch checked BEFORE the [data-item] card branch (pill click ≠ open detail)',
    uiSrc.indexOf(`target.closest('[data-action="toggle-vote"]')`)
      < uiSrc.indexOf(`target.closest('[data-item]')`));

  const h = fnBlock(uiSrc, 'handleToggleVote');
  t('handleToggleVote exists', !!h);
  t('optimistic flip before the api call (hasMyVote + count flip precede await)',
    h.indexOf('item.hasMyVote = !wasVoted') < h.indexOf('await api.toggleVote')
      && /item\.upvotes = Math\.max\(0, prevCount \+ \(wasVoted \? -1 : 1\)\);/.test(h));
  t('surgical pill update — no full board re-render in the toggle path',
    /updateVotePill\(id\);/.test(h) && !/renderBoard\(/.test(h) && !/\brender\(\);/.test(h));
  t('revert-on-error: state restored + pill re-updated on { ok:false }',
    /item\.hasMyVote = wasVoted;/.test(h) && /item\.upvotes = prevCount;/.test(h)
      && h.indexOf('item.hasMyVote = wasVoted') > h.indexOf('await api.toggleVote'));
  t("signed-out toast exact: 'Sign in to vote.'",
    h.includes(`showToast('Sign in to vote.', 'warning')`));
  t('write-failure toast (error severity)',
    h.includes(`showToast('Could not save your vote. Try again.', 'error')`));

  const up = fnBlock(uiSrc, 'updateVotePill');
  t('updateVotePill swaps outerHTML (delegation survives; CSS.escape on the id)',
    /CSS\.escape\(id\)/.test(up) && /el\.outerHTML = votePill\(item\);/.test(up));

  t('no alert() anywhere in feedback ui/api (toasts only)',
    !/\balert\(/.test(uiSrc) && !/\balert\(/.test(apiSrc));
  t('no inline onclick handlers', !/onclick=/.test(uiSrc));
}

console.log(`\ntest-bw-feedback-votes: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
