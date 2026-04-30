/**
 * IES Hub v3 — Command Center API
 * Fetches live data from Supabase tables with curated demo fallback.
 * Tables queried: fuel_prices, labor_markets, freight_rates,
 *   competitor_news, tariff_developments, automation_news,
 *   account_signals, reshoring_activity
 *
 * @module hub/command-center/api
 */

import { db } from '../../shared/supabase.js?v=20260429-demo-s3';

/**
 * Fetch all dashboard data. Tries Supabase first, falls back to demo data.
 * @returns {Promise<DashboardData>}
 */
export async function fetchDashboardData() {
  let supabaseConnected = false;
  let kpis = DEMO_KPIS;
  let sectors = DEMO_SECTORS;
  let alerts = DEMO_ALERTS;
  let rfpSignals = DEMO_RFP_SIGNALS;
  // Hoisted so the intelligence-feed + sparkline builders below the try
  // can see them.
  let newsRows = [], rfpRows = [], tariffRows = [], accountRows = [];
  let fuelRowsHoist = [], steelRowsHoist = [], freightRowsHoist = [], laborRowsHoist = [], realEstateRowsHoist = [], alertRows = [];

  try {
    // Attempt to fetch live data from Supabase
    const fetched = await Promise.all([
      db.fetchAll('fuel_prices').catch(() => []),
      db.fetchAll('labor_markets').catch(() => []),
      db.fetchAll('freight_rates').catch(() => []),
      db.fetchAll('competitor_news').catch(() => []),
      safeAlertFetch(),
      db.fetchAll('rfp_signals').catch(() => []),
      db.fetchAll('steel_prices').catch(() => []),
      db.fetchAll('industrial_real_estate').catch(() => []),
      db.fetchAll('tariff_developments').catch(() => []),
      db.fetchAll('account_signals').catch(() => []),
    ]);
    const [fuelRows, laborRows, freightRows, _news, _alerts, _rfp, steelRows, realEstateRows, _tariff, _accounts] = fetched;
    newsRows = _news; rfpRows = _rfp; tariffRows = _tariff; accountRows = _accounts;
    alertRows = _alerts;
    fuelRowsHoist = fuelRows; steelRowsHoist = steelRows; freightRowsHoist = freightRows;
    laborRowsHoist = laborRows; realEstateRowsHoist = realEstateRows;

    // If we got any data, we're connected
    if (fuelRows.length || laborRows.length || freightRows.length) {
      supabaseConnected = true;

      // Build KPIs from live data
      if (fuelRows.length) {
        const latest = fuelRows.sort((a, b) => (b.date || b.created_at || '').localeCompare(a.date || a.created_at || ''))[0];
        kpis = { ...kpis, dieselPrice: latest.price || latest.diesel_price || kpis.dieselPrice };
      }
      if (laborRows.length) {
        const avgWage = laborRows.reduce((s, r) => s + (r.avg_wage || r.avgWage || 0), 0) / laborRows.length;
        const avgTightness = laborRows.reduce((s, r) => s + (r.tightness_index || r.laborScore || 0), 0) / laborRows.length;
        if (avgWage > 0) kpis = { ...kpis, avgWage };
        if (avgTightness > 0) kpis = { ...kpis, laborTightness: avgTightness };
      }
      if (freightRows.length) {
        const avgFreight = freightRows.reduce((s, r) => s + (r.rate_index || r.freightIndex || 0), 0) / freightRows.length;
        if (avgFreight > 0) kpis = { ...kpis, freightIndex: avgFreight };
      }
      if (steelRows.length) {
        // Latest by report_date
        const sortedSteel = [...steelRows].sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''));
        const latestSteel = sortedSteel[0];
        if (latestSteel) {
          const price = parseFloat(latestSteel.price || 0);
          const wow = parseFloat(latestSteel.wow_change ?? 0);
          const trend = wow > 0.1 ? 'up' : wow < -0.1 ? 'down' : 'neutral';
          const change = wow > 0 ? `+${wow.toFixed(1)}% WoW` : wow < 0 ? `${wow.toFixed(1)}% WoW` : 'Flat WoW';
          if (price > 0) kpis = { ...kpis, steelPrice: price, steelUnit: latestSteel.unit || '$/ton', steelTrend: trend, steelChange: change };
        }
      }

      // Industrial Real Estate — avg lease rate ($/sqft/yr NNN) across markets
      if (realEstateRows.length) {
        // Latest quarter per market
        const byMarket = new Map();
        for (const r of realEstateRows) {
          const key = r.market;
          if (!key) continue;
          const prev = byMarket.get(key);
          if (!prev || (r.quarter || '') > (prev.quarter || '')) byMarket.set(key, r);
        }
        const latest = Array.from(byMarket.values());
        if (latest.length) {
          const avgRate = latest.reduce((s, r) => s + parseFloat(r.lease_rate_psf || 0), 0) / latest.length;
          const avgYoY = latest.reduce((s, r) => s + parseFloat(r.yoy_change || 0), 0) / latest.length;
          const trend = avgYoY > 0.5 ? 'up' : avgYoY < -0.5 ? 'down' : 'neutral';
          const change = avgYoY > 0 ? `+${avgYoY.toFixed(1)}% YoY` : avgYoY < 0 ? `${avgYoY.toFixed(1)}% YoY` : 'Flat YoY';
          kpis = { ...kpis, avgWarehouseRate: avgRate, warehouseRateTrend: trend, warehouseRateChange: change };
        }
      }

      // Active RFP Signals count
      if (rfpRows.length) {
        const active = rfpRows.filter(r => (r.status || 'active') === 'active').length;
        kpis = { ...kpis, rfpSignalCount: active, rfpSignalChange: `${active} in pipeline`, rfpSignalTrend: active > 3 ? 'up' : 'neutral' };
      }

      // Build alerts from live data (newest first by created_at/date)
      if (alertRows.length > 0) {
        const sortedAlerts = [...alertRows].sort((a, b) => {
          const aKey = String(a.created_at || a.date || '');
          const bKey = String(b.created_at || b.date || '');
          return bKey.localeCompare(aKey);
        });
        alerts = sortedAlerts.slice(0, 8).map(r => ({
          title: r.title || r.headline || 'Market Alert',
          message: r.message || r.summary || r.description || '',
          severity: r.severity || 'info',
          market: r.market || r.market_id || '',
          date: formatRelative(r.created_at || r.date || new Date().toISOString()),
          source: r.source || '',
          source_url: r.source_url || '',
        }));
      }

      // Build sector items from news
      if (newsRows.length) {
        sectors = buildSectorsFromNews(newsRows, sectors);
      }

      // Build RFP signals from live data. rfp_signals schema:
      //   company, vertical, signal_type, detail, estimated_timeline, confidence (1-5), status
      if (rfpRows.length) {
        // Sort by recency (newest first); take top 5
        const sorted = [...rfpRows].sort((a, b) =>
          String(b.created_at || '').localeCompare(String(a.created_at || ''))
        );
        rfpSignals = sorted.slice(0, 5).map(r => ({
          company: r.company || 'Unknown',
          vertical: formatVertical(r.vertical),
          signal: r.signal_type || 'Signal',
          detail: r.detail || '',
          timeline: r.estimated_timeline || '',
          confidence: parseInt(r.confidence, 10) || 0,
          status: r.status || 'active',
          date: formatRelative(r.created_at || new Date().toISOString()),
        }));
      }
    }
  } catch (err) {
    console.warn('[CC] Supabase fetch failed, using demo data:', err.message);
  }

  // Build unified intelligence feed — hub_alerts folded in as a new category
  // so the Command Center Signal Stream is the single surface for everything.
  const intel = buildIntelligenceFeed({
    competitor: newsRows,
    accounts: accountRows,
    tariff: tariffRows,
    rfp: rfpRows,
    alerts: Array.isArray(alertRows) ? alertRows : [],
  });

  // Build sparkline data for KPI tiles — compact last-N number arrays so the
  // KPI tiles can render inline SVG sparks instead of needing separate charts.
  const sparks = buildKpiSparks({
    fuel: fuelRowsHoist, steel: steelRowsHoist, freight: freightRowsHoist,
    labor: laborRowsHoist, rfp: rfpRows, realEstate: realEstateRowsHoist,
  });

  return {
    supabaseConnected,
    kpis,
    sectors,
    alerts,
    rfpSignals,
    intel,
    sparks,
    pipeline: DEMO_PIPELINE,
    activity: DEMO_ACTIVITY,
  };
}

