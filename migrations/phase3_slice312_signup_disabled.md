# Slice 3.12 — Public signup locked down

**Shipped:** 2026-04-23
**Commit:** (this slice)
**Test:** `test-signup-disabled.mjs` — 2 live-network assertions

## What changed

The Supabase project-level **"Allow new users to sign up"** toggle was turned
**OFF** in the dashboard
(Authentication → Sign In / Providers → User Signups). Anonymous `POST /auth/v1/signup`
calls with the published anon key now return:

```
HTTP 422
{ "error_code": "signup_disabled", "msg": "Signups not allowed for this instance" }
```

Before the toggle was flipped, a probe with a fresh `@mailinator.com` email
created a real `auth.users` row in seconds — no app changes, just the anon
key that ships in every page load.

## What this closes

- **Orphan users:** randos could not otherwise harm data (Slice 3.3 RLS
  blinds them), but they'd clutter `auth.users`, consume rate limit, and
  show up in the pilot cohort.
- **Clone-the-anon-key attack:** anyone extracting `SUPABASE_ANON_KEY` from
  `shared/supabase.js` could previously scripted account creation at will.

## What this does NOT change

- Existing users keep logging in normally (login path is unaffected — the
  test suite asserts this).
- Slice 3.11 OTP password recovery keeps working (it reuses existing
  accounts, does not create new ones).
- Service-role keys bypass the toggle. Admin flows that use
  `auth.admin.createUser` or direct SQL inserts into `auth.users` still
  work. That's how user #N+1 gets onboarded going forward — see below.

## Admin user provisioning (the new path for user #N+1)

Since public signup is closed, a human with admin access must create new
users. Pick the cleanest of the three paths:

### Option 1 — Dashboard (canonical)
1. Supabase dashboard → `ies-intelligence-hub` → Authentication → Users.
2. Click **Add user → Create new user**.
3. Fill **Email** + **Password** (8+ chars; the new user will change it on
   first login via the Slice 3.6 in-app flow, so pick something they can
   type once).
4. Check **Auto confirm user** so they can log in without email confirmation.
5. Click **Create user**.
6. Run this SQL (via Supabase SQL editor) to seed `public.profiles` + team
   membership:
   ```sql
   INSERT INTO public.profiles (id, email, display_name, role)
   VALUES ('<uuid from Users list>', '<email>', '<display name>', 'member')
   ON CONFLICT (id) DO NOTHING;

   INSERT INTO public.team_members (team_id, user_id, role)
   VALUES (
     (SELECT id FROM public.teams WHERE name = 'Solutions Design'),
     '<uuid from Users list>',
     'member'
   );
   ```
7. Share the email + temp password with the new user **out-of-band**
   (Teams DM, phone, in person). Do **not** email it — M365 Safe Links
   will pre-click any recovery-style URLs we include (this is why Slice
   3.11 switched to OTP codes).

### Option 2 — Ask Claude
Claude can drive Option 1 end-to-end in the dashboard via Chrome MCP, or
execute the equivalent SQL directly. Give Claude the email, display name,
team, and role.

### Option 3 — All-SQL one-liner
For bulk onboarding later, build a SQL block that uses `pgcrypto`'s
`crypt(password, gen_salt('bf'))` to hash the password, inserts into
`auth.users` + `auth.identities`, then seeds `public.profiles` and
`team_members`. Slice 3.5 already proved this works; see its seed SQL
for the column list.

## Rolling it back

If you ever need to temporarily re-open signups (e.g., for a migration
path or a staged rollout with a signup allowlist), flip the dashboard
toggle back ON. Re-run `node test-signup-disabled.mjs` afterwards — it
will **fail** loudly, which is the signal to flip it back or add a
Before-User-Created hook.
