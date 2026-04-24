
-- Add enum_key, color, and icon columns for dynamic UI
ALTER TABLE master_verticals ADD COLUMN IF NOT EXISTS enum_key TEXT;
ALTER TABLE master_verticals ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE master_verticals ADD COLUMN IF NOT EXISTS icon TEXT;

-- Delete duplicate Healthcare (id 7) — Healthcare / Pharma (id 5) is the canonical one
DELETE FROM master_verticals WHERE id = 7 AND vertical_name = 'Healthcare';

-- Add missing verticals that exist in the enum but not in master_verticals
INSERT INTO master_verticals (vertical_name, description, gxo_focus_level, status)
VALUES 
  ('Industrial / Manufacturing', 'Heavy industry, manufacturing logistics, MRO distribution', 'medium', 'active'),
  ('Aerospace & Defense', 'Defense logistics, aerospace component distribution, government supply chain', 'low', 'active')
ON CONFLICT DO NOTHING;

-- Set enum_key mappings for all verticals
UPDATE master_verticals SET enum_key = 'food_beverage', color = '#f59e0b', icon = '🍔' WHERE id = 1;
UPDATE master_verticals SET enum_key = 'automotive', color = '#6366f1', icon = '🚗' WHERE id = 2;
UPDATE master_verticals SET enum_key = 'retail_ecommerce', color = '#3b82f6', icon = '🛒' WHERE id = 3;
UPDATE master_verticals SET enum_key = 'technology_electronics', color = '#8b5cf6', icon = '💻' WHERE id = 4;
UPDATE master_verticals SET enum_key = 'healthcare_pharma', color = '#10b981', icon = '🏥' WHERE id = 5;
UPDATE master_verticals SET enum_key = 'consumer_goods', color = '#ec4899', icon = '📦' WHERE id = 6;
-- New rows — get their IDs dynamically
UPDATE master_verticals SET enum_key = 'industrial_manufacturing', color = '#78716c', icon = '🏭' WHERE vertical_name = 'Industrial / Manufacturing' AND enum_key IS NULL;
UPDATE master_verticals SET enum_key = 'aerospace_defense', color = '#0ea5e9', icon = '✈️' WHERE vertical_name = 'Aerospace & Defense' AND enum_key IS NULL;

-- Make enum_key unique for integrity
CREATE UNIQUE INDEX IF NOT EXISTS idx_master_verticals_enum_key ON master_verticals(enum_key) WHERE enum_key IS NOT NULL;
