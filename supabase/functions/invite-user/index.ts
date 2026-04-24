// Slice 3.16 — Admin-gated edge function that invites a pilot user.
//
// Flow:
//   1. Caller sends POST with their user JWT in Authorization: Bearer <token>.
//      (verify_jwt=true at the platform level rejects anon/no-auth before
//      we even get here — this is the outer gate.)
//   2. We ask Supabase's auth REST for the user behind that JWT.
//   3. We look up that user's public.profiles.role via service_role so RLS
//      cannot lie to us; require role='admin'. Anything else → 403.
//   4. We validate the payload: email format, team_id exists, role ∈
//      {member,admin}, full_name non-empty.
//   5. We call admin.inviteUserByEmail, passing {full_name, invited_team_id,
//      invited_role} in user_metadata. The handle_new_user() trigger picks
//      those up and creates the profiles row with correct team/role in one
//      transaction. Supabase sends the Invite-template email; we've
//      customized that template to lead with {{ .Token }} so M365 Safe Links
//      can't eat the code (Slice 3.11 lesson).
//
// Hardening notes:
//   - verify_jwt is ON so non-authed calls never reach the function body;
//     we still do the admin check manually since we need service_role for
//     admin.* calls.
//   - emailRedirectTo is passed so clicking the fallback link after OTP
//     verification returns the user to the hub origin, not the Supabase
//     default redirect that would 404 in our GH Pages deployment.
//   - Pre-existing auth.users with this email → 409 with specific code so
//     the admin UI can say "already invited" instead of a generic "failed".

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

function jsonErr(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ ok: false, code, error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonErr(405, 'method_not_allowed', 'POST only');

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return jsonErr(500, 'server_misconfigured', 'Supabase env not set');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const authHeader = req.headers.get('authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return jsonErr(401, 'no_jwt', 'Missing Authorization bearer token');

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonErr(401, 'bad_jwt', userErr?.message || 'Invalid token');
  }
  const callerId = userData.user.id;

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', callerId)
    .maybeSingle();
  if (profileErr) return jsonErr(500, 'profile_lookup_failed', profileErr.message);
  if (!profile || profile.role !== 'admin') {
    return jsonErr(403, 'not_admin', 'Caller is not an admin');
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonErr(400, 'bad_json', 'Request body is not valid JSON');
  }
  const email     = String((body.email ?? '')).trim().toLowerCase();
  const teamId    = String((body.team_id ?? '')).trim();
  const role      = String((body.role ?? 'member')).trim();
  const fullName  = String((body.full_name ?? '')).trim();
  const redirectTo = String((body.redirect_to ?? '')).trim() || undefined;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonErr(400, 'bad_email', 'Enter a valid email address');
  }
  if (!teamId || !/^[0-9a-f-]{36}$/i.test(teamId)) {
    return jsonErr(400, 'bad_team_id', 'Pick a team');
  }
  if (role !== 'member' && role !== 'admin') {
    return jsonErr(400, 'bad_role', "Role must be 'member' or 'admin'");
  }
  if (!fullName) {
    return jsonErr(400, 'bad_full_name', 'Enter a name for the invitee');
  }

  const { data: team, error: teamErr } = await admin
    .from('teams')
    .select('id, name')
    .eq('id', teamId)
    .maybeSingle();
  if (teamErr) return jsonErr(500, 'team_lookup_failed', teamErr.message);
  if (!team) return jsonErr(400, 'team_not_found', 'Team not found');

  const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      full_name: fullName,
      invited_team_id: teamId,
      invited_role: role,
      invited_by: callerId,
    },
    redirectTo,
  });

  if (inviteErr) {
    const msg = inviteErr.message || 'Invite failed';
    if (/already.+registered|already.+exists|duplicate/i.test(msg)) {
      return jsonErr(409, 'already_exists', 'A user with that email already exists');
    }
    return jsonErr(500, 'invite_failed', msg);
  }

  return jsonOk({
    user_id: inviteData?.user?.id || null,
    email,
    team_id: teamId,
    team_name: team.name,
    role,
    full_name: fullName,
  });
});
