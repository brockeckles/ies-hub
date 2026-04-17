/**
 * IES Hub v3 — Command Center API
 * Fetches live data from Supabase tables with curated demo fallback.
 * Tables queried: fuel_prices, labor_markets, freight_rates,
 *   competitor_news, tariff_developments, automation_news,
 *   account_signals, reshoring_activity
 *
 * @module hub/command-center/api
 */

import { db } from '../../shared/supabase.js?v=20260416-s2';

/**
 * Fetch all dashboard data. Tries Supabase first, falls back to demo data.
 * @returns {Promise<DashboardData>}
 */
export async function fetchDashboardData() {
  let supabaseConnected = false;
  let kpis = DEMO_KPIS;
  let sectors = DEMO_SECTORS;
  let alerts = DEMO_ALERTS;

  try {
    // Attempt to fetch live data from Supabase
    const [fuelRows, laborRows, freightRows, newsRows, alertRows] = await Promise.all([
      db.fetchAll('fuel_prices').catch(() => []),
      db.fetchAll('labor_markets').catch(() => []),
      db.fetchAll('freight_rates').catch(() => []),
      db.fetchAll('competitor_news').catch(() => []),
      safeAlertFetch(),
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
        }));
      }

      // Build sector items from news
      if (newsRows.length) {
        sectors = buildSectorsFromNews(newsRows, sectors);
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
    pipeline: DEMO_PIPELINE,
    activity: DEMO_ACTIVITY,
  };
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
    const cat = (row.category || row.sector || '').toLowerCase();
    const item = {
      headline: row.headline || row.title || row.summary || '',
      severity: row.severity || 'info',
    };
    if (cat.includes('labor') || cat.includes('workforce')) categorized.labor.push(item);
    else if (cat.includes('freight') || cat.includes('transport')) categorized.freight.push(item);
    else if (cat.includes('autom') || cat.includes('robot') || cat.includes('tech')) categorized.automation.push(item);
    else if (cat.includes('network') || cat.includes('reshoring') || cat.includes('supply')) categorized.network.push(item);
    else categorized.network.push(item); // default bucket
  }

  return {
    labor: categorized.labor.length >= 2
      ? { items: categorized.labor.slice(0, 3), source: 'Live — Supabase' }
      : fallback.labor,
    freight: categorized.freight.length >= 2
      ? { items: categorized.freight.slice(0, 3), source: 'Live — Supabase' }
      : fallback.freight,
    automation: categorized.automation.length >= 2
      ? { items: categorized.automation.slice(0, 3), source: 'Live — Supabase' }
      : fallback.automation,
    network: categorized.network.length >= 2
      ? { items: categorized.network.slice(0, 3), source: 'Live — Supabase' }
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
  { title: 'Labor Squeeze — Inland Empire', message: 'Unemployment below 3.5%. Wage pressure expected to intensify.', severity: 'critical', market: 'rvs', date: '2h ago' },
  { title: 'Diesel Price Spike', message: 'National avg up $0.12/gal in one week. Fuel surcharges may need adjustment.', severity: 'warning', market: '', date: '4h ago' },
  { title: 'Savannah Port Volume Surge', message: 'Container throughput up 8% MoM. Warehouse availability tightening.', severity: 'warning', market: 'sav', date: '1d ago' },
  { title: 'New Tariff Package Announced', message: 'Additional tariffs on imported goods may accelerate reshoring. Monitor IES pipeline impact.', severity: 'info', market: '', date: '1d ago' },
  { title: 'Columbus Market — New Competitor Entry', message: 'XPO expanding operations in Columbus market. Monitor pricing impact.', severity: 'info', market: 'col', date: '2d ago' },
  { title: 'Memphis — Favorable Lease Terms', message: 'Industrial vacancy at 6.8%. Several new builds entering market Q3.', severity: 'info', market: 'mem', date: '3d ago' },
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

/**
 * @typedef {Object} DashboardData
 * @property {boolean} supabaseConnected
 * @property {Object} kpis
 * @property {Object} sectors
 * @property {Array} alerts
 * @property {Object} pipeline
 * @property {Array} activity
 */
