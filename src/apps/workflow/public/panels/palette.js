// ── Workflow Editor — Block Catalog Sidebar ─────────────────────────────
// Left panel showing categorized, draggable node blocks.

import { NODE_TYPES, NODE_CATEGORIES } from '../models/node-types.js';

let _container = null;
let _dragCb = null;
let _cleanup = [];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPalette() {
  if (!_container) return;

  let html = '';
  for (const cat of NODE_CATEGORIES) {
    const entries = Object.entries(NODE_TYPES).filter(([, def]) => def.category === cat.id);
    if (!entries.length) continue;

    html += `<div class="wb-palette-category">${esc(cat.label)}</div>`;

    for (const [typeKey, def] of entries) {
      html += `
        <div class="wb-palette-item" data-node-type="${esc(typeKey)}" draggable="true">
          <span class="wb-palette-item-icon">${def.icon}</span>
          <span>${esc(def.label)}</span>
        </div>`;
    }
  }

  _container.innerHTML = html;
  bindDrag();
}

function bindDrag() {
  if (!_container) return;

  const items = _container.querySelectorAll('.wb-palette-item');
  for (const item of items) {
    const onPointerDown = (e) => {
      const typeKey = item.dataset.nodeType;
      const def = NODE_TYPES[typeKey];
      if (!def || !_dragCb) return;

      _dragCb({
        type: typeKey,
        label: def.label,
        icon: def.icon,
        color: def.color,
        originX: e.clientX,
        originY: e.clientY,
      });
    };

    const onDragStart = (e) => {
      const typeKey = item.dataset.nodeType;
      const def = NODE_TYPES[typeKey];
      if (!def) return;
      e.dataTransfer.setData('application/x-wb-node', JSON.stringify({
        type: typeKey,
        label: def.label,
      }));
      e.dataTransfer.effectAllowed = 'copy';
    };

    item.addEventListener('pointerdown', onPointerDown);
    item.addEventListener('dragstart', onDragStart);
    _cleanup.push(() => {
      item.removeEventListener('pointerdown', onPointerDown);
      item.removeEventListener('dragstart', onDragStart);
    });
  }
}

export const Palette = {
  /**
   * Render the palette into the given container element.
   * @param {HTMLElement} container
   */
  mount(container) {
    _container = container;
    renderPalette();
  },

  /**
   * Tear down the palette and clean up listeners.
   */
  unmount() {
    for (const fn of _cleanup) fn();
    _cleanup = [];
    if (_container) _container.innerHTML = '';
    _container = null;
    _dragCb = null;
  },

  /**
   * Register callback invoked when the user begins dragging a block.
   * @param {function} callback - Receives { type, label, icon, color, originX, originY }
   */
  onDragStart(callback) {
    _dragCb = callback;
  },
};
