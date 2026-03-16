// ── Workflow Editor — Zoomable/Pannable Canvas ─────────────────────────
// Creates a transformable world element with SVG edge overlay and dot-grid background.

import { store } from '../state/store.js';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.1;

let _container = null;
let _root = null;
let _world = null;
let _svg = null;
let _unsubs = [];
let _isPanning = false;
let _panStart = { x: 0, y: 0 };
let _spaceHeld = false;

function buildDOM() {
  _root = document.createElement('div');
  _root.className = 'wfb-canvas';
  _root.style.cssText = `
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 100%;
    background-color: var(--df-color-bg-base);
    cursor: default;
  `;
  updateGridBackground();

  // SVG overlay for edges
  _svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  _svg.setAttribute('class', 'wfb-svg-layer');
  _svg.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  `;

  // Arrowhead marker definition
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'wfb-arrowhead');
  marker.setAttribute('viewBox', '0 0 10 7');
  marker.setAttribute('refX', '10');
  marker.setAttribute('refY', '3.5');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  arrow.setAttribute('points', '0 0, 10 3.5, 0 7');
  arrow.setAttribute('fill', 'var(--df-color-border-default)');
  marker.appendChild(arrow);
  defs.appendChild(marker);

  // Selected arrowhead
  const markerSel = marker.cloneNode(true);
  markerSel.setAttribute('id', 'wfb-arrowhead-selected');
  markerSel.querySelector('polygon').setAttribute('fill', 'var(--df-color-accent-default)');
  defs.appendChild(markerSel);

  _svg.appendChild(defs);

  // SVG group that transforms with the world
  const svgWorld = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svgWorld.setAttribute('class', 'wfb-svg-world');
  _svg.appendChild(svgWorld);

  // World element (nodes go here, transforms for pan/zoom)
  _world = document.createElement('div');
  _world.className = 'wfb-world';
  _world.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    will-change: transform;
  `;

  _root.appendChild(_svg);
  _root.appendChild(_world);
  return _root;
}

function updateGridBackground() {
  if (!_root) return;
  const zoom = store.get('zoom');
  const panX = store.get('panX');
  const panY = store.get('panY');
  const size = 20 * zoom;
  const ox = (panX % (20)) * zoom;
  const oy = (panY % (20)) * zoom;
  _root.style.backgroundImage = `radial-gradient(circle, var(--df-color-border-default) 1px, transparent 1px)`;
  _root.style.backgroundSize = `${size}px ${size}px`;
  _root.style.backgroundPosition = `${ox}px ${oy}px`;
}

function updateTransform() {
  if (!_world || !_svg) return;
  const zoom = store.get('zoom');
  const panX = store.get('panX');
  const panY = store.get('panY');
  _world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;

  // Update SVG world group to match
  const svgWorld = _svg.querySelector('.wfb-svg-world');
  if (svgWorld) {
    svgWorld.setAttribute('transform', `translate(${panX}, ${panY}) scale(${zoom})`);
  }

  updateGridBackground();
}

// ── Event handlers ──────────────────────────────────────────────────────

function onWheel(e) {
  e.preventDefault();
  const zoom = store.get('zoom');
  const delta = -Math.sign(e.deltaY) * ZOOM_STEP;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));
  if (newZoom === zoom) return;

  // Zoom toward cursor
  const rect = _root.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const panX = store.get('panX');
  const panY = store.get('panY');

  const scale = newZoom / zoom;
  const newPanX = cx - (cx - panX) * scale;
  const newPanY = cy - (cy - panY) * scale;

  store.set('zoom', newZoom);
  store.set('panX', newPanX);
  store.set('panY', newPanY);
  updateTransform();
}

function onPointerDown(e) {
  // Middle mouse button or space+left for panning
  if (e.button === 1 || (_spaceHeld && e.button === 0)) {
    e.preventDefault();
    _isPanning = true;
    _panStart = { x: e.clientX - store.get('panX'), y: e.clientY - store.get('panY') };
    _root.style.cursor = 'grabbing';
    _root.setPointerCapture(e.pointerId);
  }
}

function onPointerMove(e) {
  if (!_isPanning) return;
  const panX = e.clientX - _panStart.x;
  const panY = e.clientY - _panStart.y;
  store.set('panX', panX);
  store.set('panY', panY);
  updateTransform();
}

function onPointerUp(e) {
  if (_isPanning) {
    _isPanning = false;
    _root.style.cursor = _spaceHeld ? 'grab' : 'default';
    _root.releasePointerCapture(e.pointerId);
  }
}

function onKeyDown(e) {
  if (e.code === 'Space' && !e.repeat && document.activeElement === document.body) {
    e.preventDefault();
    _spaceHeld = true;
    if (_root) _root.style.cursor = 'grab';
  }
}

