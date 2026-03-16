// ── Workflow Editor — Selection Manager ─────────────────────────────────
// Handles node/edge selection with shift-toggle and keyboard shortcuts.

import { store } from '../state/store.js';
import { WorkflowModel } from '../models/workflow-model.js';

let _container = null;
let _onContainerClick = null;
let _onKeyDown = null;
let _unsubs = [];

// ── Public API ──────────────────────────────────────────────────────────

export const SelectionManager = {
  /**
   * Initialize selection handling on the canvas container.
   * @param {HTMLElement} container - The canvas root element
   */
  init(container) {
    _container = container;

    _onContainerClick = (e) => {
      // Edge click — check if clicked on an edge hit area
      const edgeHit = e.target.closest?.('.wfb-edge-hit');
      if (edgeHit) {
        const edgeGroup = edgeHit.closest('.wfb-edge');
        const edgeId = edgeGroup?.dataset?.edgeId;
        if (edgeId) {
          this.selectEdge(edgeId, e.shiftKey);
          return;
        }
      }

      // Node click
      const nodeEl = e.target.closest?.('.wfb-node');
      if (nodeEl) {
        const nodeId = nodeEl.dataset.nodeId;
        if (nodeId) {
          this.selectNode(nodeId, e.shiftKey);
          return;
        }
      }

      // Port click — don't deselect when clicking ports
      const portEl = e.target.closest?.('.wfb-port');
      if (portEl) return;

      // Canvas background click — deselect all
      if (e.target.closest?.('.wfb-canvas') && !e.target.closest?.('.wfb-node') && !e.target.closest?.('.wfb-edge')) {
        this.deselectAll();
      }
    };

    _onKeyDown = (e) => {
      // Escape — deselect all
      if (e.key === 'Escape') {
        this.deselectAll();
        return;
      }

      // Delete or Backspace — delete selected (only when not in an input)
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isInputFocused()) {
        e.preventDefault();
        this.deleteSelected();
        return;
      }

      // Ctrl/Cmd+A — select all nodes
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isInputFocused()) {
        e.preventDefault();
        const wf = store.get('workflow');
        if (wf?.nodes.length) {
          store.set('selectedNodeIds', new Set(wf.nodes.map(n => n.id)));
          store.set('selectedEdgeIds', new Set());
        }
      }
    };

    _container.addEventListener('click', _onContainerClick);
    document.addEventListener('keydown', _onKeyDown);
  },

  /**
   * Remove all event listeners.
   */
  destroy() {
    if (_container && _onContainerClick) {
      _container.removeEventListener('click', _onContainerClick);
    }
    if (_onKeyDown) {
      document.removeEventListener('keydown', _onKeyDown);
    }
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
    _container = null;
    _onContainerClick = null;
    _onKeyDown = null;
  },

  /**
   * Select a node. If additive (shift), toggle it in/out of the selection.
   * @param {string} id
   * @param {boolean} [additive=false]
   */
  selectNode(id, additive = false) {
    const sel = store.get('selectedNodeIds');
    if (additive) {
      const next = new Set(sel);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      store.set('selectedNodeIds', next);
    } else {
      store.set('selectedNodeIds', new Set([id]));
      store.set('selectedEdgeIds', new Set());
    }
  },

  /**
   * Select an edge. If additive (shift), toggle it in/out of the selection.
   * @param {string} id
   * @param {boolean} [additive=false]
   */
  selectEdge(id, additive = false) {
    const sel = store.get('selectedEdgeIds');
    if (additive) {
      const next = new Set(sel);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      store.set('selectedEdgeIds', next);
    } else {
      store.set('selectedEdgeIds', new Set([id]));
      store.set('selectedNodeIds', new Set());
    }
  },

  /**
   * Clear all selection.
   */
  deselectAll() {
    store.set('selectedNodeIds', new Set());
    store.set('selectedEdgeIds', new Set());
  },

  /**
   * Get the current set of selected node IDs.
   * @returns {Set<string>}
   */
  getSelectedNodes() {
    return store.get('selectedNodeIds');
  },

  /**
   * Get the current set of selected edge IDs.
   * @returns {Set<string>}
   */
  getSelectedEdges() {
    return store.get('selectedEdgeIds');
  },

  /**
   * Delete all selected nodes and edges.
   */
  deleteSelected() {
    const nodeIds = store.get('selectedNodeIds');
    const edgeIds = store.get('selectedEdgeIds');

    // Delete edges first (removing nodes also removes their edges)
    for (const edgeId of edgeIds) {
      WorkflowModel.removeEdge(edgeId);
    }
    for (const nodeId of nodeIds) {
      WorkflowModel.removeNode(nodeId);
    }

    this.deselectAll();
  },
};

/**
 * Check if an input/textarea/contenteditable is focused.
 */
function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}
