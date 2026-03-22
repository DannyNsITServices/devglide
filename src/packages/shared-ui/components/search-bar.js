// ── SearchBar — Debounced search input with optional filter dropdown ─────────
// Returns an HTML string and provides a bind() function for event setup.

/**
 * Create a search bar HTML string.
 * @param {{ placeholder?: string, id?: string }} opts
 * @returns {string}
 */
export function createSearchBar({ placeholder = 'Search...', id = 'sui-search' } = {}) {
  return `
    <div class="search-bar">
      <input type="text" id="${id}" class="search-input" placeholder="${placeholder}" autocomplete="off" />
    </div>
  `;
}

/**
 * Bind a debounced search handler to a search input.
 * @param {HTMLElement} container — scoped container
 * @param {{ id?: string, onSearch: (query: string) => void, debounceMs?: number }} opts
 * @returns {{ destroy: () => void }} — call destroy() on unmount
 */
export function bindSearchBar(container, { id = 'sui-search', onSearch, debounceMs = 150 }) {
  const input = container.querySelector(`#${id}`);
  if (!input) return { destroy() {} };

  let timer = null;

  function handler() {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(input.value), debounceMs);
  }

  input.addEventListener('input', handler);

  return {
    destroy() {
      clearTimeout(timer);
      input.removeEventListener('input', handler);
    },
  };
}
