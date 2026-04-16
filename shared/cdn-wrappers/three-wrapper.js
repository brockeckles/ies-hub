/**
 * IES Hub v3 — Three.js CDN Wrapper
 * Bridges Three.js r128 (loaded as global `THREE`) with ES module imports.
 * Used by: Warehouse Sizing Calculator (3D view + elevation view)
 *
 * @module shared/cdn-wrappers/three-wrapper
 */

/**
 * Get the THREE namespace.
 * @returns {typeof THREE}
 */
export function getTHREE() {
  // @ts-ignore
  if (typeof THREE === 'undefined') {
    throw new Error('Three.js not loaded. Add the CDN script to the page.');
  }
  // @ts-ignore
  return THREE;
}

/**
 * Create a basic Three.js scene with camera, renderer, and lighting.
 * @param {HTMLElement} container
 * @param {Object} [opts]
 * @param {string} [opts.background='#f8f9fa']
 * @returns {{ scene: Object, camera: Object, renderer: Object, animate: (fn: () => void) => void }}
 */
export function createScene(container, opts = {}) {
  const THREE = getTHREE();
  const width = container.clientWidth;
  const height = container.clientHeight || 400;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background || '#f8f9fa');

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
  camera.position.set(150, 120, 150);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(100, 150, 100);
  scene.add(directional);

  // Animation loop helper
  let _animateFn = null;
  function loop() {
    requestAnimationFrame(loop);
    if (_animateFn) _animateFn();
    renderer.render(scene, camera);
  }
  loop();

  // Resize handler
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight || 400;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  return {
    scene,
    camera,
    renderer,
    animate(fn) { _animateFn = fn; },
    dispose() {
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
