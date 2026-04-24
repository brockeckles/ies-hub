# IES Hub v3

[![CI](https://github.com/brockeckles/ies-hub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/brockeckles/ies-hub/actions/workflows/ci.yml)

Productization of the IES Solutions Design tool suite — deal flow, cost
modeling, warehouse sizing, fleet, network optimization, labor standards.

Served via GitHub Pages: **https://brockeckles.github.io/ies-hub/**

## Environments

| Env     | Supabase ref           | URL                                          |
|---------|------------------------|----------------------------------------------|
| prod    | `dklnwcshrpamzsybjlzb` | https://brockeckles.github.io/ies-hub/       |
| staging | `yswhxtpkfhvfbucyhads` | same bundle, `?env=staging` or `/ies-hub-staging/` |

Runtime env detection lives in `shared/supabase.js`. See
`supabase/migrations/README.md` for the migration workflow.

## Tests

`test-*.mjs` at repo root. Run any single file directly with `node <file>`.

- **Pure tests (29)** — no network. Run on every PR + every push to main.
- **Live-net tests (4)** — hit a real Supabase project. Default to prod for
  local dev (`node test-rls.mjs`); CI points them at the staging project
  via env vars on push to main.

## Versioning

Calendar version tags of the form `YYYY.MM.DD-<shortsha>`. See
`scripts/README.md` for the build-info emit convention.
