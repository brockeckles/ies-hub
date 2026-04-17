/**
 * IES Hub v3 — Command Center API
 * Fetches live data from Supabase tables with curated demo fallback.
 * Tables queried: fuel_prices, labor_markets, freight_rates,
 *   competitor_news, tariff_developments, automation_news,
 *   account_signals, reshoring_activity
 *
 * @module hub/command-center/api
 */

import { db } from '../../shared/supabase.js';

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

  try {
    // Attempt to fetch live data from Supabase
    const [fuelRows, laborRows, freightRows, newsRows, alertRows, rfpRows] = await Promise.all([
      db.fetchAll('fuel_prices').catch(() => []),
      db.fetchAll('labor_markets').catch(() => []),
      db.fetchAll('freight_rates').catch(() => []),
      db.fetchAll('competitor_news').catch(() => []),
      safeAlertFetch(),
      db.fetchAll('rfp_signals').catch(() => []),
    ]);

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

      // Build alerts from live data
      if (alertRows.length > 0) {
        alerts = alertRows.slice(0, 8).map(r => ({
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

      // Build RFP signals from live data
      if (rfpRows.length) {
        rfpSignals = rfpRows.slice(0, 6).map(r => ({
          company: r.company || r.account_name || 'Unknown',
          vertical: r.vertical || r.industry || 'General',
          volume: r.volume || r.volume_pallets_mo || 'N/A',
          region: r.region || 'Unknown',
          stage: r.stage || r.status || 'active',
          date: formatRelative(r.created_at || r.date || new Date().toISOString()),
        }));
      }
    }
  } catch (err) {
    console.warn('[CC] Supabase fetch failed, using demo data:', err.message);
  }

  return {
    supabaseConnected,
    kpis,
    sectors,
    alerts,
    rfpSignals,
    pipeline: DEMO_PIPELINE,
    activity: DEMO_ACTIVITY,
  };
}

/**
 * Fetch chart-specific data (diesel, freight, labor) for rendering Chart.js
 * @returns {Promise<ChartData>}
 */
export async function fetchChartData() {
  const diesel = { labels: [], prices: [] };
  const freight = { labels: [], spot: [], contract: [] };
  const labor = { regions: [], wages: [] };

  try {
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
      return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART };
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
      return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART };
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
      return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART };
    }

    return { diesel, freight, labor };
  } catch (err) {
    console.warn('[CC] Chart data fetch failed, using demo:', err.message);
    return { diesel: DEMO_DIESEL_CHART, freight: DEMO_FREIGHT_CHART, labor: DEMO_LABOR_CHART };
  }
}

// ============================================================
// HELPERS
// ============================================================

async function safeAlertFetch() {
  // Try multiple possible alert tables
  for (const table of ['market_alerts', 'hub_alerts', 'account_signals']) {
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
  { company: 'Kraft Heinz', vertical: 'Food & Beverage', volume: '4,200', region: 'Midwest', stage: 'active', date: '2d ago' },
  { company: 'Amazon', vertical: 'E-Commerce', volume: '8,500', region: 'West', stage: 'active', date: '3d ago' },
  { company: 'Target', vertical: 'Retail', volume: '3,100', region: 'Northeast', stage: 'closed', date: '1w ago' },
  { company: 'Unilever', vertical: 'Consumer Goods', volume: '5,600', region: 'Southeast', stage: 'pending', date: '5d ago' },
  { company: 'XPO Logistics', vertical: 'Logistics', volume: '2,800', region: 'South', stage: 'active', date: '4d ago' },
  { company: 'PepsiCo', vertical: 'Beverages', volume: '6,100', region: 'Central', stage: 'pending', date: '1w ago' },
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
