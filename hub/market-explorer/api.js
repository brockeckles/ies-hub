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

import { db } from '../../shared/supabase.js?v=20260703-hw1';

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

/**
 * C3 (2026-07-22): live per-market deal counts from deal_sites.market_id —
 * replaces the hardcoded `activeDeals` literals that used to ship in
 * calc.DEMO_MARKETS. A "deal in a market" = a distinct deal_deals row with
 * at least one deal_sites row whose market_id is that ref_markets id.
 *
 * Returns { ok, counts } where counts is
 *   [{ marketId, marketName, dealCount }] (ref_markets name for fuzzy
 * matching onto the curated demo catalog — demo ids like 'mem' are not
 * ref_markets uuids).
 *
 * Fail-soft: no session or any query error → { ok: false, counts: [] } so
 * the UI falls back to no badge (em-dash), never to fabricated numbers.
 * @returns {Promise<{ ok: boolean, counts: Array<{marketId:string, marketName:string, dealCount:number}> }>}
 */
export async function fetchDealCountsByMarket() {
  try {
    // Anon RLS returns empty rows without an error — that would read as
    // "0 deals everywhere", which is a fabricated claim for a signed-out
    // viewer. Gate on a live session instead.
    const { data: sess } = await db.getClient().auth.getSession();
    if (!sess || !sess.session) return { ok: false, counts: [] };

    const [sites, refs] = await Promise.all([
      db.fetchAll('deal_sites', 'id, deal_id, market_id'),
      db.fetchAll('ref_markets', 'id, name').catch(() => []),
    ]);
    const refNameById = new Map();
    for (const r of refs || []) {
      if (r && r.id) refNameById.set(String(r.id), r.name || '');
    }
    // market_id → Set of distinct deal ids
    const dealsByMarket = new Map();
    for (const s of sites || []) {
      if (!s || !s.market_id || !s.deal_id) continue;
      const k = String(s.market_id);
      if (!dealsByMarket.has(k)) dealsByMarket.set(k, new Set());
      dealsByMarket.get(k).add(String(s.deal_id));
    }
    const counts = [];
    for (const [marketId, dealIds] of dealsByMarket) {
      counts.push({
        marketId,
        marketName: refNameById.get(marketId) || '',
        dealCount: dealIds.size,
      });
    }
    return { ok: true, counts };
  } catch (err) {
    console.warn('[ME] fetchDealCountsByMarket failed:', err);
    return { ok: false, counts: [] };
  }
}

/**
 * 2026-06-10 (assessment hub #4): Market Explorer presented 20 hardcoded
 * demo markets as live market intelligence while Command Center queried the
 * same tables live — same hub, two different wage numbers for one market.
 * This fetches the live fundamentals (labor_markets keyed by msa,
 * industrial_real_estate keyed by market) so the UI can overlay them onto
 * the demo catalog with explicit provenance.
 * @returns {Promise<{ labor: any[], realEstate: any[] }>}
 */
export async function fetchMarketFundamentals() {
  try {
    const [labor, realEstate] = await Promise.all([
      db.fetchAll('labor_markets').catch(() => []),
      db.fetchAll('industrial_real_estate').catch(() => []),
    ]);
    return { labor: labor || [], realEstate: realEstate || [] };
  } catch (err) {
    console.warn('[ME] fetchMarketFundamentals failed:', err);
    return { labor: [], realEstate: [] };
  }
}

