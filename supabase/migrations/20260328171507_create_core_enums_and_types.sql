
-- ═══════════════════════════════════════════════════
-- IES Intelligence Hub — Core Types & Enums
-- ═══════════════════════════════════════════════════

-- Intelligence domain categories
CREATE TYPE intel_domain AS ENUM (
  'market_cost',
  'labor',
  'competitive',
  'automation_tech',
  'macro_trade',
  'deals_pipeline'
);

-- Update cadences for feeds
CREATE TYPE update_cadence AS ENUM (
  'real_time',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'as_published'
);

-- Severity / relevance levels
CREATE TYPE severity_level AS ENUM (
  'low',
  'medium',
  'high',
  'critical'
);

-- Trend direction
CREATE TYPE trend_direction AS ENUM (
  'up',
  'down',
  'stable',
  'volatile'
);

-- Deal stages
CREATE TYPE deal_stage AS ENUM (
  'discovery',
  'qualification',
  'proposal',
  'finalist',
  'negotiation',
  'closed_won',
  'closed_lost'
);

-- Industry verticals
CREATE TYPE industry_vertical AS ENUM (
  'retail_ecommerce',
  'food_beverage',
  'automotive',
  'technology_electronics',
  'industrial_manufacturing',
  'healthcare_pharma',
  'consumer_goods',
  'aerospace_defense',
  'other'
);

-- Helper: auto-updated timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
