// ── Workflow Editor — Top Toolbar ────────────────────────────────────────
// Toolbar above the canvas with workflow controls.

import { store } from '../state/store.js';
import { WorkflowModel } from '../models/workflow-model.js';
import { NODE_TYPES, NODE_CATEGORIES } from '../models/node-types.js';

let _container = null;
let _unsubs = [];
let _historyManager = null;
let _onBack = null;
let _onSave = null;
let _onValidate = null;
let _onAddStep = null;
let _onExport = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getWorkflowName() {
  const wf = store.get('workflow');
  return wf?.name ?? 'Untitled Workflow';
}

function render() {
  if (!_container) return;

  // Skip re-render while the name input is focused — the user is actively
  // typing and the input already reflects the current value.  The next
  // render after blur will sync everything.
  const nameEl = _container.querySelector('[data-ref="name"]');
  if (nameEl && document.activeElement === nameEl) return;

  const wf = store.get('workflow');
  const dirty = store.get('isDirty');
  const zoom = store.get('zoom') ?? 1;
  const zoomPct = Math.round(zoom * 100);

  _container.innerHTML = `
    <button class="btn btn-secondary" data-action="back" title="Back to workflow list">&larr;</button>
    <button class="btn btn-primary" data-action="add-step">+ Node ▾</button>
    <input data-ref="name" type="text" value="${esc(getWorkflowName())}"
      style="background:none;border:none;color:var(--df-color-accent-default);
        font-family:var(--df-font-mono);font-size:var(--df-font-size-md);
        letter-spacing:var(--df-letter-spacing-wider);text-transform:uppercase;
        width:200px;outline:none;" />
    ${dirty ? '<span style="width:6px;height:6px;border-radius:50%;background:var(--df-color-state-recording);flex-shrink:0;" title="Unsaved changes"></span>' : ''}
    <span style="flex:1"></span>
    <button class="btn btn-secondary" data-action="undo" title="Undo (Ctrl+Z)">&#8630;</button>
    <button class="btn btn-secondary" data-action="redo" title="Redo (Ctrl+Y)">&#8631;</button>
    <span style="width:1px;height:16px;background:var(--df-color-border-default);flex-shrink:0;"></span>
    <button class="btn btn-secondary" data-action="zoom-out" title="Zoom Out (-)">&#8722;</button>
    <span data-ref="zoom-label" style="font-size:var(--df-font-size-xs);color:var(--df-color-text-muted);
      min-width:36px;text-align:center;">${zoomPct}%</span>
    <button class="btn btn-secondary" data-action="zoom-in" title="Zoom In (+)">&#43;</button>
    <span style="width:1px;height:16px;background:var(--df-color-border-default);flex-shrink:0;"></span>
    <button class="btn btn-secondary" data-action="export">Export</button>
    <button class="btn btn-primary" data-action="save" ${!dirty ? 'style="opacity:0.5"' : ''}>Save</button>
    <button class="btn ${wf?.enabled !== false ? 'btn-primary' : 'btn-secondary'}" data-action="toggle" style="width:120px;flex-shrink:0;">${wf?.enabled !== false ? '● Enabled' : '○ Disabled'}</button>
    <button class="btn ${wf?.global ? 'btn-primary' : 'btn-secondary'}" data-action="toggle-global" style="min-width:120px" title="${wf?.global ? 'Click to make project-only' : 'Click to make global (visible in all projects)'}">${wf?.global ? '⊕ Global' : '⊙ Local'}</button>
  `;

  bindEvents();
}

