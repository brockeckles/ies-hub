-- ============================================================
-- S1 — Sites become real (Brock rulings #6/#7 2026-07-22 + spec
-- rulings s2: status vocab as mocked · single-site auto-attach ·
-- in_bid mirrored through S1).
--
-- Creates the first-class Site entity under a deal, attaches
-- cost-model scenarios + design-tool scenarios to sites, moves ★
-- to a per-site FK, and seeds everything from the EXACT
-- market_id|name collapse heuristic the UI uses today (zero
-- reprice / byte-identical roll-ups by construction).
--
-- NOTE: the dead multi_site_deals table named in the scoping doc
-- is already absent from prod AND staging (verified 2026-07-22),
-- so no drop is needed here.
-- ============================================================

-- 1 ── table ─────────────────────────────────────────────────
create table if not exists public.deal_sites (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references public.deal_deals(id) on delete cascade,
  name            text not null,
  market_id       uuid references public.ref_markets(id),
  building        text,
  status          text not null default 'proposed'
                  check (status in ('proposed','evaluating','committed','dropped')),
  -- ★ per site: the one in-bid cost-model scenario for this building.
  in_bid_model_id bigint references public.cost_model_projects(id) on delete set null,
  sort_order      int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists deal_sites_deal_idx on public.deal_sites(deal_id);

drop trigger if exists trg_deal_sites_updated on public.deal_sites;
create trigger trg_deal_sites_updated
  before update on public.deal_sites
  for each row execute function set_updated_at();

-- 2 ── RLS: gate through the parent deal (deal_strategy pattern) ──
alter table public.deal_sites enable row level security;

drop policy if exists deal_sites_read on public.deal_sites;
create policy deal_sites_read on public.deal_sites for select using (
  exists (select 1 from public.deal_deals d where d.id = deal_sites.deal_id and (
    d.owner_id = auth.uid()
    or (d.visibility = 'team'::visibility_level and d.team_id = current_user_team_id())
    or d.visibility = 'shared'::visibility_level
    or current_user_is_admin())));

drop policy if exists deal_sites_insert on public.deal_sites;
create policy deal_sites_insert on public.deal_sites for insert with check (
  exists (select 1 from public.deal_deals d where d.id = deal_sites.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));

drop policy if exists deal_sites_update on public.deal_sites;
create policy deal_sites_update on public.deal_sites for update
  using (exists (select 1 from public.deal_deals d where d.id = deal_sites.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())))
  with check (exists (select 1 from public.deal_deals d where d.id = deal_sites.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));

drop policy if exists deal_sites_delete on public.deal_sites;
create policy deal_sites_delete on public.deal_sites for delete using (
  exists (select 1 from public.deal_deals d where d.id = deal_sites.deal_id
    and (d.owner_id = auth.uid() or current_user_is_admin())));

-- 3 ── site_id columns on scenario/design tables ─────────────
alter table public.cost_model_projects  add column if not exists site_id uuid references public.deal_sites(id) on delete set null;
alter table public.wsc_facility_configs add column if not exists site_id uuid references public.deal_sites(id) on delete set null;
alter table public.most_analyses        add column if not exists site_id uuid references public.deal_sites(id) on delete set null;
alter table public.cog_scenarios        add column if not exists site_id uuid references public.deal_sites(id) on delete set null;

create index if not exists cmp_site_idx  on public.cost_model_projects(site_id);
create index if not exists wsc_site_idx  on public.wsc_facility_configs(site_id);
create index if not exists most_site_idx on public.most_analyses(site_id);
create index if not exists cog_site_idx  on public.cog_scenarios(site_id);

-- 4 ── seed: one site per market_id|name group (the UI's exact
--          collapse key, hub/deal-management/api.js:121-142).
--          Idempotent: only seeds models not yet assigned. ─────
with groups as (
  select deal_deals_id as deal_id,
         coalesce(market_id::text,'') || '|' || coalesce(name,'') as gkey,
         min(coalesce(nullif(name,''), 'Unnamed Site')) as gname,
         min(market_id::text)::uuid as gmarket
  from public.cost_model_projects
  where deal_deals_id is not null and site_id is null
  group by 1, 2
), ins as (
  insert into public.deal_sites (deal_id, name, market_id, status)
  select deal_id, gname, gmarket, 'evaluating' from groups
  returning id, deal_id, coalesce(market_id::text,'') || '|' || coalesce(name,'') as gkey
)
update public.cost_model_projects m
set site_id = ins.id
from ins
where m.deal_deals_id = ins.deal_id
  and m.site_id is null
  and coalesce(m.market_id::text,'') || '|' || coalesce(m.name,'') = ins.gkey;

-- 5 ── ★ backfill: lone in_bid in the group wins outright; if
--          several (pre-exclusivity legacy), most recently
--          updated wins. ─────────────────────────────────────
update public.deal_sites s
set in_bid_model_id = pick.id
from (
  select distinct on (site_id) site_id, id
  from public.cost_model_projects
  where in_bid = true and site_id is not null
  order by site_id, updated_at desc nulls last, id desc
) pick
where s.id = pick.site_id and s.in_bid_model_id is null;

-- 6 ── single-site auto-attach (ruling: yes): deals with exactly
--          one site adopt their existing deal-linked designs.
--          parent_deal_id on design tables is TEXT (deal uuid). ──
with lone as (
  select deal_id, min(id::text)::uuid as site_id
  from public.deal_sites group by deal_id having count(*) = 1
)
update public.wsc_facility_configs w set site_id = lone.site_id
from lone where w.site_id is null and w.parent_deal_id = lone.deal_id::text;

with lone as (
  select deal_id, min(id::text)::uuid as site_id
  from public.deal_sites group by deal_id having count(*) = 1
)
update public.most_analyses m set site_id = lone.site_id
from lone where m.site_id is null and m.parent_deal_id = lone.deal_id::text;

with lone as (
  select deal_id, min(id::text)::uuid as site_id
  from public.deal_sites group by deal_id having count(*) = 1
)
update public.cog_scenarios c set site_id = lone.site_id
from lone where c.site_id is null and c.parent_deal_id = lone.deal_id::text;
