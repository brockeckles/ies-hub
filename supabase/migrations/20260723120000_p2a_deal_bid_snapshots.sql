-- S3-P2-a — "Mark as submitted": immutable bid-of-record snapshots
-- (Brock rulings, 2026-07-23).
--
-- THE CALIBRATION LOOP: deal_outcomes captures what actually happened
-- (won/lost + Y1 actuals), but comparing actuals to a bid you can still
-- edit is comparing against a moving target. An explicit submit action
-- stamps ONE append-only row here — the manifest, per-site ★ economics,
-- Σ★ totals, exec summary and review checks exactly as they stood at
-- submission. deal_outcomes.bid_snapshot_id links the outcome back to
-- that frozen bid so bid-vs-actual variance is computed against the bid
-- OF RECORD, not a reconstruction. Rows are IMMUTABLE by design: RLS has
-- no UPDATE/DELETE policies AND a BEFORE trigger raises — the trigger is
-- the belt-and-braces layer because service_role bypasses RLS but NOT
-- triggers.
--
-- Payload is written by the pure engine buildBidSnapshotPayload
-- (tools/deal-manager/calc.js); submitted_at/submitted_by come from DB
-- defaults so the snapshot content itself stays deterministic.

create table if not exists public.deal_bid_snapshots (
  id             uuid primary key default gen_random_uuid(),
  deal_id        uuid not null references public.deal_deals(id) on delete cascade,
  submitted_at   timestamptz not null default now(),
  -- Stamped by the DB (not the client) so the engine payload stays pure.
  submitted_by   uuid default auth.uid() references auth.users(id) on delete set null,
  -- Headline columns denormalized out of payload for cheap list/compare
  -- queries (the calibration coach never has to parse jsonb for these).
  manifest_pct   numeric,
  y1_revenue     numeric,
  y1_cost        numeric,
  y1_margin_pct  numeric,
  -- Self-contained bid-of-record JSON (schema_version: 1) — manifest
  -- items+pct, per-site ★ rows, Σ★ totals, exec summary, manual checks.
  payload        jsonb not null,
  notes          text
);

comment on table public.deal_bid_snapshots is
  'Append-only bid-of-record snapshots stamped by the explicit "Mark as submitted" action. Immutable (no UPDATE/DELETE policies + append-only trigger); deal_outcomes.bid_snapshot_id closes the bid-vs-outcome calibration loop.';

create index if not exists deal_bid_snapshots_deal_submitted_idx
  on public.deal_bid_snapshots (deal_id, submitted_at desc);

-- ── APPEND-ONLY, layer 1: RLS with SELECT + INSERT only ─────────────────────
-- Policy scoping mirrors deal_bid_meta (20260722210000_s3p1_deal_bid_meta.sql)
-- exactly: read follows the parent deal's owner/team/shared visibility;
-- insert is deal owner or admin. Deliberately NO update/delete policies.

alter table public.deal_bid_snapshots enable row level security;

drop policy if exists deal_bid_snapshots_read on public.deal_bid_snapshots;
create policy deal_bid_snapshots_read on public.deal_bid_snapshots for select using (
  exists (select 1 from public.deal_deals d where d.id = deal_bid_snapshots.deal_id and (
    d.owner_id = auth.uid()
    or (d.visibility = 'team'::visibility_level and d.team_id = current_user_team_id())
    or d.visibility = 'shared'::visibility_level
    or current_user_is_admin())));

drop policy if exists deal_bid_snapshots_insert on public.deal_bid_snapshots;
create policy deal_bid_snapshots_insert on public.deal_bid_snapshots for insert with check (
  exists (select 1 from public.deal_deals d where d.id = deal_bid_snapshots.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));

-- ── APPEND-ONLY, layer 2: trigger ────────────────────────────────────────────
-- service_role bypasses RLS but NOT triggers — this is the backstop that
-- makes the bid of record immutable even for privileged connections.

create or replace function public._deal_bid_snapshots_append_only()
returns trigger language plpgsql
set search_path = ''  -- pin search_path (advisor 0011 convention)
as $$
begin
  raise exception 'deal_bid_snapshots is append-only — the bid of record is immutable (%.%)', tg_op, tg_table_name;
end;
$$;

drop trigger if exists deal_bid_snapshots_append_only on public.deal_bid_snapshots;
create trigger deal_bid_snapshots_append_only
  before update or delete on public.deal_bid_snapshots
  for each row execute function public._deal_bid_snapshots_append_only();

-- ── Close the loop: outcomes point at the bid of record ─────────────────────

alter table public.deal_outcomes
  add column if not exists bid_snapshot_id uuid references public.deal_bid_snapshots(id) on delete set null;

comment on column public.deal_outcomes.bid_snapshot_id is
  'The immutable deal_bid_snapshots row this outcome''s bid_y1_* figures were prefilled from (explicit caller values always win; snapshot fills only missing fields).';