function onKeyUp(e) {
  if (e.code === 'Space') {
    _spaceHeld = false;
    if (_root && !_isPanning) _root.style.cursor = 'default';
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export const Canvas = {
  /**
   * Mount the canvas into a container.
   * @param {HTMLElement} container
   */
  mount(container) {
    _container = container;
    const root = buildDOM();
    container.appendChild(root);

    // Attach event listeners
    _root.addEventListener('wheel', onWheel, { passive: false });
    _root.addEventListener('pointerdown', onPointerDown);
    _root.addEventListener('pointermove', onPointerMove);
    _root.addEventListener('pointerup', onPointerUp);
    _root.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Subscribe to store changes
    _unsubs.push(store.on('zoom', () => updateTransform()));
    _unsubs.push(store.on('panX', () => updateTransform()));
    _unsubs.push(store.on('panY', () => updateTransform()));

    updateTransform();
  },

  /**
   * Remove listeners and clear DOM.
   */
  unmount() {
    if (_root) {
      _root.removeEventListener('wheel', onWheel);
      _root.removeEventListener('pointerdown', onPointerDown);
      _root.removeEventListener('pointermove', onPointerMove);
      _root.removeEventListener('pointerup', onPointerUp);
      _root.removeEventListener('pointercancel', onPointerUp);
    }
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);

    for (const unsub of _unsubs) unsub();
    _unsubs = [];

    if (_root && _container) {
      _container.removeChild(_root);
    }
    _root = null;
    _world = null;
    _svg = null;
    _container = null;
    _isPanning = false;
    _spaceHeld = false;
  },

  /**
   * Convert world coordinates to screen coordinates.
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }}
   */
  worldToScreen(x, y) {
    const zoom = store.get('zoom');
    const panX = store.get('panX');
    const panY = store.get('panY');
    return {
      x: x * zoom + panX,
      y: y * zoom + panY,
    };
  },

  /**
   * Convert screen coordinates to world coordinates (for drops).
   * @param {number} sx
   * @param {number} sy
   * @returns {{ x: number, y: number }}
   */
  screenToWorld(sx, sy) {
    const zoom = store.get('zoom');
    const panX = store.get('panX');
    const panY = store.get('panY');
    const rect = _root?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      x: (sx - rect.left - panX) / zoom,
      y: (sy - rect.top - panY) / zoom,
    };
  },

  /**
   * Returns the world element where nodes are placed.
   * @returns {HTMLElement|null}
   */
  getWorldElement() {
    return _world;
  },

  /**
   * Returns the SVG world group where edges are drawn.
   * @returns {SVGGElement|null}
   */
  getSvgElement() {
    return _svg?.querySelector('.wfb-svg-world') ?? null;
  },

  /**
   * Returns the root canvas element.
   * @returns {HTMLElement|null}
   */
  getRootElement() {
    return _root;
  },

  /**
   * Set the zoom level, optionally zooming toward a screen-space point.
   * @param {number} zoom
   * @param {number} [cx] - Screen X to zoom toward
   * @param {number} [cy] - Screen Y to zoom toward
   */
  setZoom(zoom, cx, cy) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (cx != null && cy != null) {
      const oldZoom = store.get('zoom');
      const panX = store.get('panX');
      const panY = store.get('panY');
      const rect = _root?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const px = cx - rect.left;
      const py = cy - rect.top;
      const scale = clamped / oldZoom;
      store.set('panX', px - (px - panX) * scale);
      store.set('panY', py - (py - panY) * scale);
    }
    store.set('zoom', clamped);
    updateTransform();
  },

  /**
   * Calculate bounds and set zoom/pan to fit all given nodes with padding.
   * @param {Array<{ position: { x: number, y: number } }>} nodes
   */
  fitToView(nodes) {
    if (!_root || !nodes.length) return;

    const NODE_WIDTH = 220;
    const NODE_HEIGHT = 80;
    const PADDING = 50;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.position.y + NODE_HEIGHT);
    }

    const boundsW = maxX - minX + PADDING * 2;
    const boundsH = maxY - minY + PADDING * 2;
    const rect = _root.getBoundingClientRect();
    const canvasW = rect.width || 800;
    const canvasH = rect.height || 600;

    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(canvasW / boundsW, canvasH / boundsH)));
    const panX = (canvasW - boundsW * zoom) / 2 - (minX - PADDING) * zoom;
    const panY = (canvasH - boundsH * zoom) / 2 - (minY - PADDING) * zoom;

    store.set('zoom', zoom);
    store.set('panX', panX);
    store.set('panY', panY);
    updateTransform();
  },

  /**
   * Force-refresh the canvas transform.
   */
  refresh() {
    updateTransform();
  },
};
