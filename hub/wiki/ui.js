/**
 * IES Hub v3 — Wiki UI
 * @module hub/wiki/ui
 */

/**
 * Mount the Wiki section.
 * @param {HTMLElement} el
 */
export function mount(el) {
  el.innerHTML = `
    <div class="hub-content-inner">
      <h2 class="text-page mb-4">Wiki</h2>
      <div class="hub-card">
        <p class="text-body text-muted">This section will be implemented in a future phase.</p>
      </div>
    </div>
  `;
}

export function unmount() {}
