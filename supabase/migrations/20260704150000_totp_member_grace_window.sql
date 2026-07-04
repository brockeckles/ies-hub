-- 20260704150000_totp_member_grace_window.sql
-- TOTP grace window for member tier (UX decision #4, 2026-07-03).
--
-- Posture: admins remain HARD-GATED (no grace, no skip). Members with no
-- verified TOTP factor may defer enrollment for a fixed window (client
-- constant MFA_GRACE_DAYS in shared/auth.js, 14 days) anchored to the
-- FIRST time they hit the MFA gate — not to account creation, so the four
-- 2026-06-24 users who never logged in still get a full window.
--
-- The anchor is stamped ONCE via a SECURITY DEFINER RPC (coalesce keeps
-- the original timestamp on every later call; clearing localStorage or
-- switching browsers cannot restart the clock). Admins get no stamp at
-- all — the RPC's WHERE clause excludes them, returns NULL, and the
-- client fails CLOSED (gate stays up) whenever the RPC returns nothing.

alter table public.profiles
  add column if not exists mfa_grace_started_at timestamptz;

comment on column public.profiles.mfa_grace_started_at is
  'First time this user hit the MFA gate without a verified TOTP factor. Anchors the member-tier enrollment grace window. NULL for admins and for users who enrolled before ever seeing the gate.';

create or replace function public.mfa_grace_start()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set mfa_grace_started_at = coalesce(mfa_grace_started_at, now())
   where id = auth.uid()
     and coalesce(role, 'member') <> 'admin'
  returning mfa_grace_started_at;
$$;

revoke all on function public.mfa_grace_start() from public;
revoke all on function public.mfa_grace_start() from anon;
grant execute on function public.mfa_grace_start() to authenticated;
