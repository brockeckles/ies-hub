import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// National/topical queries (location parsed from title)
const NATIONAL = [
  { q: '(union OR UAW OR Teamsters OR ILA) (warehouse OR logistics OR fulfillment OR distribution) -russia -ukraine', severity: 'high' },
  { q: '(UAW OR IAM OR USW) (plant OR factory) (strike OR contract OR ratify OR vote) -russia -ukraine -military', severity: 'high' },
  { q: '(Amazon OR FedEx OR UPS OR DHL OR Walmart OR Target) (union OR strike OR organize OR Teamsters) -russia -ukraine', severity: 'high' },
  { q: '(port workers OR ILA OR longshore) (contract OR walkout OR negotiate)', severity: 'high' },
  { q: '(NLRB OR unfair labor practice) (filed OR complaint OR ruling)', severity: 'medium' },
  { q: '(Starbucks OR REI OR Trader Joes OR Whole Foods) union vote', severity: 'medium' }
];

// State-scoped queries — location is GUARANTEED from the query itself
const STATES = [
  { name: 'California', loc: 'California' },
  { name: 'Texas', loc: 'Texas' },
  { name: 'New York', loc: 'New York' },
  { name: 'Illinois', loc: 'Illinois' },
  { name: 'Michigan', loc: 'Michigan' },
  { name: 'Pennsylvania', loc: 'Pennsylvania' },
  { name: 'Ohio', loc: 'Ohio' },
  { name: 'Georgia', loc: 'Georgia' },
  { name: 'Florida', loc: 'Florida' },
  { name: 'Washington state', loc: 'Washington' },
  { name: 'Tennessee', loc: 'Tennessee' },
  { name: 'North Carolina', loc: 'North Carolina' },
  { name: 'Indiana', loc: 'Indiana' },
  { name: 'New Jersey', loc: 'New Jersey' },
  { name: 'Virginia', loc: 'Virginia' }
];

const NOISE_RE = /(russia|ukraine|odesa|kyiv|pavlohrad|kharkiv|donetsk|zelensky|putin|kremlin|missile|drone strike|air strike|israeli strike|\biran\b|hamas|gaza|hezbollah|houthi|\bbomb\b|rocket strike|pantry clutter|coupon|prime day sale|black friday deal|banish)/i;

const STATUS_KEYWORDS = [
  { re: /ratif|approv|agree|deal reached|accept/i, status: 'Ratified' },
  { re: /strike vote|authorize|walkout|picket|strike begins|on strike/i, status: 'Strike vote' },
  { re: /negotiat|bargain|talks|tentative/i, status: 'Negotiating' },
  { re: /organiz|card|petition|drive/i, status: 'Organizing' },
  { re: /file|lawsuit|charge|complaint|nlrb/i, status: 'Filed' }
];

function detectStatus(text) { for (const s of STATUS_KEYWORDS) if (s.re.test(text)) return s.status; return 'Negotiating'; }

function detectCompany(title) {
  const COMPANIES = ['Boeing','Amazon','UPS','FedEx','DHL','Walmart','Target','Tesla','Ford','GM','Stellantis','Toyota','Honda','Nissan','Hyundai','Kia','Volkswagen','Mercedes','BMW','Starbucks','REI','Costco','Kroger','Whole Foods','Trader Joes','Chipotle','Dollar General','John Deere','Caterpillar','Kaiser Permanente','MGM','Samsung','CPKC','Union Pacific','Norfolk Southern','BNSF','CSX','PepsiCo','Frito-Lay','Macys','Bloomingdales','Nordstrom','Home Depot','Lowes','IKEA','Boeing','Intel','Micron'];
  for (const c of COMPANIES) if (title.toLowerCase().includes(c.toLowerCase())) return c;
  const m = title.match(/\b([A-Z][A-Za-z&.-]+(?:\s+[A-Z][A-Za-z&.-]+)?)\b/);
  return m ? m[1] : 'Unknown';
}

