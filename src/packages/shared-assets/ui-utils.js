// ── Shared UI Utilities ──────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape string for use in HTML attributes.
 */
export function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert literal \n and \t escape sequences to real characters.
 */
export function normalizeEscapes(text) {
  if (!text) return '';
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * Format a date string as relative time (e.g., "5m ago", "2h ago").
 */
export function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

/**
 * Format a duration in milliseconds to human-readable string.
 */
export function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

// ── HTML Sanitization ─────────────────────────────────────────────────────────

const DANGEROUS_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet',
  'form', 'textarea', 'select', 'meta', 'link', 'base',
  'svg', 'math', 'template', 'noscript',
]);

const DANGEROUS_URL_RE = /^\s*(javascript|vbscript|data)\s*:/i;

const EVENT_ATTR_RE = /^on/i;

/**
 * Sanitize an HTML string by removing dangerous elements and attributes.
 * Uses the browser's DOMParser for robust parsing, then walks the tree
 * to strip script tags, event handlers, and javascript: URLs.
 */
export function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove dangerous elements
  for (const tag of DANGEROUS_TAGS) {
    for (const el of doc.body.querySelectorAll(tag)) el.remove();
  }
  // Walk all remaining elements
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    // Remove event-handler attributes (onclick, onerror, onload, etc.)
    for (const attr of [...node.attributes]) {
      if (EVENT_ATTR_RE.test(attr.name)) {
        node.removeAttribute(attr.name);
      }
    }
    // Strip dangerous URLs from href, src, action, formaction, xlink:href
    for (const urlAttr of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
      const val = node.getAttribute(urlAttr);
      if (val && DANGEROUS_URL_RE.test(val)) {
        node.removeAttribute(urlAttr);
      }
    }
  }
  return doc.body.innerHTML;
}
