-- Shift Planner v1 — catalog of shift % archetypes (admin-editable)
-- See ShiftPlanner_DesignMemo_2026-04-22.md §8 for rationale.

CREATE TABLE IF NOT EXISTS public.ref_shift_archetype_defaults (
  id            bigserial PRIMARY KEY,
  archetype_ref text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  description   text,
  vertical      text,
  shifts_per_day smallint NOT NULL CHECK (shifts_per_day BETWEEN 1 AND 4),
  matrix        jsonb NOT NULL,
  sort_order    smallint DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  source_citation text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.ref_shift_archetype_defaults.matrix IS
  'JSONB of { fn: [shift_pct_array] } where fn in {inbound,putaway,picking,replenish,pack,ship,returns,vas} and array length = shifts_per_day; each array must sum to 100 within 0.5.';

CREATE INDEX IF NOT EXISTS ix_shift_archetype_active_sort
  ON public.ref_shift_archetype_defaults (is_active, sort_order);

-- Seed 6 archetypes (matches ShiftPlanner_Defaults_2026-04-22.xlsx)
INSERT INTO public.ref_shift_archetype_defaults
  (archetype_ref, display_name, description, vertical, shifts_per_day, matrix, sort_order, source_citation)
VALUES
  (
    'omni_channel_3pl',
    'Omni-Channel 3PL',
    'Retail + e-com 3PL with 3-shift operation. S1 IB-heavy, S2 peak ship, S3 replen + catch-up.',
    'retail',
    3,
    '{"inbound":[60,40,0],"putaway":[50,45,5],"picking":[30,50,20],"replenish":[40,45,15],"pack":[35,50,15],"ship":[30,50,20],"returns":[50,50,0],"vas":[33,50,17]}'::jsonb,
    10,
    'Memphis FC shape, 2026-Q1 benchmarks'
  ),
  (
    'big_box_parcel_ecom',
    'Big-Box Parcel (pure e-com)',
    'Pure e-com fulfillment (Wayfair/Chewy-shape). Fulfillment-weighted across 3 shifts; limited inbound/returns.',
    'ecommerce',
    3,
    '{"inbound":[70,30,0],"putaway":[60,35,5],"picking":[25,50,25],"replenish":[35,45,20],"pack":[30,50,20],"ship":[25,50,25],"returns":[100,0,0],"vas":[30,45,25]}'::jsonb,
    20,
    'GXO Wayfair deal shape'
  ),
  (
    'cold_chain_food',
    'Cold Chain Food',
    '2-shift operation with Q4 peak expansion to 3. S1 trailer-unload heavy; S2 outbound + staging.',
    'food_beverage',
    2,
    '{"inbound":[75,25],"putaway":[70,30],"picking":[40,60],"replenish":[50,50],"pack":[0,0],"ship":[30,70],"returns":[100,0],"vas":[50,50]}'::jsonb,
    30,
    '3PL Cold benchmarks'
  ),
  (
    'apparel_returns',
    'Apparel / Returns-Heavy',
    '2-shift. Single direction most days; returns batched to dedicated shifts/days.',
    'apparel',
    2,
    '{"inbound":[65,35],"putaway":[60,40],"picking":[55,45],"replenish":[50,50],"pack":[55,45],"ship":[45,55],"returns":[70,30],"vas":[60,40]}'::jsonb,
    40,
    'Apparel FC benchmarks'
  ),
  (
    'auto_parts_distribution',
    'Auto Parts Distribution',
    '2-shift. Bulk inbound Monday; small-line picking mid-week.',
    'automotive',
    2,
    '{"inbound":[80,20],"putaway":[75,25],"picking":[65,35],"replenish":[60,40],"pack":[60,40],"ship":[55,45],"returns":[80,20],"vas":[70,30]}'::jsonb,
    50,
    'Auto parts DC benchmarks'
  ),
  (
    'cross_dock_flow_through',
    'Cross-Dock (Flow-Through)',
    '2-shift. IB/OB tightly coupled; no putaway/replenishment.',
    'industrial',
    2,
    '{"inbound":[55,45],"putaway":[0,0],"picking":[0,0],"replenish":[0,0],"pack":[0,0],"ship":[55,45],"returns":[0,0],"vas":[0,0]}'::jsonb,
    60,
    'Cross-dock facility benchmarks'
  )
ON CONFLICT (archetype_ref) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      vertical     = EXCLUDED.vertical,
      shifts_per_day = EXCLUDED.shifts_per_day,
      matrix       = EXCLUDED.matrix,
      sort_order   = EXCLUDED.sort_order,
      source_citation = EXCLUDED.source_citation,
      updated_at   = now();

ALTER TABLE public.ref_shift_archetype_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ref_shift_archetype_public_read ON public.ref_shift_archetype_defaults;
CREATE POLICY ref_shift_archetype_public_read
  ON public.ref_shift_archetype_defaults
  FOR SELECT
  USING (is_active = true);