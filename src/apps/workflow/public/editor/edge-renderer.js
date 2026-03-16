// ── Workflow Editor — SVG Bezier Edge Rendering ────────────────────────
// Creates and updates SVG cubic bezier paths between node ports.

import { store } from '../state/store.js';
import { resolveOutputPorts } from '../models/node-types.js';

const NODE_WIDTH = 220;
const NODE_HEIGHT_ESTIMATE = 80;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Get output port position for a source node.
 * For single-output nodes, port is at the right-center.
 * For multi-output nodes, ports are spaced vertically.
 */
function getSourcePoint(node, sourcePort, _typeDef) {
  const x = node.position.x + NODE_WIDTH;
  const outPorts = resolveOutputPorts(node);
  if (outPorts.length <= 1) {
    return { x, y: node.position.y + NODE_HEIGHT_ESTIMATE / 2 };
  }
  // Multi-output: find port index
  let idx = outPorts.findIndex(p => p.id === sourcePort);
  if (idx === -1) idx = 0;
  const spacing = NODE_HEIGHT_ESTIMATE / (outPorts.length + 1);
  return { x, y: node.position.y + spacing * (idx + 1) };
}

/**
 * Get input port position for a target node.
 * Input port is at the left-center.
 */
function getTargetPoint(node, targetPort, typeDef) {
  const x = node.position.x;
  const inCount = typeDef?.ports?.in ?? 1;
  if (inCount <= 1) {
    return { x, y: node.position.y + NODE_HEIGHT_ESTIMATE / 2 };
  }
  let idx = 0; // Default to first port
  if (targetPort) {
    const match = targetPort.match(/in-(\d+)/);
    if (match) idx = parseInt(match[1], 10);
  }
  const spacing = NODE_HEIGHT_ESTIMATE / (inCount + 1);
  return { x, y: node.position.y + spacing * (idx + 1) };
}

/**
 * Compute the cubic bezier 'd' attribute for a path.
 */
