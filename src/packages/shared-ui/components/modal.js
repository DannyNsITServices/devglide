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

/**
 * Show a single-input prompt dialog. Returns the input string on confirm,
 * or `null` if dismissed/cancelled. Whitespace is preserved as-is so callers
 * can decide on their own trim/empty semantics — matching the contract of the
 * native `prompt()` it replaces (where pressing Cancel returns `null` and
 * confirming an empty field returns `""`).
 *
 * Keyboard:
 *   - Enter inside the input submits as if the primary button was clicked.
 *   - Escape (handled by showModal) dismisses with `null`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   title: string,
 *   message?: string,            // trusted HTML — caller must escape user data
 *   label?: string,              // plain text label above the input
 *   defaultValue?: string,
 *   placeholder?: string,
 *   confirmLabel?: string,
 *   confirmCls?: string,
 *   inputType?: string,          // "text" by default
 * }} opts
 * @returns {Promise<string|null>}
 */
export async function promptModal(container, {
  title,
  message = '',
  label = '',
  defaultValue = '',
  placeholder = '',
  confirmLabel = 'OK',
  confirmCls = 'btn-primary',
  inputType = 'text',
} = {}) {
  const inputId = `sui-prompt-input-${Math.random().toString(36).slice(2, 10)}`;
  const messageHtml = message
    ? `<p style="font-size:var(--df-font-size-sm);color:var(--df-color-text-secondary);margin:0 0 var(--df-space-2)">${message}</p>`
    : '';
  const labelHtml = label
    ? `<label for="${inputId}" style="display:block;font-size:var(--df-font-size-sm);color:var(--df-color-text-secondary);margin-bottom:var(--df-space-1)">${escapeHtml(label)}</label>`
    : '';
  const body = `
    ${messageHtml}
    ${labelHtml}
    <input
      id="${inputId}"
      type="${escapeHtml(inputType)}"
      class="sui-prompt-input"
      value="${escapeHtml(defaultValue)}"
      placeholder="${escapeHtml(placeholder)}"
      style="width:100%;box-sizing:border-box;padding:var(--df-space-2);font-size:var(--df-font-size-sm);background:var(--df-color-bg-input);border:1px solid var(--df-color-border-default);border-radius:6px;color:var(--df-color-text-primary)"
    />
  `;

  // We need to read the input value at the moment the user clicks confirm,
  // so we wrap showModal in a Promise that intercepts the keydown for Enter
  // and reads from the DOM after showModal resolves. The simplest reliable
  // approach is: wire an Enter listener that programmatically clicks the
  // primary button, and capture the input element's current value into a
  // closure-scoped ref the caller can read after showModal resolves.
  let capturedValue = null;
  let inputEl = null;

  // showModal appends the overlay to `container`, so we can find the input
  // via container.querySelector once the DOM is mounted. requestAnimationFrame
  // inside showModal already focuses the first button — we override that and
  // focus the input instead via a microtask after the modal mounts.
  const modalPromise = showModal(container, {
    title,
    body,
    buttons: [
      { key: 'cancel', label: 'Cancel', cls: 'btn-secondary' },
      { key: 'confirm', label: confirmLabel, cls: confirmCls },
    ],
  });

  // Bind Enter-to-submit and capture the input ref. We schedule this on the
  // next animation frame so the modal DOM is in place. Two frames are used to
  // beat showModal's own focus rAF and steal focus to the input.
  requestAnimationFrame(() => {
    inputEl = container.querySelector(`#${inputId}`);
    if (!inputEl) return;
    requestAnimationFrame(() => {
      inputEl.focus();
      inputEl.select();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        capturedValue = inputEl.value;
        const confirmBtn = container.querySelector('[data-modal-key="confirm"]');
        if (confirmBtn) confirmBtn.click();
      }
    });
  });

  const result = await modalPromise;
  if (result !== 'confirm') return null;
  // If user clicked the button (not Enter), capturedValue is still null —
  // read the input's last value before the overlay was removed. Since the
  // overlay is gone by the time showModal resolves, fall back to the value
  // we captured on the keydown path; otherwise read it from inputEl which
  // we kept a reference to.
  if (capturedValue !== null) return capturedValue;
  if (inputEl) return inputEl.value;
  return '';
}
