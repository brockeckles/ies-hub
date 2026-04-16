/**
 * IES Hub v3 — Leaflet CDN Wrapper
 * Bridges Leaflet (loaded as global `L`) with ES module imports.
 * Used by: Center of Gravity, Network Optimization, Fleet Modeler
 *
 * @module shared/cdn-wrappers/leaflet-wrapper
 */

/**
 * Get the Leaflet library.
 * @returns {typeof L}
 */
export function getLeaflet() {
  // @ts-ignore
  if (typeof L === 'undefined') {
    throw new Error('Leaflet not loaded. Add the CDN script to the page.');
  }
  // @ts-ignore
  return L;
}

/**
 * Create a Leaflet map with IES Hub defaults (US-centered, OSM tiles).
 * @param {string|HTMLElement} container — element or element ID
 * @param {Object} [opts]
 * @param {[number, number]} [opts.center=[39.8, -98.5]] — lat/lng
 * @param {number} [opts.zoom=4]
 * @returns {Object} Leaflet map instance
 */
export function createMap(container, opts = {}) {
  const L = getLeaflet();
  const center = opts.center || [39.8, -98.5];
  const zoom = opts.zoom || 4;

  const map = L.map(container, {
    center,
    zoom,
    zoomControl: true,
    scrollWheelZoom: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  return map;
}
