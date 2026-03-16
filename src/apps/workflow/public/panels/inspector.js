// ── Workflow Editor — Dynamic Property Panel ────────────────────────────
// Right sidebar showing properties of the selected node or the workflow.

import { store } from '../state/store.js';
import { NODE_TYPES } from '../models/node-types.js';
import { WorkflowModel } from '../models/workflow-model.js';

let _container = null;
let _unsubs = [];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Field renderer ───────────────────────────────────────────────────────

function renderField(field, config) {
  const val = config[field.key] ?? '';
  const id = `wb-cfg-${field.key}`;

  switch (field.type) {
    case 'select':
      return `
        <div class="wb-inspector-field">
          <div class="wb-inspector-label">${esc(field.label)}</div>
          <select id="${id}">
            ${(field.options ?? []).map(o =>
              `<option value="${esc(o)}"${val === o ? ' selected' : ''}>${esc(o)}</option>`
            ).join('')}
          </select>
        </div>`;

    case 'textarea':
      return `
        <div class="wb-inspector-field">
          <div class="wb-inspector-label">${esc(field.label)}</div>
          <textarea id="${id}" rows="4" placeholder="${esc(field.label)}">${esc(val)}</textarea>
        </div>`;

    case 'checkbox':
      return `
        <div class="wb-inspector-field">
          <label style="display:flex;align-items:center;gap:var(--df-space-2);cursor:pointer;">
            <input type="checkbox" id="${id}"${val ? ' checked' : ''} />
            <span>${esc(field.label)}</span>
          </label>
        </div>`;

    case 'number':
      return `
        <div class="wb-inspector-field">
          <div class="wb-inspector-label">${esc(field.label)}</div>
          <input type="number" id="${id}" value="${esc(val)}" />
        </div>`;

    default: // 'text'
      return `
        <div class="wb-inspector-field">
          <div class="wb-inspector-label">${esc(field.label)}</div>
          <input type="text" id="${id}" value="${esc(val)}" placeholder="${esc(field.label)}" />
        </div>`;
  }
}

// ── Node inspector ──────────────────────────────────────────────────────

function renderNodeInspector(node) {
  const typeDef = NODE_TYPES[node.type];
  const config = node.config || {};
  const fields = typeDef?.configFields ?? [];

  let html = `
    <div class="wb-inspector-header">${esc(typeDef?.label ?? node.type)} Properties</div>
    <div class="wb-inspector-field">
      <div class="wb-inspector-label">Label</div>
      <input type="text" id="wb-node-label" value="${esc(node.label)}" />
    </div>`;

  for (const field of fields) {
    if (field.showWhen) {
      const [key, val] = Object.entries(field.showWhen)[0];
      if (config[key] !== val) continue;
    }
    html += renderField(field, config);
  }

  // Decision port editor
  if (node.type === 'decision') {
    const ports = Array.isArray(config.ports) ? config.ports : [];
    html += `
      <div class="wb-inspector-field">
        <div class="wb-inspector-label" style="display:flex;justify-content:space-between;align-items:center;">
          <span>Output Ports</span>
          <button id="wb-add-port" style="font-size:var(--df-font-size-xs);padding:2px 8px;cursor:pointer;">+ Add</button>
        </div>
        <div id="wb-port-list" style="display:flex;flex-direction:column;gap:var(--df-space-1);margin-top:var(--df-space-1);">`;
    for (let i = 0; i < ports.length; i++) {
      const p = ports[i];
      html += `
          <div class="wb-port-row" style="display:flex;gap:var(--df-space-1);align-items:center;" data-port-idx="${i}">
            <input type="text" class="wb-port-label" value="${esc(p.label ?? '')}"
              placeholder="Label" style="flex:1;min-width:0;" />
            <input type="text" class="wb-port-condition" value="${esc(p.condition ?? '')}"
              placeholder="Condition" style="flex:1;min-width:0;" />
            <button class="wb-remove-port" data-port-idx="${i}"
              style="padding:2px 6px;cursor:pointer;flex-shrink:0;">&times;</button>
          </div>`;
    }
    if (ports.length === 0) {
      html += `<div style="font-size:var(--df-font-size-xs);color:var(--df-color-text-muted);">No ports — add at least one to create branches</div>`;
    }
    html += `
        </div>
      </div>`;
  }

  // For non-step types, show instructions at the bottom as an optional field
  if (node.type !== 'step' && fields.length > 0) {
    html += `
      <div class="wb-inspector-field">
        <div class="wb-inspector-label">Instructions</div>
        <textarea id="wb-node-instructions" rows="3"
          placeholder="Optional AI instructions for this node">${esc(config.instructions ?? '')}</textarea>
      </div>`;
  }

  return html;
}

