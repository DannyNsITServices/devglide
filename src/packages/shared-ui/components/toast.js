// ── Toast — Unified toast notification helper ────────────────────────────────
// Usage: showToast(container, 'Saved!', 'success');

let _toastContainer = null;

function ensureContainer(parent) {
  if (_toastContainer && _toastContainer.isConnected) return _toastContainer;
  _toastContainer = document.createElement('div');
  _toastContainer.className = 'sui-toast-container';
  (parent ?? document.body).appendChild(_toastContainer);
  return _toastContainer;
}

/**
 * Show a toast notification.
 * @param {HTMLElement} parent — element to attach the toast container to (usually document.body or app container)
 * @param {string} msg — message text
 * @param {'info'|'success'|'warning'|'error'} type
 * @param {number} duration — auto-dismiss duration in ms (default 4000)
 */
export function showToast(parent, msg, type = 'info', duration = 4000) {
  const container = ensureContainer(parent);

  const toast = document.createElement('div');
  toast.className = `sui-toast${type !== 'info' ? ` sui-toast--${type}` : ''}`;
  toast.textContent = msg;
  container.appendChild(toast);

  // Trigger enter animation
  requestAnimationFrame(() => toast.classList.add('visible'));

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback removal if transitionend doesn't fire
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 300);
  }, duration);
}

/**
 * Remove the toast container. Call on app unmount for cleanup.
 */
export function clearToasts() {
  if (_toastContainer && _toastContainer.isConnected) {
    _toastContainer.remove();
  }
  _toastContainer = null;
}