function computePathD(x1, y1, x2, y2) {
  const dx = Math.max(50, Math.abs(x2 - x1) * 0.4);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// ── Public API ──────────────────────────────────────────────────────────

export const EdgeRenderer = {
  /**
   * Create an SVG path element for a workflow edge.
   * @param {object} edge - { id, source, target, sourcePort, condition }
   * @param {object} sourceNode
   * @param {object} targetNode
   * @param {object} [sourceTypeDef] - NODE_TYPES entry for source
   * @param {object} [targetTypeDef] - NODE_TYPES entry for target
   * @returns {SVGGElement} An SVG group containing the path and optional label
   */
  createEdgePath(edge, sourceNode, targetNode, sourceTypeDef, targetTypeDef) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'wfb-edge');
    group.dataset.edgeId = edge.id;

    // Hit area (wider, invisible path for easier selection)
    const hitPath = document.createElementNS(SVG_NS, 'path');
    hitPath.setAttribute('class', 'wfb-edge-hit');
    hitPath.setAttribute('fill', 'none');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', '12');
    hitPath.style.cursor = 'pointer';
    hitPath.style.pointerEvents = 'stroke';

    // Visible path
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'wfb-edge-path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--df-color-border-default)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#wfb-arrowhead)');
    path.style.transition = `stroke var(--df-duration-fast) ease`;
    path.style.pointerEvents = 'none';

    // Compute positions
    const src = getSourcePoint(sourceNode, edge.sourcePort, sourceTypeDef);
    const tgt = getTargetPoint(targetNode, null, targetTypeDef);
    const d = computePathD(src.x, src.y, tgt.x, tgt.y);
    path.setAttribute('d', d);
    hitPath.setAttribute('d', d);

    group.appendChild(hitPath);
    group.appendChild(path);

    // Label
    if (edge.condition) {
      const midX = (src.x + tgt.x) / 2;
      const midY = (src.y + tgt.y) / 2 - 8;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'wfb-edge-label');
      text.setAttribute('x', String(midX));
      text.setAttribute('y', String(midY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--df-color-text-muted)');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-family', 'var(--df-font-mono)');
      text.style.pointerEvents = 'none';
      text.textContent = edge.condition;
      group.appendChild(text);
    }

    return group;
  },

  /**
   * Update the path 'd' attribute for an existing edge group.
   * @param {SVGGElement} groupEl
   * @param {object} sourceNode
   * @param {object} targetNode
   * @param {object} [sourceTypeDef]
   * @param {object} [targetTypeDef]
   * @param {string} [sourcePort]
   */
  updateEdgePath(groupEl, sourceNode, targetNode, sourceTypeDef, targetTypeDef, sourcePort) {
    const src = getSourcePoint(sourceNode, sourcePort, sourceTypeDef);
    const tgt = getTargetPoint(targetNode, null, targetTypeDef);
    const d = computePathD(src.x, src.y, tgt.x, tgt.y);

    const hitPath = groupEl.querySelector('.wfb-edge-hit');
    const path = groupEl.querySelector('.wfb-edge-path');
    if (hitPath) hitPath.setAttribute('d', d);
    if (path) path.setAttribute('d', d);

    // Update label position
    const label = groupEl.querySelector('.wfb-edge-label');
    if (label) {
      label.setAttribute('x', String((src.x + tgt.x) / 2));
      label.setAttribute('y', String((src.y + tgt.y) / 2 - 8));
    }
  },

  /**
   * Create a temporary edge path for edge creation drag.
   * @returns {SVGPathElement}
   */
  createTempEdge() {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'wfb-temp-edge');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--df-color-accent-default)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '6 3');
    path.setAttribute('marker-end', 'url(#wfb-arrowhead-selected)');
    path.style.pointerEvents = 'none';
    path.style.opacity = '0.7';
    return path;
  },

  /**
   * Update the temporary edge path during drag.
   * @param {SVGPathElement} pathEl
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   */
  updateTempEdge(pathEl, x1, y1, x2, y2) {
    pathEl.setAttribute('d', computePathD(x1, y1, x2, y2));
  },

  /**
   * Remove a temporary edge path from the SVG layer.
   * @param {SVGPathElement} pathEl
   */
  removeTempEdge(pathEl) {
    pathEl?.remove();
  },

  /**
   * Set execution status highlight on an edge.
   * @param {SVGGElement} groupEl
   * @param {'running'|'passed'|'failed'|null} status
   */
  setEdgeStatus(groupEl, status) {
    const path = groupEl?.querySelector('.wfb-edge-path');
    if (!path) return;

    switch (status) {
      case 'running':
        path.setAttribute('stroke', 'var(--df-color-state-recording)');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('marker-end', 'url(#wfb-arrowhead-selected)');
        break;
      case 'passed':
        path.setAttribute('stroke', 'var(--df-color-state-success)');
        path.setAttribute('stroke-width', '2');
        break;
      case 'failed':
        path.setAttribute('stroke', 'var(--df-color-state-error)');
        path.setAttribute('stroke-width', '2');
        break;
      default:
        path.setAttribute('stroke', 'var(--df-color-border-default)');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('marker-end', 'url(#wfb-arrowhead)');
        break;
    }
  },

  /**
   * Mark an edge as selected or deselected.
   * @param {SVGGElement} groupEl
   * @param {boolean} selected
   */
  setSelected(groupEl, selected) {
    const path = groupEl?.querySelector('.wfb-edge-path');
    if (!path) return;
    if (selected) {
      path.setAttribute('stroke', 'var(--df-color-accent-default)');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('marker-end', 'url(#wfb-arrowhead-selected)');
    } else {
      path.setAttribute('stroke', 'var(--df-color-border-default)');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('marker-end', 'url(#wfb-arrowhead)');
    }
  },
};
