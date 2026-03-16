// ── Workflow Editor — Graph Data Model ──────────────────────────────────
// Manages the workflow graph: nodes, edges, and structural queries.

import { store } from '../state/store.js';
import { NODE_TYPES } from './node-types.js';

function uid() {
  return crypto.randomUUID();
}

function markDirty() {
  store.set('isDirty', true);
}

function emitWorkflow() {
  // Re-set to trigger listeners even though the reference may be the same
  store.set('workflow', store.get('workflow'));
}

export const WorkflowModel = {
  /**
   * Load a workflow object into the store.
   * @param {object} workflow - { id, name, description, nodes, edges, ... }
   */
  load(workflow) {
    const wf = {
      id: workflow.id,
      name: workflow.name ?? 'Untitled Workflow',
      description: workflow.description ?? '',
      nodes: (workflow.nodes ?? []).map(n => ({ ...n })),
      edges: (workflow.edges ?? []).map(e => ({ ...e })),
      enabled: workflow.enabled ?? true,
      global: workflow.global ?? false,
      createdAt: workflow.createdAt ?? new Date().toISOString(),
      updatedAt: workflow.updatedAt ?? new Date().toISOString(),
    };
    store.set('workflow', wf);
    store.set('isDirty', false);
    store.set('selectedNodeIds', new Set());
    store.set('selectedEdgeIds', new Set());
  },

  /**
   * Return a serializable workflow object from the current store state.
   * @returns {object|null}
   */
  save() {
    const wf = store.get('workflow');
    if (!wf) return null;
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description,
      enabled: wf.enabled,
      global: wf.global,
      nodes: wf.nodes.map(n => ({ ...n, position: { ...n.position }, config: { ...n.config } })),
      edges: wf.edges.map(e => ({ ...e })),
      createdAt: wf.createdAt,
      updatedAt: new Date().toISOString(),
    };
  },

  /**
   * Add a node to the workflow.
   * @param {string} type - Node type key (e.g. 'action:shell')
   * @param {string} label - Display label
   * @param {{ x: number, y: number }} position
   * @param {object} [config={}] - Node-specific config
   * @returns {object} The created node
   */
  addNode(type, label, position, config = {}) {
    const wf = store.get('workflow');
    if (!wf) return null;

    const typeDef = NODE_TYPES[type];
    const node = {
      id: uid(),
      type,
      label: label || typeDef?.label || type,
      position: { x: position.x, y: position.y },
      config: { ...(typeDef?.defaultConfig ?? {}), ...config },
    };
    wf.nodes.push(node);
    markDirty();
    emitWorkflow();
    return node;
  },

  /**
   * Remove a node and all connected edges.
   * @param {string} id
   */
  removeNode(id) {
    const wf = store.get('workflow');
    if (!wf) return;

    wf.nodes = wf.nodes.filter(n => n.id !== id);
    wf.edges = wf.edges.filter(e => e.source !== id && e.target !== id);

    // Remove from selection
    const sel = store.get('selectedNodeIds');
    if (sel.has(id)) {
      sel.delete(id);
      store.set('selectedNodeIds', new Set(sel));
    }

    markDirty();
    emitWorkflow();
  },

  /**
   * Partial-update a node.
   * @param {string} id
   * @param {object} updates - Merged into the node
   */
  updateNode(id, updates) {
    const wf = store.get('workflow');
    if (!wf) return;
    const node = wf.nodes.find(n => n.id === id);
    if (!node) return;

    if (updates.config) {
      node.config = { ...node.config, ...updates.config };
      delete updates.config;
    }
    Object.assign(node, updates);
    markDirty();
    emitWorkflow();
  },

  /**
   * Move a node to a new position.
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  moveNode(id, x, y) {
    const wf = store.get('workflow');
    if (!wf) return;
    const node = wf.nodes.find(n => n.id === id);
    if (!node) return;
    node.position = { x, y };
    markDirty();
    emitWorkflow();
  },

  /**
   * Add an edge between two nodes.
   * @param {string} source - Source node ID
   * @param {string} target - Target node ID
   * @param {string} [sourcePort] - Port identifier (for multi-output nodes)
   * @param {string} [condition] - Edge label / condition text
   * @returns {object} The created edge
   */
  addEdge(source, target, sourcePort, condition) {
    const wf = store.get('workflow');
    if (!wf) return null;

    // Prevent duplicate edges
    const exists = wf.edges.some(
      e => e.source === source && e.target === target && (e.sourcePort ?? '') === (sourcePort ?? '')
    );
    if (exists) return null;

    // Prevent self-loops
    if (source === target) return null;

    const edge = {
      id: uid(),
      source,
      target,
      sourcePort: sourcePort ?? null,
      condition: condition ?? null,
    };
    wf.edges.push(edge);
    markDirty();
    emitWorkflow();
    return edge;
  },

  /**
   * Remove an edge.
   * @param {string} id
   */
  removeEdge(id) {
    const wf = store.get('workflow');
    if (!wf) return;
    wf.edges = wf.edges.filter(e => e.id !== id);

    const sel = store.get('selectedEdgeIds');
    if (sel.has(id)) {
      sel.delete(id);
      store.set('selectedEdgeIds', new Set(sel));
    }

    markDirty();
    emitWorkflow();
  },

  /**
   * Get a node by ID.
   * @param {string} id
   * @returns {object|null}
   */
  getNode(id) {
    const wf = store.get('workflow');
    return wf?.nodes.find(n => n.id === id) ?? null;
  },

  /**
   * Get an edge by ID.
   * @param {string} id
   * @returns {object|null}
   */
  getEdge(id) {
    const wf = store.get('workflow');
    return wf?.edges.find(e => e.id === id) ?? null;
  },

  /**
   * Get all nodes of a given type.
   * @param {string} type
   * @returns {Array<object>}
   */
  getNodesOfType(type) {
    const wf = store.get('workflow');
    return wf?.nodes.filter(n => n.type === type) ?? [];
  },

  /**
   * Get all edges targeting a given node.
   * @param {string} nodeId
   * @returns {Array<object>}
   */
  getIncomingEdges(nodeId) {
    const wf = store.get('workflow');
    return wf?.edges.filter(e => e.target === nodeId) ?? [];
  },

  /**
   * Get all edges originating from a given node.
   * @param {string} nodeId
   * @returns {Array<object>}
   */
  getOutgoingEdges(nodeId) {
    const wf = store.get('workflow');
    return wf?.edges.filter(e => e.source === nodeId) ?? [];
  },

  /**
   * Serialize the workflow as a plain JSON-friendly object.
   * @returns {object|null}
   */
  toJSON() {
    return this.save();
  },
};
