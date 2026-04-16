/**
 * IES Hub v3 — GLPK CDN Wrapper
 * Bridges glpk.js (loaded as global `glpk`) with ES module imports.
 * Used by: Network Optimization (LP solver)
 *
 * @module shared/cdn-wrappers/glpk-wrapper
 */

/**
 * Get the GLPK solver instance.
 * @returns {Object} glpk instance
 */
export function getGLPK() {
  // @ts-ignore
  if (typeof glpk === 'undefined') {
    throw new Error('GLPK.js not loaded. Add the CDN script to the page.');
  }
  // @ts-ignore
  return glpk;
}

/**
 * Solve a linear programming problem.
 * @param {Object} model — GLPK model definition
 * @returns {Promise<Object>} solution
 */
export async function solve(model) {
  const solver = getGLPK();
  return solver.solve(model);
}
