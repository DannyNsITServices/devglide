// ── Workflow Editor — Block Catalog Sidebar ─────────────────────────────
// Left panel showing categorized, draggable node blocks.

import { NODE_TYPES, NODE_CATEGORIES } from '../models/node-types.js';

let _container = null;
let _dragCb = null;
let _cleanup = [];

function renderPalette() {
  if (!_container) return;

  _container.replaceChildren();
  for (const cat of NODE_CATEGORIES) {
    const entries = Object.entries(NODE_TYPES).filter(([, def]) => def.category === cat.id);
    if (!entries.length) continue;

    const category = document.createElement('div');
    category.className = 'wb-palette-category';
    category.textContent = cat.label;
    _container.appendChild(category);

    for (const [typeKey, def] of entries) {
      const item = document.createElement('div');
      item.className = 'wb-palette-item';
      item.dataset.nodeType = typeKey;
      item.draggable = true;
      const icon = document.createElement('span');
      icon.className = 'wb-palette-item-icon';
      icon.textContent = def.icon;
      const label = document.createElement('span');
      label.textContent = def.label;
      item.append(icon, label);
      _container.appendChild(item);
    }
  }
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
