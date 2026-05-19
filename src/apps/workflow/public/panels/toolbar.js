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

function getWorkflowName() {
  const wf = store.get('workflow');
  return wf?.name ?? 'Untitled Workflow';
}

function createButton(className, action, text, title = null) {
  const button = document.createElement('button');
  button.className = className;
  button.dataset.action = action;
  button.textContent = text;
  if (title) button.title = title;
  return button;
}

function createDivider() {
  const divider = document.createElement('span');
  divider.style.width = '1px';
  divider.style.height = '16px';
  divider.style.background = 'var(--df-color-border-default)';
  divider.style.flexShrink = '0';
  return divider;
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

  _container.replaceChildren();

  const back = createButton('btn btn-secondary', 'back', '←', 'Back to workflow list');
  const addStep = createButton('btn btn-primary', 'add-step', '+ Node ▾');

  const nameInput = document.createElement('input');
  nameInput.dataset.ref = 'name';
  nameInput.type = 'text';
  nameInput.value = getWorkflowName();
  nameInput.style.background = 'none';
  nameInput.style.border = 'none';
  nameInput.style.color = 'var(--df-color-accent-default)';
  nameInput.style.fontFamily = 'var(--df-font-mono)';
  nameInput.style.fontSize = 'var(--df-font-size-md)';
  nameInput.style.letterSpacing = 'var(--df-letter-spacing-wider)';
  nameInput.style.textTransform = 'uppercase';
  nameInput.style.width = '200px';
  nameInput.style.outline = 'none';

  const spacer = document.createElement('span');
  spacer.style.flex = '1';

  const children = [back, addStep, nameInput];
  if (dirty) {
    const indicator = document.createElement('span');
    indicator.style.width = '6px';
    indicator.style.height = '6px';
    indicator.style.borderRadius = '50%';
    indicator.style.background = 'var(--df-color-state-recording)';
    indicator.style.flexShrink = '0';
    indicator.title = 'Unsaved changes';
    children.push(indicator);
  }
  const undo = createButton('btn btn-secondary', 'undo', '↶', 'Undo (Ctrl+Z)');
  const redo = createButton('btn btn-secondary', 'redo', '↷', 'Redo (Ctrl+Y)');
  const zoomOut = createButton('btn btn-secondary', 'zoom-out', '−', 'Zoom Out (-)');
  const zoomIn = createButton('btn btn-secondary', 'zoom-in', '+', 'Zoom In (+)');
  const zoomLabel = document.createElement('span');
  zoomLabel.dataset.ref = 'zoom-label';
  zoomLabel.style.fontSize = 'var(--df-font-size-xs)';
  zoomLabel.style.color = 'var(--df-color-text-muted)';
  zoomLabel.style.minWidth = '36px';
  zoomLabel.style.textAlign = 'center';
  zoomLabel.textContent = `${zoomPct}%`;
  const exportBtn = createButton('btn btn-secondary', 'export', 'Export');
  const save = createButton('btn btn-primary', 'save', 'Save');
  if (!dirty) save.style.opacity = '0.5';
  const toggle = createButton(`btn ${wf?.enabled !== false ? 'btn-primary' : 'btn-secondary'}`, 'toggle', wf?.enabled !== false ? '● Enabled' : '○ Disabled');
  toggle.style.width = '120px';
  toggle.style.flexShrink = '0';
  const toggleGlobal = createButton(`btn ${wf?.global ? 'btn-primary' : 'btn-secondary'}`, 'toggle-global', wf?.global ? '⊕ Global' : '⊙ Local', wf?.global ? 'Click to make project-only' : 'Click to make global (visible in all projects)');
  toggleGlobal.style.minWidth = '120px';

  children.push(spacer, undo, redo, createDivider(), zoomOut, zoomLabel, zoomIn, createDivider(), exportBtn, save, toggle, toggleGlobal);
  _container.append(...children);

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

  for (const cat of NODE_CATEGORIES) {
    const entries = Object.entries(NODE_TYPES).filter(([, def]) => def.category === cat.id);
    if (!entries.length) continue;
    const heading = document.createElement('div');
    heading.className = 'wb-node-picker-cat';
    heading.textContent = cat.label;
    _pickerEl.appendChild(heading);
    for (const [typeKey, def] of entries) {
      const button = document.createElement('button');
      button.className = 'wb-node-picker-item';
      button.dataset.type = typeKey;
      button.textContent = def.label;
      _pickerEl.appendChild(button);
    }
  }

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