/**
 * Build compact sparkline series for each KPI. Each result is an array of
 * numbers (most recent last). KPI tiles render an inline SVG polyline from
 * these arrays. Falls back to the demo series when the table is empty or
 * has only a current snapshot (wage/warehouse rate fall into that bucket).
 */
function buildKpiSparks(src) {
  const out = {};

  // Diesel — last 26 weekly prices
  if (src.fuel?.length) {
    const sorted = [...src.fuel].sort((a, b) => (a.report_date || a.date || '').localeCompare(b.report_date || b.date || ''));
    out.diesel = sorted.slice(-26).map(r => parseFloat(r.price_per_gallon || r.price || 0)).filter(v => v > 0);
  } else {
    out.diesel = DEMO_DIESEL_CHART.prices.slice();
  }

  // Steel — last 26 weekly prices
  if (src.steel?.length) {
    const sorted = [...src.steel].sort((a, b) => (a.report_date || '').localeCompare(b.report_date || ''));
    out.steel = sorted.slice(-26).map(r => parseFloat(r.price || 0)).filter(v => v > 0);
  } else {
    out.steel = DEMO_STEEL_CHART.prices.slice();
  }

  // Freight Index — last 26 readings (spot preferred)
  if (src.freight?.length) {
    const sorted = [...src.freight].sort((a, b) => (a.report_date || '').localeCompare(b.report_date || ''));
    out.freight = sorted.slice(-26).map(r => parseFloat(r.rate_index || r.rate || 0)).filter(v => v > 0);
    if (out.freight.length < 4) out.freight = DEMO_FREIGHT_CHART.spot.slice();
  } else {
    out.freight = DEMO_FREIGHT_CHART.spot.slice();
  }

  // Labor wage — modeled 12-mo rise to current snapshot (individual markets
  // carry no history; demo is a reasonable stand-in shape).
  if (src.labor?.length) {
    // Average across markets for today; generate a gently rising 12-point
    // series ending at that number.
    const latest = src.labor.reduce((s, r) => s + parseFloat(r.avg_wage || r.avgWage || 0), 0) / src.labor.length;
    if (latest > 0) {
      out.wage = Array.from({ length: 12 }, (_, i) => +(latest * (0.96 + i * 0.0036)).toFixed(2));
    } else {
      out.wage = [17.95, 17.98, 18.02, 18.05, 18.08, 18.12, 18.18, 18.22, 18.28, 18.33, 18.38, 18.42];
    }
  } else {
    out.wage = [17.95, 17.98, 18.02, 18.05, 18.08, 18.12, 18.18, 18.22, 18.28, 18.33, 18.38, 18.42];
  }

  // Warehouse rate — 8 quarters ending at the current avg (modeled).
  if (src.realEstate?.length) {
    const latestByMarket = new Map();
    for (const r of src.realEstate) {
      const prev = latestByMarket.get(r.market);
      if (!prev || (r.quarter || '') > (prev.quarter || '')) latestByMarket.set(r.market, r);
    }
    const latest = Array.from(latestByMarket.values())
      .reduce((s, r) => s + parseFloat(r.lease_rate_psf || 0), 0) / Math.max(1, latestByMarket.size);
    if (latest > 0) {
      out.warehouseRate = Array.from({ length: 8 }, (_, i) => +(latest * (0.92 + i * 0.0114)).toFixed(2));
    } else {
      out.warehouseRate = [8.10, 8.25, 8.35, 8.48, 8.58, 8.68, 8.78, 8.90];
    }
  } else {
    out.warehouseRate = [8.10, 8.25, 8.35, 8.48, 8.58, 8.68, 8.78, 8.90];
  }

  // RFP signals — count by week for last 12 weeks (using created_at).
  if (src.rfp?.length) {
    const buckets = new Array(12).fill(0);
    const now = Date.now();
    for (const r of src.rfp) {
      const t = r.created_at ? new Date(r.created_at).getTime() : null;
      if (!t) continue;
      const weeksAgo = Math.floor((now - t) / (7 * 24 * 3600 * 1000));
      if (weeksAgo >= 0 && weeksAgo < 12) buckets[11 - weeksAgo] += 1;
    }
    // If we got nothing bucketed (all old/null dates), show a flat series
    // pegged at current total.
    if (buckets.every(v => v === 0)) {
      const n = src.rfp.length;
      out.rfp = Array.from({ length: 12 }, (_, i) => Math.max(0, Math.round(n * (0.6 + i * 0.036))));
    } else {
      // Cumulative over 12 weeks for a smoother curve.
      let cum = 0;
      out.rfp = buckets.map(v => { cum += v; return cum; });
    }
  } else {
    out.rfp = [1, 1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5];
  }

  return out;
}

