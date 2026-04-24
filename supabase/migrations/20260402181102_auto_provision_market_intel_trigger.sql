
-- Function: when a market is inserted into master_markets, create stub rows in intel tables
CREATE OR REPLACE FUNCTION provision_market_intel()
RETURNS TRIGGER AS $$
DECLARE
  market_key TEXT;
BEGIN
  -- Use city as the canonical key across intel tables
  market_key := NEW.city;

  -- Provision labor_markets stub (if not exists)
  IF NOT EXISTS (SELECT 1 FROM labor_markets WHERE msa = market_key) THEN
    INSERT INTO labor_markets (msa, avg_warehouse_wage, availability_status, availability_score, trend, avg_time_to_fill_days, turnover_rate, as_of_date, source)
    VALUES (market_key, 18.00, 'Moderate', 50, 'stable', 18, 45.00, CURRENT_DATE, 'Pending — baseline estimate');
  END IF;

  -- Provision industrial_real_estate stub (if not exists)
  IF NOT EXISTS (SELECT 1 FROM industrial_real_estate WHERE market = market_key) THEN
    INSERT INTO industrial_real_estate (market, quarter, lease_rate_psf, vacancy_rate, yoy_change, trend, source)
    VALUES (market_key, 'Q1 2026', 7.00, 7.00, 0.00, 'stable', 'Pending — baseline estimate');
  END IF;

  -- Provision market_freight stub (if not exists)
  IF NOT EXISTS (SELECT 1 FROM market_freight WHERE market = market_key) THEN
    INSERT INTO market_freight (market, avg_outbound_rate_per_mile, avg_inbound_rate_per_mile, tl_capacity, ltl_transit_days, intermodal_available, as_of_date, source)
    VALUES (market_key, 2.20, 2.10, 'Balanced', 3.0, false, CURRENT_DATE, 'Pending — baseline estimate');
  END IF;

  -- Also set the labor_key and re_key on the master_markets row to match
  NEW.labor_key := COALESCE(NEW.labor_key, market_key);
  NEW.re_key := COALESCE(NEW.re_key, market_key);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: fires BEFORE INSERT on master_markets so we can modify NEW
CREATE TRIGGER trg_provision_market_intel
  BEFORE INSERT ON master_markets
  FOR EACH ROW
  EXECUTE FUNCTION provision_market_intel();

-- Also create an update trigger to sync labor_key/re_key
CREATE OR REPLACE FUNCTION sync_market_keys()
RETURNS TRIGGER AS $$
BEGIN
  -- If city changed, update intel table references
  IF OLD.city IS DISTINCT FROM NEW.city THEN
    UPDATE labor_markets SET msa = NEW.city WHERE msa = OLD.city;
    UPDATE industrial_real_estate SET market = NEW.city WHERE market = OLD.city;
    UPDATE market_freight SET market = NEW.city WHERE market = OLD.city;
    NEW.labor_key := NEW.city;
    NEW.re_key := NEW.city;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_market_keys
  BEFORE UPDATE ON master_markets
  FOR EACH ROW
  EXECUTE FUNCTION sync_market_keys();
