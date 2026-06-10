-- Phase 0a security fix (2026-06-10 ground-up assessment, Critical #1)
--
-- profiles_update_self_or_admin had USING but no WITH CHECK. Postgres reuses the
-- USING expression for the write check when WITH CHECK is absent, so any
-- authenticated member could UPDATE their own row to role='admin' straight
-- through PostgREST with the public anon key. Verified live, then verified
-- blocked after this migration (rls-test-a self-promotion attempt => 42501).
--
-- Two layers:
--   1. Explicit WITH CHECK on the UPDATE policy.
--   2. BEFORE UPDATE trigger making role/team_id immutable except for admins —
--      defense in depth that survives future policy rewrites.
--
-- Exemptions in the trigger: requests with no request.jwt.claims (direct DB
-- access: migrations, SQL editor, dashboard) and service_role JWTs (edge
-- functions). PostgREST requests ALWAYS carry claims, so the attack path is
-- never exempt. Deliberately claims-based rather than session_user-based so the
-- guard is testable from any connection.
-- Applied to prod (dklnwcshrpamzsybjlzb) + staging (yswhxtpkfhvfbucyhads) 2026-06-10.

DROP POLICY IF EXISTS profiles_update_self_or_admin ON public.profiles;
CREATE POLICY profiles_update_self_or_admin
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.current_user_is_admin())
  WITH CHECK (id = auth.uid() OR public.current_user_is_admin());

CREATE OR REPLACE FUNCTION public.protect_profile_privileged_cols()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb;
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role OR NEW.team_id IS DISTINCT FROM OLD.team_id) THEN
    claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    IF claims IS NULL THEN
      RETURN NEW;  -- direct DB access (migrations / SQL editor): not a PostgREST request
    END IF;
    IF COALESCE(claims ->> 'role', '') = 'service_role' THEN
      RETURN NEW;  -- edge functions with service key
    END IF;
    IF NOT public.current_user_is_admin() THEN
      RAISE EXCEPTION 'changing role or team_id requires admin privileges'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileged_cols ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileged_cols
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_cols();
