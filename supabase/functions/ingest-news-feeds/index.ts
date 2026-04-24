import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface FeedConfig {
  name: string;
  url: string;
  targetTable: string;
  mapFn: (item: any, source: string) => any;
}

function cleanText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const FEEDS: FeedConfig[] = [
  { name: 'DHL Supply Chain', url: 'https://news.google.com/rss/search?q=%22DHL+Supply+Chain%22+warehouse+OR+logistics+OR+fulfillment&hl=en-US&gl=US&ceid=US:en', targetTable: 'competitor_news',
    mapFn: (item, source) => ({ competitor: 'DHL Supply Chain', headline: cleanText(item.title), summary: cleanText(item.description) || null, tags: ['DHL SUPPLY CHAIN'], relevance: 'medium', source, source_url: item.link || null, published_date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0] }) },
  { name: 'Ryder Logistics', url: 'https://news.google.com/rss/search?q=%22Ryder%22+warehouse+OR+logistics+OR+%22supply+chain%22&hl=en-US&gl=US&ceid=US:en', targetTable: 'competitor_news',
    mapFn: (item, source) => ({ competitor: 'Ryder', headline: cleanText(item.title), summary: cleanText(item.description) || null, tags: ['RYDER'], relevance: 'medium', source, source_url: item.link || null, published_date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0] }) },
  { name: 'XPO Logistics', url: 'https://news.google.com/rss/search?q=%22XPO+Logistics%22+OR+%22XPO+Inc%22+warehouse+OR+%22supply+chain%22&hl=en-US&gl=US&ceid=US:en', targetTable: 'competitor_news',
    mapFn: (item, source) => ({ competitor: 'XPO', headline: cleanText(item.title), summary: cleanText(item.description) || null, tags: ['XPO'], relevance: 'medium', source, source_url: item.link || null, published_date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0] }) },
  { name: 'CEVA Logistics', url: 'https://news.google.com/rss/search?q=%22CEVA+Logistics%22+warehouse+OR+fulfillment&hl=en-US&gl=US&ceid=US:en', targetTable: 'competitor_news',
    mapFn: (item, source) => ({ competitor: 'CEVA', headline: cleanText(item.title), summary: cleanText(item.description) || null, tags: ['CEVA'], relevance: 'medium', source, source_url: item.link || null, published_date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0] }) },
  { name: 'Warehouse Robotics', url: 'https://news.google.com/rss/search?q=warehouse+robotics+OR+%22AMR%22+OR+%22Locus+Robotics%22+OR+%22Symbotic%22+OR+%226+River+Systems%22+OR+%22Geek%2B%22&hl=en-US&gl=US&ceid=US:en', targetTable: 'automation_news',
    mapFn: (item, source) => { const headline = cleanText(item.title); const vendor = ['Symbotic','Locus','Geek+','6 River','Ocado','AutoStore','Berkshire Grey','Fetch'].find(v => headline.includes(v)) || 'Industry'; return { vendor, headline, summary: cleanText(item.description) || null, tags: ['ROBOTICS'], relevance: 'medium', source, source_url: item.link || null, published_date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0] }; } },
  { name: 'US Tariffs & Trade', url: 'https://news.google.com/rss/search?q=US+tariff+OR+%22trade+policy%22+OR+%22USTR%22+logistics+OR+%22supply+chain%22&hl=en-US&gl=US&ceid=US:en', targetTable: 'tariff_developments',
    mapFn: (item, source) => ({ title: cleanText(item.title), summary: cleanText(item.description) || null, status: 'WATCH', impact: 'medium', source, source_url: item.link || null, published_date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0] }) },
];

function parseRSSItems(xml: string): any[] {
  const items: any[] = [];
  const itemRegex = /<item>(.*?)<\/item>/gs;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag: string) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[(.+?)\\]\\]><\\/${tag}>|<${tag}[^>]*>(.+?)<\\/${tag}>`, 's'));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    items.push({ title: getTag('title'), description: getTag('description'), link: getTag('link'), pubDate: getTag('pubDate') });
  }
  return items;
}

// Map table → unique conflict column
const CONFLICT_COL: Record<string,string> = {
  competitor_news: 'headline',
  automation_news: 'headline',
  tariff_developments: 'title',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const url = new URL(req.url);
    const feedFilter = url.searchParams.get('feeds');
    const maxPerFeed = parseInt(url.searchParams.get('limit') || '5');
    const activeFeedConfigs = feedFilter
      ? FEEDS.filter(f => feedFilter.split(',').some(name => f.name.toLowerCase().includes(name.toLowerCase())))
      : FEEDS;
    const results: Record<string, any> = {};
    let totalUpserted = 0;
    for (const feed of activeFeedConfigs) {
      try {
        const res = await fetch(feed.url, { headers: { 'User-Agent': 'IES-Intelligence-Hub/1.0' } });
        if (!res.ok) { results[feed.name] = { error: `HTTP ${res.status}` }; continue; }
        const xml = await res.text();
        const items = parseRSSItems(xml).slice(0, maxPerFeed);
        if (!items.length) { results[feed.name] = { items_found: 0, upserted: 0 }; continue; }
        // De-dup within this batch by conflict key, drop blanks
        const onConflict = CONFLICT_COL[feed.targetTable] || 'headline';
        const mapped = items.map(i => feed.mapFn(i, feed.name)).filter(r => r[onConflict]);
        const seen = new Set<string>();
        const unique = mapped.filter(r => { const k = r[onConflict]; if (seen.has(k)) return false; seen.add(k); return true; });
        if (!unique.length) { results[feed.name] = { items_found: items.length, upserted: 0 }; continue; }
        const { error, count } = await supabase
          .from(feed.targetTable)
          .upsert(unique, { onConflict, ignoreDuplicates: false, count: 'exact' });
        if (error) { results[feed.name] = { error: error.message }; }
        else { results[feed.name] = { items_found: items.length, upserted: unique.length }; totalUpserted += unique.length; }
      } catch (feedErr) { results[feed.name] = { error: (feedErr as Error).message }; }
    }
    return new Response(JSON.stringify({ status: 'ok', feeds_processed: Object.keys(results).length, total_upserted: totalUpserted, details: results }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
});