const CITY_MAP: [string,string][] = [
  ['Staten Island','Staten Island, NY'],['Brooklyn','Brooklyn, NY'],['Manhattan','Manhattan, NY'],['Buffalo','Buffalo, NY'],['Rochester','Rochester, NY'],
  ['Los Angeles','Los Angeles, CA'],['San Francisco','San Francisco, CA'],['Oakland','Oakland, CA'],['San Diego','San Diego, CA'],['Sacramento','Sacramento, CA'],['San Jose','San Jose, CA'],['Long Beach','Long Beach, CA'],
  ['Chicago','Chicago, IL'],['Moline','Moline, IL'],['Belvidere','Belvidere, IL'],
  ['Houston','Houston, TX'],['Dallas','Dallas, TX'],['Austin','Austin, TX'],['San Antonio','San Antonio, TX'],
  ['Philadelphia','Philadelphia, PA'],['Pittsburgh','Pittsburgh, PA'],
  ['Phoenix','Phoenix, AZ'],['Tucson','Tucson, AZ'],
  ['Seattle','Seattle, WA'],['Tacoma','Tacoma, WA'],['Bellevue','Bellevue, WA'],['Issaquah','Issaquah, WA'],
  ['Portland','Portland, OR'],
  ['Atlanta','Atlanta, GA'],['Savannah','Savannah, GA'],
  ['Miami','Miami, FL'],['Orlando','Orlando, FL'],['Tampa','Tampa, FL'],['Jacksonville','Jacksonville, FL'],
  ['Detroit','Detroit, MI'],['Grand Rapids','Grand Rapids, MI'],['Lansing','Lansing, MI'],['Flint','Flint, MI'],['Dearborn','Dearborn, MI'],
  ['Minneapolis','Minneapolis, MN'],['St. Paul','St. Paul, MN'],
  ['Boston','Boston, MA'],['Worcester','Worcester, MA'],['Cambridge','Cambridge, MA'],
  ['Denver','Denver, CO'],['Boulder','Boulder, CO'],
  ['Las Vegas','Las Vegas, NV'],['Reno','Reno, NV'],
  ['Nashville','Nashville, TN'],['Memphis','Memphis, TN'],['Chattanooga','Chattanooga, TN'],['Knoxville','Knoxville, TN'],
  ['Charlotte','Charlotte, NC'],['Raleigh','Raleigh, NC'],['Greensboro','Greensboro, NC'],['Durham','Durham, NC'],
  ['Columbus','Columbus, OH'],['Cleveland','Cleveland, OH'],['Cincinnati','Cincinnati, OH'],['Toledo','Toledo, OH'],['Dayton','Dayton, OH'],['Akron','Akron, OH'],
  ['Indianapolis','Indianapolis, IN'],['Fort Wayne','Fort Wayne, IN'],
  ['Milwaukee','Milwaukee, WI'],['Madison','Madison, WI'],
  ['Kansas City','Kansas City, MO'],['St. Louis','St. Louis, MO'],
  ['Louisville','Louisville, KY'],['Lexington','Lexington, KY'],['Georgetown','Georgetown, KY'],
  ['New Orleans','New Orleans, LA'],['Baton Rouge','Baton Rouge, LA'],
  ['Birmingham','Birmingham, AL'],['Montgomery','Montgomery, AL'],['Huntsville','Huntsville, AL'],['Vance','Vance, AL'],
  ['Canton, MS','Canton, MS'],
  ['Topeka','Topeka, KS'],['Wichita','Wichita, KS'],
  ['Newark','Newark, NJ'],['Jersey City','Jersey City, NJ'],
  ['Baltimore','Baltimore, MD'],
  ['Richmond','Richmond, VA'],['Norfolk','Norfolk, VA'],
  ['Hartford','Hartford, CT'],['New Haven','New Haven, CT'],
  ['Salt Lake City','Salt Lake City, UT'],['Albuquerque','Albuquerque, NM'],['Boise','Boise, ID'],
  ['East Coast','East Coast'],['West Coast','West Coast'],['Gulf Coast','Gulf Coast'],
  ['California','California'],['Texas','Texas'],['Florida','Florida'],['New York','New York'],['Illinois','Illinois'],['Pennsylvania','Pennsylvania'],['Ohio','Ohio'],['Georgia','Georgia'],['Michigan','Michigan'],['North Carolina','North Carolina'],['New Jersey','New Jersey'],['Virginia','Virginia'],['Washington','Washington'],['Arizona','Arizona'],['Tennessee','Tennessee'],['Massachusetts','Massachusetts'],['Indiana','Indiana'],['Missouri','Missouri'],['Maryland','Maryland'],['Wisconsin','Wisconsin'],['Colorado','Colorado'],['Minnesota','Minnesota'],['Alabama','Alabama'],['Louisiana','Louisiana'],['Kentucky','Kentucky'],['Oregon','Oregon'],['Oklahoma','Oklahoma'],['Connecticut','Connecticut'],['Iowa','Iowa'],['Utah','Utah'],['Arkansas','Arkansas'],['Nevada','Nevada'],['Mississippi','Mississippi'],['Kansas','Kansas'],['Nebraska','Nebraska']
];

