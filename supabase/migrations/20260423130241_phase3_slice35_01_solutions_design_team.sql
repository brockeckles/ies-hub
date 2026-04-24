-- IES Hub — Phase 3 Slice 3.5 — Migration 01 (Solutions Design team + trigger)

-- 1. Create the Solutions Design team if it doesn't exist.
--    created_by stays NULL for now — Brock hasn't signed up yet. Can be set
--    later if we care, but it's cosmetic.
INSERT INTO public.teams (name)
SELECT 'Solutions Design'
WHERE NOT EXISTS (SELECT 1 FROM public.teams WHERE name = 'Solutions Design');

-- 2. Update handle_new_user to auto-assign every new signup to Solutions Design.
--    Phase 3 pilot is single-team. When Phase 7+ expands, revise to inspect
--    invite metadata or allow admins to reassign.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  default_team_id uuid;
BEGIN
  SELECT id INTO default_team_id FROM public.teams WHERE name = 'Solutions Design' LIMIT 1;
  INSERT INTO public.profiles (id, email, team_id)
  VALUES (NEW.id, NEW.email, default_team_id);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Trigger on auth.users insert: auto-creates a matching public.profiles row. Every Phase 3 signup lands in the Solutions Design team with role=member; admin role is assigned post-signup by an existing admin (see Slice 3.5 backfill).';