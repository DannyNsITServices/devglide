// ── Workflow Editor — Drag & Drop Manager ──────────────────────────────
// Handles palette drops, node moves, and port-to-port edge creation
// using the Pointer Events API with setPointerCapture.

import { store } from '../state/store.js';
import { WorkflowModel } from '../models/workflow-model.js';
import { NODE_TYPES, resolveOutputPorts } from '../models/node-types.js';

const GRID_SIZE = 20;

let _canvas = null;       // Canvas module reference
let _nodeContainer = null; // World element (nodes)
let _svgLayer = null;      // SVG world group (edges)
let _snapEnabled = true;

// Active drag state
let _drag = null; // { type: 'node'|'palette'|'edge', ... }

// ── Snap helper ─────────────────────────────────────────────────────────

function snap(x, y) {
  if (!_snapEnabled) return { x, y };
  return {
    x: Math.round(x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(y / GRID_SIZE) * GRID_SIZE,
  };
}

// ── Palette drag ────────────────────────────────────────────────────────

function startPaletteDrag(e, nodeType) {
  const typeDef = NODE_TYPES[nodeType];
  if (!typeDef) return;

  // Create ghost element
  const ghost = document.createElement('div');
  ghost.className = 'wfb-drag-ghost';
  ghost.textContent = `${typeDef.icon} ${typeDef.label}`;
  ghost.style.cssText = `
    position: fixed;
    left: ${e.clientX - 60}px;
    top: ${e.clientY - 20}px;
    width: 120px;
    padding: var(--df-space-2) var(--df-space-3);
    background: var(--df-color-bg-surface);
    border: 1px solid ${typeDef.color};
    border-left: 4px solid ${typeDef.color};
    font-family: var(--df-font-mono);
    font-size: var(--df-font-size-xs);
    color: var(--df-color-text-primary);
    opacity: 0.85;
    pointer-events: none;
    z-index: 9999;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `;
  document.body.appendChild(ghost);

  _drag = { type: 'palette', nodeType, ghost, pointerId: e.pointerId };
}

function movePaletteDrag(e) {
  if (_drag?.ghost) {
    _drag.ghost.style.left = `${e.clientX - 60}px`;
    _drag.ghost.style.top = `${e.clientY - 20}px`;
  }
}

function endPaletteDrag(e) {
  if (!_drag || _drag.type !== 'palette') return;

  // Remove ghost
  _drag.ghost.remove();

  // Check if dropped over canvas
  if (_canvas) {
    const root = _canvas.getRootElement?.();
    if (root) {
      const rect = root.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const worldPos = _canvas.screenToWorld(e.clientX, e.clientY);
        const snapped = snap(worldPos.x, worldPos.y);
        const typeDef = NODE_TYPES[_drag.nodeType];
        WorkflowModel.addNode(_drag.nodeType, typeDef?.label ?? _drag.nodeType, snapped);
      }
    }
  }

  _drag = null;
}

// ── Node move ───────────────────────────────────────────────────────────

function startNodeMove(e, nodeId, nodeEl) {
  const wf = store.get('workflow');
  const node = wf?.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const zoom = store.get('zoom');
  const selectedIds = store.get('selectedNodeIds');

  // If this node is not selected, select only it (unless shift is held)
  if (!selectedIds.has(nodeId) && !e.shiftKey) {
    store.set('selectedNodeIds', new Set([nodeId]));
  } else if (!selectedIds.has(nodeId) && e.shiftKey) {
    selectedIds.add(nodeId);
    store.set('selectedNodeIds', new Set(selectedIds));
  }

  // Capture start positions of all selected nodes
  const movingIds = store.get('selectedNodeIds');
  const startPositions = new Map();
  for (const id of movingIds) {
    const n = wf.nodes.find(nd => nd.id === id);
    if (n) startPositions.set(id, { x: n.position.x, y: n.position.y });
  }

  _drag = {
    type: 'node',
    nodeId,
    startX: e.clientX,
    startY: e.clientY,
    startPositions,
    zoom,
    pointerId: e.pointerId,
    moved: false,
  };

  nodeEl.style.cursor = 'grabbing';
  nodeEl.setPointerCapture(e.pointerId);
}

function moveNodeMove(e) {
  if (!_drag || _drag.type !== 'node') return;
  _drag.moved = true;

  const dx = (e.clientX - _drag.startX) / _drag.zoom;
  const dy = (e.clientY - _drag.startY) / _drag.zoom;

  for (const [id, startPos] of _drag.startPositions) {
    const snapped = snap(startPos.x + dx, startPos.y + dy);
    WorkflowModel.moveNode(id, snapped.x, snapped.y);
  }
}

function endNodeMove(e) {
  if (!_drag || _drag.type !== 'node') return;
  const nodeEl = _nodeContainer?.querySelector(`[data-node-id="${_drag.nodeId}"]`);
  if (nodeEl) {
    nodeEl.style.cursor = 'grab';
    nodeEl.releasePointerCapture(_drag.pointerId);
  }
  _drag = null;
}

// ── Edge creation ───────────────────────────────────────────────────────

