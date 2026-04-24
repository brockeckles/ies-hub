-- =============================================================================
-- IES Hub — Phase 4.5 — MFA Admin Gate (defense-in-depth)
-- =============================================================================
-- Purpose: Require AAL2 (MFA-verified session) for the admin role. Rewrites
--          current_user_is_admin() to AND the existing profile-role check
--          with a JWT aal='aal2' assertion. Because 86+ RLS policies call
--          this fn via .FILTER or .WITH CHECK, this single change gates all
--          admin writes and admin-only reads at the DB layer. Pairs with
--          the app-side MFA gate shipped in the same slice (shared/mfa-ui.js
--          + shared/auth.js MFA helpers + index.html gate in bootApp path).
--
-- Rollout: Apply to STAGING first. Test: aal1 admin → all admin policies
--          deny; aal2 admin (post-challenge) → allow. Then apply to PROD
--          ONLY AFTER Brock has enrolled a TOTP factor on prod via the UI
--          (otherwise the sole prod admin loses admin access). The UI gate
--          ships ahead of this migration so enrollment is possible while
--          still at aal1.
--
-- Author:  Brock + Claude (Cowork)
-- Created: 2026-04-24
-- Scope:   Security hardening — Security Posture §5 #6 (only pilot-blocking
--          gap). Phase 4.5 tranche-2 start.
--
-- Rollback: See paired restore migration
--          (20260424_phase45_mfa_admin_gate_rollback.sql). Drops the aal2
--          clause, restoring the previous fn body. Net effect: admins can
--          authenticate at aal1 again. Use ONLY if MFA flow is broken in
--          a way that can't be recovered by re-enrollment.
-- =============================================================================

-- Depends on: supabase public.profiles(id, role) — unchanged since Phase 3
-- Depends on: auth.uid(), auth.jwt() — Supabase-provided SECURITY DEFINER helpers
-- Replaces:   public.current_user_is_admin() (same name, augmented body)

CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND role = 'admin'
  )
  AND (auth.jwt() ->> 'aal') = 'aal2';
$$;

COMMENT ON FUNCTION public.current_user_is_admin() IS
  'Phase 4.5 — returns true only when signed-in user is role=admin AND session is AAL2 (MFA-verified). Used by 86+ RLS policies. Rewrites Phase 3 Slice 3.6 fn; rollback migration restores the aal1-tolerant version.';
