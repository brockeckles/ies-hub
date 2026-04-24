-- IES Hub — Phase 3 Slice 3.1 — Migration 01 of 03
-- Establish the identity data model (teams + profiles + visibility enum + auto-profile trigger).
-- Additive only. No existing data touched.

-- 1. visibility_level enum
CREATE TYPE public.visibility_level AS ENUM ('private', 'team', 'shared');

COMMENT ON TYPE public.visibility_level IS
  'Row-level visibility for deal-sensitive objects. private = owner only; team = owner + same-team members; shared = all authenticated users in the org.';

-- 2. teams table
CREATE TABLE public.teams (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE  public.teams            IS 'Org groupings (e.g., Solutions Design). One team per user for Phase 3.';
COMMENT ON COLUMN public.teams.created_by IS 'User who created the team. NULL if creator was deleted.';

-- Updated_at trigger helper (reused on profiles below).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS 'Trigger helper: sets updated_at to now() on UPDATE.';

CREATE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. profiles table (app-layer extension of auth.users)
CREATE TABLE public.profiles (
  id         uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text        NOT NULL,
  full_name  text,
  role       text        NOT NULL DEFAULT 'member'
               CHECK (role IN ('admin', 'member', 'viewer')),
  team_id    uuid        REFERENCES public.teams(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.profiles       IS 'App-layer user profile. One row per auth.users row, kept in sync by trigger.';
COMMENT ON COLUMN public.profiles.id    IS 'Matches auth.users.id. This is the canonical identity key — never use email.';
COMMENT ON COLUMN public.profiles.email IS 'Mirrored from auth.users.email for display. Do NOT use for identity lookups or RLS.';
COMMENT ON COLUMN public.profiles.role  IS 'admin = full access incl. reference tables + user invites; member = standard SME; viewer = read-only stakeholder.';

CREATE INDEX profiles_team_id_idx ON public.profiles(team_id);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. auto-create profile on new auth.users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user()
  IS 'Trigger on auth.users insert: auto-creates a matching public.profiles row. Users land with role=member and team_id=NULL until admin assigns.';

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5. RLS on profiles and teams
ALTER TABLE public.teams    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- teams: any authenticated user can read; only admins can write.
CREATE POLICY teams_select_authenticated
  ON public.teams FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY teams_write_admin_only
  ON public.teams FOR ALL
  TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- profiles: user sees their own row and teammates' rows; admins see all.
-- Writes: self-edit OR admin.
CREATE POLICY profiles_select_self_or_teammate_or_admin
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE POLICY profiles_update_self_or_admin
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );