
-- ═══════════════════════════════════════════════════
-- RLS: Enable on all tables + read-only public access
-- The hub is an internal tool — authenticated users can read all data.
-- Write access is restricted to service_role (edge functions / admin).
-- ═══════════════════════════════════════════════════

-- Enable RLS on every table
ALTER TABLE fuel_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE industrial_real_estate ENABLE ROW LEVEL SECURITY;
ALTER TABLE construction_indices ENABLE ROW LEVEL SECURITY;
ALTER TABLE bts_cost_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulatory_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfp_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_logistics_developments ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE freight_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tariff_developments ENABLE ROW LEVEL SECURITY;
ALTER TABLE port_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE reshoring_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE reshoring_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_benchmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE win_loss_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE vertical_spotlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE vertical_spotlight_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_alerts ENABLE ROW LEVEL SECURITY;

-- Read access for anon (used by the public-facing hub with anon key)
-- In production, swap to authenticated-only if you add auth
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'fuel_prices','industrial_real_estate','construction_indices','bts_cost_components',
      'utility_rates','material_prices','labor_markets','labor_summary','union_activity',
      'regulatory_updates','competitor_news','account_signals','rfp_signals',
      'automation_news','wms_updates','ai_logistics_developments','automation_metrics',
      'freight_rates','tariff_developments','port_status','reshoring_activity',
      'reshoring_metrics','pipeline_deals','proposal_benchmarks','win_loss_factors',
      'pipeline_summary','vertical_spotlights','vertical_spotlight_deals','hub_alerts'
    ])
  LOOP
    EXECUTE format('CREATE POLICY "Allow public read" ON %I FOR SELECT TO anon USING (true)', tbl);
  END LOOP;
END $$;
