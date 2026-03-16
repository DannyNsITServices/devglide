// ── Workflow Editor — Layout Utilities ──────────────────────────────────
// Grid snapping, fit-to-view, and automatic layout for imported workflows.

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const H_SPACING = 100; // Horizontal gap between columns
const V_SPACING = 40;  // Vertical gap between rows

export const LayoutEngine = {
  /**
   * Snap coordinates to a grid.
   * @param {number} x
   * @param {number} y
   * @param {number} [gridSize=20]
   * @returns {{ x: number, y: number }}
   */
  snapToGrid(x, y, gridSize = 20) {
    return {
      x: Math.round(x / gridSize) * gridSize,
      y: Math.round(y / gridSize) * gridSize,
    };
  },

  /**
   * Calculate zoom and pan to fit all nodes within the canvas viewport.
   * @param {Array<{ position: { x: number, y: number } }>} nodes
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @param {number} [padding=50]
   * @returns {{ zoom: number, panX: number, panY: number }}
   */
  fitToView(nodes, canvasWidth, canvasHeight, padding = 50) {
    if (!nodes.length) {
      return { zoom: 1, panX: 0, panY: 0 };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.position.y + NODE_HEIGHT);
    }

    const boundsW = maxX - minX + padding * 2;
    const boundsH = maxY - minY + padding * 2;

    const zoom = Math.max(0.25, Math.min(3, Math.min(canvasWidth / boundsW, canvasHeight / boundsH)));
    const panX = (canvasWidth - boundsW * zoom) / 2 - (minX - padding) * zoom;
    const panY = (canvasHeight - boundsH * zoom) / 2 - (minY - padding) * zoom;

    return { zoom, panX, panY };
  },

  /**
   * Automatically layout nodes in a top-to-bottom arrangement.
   * Uses a simple topological sort approach for DAG layout.
   * Useful for imported legacy workflows that have no position data.
   *
   * @param {Array<object>} nodes - Nodes with { id, type, ... }
   * @param {Array<object>} edges - Edges with { source, target, ... }
   * @returns {Array<object>} Nodes with updated positions
   */
  autoLayout(nodes, edges) {
    if (!nodes.length) return nodes;

    // Build adjacency map
    const outgoing = new Map(); // nodeId -> [targetNodeId]
    const incoming = new Map(); // nodeId -> [sourceNodeId]
    const nodeMap = new Map();

    for (const n of nodes) {
      nodeMap.set(n.id, n);
      outgoing.set(n.id, []);
      incoming.set(n.id, []);
    }
    for (const e of edges) {
      if (outgoing.has(e.source) && incoming.has(e.target)) {
        outgoing.get(e.source).push(e.target);
        incoming.get(e.target).push(e.source);
      }
    }

    // Topological sort (Kahn's algorithm) to determine layers
    const inDegree = new Map();
    for (const n of nodes) {
      inDegree.set(n.id, incoming.get(n.id).length);
    }

    const layers = [];
    const visited = new Set();
    let queue = [];

    // Start with nodes that have no incoming edges (triggers, roots)
    for (const n of nodes) {
      if (inDegree.get(n.id) === 0) {
        queue.push(n.id);
      }
    }

    while (queue.length > 0) {
      layers.push([...queue]);
      for (const id of queue) visited.add(id);

      const nextQueue = [];
      for (const id of queue) {
        for (const targetId of outgoing.get(id)) {
          if (visited.has(targetId)) continue;
          inDegree.set(targetId, inDegree.get(targetId) - 1);
          if (inDegree.get(targetId) === 0) {
            nextQueue.push(targetId);
          }
        }
      }
      queue = nextQueue;
    }

    // Handle any remaining nodes (cycles or disconnected)
    for (const n of nodes) {
      if (!visited.has(n.id)) {
        layers.push([n.id]);
        visited.add(n.id);
      }
    }

    // Assign positions: each layer is a column (left to right)
    const result = nodes.map(n => ({ ...n, position: { ...n.position } }));

    for (let col = 0; col < layers.length; col++) {
      const layer = layers[col];
      const totalHeight = layer.length * NODE_HEIGHT + (layer.length - 1) * V_SPACING;
      const startY = -totalHeight / 2;

      for (let row = 0; row < layer.length; row++) {
        const nodeId = layer[row];
        const node = result.find(n => n.id === nodeId);
        if (node) {
          node.position.x = col * (NODE_WIDTH + H_SPACING);
          node.position.y = startY + row * (NODE_HEIGHT + V_SPACING);
        }
      }
    }

    // Normalize so that the top-left is at (40, 40)
    let minX = Infinity, minY = Infinity;
    for (const n of result) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
    }
    const offsetX = 40 - minX;
    const offsetY = 40 - minY;
    for (const n of result) {
      n.position.x += offsetX;
      n.position.y += offsetY;
    }

    return result;
  },
};
