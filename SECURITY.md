# Security Policy

This repository hosts the IES Intelligence Hub — an internal productization
of the GXO IES Solutions Design tool suite, served via GitHub Pages to named
GXO users and backed by Supabase (Postgres + Auth + Edge Functions).

This document explains how to report a security issue and what to expect in
response. It is the external-facing counterpart to the internal runbooks:

- `IT_Pitch/IncidentResponse_Runbook_DRAFT_v1_2026-04-24.md` — response process
- `IT_Pitch/SecurityPosture_SelfAssessment_DRAFT_v1_2026-04-24.md` — posture
- `IT_Pitch/DataClassification_Matrix_DRAFT_v1_2026-04-24.md` — data tiers

## Scope

In scope:

- The hosted application at `https://brockeckles.github.io/ies-hub/`
- Supabase Edge Functions under `supabase/functions/*` in this repository
- RLS policies, migrations, and SQL under `supabase/migrations/*`
- Client-side code under `shared/`, `hub/`, and `tools/*`

Out of scope (report to the respective provider directly):

- Supabase platform vulnerabilities → https://supabase.com/.well-known/security.txt
- GitHub / GitHub Pages platform vulnerabilities → https://github.com/security
- Cloudflare CDN vulnerabilities → https://www.cloudflare.com/trust-hub/
- GXO enterprise infrastructure (corporate network, endpoint, SSO) → GXO IT

## Reporting a vulnerability

**Preferred channel:** email `brockeckles@gmail.com` with a subject line
starting `[IES Hub Security]`. Include:

1. A description of the issue and the impact you believe it has.
2. Steps to reproduce (URL, payload, request/response if relevant).
3. Your contact info for follow-up.
4. Whether you've disclosed this to anyone else yet.

Do **not** open a public GitHub issue for unpatched security findings.

**If you believe the issue is being actively exploited**, mark the subject
line `[IES Hub Security — URGENT]` and, where possible, reach GXO IT
Security through the standard internal escalation path in parallel.

## What to expect

- **Acknowledgement:** within 2 business days.
- **Triage update:** within 5 business days, including a severity assessment
  using the CVSS v3.1 rubric (see Posture Self-Assessment §7 for the severity
  policy).
- **Resolution target:** aligned to severity —
  - Critical: mitigation within 24–72 hours, full fix in 7 days
  - High: fix in 14 days
  - Medium: fix in 30 days
  - Low: best-effort in 90 days
- **Disclosure:** coordinated — we will credit reporters who request it.

## Safe-harbor

Good-faith security research that stays within the reporting guidelines
above will not result in legal action from the IES Hub maintainer.
Specifically, please:

- Do not access, modify, or destroy user data beyond what is strictly
  necessary to demonstrate the issue.
- Do not disrupt availability for other users.
- Do not pivot from a finding into further systems (GXO corporate, Supabase
  platform, GitHub) — those are explicitly out of scope above.
- Do not publicly disclose the issue before we've had a chance to respond
  and deploy a fix.

## Scope note: tool audience

The tool is distributed only to named GXO employees; there is no public
signup path (`auth.users.signup_enabled = OFF` on prod + staging). If you
are receiving this document as part of an external engagement (e.g. a GXO
customer, a partner, or a procurement review), please coordinate through
your GXO counterpart rather than the email above — this will route faster.

## Supply chain

- Frontend: zero `npm` dependencies — vanilla JS + ES modules (intentional;
  see `IES-Hub-v3-Architecture-Blueprint.docx`).
- Backend: Supabase-managed Postgres 17.6.1 + Edge Functions pinned to
  `jsr:@supabase/functions-js/edge-runtime.d.ts` + `esm.sh` pinned URLs.
- CI: GitHub Actions, see `.github/workflows/ci.yml`.

## Contact

- Security: `brockeckles@gmail.com` — `[IES Hub Security]` subject prefix
- Maintainer: Brock Eckles (IES Solutions Design leader, GXO)