/**
 * Combine the four intel streams into a single structure with all + per-category.
 * @param {{competitor: any[], accounts: any[], tariff: any[], rfp: any[]}} src
 * @returns {{all: any[], competitor: any[], accounts: any[], tariff: any[], rfp: any[]}}
 */
function buildIntelligenceFeed(src) {
  const toItem = (r, category) => {
    // Accounts: account_signals rows carry account_name + signal_type as a
    // pair; surface both so the feed reads "Walmart — Leadership Change"
    // rather than just the signal type.
    let title, detail;
    if (category === 'Accounts') {
      const acct = r.account_name || r.company || '';
      const sig = r.signal_type || '';
      title = acct && sig ? `${acct} — ${sig}` : (acct || sig || 'Account signal');
      detail = r.detail || r.summary || r.description || r.message || '';
    } else {
      title = r.headline || r.title || r.company || r.signal_type || 'Signal';
      detail = r.summary || r.detail || r.description || r.message || '';
    }
    return {
      category,
      title,
      detail,
      severity: r.severity || 'info',
      source: r.source || '',
      source_url: r.source_url || '',
      at: r.created_at || r.date || r.published_at || r.signal_date || null,
      relDate: formatRelative(r.created_at || r.date || r.published_at || r.signal_date || new Date().toISOString()),
    };
  };

  // Sort each category newest-first (by `at`) before capping, so we don't
  // drop recent items that happen to appear late in the raw result set.
  const sortByAtDesc = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  const competitor = (src.competitor || []).map(r => toItem(r, 'Competitor')).sort(sortByAtDesc).slice(0, 25);
  const accounts = (src.accounts || []).map(r => toItem(r, 'Accounts')).sort(sortByAtDesc).slice(0, 25);
  const tariff = (src.tariff || []).map(r => toItem(r, 'Tariff')).sort(sortByAtDesc).slice(0, 25);
  const rfp = (src.rfp || []).map(r => toItem(r, 'RFP')).sort(sortByAtDesc).slice(0, 25);
  const alerts = (src.alerts || []).map(r => toItem(r, 'Alerts')).sort(sortByAtDesc).slice(0, 25);

  const all = [...alerts, ...competitor, ...accounts, ...tariff, ...rfp]
    .sort(sortByAtDesc)
    .slice(0, 60);

  return { all, alerts, competitor, accounts, tariff, rfp };
}

