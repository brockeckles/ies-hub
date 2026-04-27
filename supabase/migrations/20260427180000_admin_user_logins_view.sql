-- =============================================================================
-- IES Hub — admin: expose auth.users.last_sign_in_at to admin UI
-- =============================================================================
-- The User Activity admin tab's "Last login" column has been deriving the
-- timestamp from public.analytics_events session_start rows, which always
-- write user_id = NULL because analytics fire before auth.bootstrap resolves
-- the current user. Result: every row reads "never" even after the user has
-- successfully signed in.
--
-- Auth's own auth.users.last_sign_in_at is the authoritative signal — it's
-- updated on every successful sign-in (including refresh-token rotation) by
-- Supabase's GoTrue. This migration exposes a SECURITY DEFINER RPC that
-- joins public.profiles to auth.users.last_sign_in_at, gated on
-- current_user_is_admin() so non-admins see nothing.
--
-- We deliberately return only `(user_id uuid, last_sign_in_at timestamptz)`
-- — no other auth.users columns leak. The admin app already pulls profile
-- shape (email / full_name / role / team_id) from public.profiles via the
-- existing loadUserActivityInputs query.
--
-- Idempotent via OR REPLACE; additive only. No existing function signatures
-- change. Safe on staging + prod.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_list_user_logins()
RETURNS TABLE (user_id uuid, last_sign_in_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT u.id, u.last_sign_in_at
    FROM auth.users u;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_user_logins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_user_logins() TO authenticated;

COMMENT ON FUNCTION public.admin_list_user_logins() IS
  '2026-04-27 — admin-only RPC returning (user_id, last_sign_in_at) for every auth.users row. Gated on current_user_is_admin(); non-admins get permission denied. Used by hub/admin User Activity tab to display authoritative last-login times instead of brittle session_start telemetry.';

-- Smoke: postgres/admin context (no JWT) → current_user_is_admin() returns
-- false → function raises. We simply assert the function exists.
DO $$
BEGIN
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'admin_list_user_logins';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_list_user_logins() not created';
  END IF;
END $$;
