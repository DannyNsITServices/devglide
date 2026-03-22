// ── Header — Standard app header component ──────────────────────────────────
// Returns an HTML string. Layout: .brand | .header-meta (flex:1) | .toolbar-actions
//
// SAFETY: `brand` is escaped automatically. `meta` and `actions` accept trusted
// HTML strings (static markup defined by the app, not user input). If you need
// to include user data in meta/actions, escape it at the call site.

import { escapeHtml } from '/shared-assets/ui-utils.js';

/**
 * Create a standard app header HTML string.
 * @param {{ brand: string, meta?: string, actions?: string }} opts
 *   - brand: plain text (auto-escaped)
 *   - meta: trusted HTML string for the center section
 *   - actions: trusted HTML string for toolbar buttons
 * @returns {string}
 */
export function createHeader({ brand, meta = '', actions = '' }) {
  return `
    <header>
      <div class="brand">${escapeHtml(brand)}</div>
      <div class="header-meta">${meta}</div>
      <div class="toolbar-actions">${actions}</div>
    </header>
  `;
}
