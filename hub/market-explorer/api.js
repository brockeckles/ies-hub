/**
 * IES Hub v3 — Market Explorer API
 * Fetches per-market intelligence signals by fuzzy-matching competitor_news
 * and hub_alerts headline/summary/tags against the market name + state.
 *
 * Neither table currently has a market_id column — this is a pragmatic text
 * match. Exact per-market tagging would need a schema change + backfill.
 *
 * @module hub/market-explorer/api
 */

import { db } from '../../shared/supabase.js?v=20260424-A1';

/**
 * Fetch signals relevant to a given market.
 * @param {{ name?: string, state?: string, id?: string }} market
 * @returns {Promise<{ news: any[], alerts: any[] }>}
 */
export async function fetchMarketSignals(market) {
  if (!market) return { news: [], alerts: [] };

  const primary = (market.name || '').split(/[-,/]/)[0].trim(); // "Chicago Metro" → "Chicago"
  const state = (market.state || '').trim();

  const terms = [primary, state].filter(t => t && t.length >= 2);
  if (terms.length === 0) return { news: [], alerts: [] };

  // Use ilike on each candidate field, OR'd. PostgREST supports `or` filter syntax.
  // Example: or=(headline.ilike.%Chicago%,summary.ilike.%Chicago%,tags.cs.{Chicago})
  const ilikeClauses = (field) => terms.map(t => `${field}.ilike.%${escapeIlike(t)}%`);
  const newsOr = [...ilikeClauses('headline'), ...ilikeClauses('summary')].join(',');
  const alertsOr = [...ilikeClauses('title'), ...ilikeClauses('summary')].join(',');

  try {
    const [newsRes, alertsRes] = await Promise.all([
      db.from('competitor_news')
        .select('id, headline, summary, source, source_url, published_date, competitor, relevance')
        .or(newsOr)
        .order('published_date', { ascending: false, nullsFirst: false })
        .limit(8),
      db.from('hub_alerts')
        .select('id, title, summary, severity, source, source_url, created_at')
        .eq('is_active', true)
        .or(alertsOr)
        .order('created_at', { ascending: false })
        .limit(8),
    ]);
    return {
      news: newsRes.data || [],
      alerts: alertsRes.data || [],
    };
  } catch (err) {
    console.warn('[ME] fetchMarketSignals failed:', err);
    return { news: [], alerts: [] };
  }
}

function escapeIlike(s) {
  return String(s).replace(/[%_,]/g, ''); // strip special chars to avoid breaking the filter
}