/**
 * Fetch chart-specific data (diesel, freight, labor) for rendering Chart.js
 * @returns {Promise<ChartData>}
 */
export async function fetchChartData() {
  const diesel = { labels: [], prices: [] };
  const freight = { labels: [], spot: [], contract: [] };
  const labor = { regions: [], wages: [] };
  let steel = DEMO_STEEL_CHART;

  try {
    // Steel prices — 26 weeks
    const steelRows = await db.fetchAll('steel_prices').catch(() => []);
    if (steelRows.length) {
      const sorted = [...steelRows].sort((a, b) => (a.report_date || '').localeCompare(b.report_date || ''));
      steel = {
        labels: sorted.map(r => {
          const d = new Date(r.report_date || new Date().toISOString());
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }),
        prices: sorted.map(r => parseFloat(r.price || 0)),
      };
    }

    // Fetch diesel price data
    const fuelRows = await db.fetchAll('fuel_prices').catch(() => []);
    if (fuelRows.length) {
      const recent = fuelRows.slice(-52); // Last 52 weeks
      diesel.labels = recent.map(r => {
        const d = new Date(r.report_date || r.date || new Date().toISOString());
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      diesel.prices = recent.map(r => parseFloat(r.price_per_gallon || r.price || 3.85));
    } else {
      return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART, steel };
    }

    // Fetch freight rate data
    const freightRows = await db.fetchAll('freight_rates').catch(() => []);
    if (freightRows.length) {
      const spotRates = freightRows.filter(r => r.rate_type === 'spot' || r.index_name === 'DAT Spot Van');
      const contractRates = freightRows.filter(r => r.rate_type === 'contract' || r.index_name === 'DAT Contract Van');

      if (spotRates.length) {
        freight.labels = spotRates.slice(-26).map(r => {
          const d = new Date(r.report_date || r.date || new Date().toISOString());
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        freight.spot = spotRates.slice(-26).map(r => parseFloat(r.rate || 2.15));
        freight.contract = contractRates.slice(-26).map(r => parseFloat(r.rate || 2.00));
      }
    } else {
      return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART, steel };
    }

    // Fetch labor wage data by region
    const laborRows = await db.fetchAll('labor_markets').catch(() => []);
    if (laborRows.length) {
      const byRegion = {};
      laborRows.forEach(r => {
        const region = r.region || r.msa || 'Unknown';
        const wage = parseFloat(r.avg_wage || r.avgWage || 18);
        if (!byRegion[region]) byRegion[region] = [];
        byRegion[region].push(wage);
      });

      // Average wages by region, take top 5
      const regionWages = Object.entries(byRegion)
        .map(([region, wages]) => ({
          region,
          wage: wages.reduce((a, b) => a + b, 0) / wages.length
        }))
        .sort((a, b) => b.wage - a.wage)
        .slice(0, 5);

      labor.regions = regionWages.map(r => r.region);
      labor.wages = regionWages.map(r => r.wage);
    } else {
      return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART, steel };
    }

    return { diesel, freight, labor, steel };
  } catch (err) {
    console.warn('[CC] Chart data fetch failed, using demo:', err.message);
    return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART, steel };
  }
}