// ── Workflow inspector (no selection) ───────────────────────────────────

function renderWorkflowInspector() {
  const wf = store.get('workflow');
  if (!wf) {
    return `
      <div class="wb-inspector-header">Workflow</div>
      <div class="wb-inspector-field" style="color:var(--df-color-text-muted);font-size:var(--df-font-size-xs);">
        No workflow loaded
      </div>`;
  }

  const nodeCount = wf.nodes?.length ?? 0;
  const edgeCount = wf.edges?.length ?? 0;

  return `
    <div class="wb-inspector-header">Workflow Properties</div>
    <div class="wb-inspector-field">
      <div class="wb-inspector-label">Name</div>
      <input type="text" id="wb-wf-name" value="${esc(wf.name)}" />
    </div>
    <div class="wb-inspector-field">
      <div class="wb-inspector-label">Description</div>
      <textarea id="wb-wf-description" rows="3" placeholder="Workflow description">${esc((wf.description ?? '').replace(/\\n/g, '\n'))}</textarea>
    </div>
    <div class="wb-inspector-field">
      <div class="wb-inspector-label">Stats</div>
      <div style="font-size:var(--df-font-size-xs);color:var(--df-color-text-muted);">
        ${nodeCount} node${nodeCount !== 1 ? 's' : ''} &middot; ${edgeCount} edge${edgeCount !== 1 ? 's' : ''}
      </div>
    </div>
    <div class="wb-inspector-field">
      <div class="wb-inspector-label">Scope</div>
      <div style="font-size:var(--df-font-size-xs);color:var(--df-color-text-muted);">
        ${wf.global ? 'Global — visible in all projects' : 'Project-scoped'}
      </div>
    </div>`;
}

// ── Event wiring ────────────────────────────────────────────────────────

