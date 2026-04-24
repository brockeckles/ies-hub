CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
DECLARE
  meta             jsonb  := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  invited_team_id  uuid;
  invited_role     text;
  full_name        text;
  resolved_team    uuid;
  resolved_role    text;
BEGIN
  BEGIN
    invited_team_id := NULLIF(meta->>'invited_team_id','')::uuid;
  EXCEPTION WHEN others THEN
    invited_team_id := NULL;
  END;
  invited_role := NULLIF(meta->>'invited_role','');
  full_name    := NULLIF(meta->>'full_name','');

  IF invited_team_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = invited_team_id) THEN
    resolved_team := invited_team_id;
  ELSE
    SELECT id INTO resolved_team FROM public.teams WHERE name = 'Solutions Design' LIMIT 1;
  END IF;

  IF invited_role IN ('admin','member') THEN
    resolved_role := invited_role;
  ELSE
    resolved_role := 'member';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, team_id)
  VALUES (NEW.id, NEW.email, full_name, resolved_role, resolved_team);

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Auto-creates public.profiles on auth.users INSERT. Honors invited_team_id, invited_role (admin|member), and full_name from raw_user_meta_data; falls back to Solutions Design team + member role for non-invite signups. Slice 3.16.';