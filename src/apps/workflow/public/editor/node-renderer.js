// ── Workflow Editor — Node Card DOM Creation ───────────────────────────
// Creates, updates, and manages runtime status for node DOM elements.
// Simplified to a single "step" node type for LLM instruction flows.

import { NODE_TYPES, resolveOutputPorts, resolveInputPortCount } from '../models/node-types.js';

const NODE_WIDTH = 220;

function truncate(s, len) {
  return s.length > len ? s.slice(0, len) + '\u2026' : s;
}

/**
 * Build a compact config preview string for a node.
 */
function configPreview(node) {
  const c = node.config ?? {};

  switch (node.type) {
    case 'trigger':
      return c.triggerType ?? 'manual';
    case 'action:shell':
      return c.command ? truncate(c.command, 40) : 'No command';
    case 'action:kanban':
      return c.operation ?? 'kanban';
    case 'action:git':
      return c.operation ? `git ${c.operation}` : 'git';
    case 'action:llm':
      return c.prompt ? truncate(c.prompt, 40) : (c.model ?? 'LLM');
    case 'action:test':
      return c.operation ?? 'test';
    case 'action:log':
      return c.operation ?? 'log';
    case 'action:file':
      return c.operation ? `${c.operation}: ${truncate(c.path ?? '', 30)}` : 'file';
    case 'action:http':
      return c.method ? `${c.method} ${truncate(c.url ?? '', 30)}` : 'HTTP';
    case 'decision':
      return c.conditionType ?? 'decision';
    case 'loop':
      return c.loopType ?? 'loop';
    case 'sub-workflow':
      return c.workflowId ? truncate(c.workflowId, 30) : 'sub-workflow';
    case 'step':
      if (c.instructions) return truncate(c.instructions, 40);
      if (c.instructionFile) return c.instructionFile;
      return 'Click to add instructions';
    default:
      return node.type;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export const NodeRenderer = {
  /**
   * Create a DOM element for a workflow node.
   * @param {object} node - { id, type, label, position, config }
   * @returns {HTMLElement}
   */
  createNodeElement(node) {
    const typeDef = NODE_TYPES[node.type];
    const color = typeDef?.color ?? '#64748b';

    const el = document.createElement('div');
    el.className = 'wfb-node';
    el.dataset.nodeId = node.id;
    el.style.position = 'absolute';
    el.style.left = `${node.position.x}px`;
    el.style.top = `${node.position.y}px`;
    el.style.setProperty('--wfb-type-color', color);

    // Header
    const header = document.createElement('div');
    header.className = 'wfb-node-header';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'wfb-node-label';
    labelSpan.textContent = node.label;

    header.appendChild(labelSpan);

    // Body (config preview)
    const body = document.createElement('div');
    body.className = 'wfb-node-body';
    body.textContent = configPreview(node);

    el.appendChild(header);
    el.appendChild(body);

    // Input ports
    const inCount = resolveInputPortCount(node);
    for (let i = 0; i < inCount; i++) {
      const portIn = document.createElement('div');
      portIn.className = 'wfb-port wfb-port-in';
      portIn.dataset.portId = `in-${i}`;
      portIn.dataset.portType = 'in';
      portIn.dataset.nodeId = node.id;
      if (inCount > 1) {
        portIn.style.top = `${((i + 1) / (inCount + 1)) * 100}%`;
      }
      el.appendChild(portIn);
    }

    // Output ports
    const outPorts = resolveOutputPorts(node);
    for (let i = 0; i < outPorts.length; i++) {
      const portOut = document.createElement('div');
      portOut.className = 'wfb-port wfb-port-out';
      portOut.dataset.portId = outPorts[i].id;
      portOut.dataset.portType = 'out';
      portOut.dataset.nodeId = node.id;
      if (outPorts.length > 1) {
        portOut.style.top = `${((i + 1) / (outPorts.length + 1)) * 100}%`;
        portOut.title = outPorts[i].label;
      }
      el.appendChild(portOut);
    }

    return el;
  },

  /**
   * Update an existing node element to reflect changes.
   * @param {HTMLElement} el
   * @param {object} node
   */
  updateNodeElement(el, node) {
    const typeDef = NODE_TYPES[node.type];
    const color = typeDef?.color ?? '#64748b';

    // Update position
    el.style.left = `${node.position.x}px`;
    el.style.top = `${node.position.y}px`;

    // Update type color
    el.style.setProperty('--wfb-type-color', color);

    // Update label
    const labelEl = el.querySelector('.wfb-node-label');
    if (labelEl) labelEl.textContent = node.label;

    // Update config preview
    const bodyEl = el.querySelector('.wfb-node-body');
    if (bodyEl) bodyEl.textContent = configPreview(node);

    // Sync output ports for dynamic-port nodes (decision)
    if (typeDef?.ports?.out === 'dynamic') {
      const outPorts = resolveOutputPorts(node);
      const existingOuts = el.querySelectorAll('.wfb-port-out');
      // Only rebuild if count changed
      if (existingOuts.length !== outPorts.length) {
        existingOuts.forEach(p => p.remove());
        for (let i = 0; i < outPorts.length; i++) {
          const portOut = document.createElement('div');
          portOut.className = 'wfb-port wfb-port-out';
          portOut.dataset.portId = outPorts[i].id;
          portOut.dataset.portType = 'out';
          portOut.dataset.nodeId = node.id;
          if (outPorts.length > 1) {
            portOut.style.top = `${((i + 1) / (outPorts.length + 1)) * 100}%`;
            portOut.title = outPorts[i].label;
          }
          el.appendChild(portOut);
        }
      }
    }
  },

  /**
   * Set runtime status on a node element.
   * @param {HTMLElement} el
   * @param {'running'|'passed'|'failed'} status
   */
  setNodeStatus(el, status) {
    el.classList.remove('wfb-status-running', 'wfb-status-passed', 'wfb-status-failed');
    el.classList.add(`wfb-status-${status}`);
  },

  /**
   * Remove runtime status from a node element.
   * @param {HTMLElement} el
   */
  clearNodeStatus(el) {
    el.classList.remove('wfb-status-running', 'wfb-status-passed', 'wfb-status-failed');
  },

  /**
   * Mark a node element as selected.
   * @param {HTMLElement} el
   * @param {boolean} selected
   */
  setSelected(el, selected) {
    el.classList.toggle('selected', selected);
  },

  /** Node width constant for layout calculations. */
  NODE_WIDTH,
};
