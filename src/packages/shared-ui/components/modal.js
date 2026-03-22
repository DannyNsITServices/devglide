// ── Modal — Promise-based modal component ────────────────────────────────────
// Usage: const result = await showModal(container, { title, body, buttons });
// Returns the clicked button's `key`, or null if dismissed.
//
// SAFETY: `title` and button `label`/`key` are auto-escaped. `body` accepts
// trusted HTML (app-defined markup). If you include user data in `body`,
// escape it at the call site with escapeHtml().

import { escapeHtml } from '/shared-assets/ui-utils.js';

/**
 * Show a modal dialog and return a Promise that resolves to the clicked button key.
 * @param {HTMLElement} container — parent element to attach the overlay to
 * @param {{ title: string, body?: string, buttons?: Array<{ key: string, label: string, cls?: string }> }} opts
 *   - title: plain text (auto-escaped)
 *   - body: trusted HTML string for the modal content
 *   - buttons[].label: plain text (auto-escaped)
 *   - buttons[].key: plain text (auto-escaped into data attribute)
 *   - buttons[].cls: CSS class (not escaped — must be a literal)
 * @returns {Promise<string|null>}
 */
export function showModal(container, { title, body = '', buttons = [] }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'sui-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const defaultButtons = buttons.length > 0
      ? buttons
      : [{ key: 'cancel', label: 'Cancel', cls: 'btn-secondary' }, { key: 'ok', label: 'OK', cls: 'btn-primary' }];

    const buttonsHtml = defaultButtons
      .map(b => `<button class="btn ${b.cls || 'btn-secondary'}" data-modal-key="${escapeHtml(b.key)}">${escapeHtml(b.label)}</button>`)
      .join('');

    const modal = document.createElement('div');
    modal.className = 'sui-modal';
    modal.innerHTML = `
      <div class="sui-modal-header"><h2>${escapeHtml(title)}</h2></div>
      <div class="sui-modal-body">${body}</div>
      <div class="sui-modal-actions">${buttonsHtml}</div>
    `;

    overlay.appendChild(modal);

    function close(result) {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(result);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') close(null);
    }

    // Button clicks
    modal.querySelector('.sui-modal-actions').addEventListener('click', (e) => {
      const key = e.target.closest('[data-modal-key]')?.dataset.modalKey;
      if (key) close(key);
    });

    // Overlay click to dismiss
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    document.addEventListener('keydown', onKeyDown);
    container.appendChild(overlay);

    // Focus first button
    requestAnimationFrame(() => {
      modal.querySelector('.sui-modal-actions button')?.focus();
    });
  });
}

/**
 * Show a confirmation dialog. Returns true if confirmed, false otherwise.
 * @param {HTMLElement} container
 * @param {{ title: string, message: string, confirmLabel?: string, confirmCls?: string }} opts
 *   - title: plain text (auto-escaped by showModal)
 *   - message: trusted HTML string (caller must escape user data)
 *   - confirmLabel: plain text (auto-escaped by showModal)
 * @returns {Promise<boolean>}
 */
export async function confirmModal(container, { title, message, confirmLabel = 'Confirm', confirmCls = 'btn-danger' }) {
  const result = await showModal(container, {
    title,
    body: `<p style="font-size:var(--df-font-size-sm);color:var(--df-color-text-secondary);margin:0">${message}</p>`,
    buttons: [
      { key: 'cancel', label: 'Cancel', cls: 'btn-secondary' },
      { key: 'confirm', label: confirmLabel, cls: confirmCls },
    ],
  });
  return result === 'confirm';
}