/** Normalize enum-like vertical strings ("retail_ecommerce" → "Retail / E-Commerce"). */
function formatVertical(v) {
  if (!v) return 'General';
  const cleaned = String(v).replace(/_/g, ' ').split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return cleaned.replace(/Ecommerce/i, 'E-Commerce');
}

// ============================================================
// HELPERS
// ============================================================

async function safeAlertFetch() {
  // Try tables in order of most-likely-to-exist to minimize console noise. hub_alerts
  // is the canonical table; the others are historical fallbacks that may not exist.
  for (const table of ['hub_alerts', 'market_alerts', 'account_signals']) {
    try {
      const rows = await db.fetchAll(table);
      if (rows.length) return rows;
    } catch { /* try next */ }
  }
  return [];
}

function buildSectorsFromNews(newsRows, fallback) {
  const categorized = { labor: [], freight: [], automation: [], network: [] };

  for (const row of newsRows) {
    const hl = (row.headline || row.title || row.summary || '').toLowerCase();
    const item = {
      headline: row.headline || row.title || row.summary || '',
      severity: row.severity || 'info',
      source: row.source || '',
      source_url: row.source_url || '',
    };
    // Keyword-based categorization from headline text
    if (/labor|wage|worker|workforce|hiring|staffing|employ|strike|union/.test(hl)) categorized.labor.push(item);
    else if (/freight|truck|tl|ltl|parcel|shipping|logistics|carrier|transport|lane|dock|port/.test(hl)) categorized.freight.push(item);
    else if (/autom|robot|cobot|amr|agv|tech|ai|machine|conveyor|sortation/.test(hl)) categorized.automation.push(item);
    else if (/network|reshoring|supply|warehouse|facility|distribution|nearshoring|tariff/.test(hl)) categorized.network.push(item);
    else categorized.network.push(item); // default bucket
  }

  return {
    labor: categorized.labor.length >= 1
      ? { items: categorized.labor.slice(0, 3), source: 'Live — Competitor Intelligence' }
      : fallback.labor,
    freight: categorized.freight.length >= 1
      ? { items: categorized.freight.slice(0, 3), source: 'Live — Competitor Intelligence' }
      : fallback.freight,
    automation: categorized.automation.length >= 1
      ? { items: categorized.automation.slice(0, 3), source: 'Live — Competitor Intelligence' }
      : fallback.automation,
    network: categorized.network.length >= 1
      ? { items: categorized.network.slice(0, 3), source: 'Live — Competitor Intelligence' }
      : fallback.network,
  };
}