function bindEvents() {
  if (!_container) return;

  const $ = (sel) => _container.querySelector(sel);

  $('[data-action="back"]')?.addEventListener('click', () => _onBack?.());
  $('[data-action="add-step"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNodeTypePicker();
  });

  const nameInput = $('[data-ref="name"]');
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

  $('[data-action="undo"]')?.addEventListener('click', () => _historyManager?.undo?.());
  $('[data-action="redo"]')?.addEventListener('click', () => _historyManager?.redo?.());

  $('[data-action="zoom-out"]')?.addEventListener('click', () => {
    const z = Math.max(0.25, (store.get('zoom') ?? 1) - 0.1);
    store.set('zoom', z);
  });

  $('[data-action="zoom-in"]')?.addEventListener('click', () => {
    const z = Math.min(3, (store.get('zoom') ?? 1) + 0.1);
    store.set('zoom', z);
  });

  $('[data-action="export"]')?.addEventListener('click', () => _onExport?.());
  $('[data-action="save"]')?.addEventListener('click', () => _onSave?.());
  $('[data-action="toggle-global"]')?.addEventListener('click', () => {
    const wf = store.get('workflow');
    if (wf) {
      wf.global = !wf.global;
      store.set('isDirty', true);
      store.set('workflow', wf);
      render();
    }
  });
  $('[data-action="toggle"]')?.addEventListener('click', () => {
    const wf = store.get('workflow');
    if (wf) {
      wf.enabled = wf.enabled === false ? true : false;
      store.set('isDirty', true);
      store.set('workflow', wf);
      render();
    }
  });
}

// ── Node type picker dropdown ────────────────────────────────────────────

let _pickerEl = null;
let _pickerDismiss = null;

function toggleNodeTypePicker() {
  if (_pickerEl) {
    closeNodeTypePicker();
    return;
  }

  const btn = _container?.querySelector('[data-action="add-step"]');
  if (!btn) return;

  _pickerEl = document.createElement('div');
  _pickerEl.className = 'wb-node-picker';

  let html = '';
  for (const cat of NODE_CATEGORIES) {
    const entries = Object.entries(NODE_TYPES).filter(([, def]) => def.category === cat.id);
    if (!entries.length) continue;
    html += `<div class="wb-node-picker-cat">${esc(cat.label)}</div>`;
    for (const [typeKey, def] of entries) {
      html += `<button class="wb-node-picker-item" data-type="${esc(typeKey)}">${esc(def.label)}</button>`;
    }
  }
  _pickerEl.innerHTML = html;

  // Position below the button
  const rect = btn.getBoundingClientRect();
  _pickerEl.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;`;

  document.body.appendChild(_pickerEl);

  _pickerEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-type]');
    if (!item) return;
    _onAddStep?.(item.dataset.type);
    closeNodeTypePicker();
  });

  _pickerDismiss = (e) => {
    if (!_pickerEl?.contains(e.target) && e.target !== btn) {
      closeNodeTypePicker();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', _pickerDismiss), 0);
}

function closeNodeTypePicker() {
  if (_pickerDismiss) {
    document.removeEventListener('pointerdown', _pickerDismiss);
    _pickerDismiss = null;
  }
  _pickerEl?.remove();
  _pickerEl = null;
}

// ── Exports ─────────────────────────────────────────────────────────────

export const Toolbar = {
  mount(container) {
    _container = container;
    render();

    _unsubs.push(store.on('isDirty', () => render()));
    _unsubs.push(store.on('zoom', () => {
      const label = _container?.querySelector('[data-ref="zoom-label"]');
      if (label) label.textContent = Math.round((store.get('zoom') ?? 1) * 100) + '%';
    }));
  },

  unmount() {
    closeNodeTypePicker();
    for (const unsub of _unsubs) unsub();
    _unsubs = [];
    if (_container) _container.innerHTML = '';
    _container = null;
    _historyManager = null;
    _onBack = null;
    _onSave = null;
    _onValidate = null;
    _onAddStep = null;
    _onExport = null;
  },

  setHistoryManager(hm) {
    _historyManager = hm;
  },

  setHandlers(handlers) {
    _onBack = handlers.onBack ?? null;
    _onSave = handlers.onSave ?? null;
    _onValidate = handlers.onValidate ?? null;
    _onAddStep = handlers.onAddStep ?? null;
    _onExport = handlers.onExport ?? null;
  },

  setWorkflowName(name) {
    const input = _container?.querySelector('[data-ref="name"]');
    if (input) input.value = name;
  },

  setDirty(dirty) {
    store.set('isDirty', dirty);
  },
};
