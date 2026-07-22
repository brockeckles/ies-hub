-- S2 residue (2026-07-22): manual sq-ft estimate for sites without a ★
-- scenario (the mockup's "95,000 sq ft (est)" state). Display fallback
-- only — a ★ scenario's facility_sqft always outranks it.
alter table public.deal_sites add column if not exists sqft_estimate int;