function formatRelative(isoDate) {
  try {
    const d = new Date(isoDate);
    const now = new Date();
    const diffMs = now - d;
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);
    if (diffH < 1) return 'Just now';
    if (diffH < 24) return `${diffH}h ago`;
    if (diffD < 7) return `${diffD}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return 'Recently'; }
}

// ============================================================
// CURATED DEMO DATA
// ============================================================

const DEMO_KPIS = {
  dieselPrice: 3.84,
  dieselTrend: 'up',
  dieselChange: '+$0.12 vs last week',
  laborTightness: 62.4,
  laborTrend: 'up',
  laborChange: '+1.8 pts MoM',
  avgWage: 18.42,
  wageTrend: 'up',
  wageChange: '+$0.35 YoY',
  freightIndex: 94.2,
  freightTrend: 'down',
  freightChange: '-2.1 pts MoM',
  marketSignal: 73,
  signalTrend: 'neutral',
  signalChange: 'Stable — moderate activity',
  steelPrice: 835,
  steelUnit: '$/ton',
  steelTrend: 'up',
  steelChange: '+0.8% WoW',
  avgWarehouseRate: 8.90,
  warehouseRateTrend: 'up',
  warehouseRateChange: '+2.9% YoY',
  rfpSignalCount: 5,
  rfpSignalTrend: 'up',
  rfpSignalChange: '5 in pipeline',
};

const DEMO_SECTORS = {
  labor: {
    items: [
      { headline: 'Memphis warehouse wages up 4.2% YoY', severity: 'warning' },
      { headline: 'Inland Empire facing seasonal labor squeeze', severity: 'critical' },
      { headline: 'Columbus labor market remains favorable', severity: 'info' },
    ],
    source: 'Demo Data — BLS, Indeed',
  },
  freight: {
    items: [
      { headline: 'Spot TL rates softening in SE corridor', severity: 'info' },
      { headline: 'West Coast port congestion easing', severity: 'info' },
      { headline: 'Diesel surcharge adjustments expected Q2', severity: 'warning' },
    ],
    source: 'Demo Data — DAT, FreightWaves',
  },
  automation: {
    items: [
      { headline: 'GXO expanding Cobot deployments in 2026', severity: 'info' },
      { headline: 'AMR adoption accelerating in e-comm fulfillment', severity: 'info' },
      { headline: 'Locus Robotics announces new partnership', severity: 'info' },
    ],
    source: 'Demo Data — Industry News',
  },
  network: {
    items: [
      { headline: 'Savannah port volumes up 8% — capacity watch', severity: 'warning' },
      { headline: 'Reshoring index highest since 2019', severity: 'info' },
      { headline: 'New tariff package may shift nearshoring calculus', severity: 'warning' },
    ],
    source: 'Demo Data — JLL, CBRE',
  },
};

const DEMO_ALERTS = [
  { title: 'Labor Squeeze — Inland Empire', message: 'Unemployment below 3.5%. Wage pressure expected to intensify.', severity: 'critical', market: 'rvs', date: '2h ago', source: 'BLS', source_url: 'https://www.bls.gov/regions/west/' },
  { title: 'Diesel Price Spike', message: 'National avg up $0.12/gal in one week. Fuel surcharges may need adjustment.', severity: 'warning', market: '', date: '4h ago', source: 'EIA', source_url: 'https://www.eia.gov/petroleum/gasdiesel/' },
  { title: 'Savannah Port Volume Surge', message: 'Container throughput up 8% MoM. Warehouse availability tightening.', severity: 'warning', market: 'sav', date: '1d ago', source: 'GPA', source_url: 'https://gaports.com/statistics/' },
  { title: 'New Tariff Package Announced', message: 'Additional tariffs on imported goods may accelerate reshoring. Monitor IES pipeline impact.', severity: 'info', market: '', date: '1d ago', source: 'Reuters', source_url: 'https://www.reuters.com/business/' },
  { title: 'Columbus Market — New Competitor Entry', message: 'XPO expanding operations in Columbus market. Monitor pricing impact.', severity: 'info', market: 'col', date: '2d ago', source: 'FreightWaves', source_url: 'https://www.freightwaves.com/' },
  { title: 'Memphis — Favorable Lease Terms', message: 'Industrial vacancy at 6.8%. Several new builds entering market Q3.', severity: 'info', market: 'mem', date: '3d ago', source: 'CBRE', source_url: 'https://www.cbre.com/insights/reports/' },
];

const DEMO_PIPELINE = {
  activeDeals: 10,
  totalRevenue: 192200000,
  avgMargin: 10.9,
  totalSites: 24,
  stageCounts: [2, 2, 2, 2, 1, 1], // per DOS stage 1-6
};

const DEMO_ACTIVITY = [
  { title: 'Cost Model updated', description: 'Wayfair Midwest — margin adjusted to 11.2%', time: '2 hours ago', color: '#2563eb' },
  { title: 'Fleet scenario created', description: 'New fleet analysis for SE regional lanes', time: 'Yesterday', color: '#7c3aed' },
  { title: 'DOS element completed', description: 'Site Assessment checklist finalized', time: 'Yesterday', color: '#16a34a' },
  { title: 'Market alert triggered', description: 'Labor squeeze detected in Inland Empire', time: '2 days ago', color: '#dc2626' },
  { title: 'Change initiative created', description: 'DOS Process Standardization kickoff', time: '3 days ago', color: '#d97706' },
  { title: 'Feedback submitted', description: 'Fleet team driving toggle bug reported', time: '4 days ago', color: '#6b7280' },
];

const DEMO_RFP_SIGNALS = [
  { company: 'Rivian',       vertical: 'Automotive',           signal: 'Facility Expansion', detail: 'New parts DC planned in Illinois',                  timeline: '1–3 months',  confidence: 4, status: 'active', date: '3d ago' },
  { company: 'Target',       vertical: 'Retail / E-Commerce',  signal: 'Leadership Change',  detail: 'New VP Supply Chain from Amazon',                   timeline: '3–6 months',  confidence: 3, status: 'active', date: '1w ago' },
  { company: 'Peloton',      vertical: 'Consumer Goods',       signal: '10-K Commentary',    detail: '"Evaluating fulfillment partnerships"',             timeline: '3–6 months',  confidence: 3, status: 'active', date: '5d ago' },
  { company: 'Albertsons',   vertical: 'Food & Beverage',      signal: 'Cost Restructuring', detail: 'Post-merger integration; 3PL evaluation',           timeline: '6–9 months',  confidence: 2, status: 'active', date: '6d ago' },
  { company: 'Caterpillar',  vertical: 'Industrial Mfg',       signal: 'M&A Activity',       detail: 'Acquired parts distributor; integration likely',    timeline: '6–12 months', confidence: 2, status: 'active', date: '1w ago' },
];

// Demo chart data (52-week diesel, 26-week freight, regional labor)
const DEMO_DIESEL_CHART = {
  labels: ['Jan 8', 'Jan 15', 'Jan 22', 'Jan 29', 'Feb 5', 'Feb 12', 'Feb 19', 'Feb 26', 'Mar 5', 'Mar 12', 'Mar 19', 'Mar 26'],
  prices: [3.65, 3.68, 3.72, 3.78, 3.82, 3.85, 3.84, 3.81, 3.79, 3.76, 3.74, 3.72],
};

const DEMO_FREIGHT_CHART = {
  labels: ['Dec 1', 'Dec 8', 'Dec 15', 'Dec 22', 'Dec 29', 'Jan 5', 'Jan 12', 'Jan 19', 'Jan 26', 'Feb 2', 'Feb 9', 'Feb 16'],
  spot: [2.45, 2.42, 2.40, 2.38, 2.35, 2.32, 2.28, 2.25, 2.22, 2.20, 2.18, 2.15],
  contract: [2.10, 2.10, 2.10, 2.09, 2.08, 2.07, 2.06, 2.05, 2.04, 2.03, 2.02, 2.00],
};

const DEMO_LABOR_CHART = {
  regions: ['Northeast', 'Southeast', 'Midwest', 'Southwest', 'West'],
  wages: [21.45, 19.80, 18.90, 17.50, 22.10],
};

const DEMO_STEEL_CHART = {
  labels: ['Oct 10','Oct 17','Oct 24','Oct 31','Nov 7','Nov 14','Nov 21','Nov 28','Dec 5','Dec 12','Dec 19','Dec 26','Jan 2','Jan 9','Jan 16','Jan 23','Jan 30','Feb 6','Feb 13','Feb 20','Feb 27','Mar 6','Mar 13','Mar 20','Mar 27','Apr 3'],
  prices: [760, 755, 762, 770, 778, 785, 790, 795, 790, 785, 788, 792, 798, 805, 810, 815, 820, 822, 825, 828, 826, 824, 828, 830, 828, 835],
};

/**
 * @typedef {Object} DashboardData
 * @property {boolean} supabaseConnected
 * @property {Object} kpis
 * @property {Object} sectors
 * @property {Array} alerts
 * @property {Array} rfpSignals
 * @property {Object} pipeline
 * @property {Array} activity
 */
