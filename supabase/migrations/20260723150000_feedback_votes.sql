-- Feedback voting — real upvotes for the feedback board (Brock ruling,
-- 2026-07-23).
--
-- THE HONESTY LOOP CLOSES: the original hub_feedback.upvotes TEXT[] column
-- was fictional — no write path ever touched it, and Wave C5 stripped the
-- phantom voting UI (test-c5-feedback-honest.mjs pinned "no voting claim").
-- This migration ships the REAL mechanism: one row here per (feedback item,
-- user) vote. Toggle semantics — voting is an INSERT, un-voting is a DELETE
-- of your own row. There is deliberately NO UPDATE policy (a vote row has
-- nothing to update) and deliberately NO append-only trigger: this table is
-- NOT append-only — deletes ARE the un-vote, unlike deal_bid_snapshots
-- (20260723120000) where the trigger enforces immutability.
--
-- hub_feedback.upvotes TEXT[] is LEGACY / DEAD as of this migration: never
-- written by any code path, now superseded by this table. It is left in
-- place (dropping a column is a separate ruling); do not read or write it.

create table if not exists public.feedback_votes (
  id           bigserial primary key,
  feedback_id  uuid not null references public.hub_feedback(id) on delete cascade,
  -- Stamped by the DB when the client omits it; RLS pins it to auth.uid()
  -- either way, so nobody can vote as somebody else.
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at   timestamptz default now(),
  -- ONE vote per user per item — the toggle contract lives in the schema.
  unique (feedback_id, user_id)
);

comment on table public.feedback_votes is
  'One upvote per (feedback item, user) — unique(feedback_id, user_id). Toggle = insert / delete your own row; no UPDATE policy and no append-only trigger by design (deletes are the un-vote). Supersedes the dead legacy column hub_feedback.upvotes TEXT[] (never written; left in place).';

-- Board render aggregates counts per item — index the FK we group by.
create index if not exists feedback_votes_feedback_idx
  on public.feedback_votes (feedback_id);

-- ── RLS: everyone signed-in sees counts; you only write YOUR vote ────────────
-- select  → any authenticated user (vote counts are team-visible);
-- insert  → own row only (user_id = auth.uid());
-- delete  → own row only (the un-vote);
-- update  → NO policy, deliberately (toggle = insert/delete).

alter table public.feedback_votes enable row level security;

drop policy if exists feedback_votes_read on public.feedback_votes;
create policy feedback_votes_read on public.feedback_votes
  for select to authenticated using (true);

drop policy if exists feedback_votes_insert_own on public.feedback_votes;
create policy feedback_votes_insert_own on public.feedback_votes
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists feedback_votes_delete_own on public.feedback_votes;
create policy feedback_votes_delete_own on public.feedback_votes
  for delete to authenticated using (user_id = auth.uid());

-- ── Grants: authenticated only — anon gets nothing ───────────────────────────
-- The board lives behind the auth gate; the only anon-reachable feedback
-- surface is the hub_feedback INSERT path (the FAB), not votes. Mirrors the
-- C6 hygiene posture (20260723000000_c6_rpc_grant_hygiene.sql): revoke
-- PUBLIC/anon, grant the roles that actually call.

revoke all on table public.feedback_votes from public, anon;
grant select, insert, delete on table public.feedback_votes to authenticated;

revoke all on sequence public.feedback_votes_id_seq from public, anon;
grant usage, select on sequence public.feedback_votes_id_seq to authenticated;
