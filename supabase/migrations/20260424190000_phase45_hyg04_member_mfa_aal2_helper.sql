-- =============================================================================
-- IES Hub — Phase 4.5 Slice HYG-04 — Member-tier MFA (DB helper + docs)
-- =============================================================================
-- Primary enforcement of member-tier MFA is the application-layer gate in
-- shared/auth.js `requiresMfa()`, which now returns true for every signed-in
-- user whose session AAL is not aal2 (Slice MFA-01 had gated admins only).
-- Satisfies CIS Control 6.3 (Require MFA for Externally-Exposed Applications).
--
-- This migration adds a SQL-layer helper, public.current_user_is_aal2(), so
-- future policy-level hardening can reference a single canonical AAL2 check
-- (mirroring the pattern set by current_user_is_admin()). It does NOT wire
-- the helper into any existing policies — 165 policies currently live on
-- public.*, and a blanket rewrite is out of scope for HYG-04. The helper
-- lets us selectively AND aal2 onto high-value policies in future slices
-- without re-inventing the JWT lookup each time.
--
-- COALESCE is required: auth.jwt() returns NULL when called from an
-- admin/postgres/no-JWT context; without COALESCE the function would
-- return NULL instead of false, which would make any RLS predicate that
-- ANDs it against other clauses silently fail (NULL AND TRUE = NULL).
--
-- Scope: additive only. No existing function signatures change. No behavior
-- change against current RLS. Safe on both envs; idempotent via OR REPLACE.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_user_is_aal2()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((auth.jwt() ->> 'aal') = 'aal2', false);
$$;

COMMENT ON FUNCTION public.current_user_is_aal2() IS
  'Phase 4.5 Slice HYG-04 — returns true iff the current session JWT has aal=aal2 (MFA-verified). COALESCE to false when auth.jwt() is NULL (admin/no-JWT context). Available for defense-in-depth RLS hardening; not wired into any existing policy today. App-layer MFA gate (shared/auth.js requiresMfa) is the primary Control 6.3 enforcement.';

-- Smoke assertion: admin/postgres context has no JWT → false.
DO $$
DECLARE
  v_result boolean;
BEGIN
  SELECT public.current_user_is_aal2() INTO v_result;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'current_user_is_aal2() returned NULL — COALESCE did not guard';
  END IF;
  IF v_result IS NOT FALSE THEN
    RAISE EXCEPTION 'current_user_is_aal2() returned % in no-JWT context — expected false', v_result;
  END IF;
  RAISE NOTICE 'current_user_is_aal2() smoke: % (expected: false in admin/no-JWT context) — OK', v_result;
END $$;