function bindNodeEvents(nodeId) {
  if (!_container) return;

  const node = WorkflowModel.getNode(nodeId);
  if (!node) return;

  // Label (always present)
  const labelInput = _container.querySelector('#wb-node-label');
  if (labelInput) {
    labelInput.addEventListener('input', () => {
      WorkflowModel.updateNode(nodeId, { label: labelInput.value });
    });
  }

  // Dynamic config fields
  const typeDef = NODE_TYPES[node.type];
  const fields = typeDef?.configFields ?? [];
  for (const field of fields) {
    const el = _container.querySelector(`#wb-cfg-${field.key}`);
    if (!el) continue;

    const eventType = field.type === 'select' ? 'change' : 'input';
    el.addEventListener(eventType, () => {
      let value;
      if (field.type === 'checkbox') {
        value = el.checked;
      } else if (field.type === 'number') {
        value = el.value === '' ? undefined : Number(el.value);
      } else {
        value = el.value;
      }

      WorkflowModel.updateNode(nodeId, { config: { [field.key]: value } });

      // Re-render if a field with showWhen dependents changed — other fields
      // may need to appear or disappear.
      const hasDependents = fields.some(f => f.showWhen && f.showWhen[field.key] !== undefined);
      if (hasDependents) {
        // Defer so the store update settles first
        requestAnimationFrame(() => renderForNode(WorkflowModel.getNode(nodeId)));
      }
    });
  }

  // Decision port editor
  if (node.type === 'decision') {
    const addBtn = _container.querySelector('#wb-add-port');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const current = WorkflowModel.getNode(nodeId);
        const ports = Array.isArray(current.config.ports) ? [...current.config.ports] : [];
        const id = `port-${crypto.randomUUID().slice(0, 8)}`;
        ports.push({ id, label: '', condition: '' });
        WorkflowModel.updateNode(nodeId, { config: { ports } });
        requestAnimationFrame(() => renderForNode(WorkflowModel.getNode(nodeId)));
      });
    }

    for (const removeBtn of _container.querySelectorAll('.wb-remove-port')) {
      removeBtn.addEventListener('click', () => {
        const idx = parseInt(removeBtn.dataset.portIdx, 10);
        const current = WorkflowModel.getNode(nodeId);
        const ports = Array.isArray(current.config.ports) ? [...current.config.ports] : [];
        ports.splice(idx, 1);
        WorkflowModel.updateNode(nodeId, { config: { ports } });
        requestAnimationFrame(() => renderForNode(WorkflowModel.getNode(nodeId)));
      });
    }

    for (const row of _container.querySelectorAll('.wb-port-row')) {
      const idx = parseInt(row.dataset.portIdx, 10);
      const labelInput = row.querySelector('.wb-port-label');
      const condInput = row.querySelector('.wb-port-condition');

      const updatePort = () => {
        const current = WorkflowModel.getNode(nodeId);
        const ports = Array.isArray(current.config.ports) ? [...current.config.ports] : [];
        if (ports[idx]) {
          ports[idx] = { ...ports[idx], label: labelInput.value, condition: condInput.value };
          WorkflowModel.updateNode(nodeId, { config: { ports } });
        }
      };

      if (labelInput) labelInput.addEventListener('input', updatePort);
      if (condInput) condInput.addEventListener('input', updatePort);
    }
  }

  // Instructions (present for non-step typed nodes)
  const instructionsInput = _container.querySelector('#wb-node-instructions');
  if (instructionsInput) {
    instructionsInput.addEventListener('input', () => {
      WorkflowModel.updateNode(nodeId, { config: { instructions: instructionsInput.value } });
    });
  }
}

function bindWorkflowEvents() {
  if (!_container) return;

  const nameInput = _container.querySelector('#wb-wf-name');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      const wf = store.get('workflow');
      if (wf) {
        wf.name = nameInput.value;
        store.set('isDirty', true);
        store.set('workflow', wf);
      }
    });
  }

  const descInput = _container.querySelector('#wb-wf-description');
  if (descInput) {
    descInput.addEventListener('input', () => {
      const wf = store.get('workflow');
      if (wf) {
        wf.description = descInput.value;
        store.set('isDirty', true);
        store.set('workflow', wf);
      }
    });
  }
}

function renderForNode(node) {
  if (!_container) return;
  _container.innerHTML = renderNodeInspector(node);
  bindNodeEvents(node.id);
}

function render() {
  if (!_container) return;

  // Skip re-render while a field inside the inspector is focused — the user
  // is actively typing and re-rendering would destroy the focused element.
  if (_container.contains(document.activeElement)) return;

  const selectedIds = store.get('selectedNodeIds');
  if (selectedIds && selectedIds.size === 1) {
    const nodeId = [...selectedIds][0];
    const node = WorkflowModel.getNode(nodeId);
    if (node) {
      renderForNode(node);
      return;
    }
  }

  // No node selected — show workflow properties
  _container.innerHTML = renderWorkflowInspector();
  bindWorkflowEvents();
}

// ── Exports ─────────────────────────────────────────────────────────────

export const Inspector = {
  /**
   * Mount the inspector panel into a container and subscribe to selection changes.
   * @param {HTMLElement} container
   */
  mount(container) {
    _container = container;
    render();

    _unsubs.push(store.on('selectedNodeIds', () => render()));
    _unsubs.push(store.on('workflow', () => {
      // Only re-render workflow panel if no node is selected
      const sel = store.get('selectedNodeIds');
      if (!sel || sel.size === 0) render();
    }));
  },

  /**
   * Unmount and clean up subscriptions.
   */
  unmount() {
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
    if (_container) _container.innerHTML = '';
    _container = null;
  },

  /**
   * Force re-render for current selection.
   */
  refresh() {
    render();
  },
};
