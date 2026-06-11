-- TI Phase B + C (2026-06-11) — completes the TI Handling doc's phasing.
-- Phase B: ti_rent_credit_psf_mo (Mode B — landlord funds TI, recoups via
-- elevated rent; credit drives net market-equivalent rent display; gross
-- rent stays in the P&L). Phase C: ti_amort_years explicit override
-- (default = contract term). Runtime fields ride in project_data jsonb
-- (facility.tiRentCreditPsfMo / facility.tiAmortYears); columns normalize
-- for Phase 3 SQL consumers.

ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS ti_rent_credit_psf_mo numeric DEFAULT 0
    CHECK (ti_rent_credit_psf_mo >= 0),
  ADD COLUMN IF NOT EXISTS ti_amort_years integer
    CHECK (ti_amort_years IS NULL OR ti_amort_years >= 1);

COMMENT ON COLUMN public.cost_model_projects.ti_rent_credit_psf_mo IS
  'Mode B TI: $/SF/month of quoted rent attributable to landlord TI recovery. Informational benchmark (net market-equivalent rent); gross rent stays in P&L.';
COMMENT ON COLUMN public.cost_model_projects.ti_amort_years IS
  'Explicit TI amortization period override. NULL = amortize provider-funded TI over the contract term (the usual case).';
