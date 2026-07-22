-- S3-P1 — Package manifest station (Brock ruling s3 2026-07-22: P1-only).
-- One tiny per-deal row backing the Package tab: exec summary, optional
-- submission due date, and manual reviewer checks. Everything else on the
-- manifest is DERIVED live from deal state (sites/star/designs/strategy).
-- Applied to staging + prod 2026-07-22 via MCP.
create table if not exists public.deal_bid_meta (
  deal_id       uuid primary key references public.deal_deals(id) on delete cascade,
  exec_summary  text not null default '',
  submission_due date,
  manual_checks jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_deal_bid_meta_updated on public.deal_bid_meta;
create trigger trg_deal_bid_meta_updated
  before update on public.deal_bid_meta
  for each row execute function set_updated_at();

alter table public.deal_bid_meta enable row level security;

drop policy if exists deal_bid_meta_read on public.deal_bid_meta;
create policy deal_bid_meta_read on public.deal_bid_meta for select using (
  exists (select 1 from public.deal_deals d where d.id = deal_bid_meta.deal_id and (
    d.owner_id = auth.uid()
    or (d.visibility = 'team'::visibility_level and d.team_id = current_user_team_id())
    or d.visibility = 'shared'::visibility_level
    or current_user_is_admin())));

drop policy if exists deal_bid_meta_insert on public.deal_bid_meta;
create policy deal_bid_meta_insert on public.deal_bid_meta for insert with check (
  exists (select 1 from public.deal_deals d where d.id = deal_bid_meta.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));

drop policy if exists deal_bid_meta_update on public.deal_bid_meta;
create policy deal_bid_meta_update on public.deal_bid_meta for update
  using (exists (select 1 from public.deal_deals d where d.id = deal_bid_meta.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())))
  with check (exists (select 1 from public.deal_deals d where d.id = deal_bid_meta.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));

drop policy if exists deal_bid_meta_delete on public.deal_bid_meta;
create policy deal_bid_meta_delete on public.deal_bid_meta for delete
  using (exists (select 1 from public.deal_deals d where d.id = deal_bid_meta.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));
