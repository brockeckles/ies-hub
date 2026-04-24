ALTER TABLE competitor_news ADD CONSTRAINT competitor_news_headline_key UNIQUE (headline);
ALTER TABLE tariff_developments ADD CONSTRAINT tariff_developments_title_key UNIQUE (title);
ALTER TABLE automation_news ADD CONSTRAINT automation_news_headline_key UNIQUE (headline);