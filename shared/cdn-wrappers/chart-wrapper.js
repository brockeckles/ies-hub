/**
 * IES Hub v3 — Chart.js CDN Wrapper
 * Bridges Chart.js (loaded as global `Chart`) with ES module imports.
 *
 * Usage:
 *   import { getChart } from './chart-wrapper.js?v=20260418-sI';
 *   const Chart = getChart();
 *   new Chart(ctx, config);
 *
 * @module shared/cdn-wrappers/chart-wrapper
 */

/**
 * Get the Chart.js constructor.
 * @returns {typeof Chart}
 * @throws {Error} if Chart.js is not loaded
 */
export function getChart() {
  // @ts-ignore — Chart loaded via CDN
  if (typeof Chart === 'undefined') {
    throw new Error('Chart.js not loaded. Add the CDN script to the page.');
  }
  // @ts-ignore
  return Chart;
}

/**
 * Create a chart with sensible IES Hub defaults.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} config — Chart.js config
 * @returns {Object} Chart instance
 */
export function createChart(canvas, config) {
  const Chart = getChart();

  // Apply IES Hub default styling
  const defaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          font: { family: 'Montserrat', size: 12, weight: '600' },
          color: '#1c1c1c',
        },
      },
      tooltip: {
        backgroundColor: '#1c1c1c',
        titleFont: { family: 'Montserrat', size: 12, weight: '700' },
        bodyFont: { family: 'Montserrat', size: 12, weight: '500' },
        cornerRadius: 6,
        padding: 10,
      },
    },
  };

  // Deep merge defaults with user config
  const merged = deepMerge(defaults, config.options || {});
  config.options = merged;

  return new Chart(canvas, config);
}

/** Simple deep merge (objects only, no arrays) */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