function startEdgeDrag(e, nodeId, portId, portType) {
  if (portType !== 'out') return; // Only drag from output ports

  const wf = store.get('workflow');
  const node = wf?.nodes.find(n => n.id === nodeId);
  if (!node) return;

  // Import EdgeRenderer dynamically to avoid circular deps
  import('./edge-renderer.js').then(({ EdgeRenderer }) => {
    const tempPath = EdgeRenderer.createTempEdge();
    _svgLayer?.appendChild(tempPath);

    const outPorts = resolveOutputPorts(node);
    let portIdx = outPorts.findIndex(p => p.id === portId);
    if (portIdx === -1) portIdx = 0;

    const NODE_HEIGHT = 80;
    const spacing = outPorts.length <= 1
      ? NODE_HEIGHT / 2
      : NODE_HEIGHT / (outPorts.length + 1);
    const startX = node.position.x + 220; // NODE_WIDTH
    const startY = outPorts.length <= 1
      ? node.position.y + NODE_HEIGHT / 2
      : node.position.y + spacing * (portIdx + 1);

    _drag = {
      type: 'edge',
      sourceNodeId: nodeId,
      sourcePort: portId,
      tempPath,
      startX,
      startY,
      pointerId: e.pointerId,
      EdgeRenderer,
    };

    EdgeRenderer.updateTempEdge(tempPath, startX, startY, startX, startY);
  });
}

function moveEdgeDrag(e) {
  if (!_drag || _drag.type !== 'edge') return;
  const worldPos = _canvas?.screenToWorld(e.clientX, e.clientY);
  if (worldPos && _drag.EdgeRenderer) {
    _drag.EdgeRenderer.updateTempEdge(_drag.tempPath, _drag.startX, _drag.startY, worldPos.x, worldPos.y);
  }
}

function endEdgeDrag(e) {
  if (!_drag || _drag.type !== 'edge') return;

  // Remove temp edge
  if (_drag.EdgeRenderer) {
    _drag.EdgeRenderer.removeTempEdge(_drag.tempPath);
  }

  // Check if we released over an input port
  const targetEl = document.elementFromPoint(e.clientX, e.clientY);
  if (targetEl?.classList?.contains('wfb-port-in') ||
      (targetEl?.dataset?.portType === 'in')) {
    const targetNodeId = targetEl.dataset.nodeId;
    if (targetNodeId && targetNodeId !== _drag.sourceNodeId) {
      WorkflowModel.addEdge(_drag.sourceNodeId, targetNodeId, _drag.sourcePort);
    }
  }

  _drag = null;
}

// ── Unified event handlers ──────────────────────────────────────────────

function onPointerDown(e) {
  // Check if clicking a port
  const portEl = e.target.closest?.('.wfb-port');
  if (portEl) {
    e.preventDefault();
    e.stopPropagation();
    startEdgeDrag(e, portEl.dataset.nodeId, portEl.dataset.portId, portEl.dataset.portType);
    return;
  }

  // Check if clicking a node body (not port)
  const nodeEl = e.target.closest?.('.wfb-node');
  if (nodeEl && e.button === 0) {
    e.preventDefault();
    startNodeMove(e, nodeEl.dataset.nodeId, nodeEl);
    return;
  }
}

function onPointerMove(e) {
  if (!_drag) return;
  switch (_drag.type) {
    case 'palette': movePaletteDrag(e); break;
    case 'node': moveNodeMove(e); break;
    case 'edge': moveEdgeDrag(e); break;
  }
}

function onPointerUp(e) {
  if (!_drag) return;
  switch (_drag.type) {
    case 'palette': endPaletteDrag(e); break;
    case 'node': endNodeMove(e); break;
    case 'edge': endEdgeDrag(e); break;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export const DragManager = {
  /**
   * Initialize drag handling.
   * @param {object} canvas - Canvas module
   * @param {HTMLElement} nodeContainer - World element
   * @param {SVGGElement} svgLayer - SVG world group
   */
  init(canvas, nodeContainer, svgLayer) {
    _canvas = canvas;
    _nodeContainer = nodeContainer;
    _svgLayer = svgLayer;

    // Node/port interactions on the world element
    _nodeContainer.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  },

  /**
   * Remove all event listeners.
   */
  destroy() {
    if (_nodeContainer) {
      _nodeContainer.removeEventListener('pointerdown', onPointerDown);
    }
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);

    if (_drag?.type === 'palette' && _drag.ghost) {
      _drag.ghost.remove();
    }
    _drag = null;
    _canvas = null;
    _nodeContainer = null;
    _svgLayer = null;
  },

  /**
   * Toggle snap-to-grid.
   * @param {boolean} enabled
   */
  setSnapToGrid(enabled) {
    _snapEnabled = enabled;
  },

  /**
   * Begin a palette drag from an external element (e.g., node palette).
   * Call this from a pointerdown handler on a palette item.
   * @param {PointerEvent} e
   * @param {string} nodeType
   */
  startPaletteDrag(e, nodeType) {
    startPaletteDrag(e, nodeType);
  },
};