function detectLocation(title) {
  for (const [pat, loc] of CITY_MAP) if (title.includes(pat)) return loc;
  return '';
}

async function fetchRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:30d&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  const rx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)||[])[1]||'';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)||[])[1]||'';
    const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1]||'';
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)||[])[1]||'Google News';
    items.push({ title: title.replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim(), link: link.trim(), pubDate: pub.trim(), source: source.trim() });
  }
  return items;
}

async function ingestItems(sb, items, fallbackLoc, severity, cutoffStr, counters) {
  for (const it of items) {
    if (!it.title || !it.link) continue;
    const cleanTitle = it.title.replace(/\s+-\s+[^-]+$/, '');
    if (NOISE_RE.test(cleanTitle)) { counters.noise++; continue; }
    const eventDate = it.pubDate ? new Date(it.pubDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
    if (eventDate < cutoffStr) { counters.stale++; continue; }
    const detected = detectLocation(cleanTitle);
    const location = detected || fallbackLoc || '';
    const row = {
      event_description: cleanTitle.slice(0, 220),
      company: detectCompany(cleanTitle),
      location,
      status: detectStatus(cleanTitle),
      impact: severity,
      details: cleanTitle,
      event_date: eventDate,
      source: it.source,
      source_url: it.link
    };
    const { error } = await sb.from('union_activity').upsert(row, { onConflict: 'company,event_date,event_description', ignoreDuplicates: true });
    if (error) counters.errors.push(error.message); else counters.inserted++;
  }
}

Deno.serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const counters = { inserted: 0, stale: 0, noise: 0, errors: [] as string[] };
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0,10);

  // National queries — location from title parsing
  for (const q of NATIONAL) {
    try { await ingestItems(sb, await fetchRss(q.q), '', q.severity, cutoffStr, counters); }
    catch(e) { counters.errors.push('nat: ' + e.message); }
  }

  // State-scoped queries — location GUARANTEED from query itself
  for (const st of STATES) {
    try {
      const q = `(union OR strike OR UAW OR Teamsters OR NLRB) workers ${st.name} -russia -ukraine`;
      await ingestItems(sb, await fetchRss(q), st.loc, 'medium', cutoffStr, counters);
    } catch(e) { counters.errors.push('state ' + st.name + ': ' + e.message); }
  }

  // Prune anything stale
  const { count } = await sb.from('union_activity').delete({ count: 'exact' }).lt('event_date', cutoffStr);

  return new Response(JSON.stringify({
    inserted: counters.inserted,
    skippedStale: counters.stale,
    skippedNoise: counters.noise,
    pruned: count || 0,
    errors: counters.errors.slice(0,5),
    cutoff: cutoffStr,
    ts: new Date().toISOString()
  }), { headers: { 'Content-Type': 'application/json' }});
});
