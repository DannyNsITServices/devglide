// ── Keymap App — Page Module ─────────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).
// Migrated to shared-ui: header component, app-page CSS class.

import { createHeader } from '/shared-ui/components/header.js';

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

let _container = null;
let _registry = null;
let _recordingState = null; // { actionId, kbdEl, editBtn, conflictEl, rowEl }
let _onRecordKeydown = null;
let _unsubRegistry = null;

// ── HTML ─────────────────────────────────────────────────────────────

const BODY_HTML = `
  ${createHeader({
    brand: 'Keymap',
    actions: `
      <button class="btn" id="km-btn-reset-all">Reset All</button>
      <button class="btn" id="km-btn-export">Export</button>
      <button class="btn" id="km-btn-import">Import</button>
      <input type="file" id="km-file-input" accept=".json" style="display:none" />
    `,
  })}

  <main>
    <div class="shortcut-groups" id="km-shortcut-groups"></div>
  </main>
`;

// ── Rendering ───────────────────────────────────────────────────────

function render() {
  if (!_container || !_registry) return;

  const groupsContainer = _container.querySelector('#km-shortcut-groups');
  if (!groupsContainer) return;

  const groups = _registry.getAll();
  groupsContainer.innerHTML = '';

  Object.keys(groups).forEach(groupName => {
    const section = document.createElement('section');
    section.className = 'shortcut-group';

    const title = document.createElement('h2');
    title.className = 'group-title';
    title.textContent = groupName;
    section.appendChild(title);

    groups[groupName].forEach(item => {
      section.appendChild(buildRow(item));
    });

    groupsContainer.appendChild(section);
  });
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'shortcut-row';
  row.dataset.actionId = item.actionId;

  const desc = document.createElement('span');
  desc.className = 'shortcut-desc';
  desc.textContent = item.description || item.actionId;

  const right = document.createElement('div');
  right.className = 'shortcut-right';

  const kbd = document.createElement('kbd');
  kbd.className = 'shortcut-kbd';
  kbd.textContent = _registry.formatBinding(item.binding);

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-sm';
  editBtn.textContent = 'Edit';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-sm btn-danger';
  resetBtn.textContent = 'Reset';
  resetBtn.style.display = item.overridden ? '' : 'none';

  const conflictEl = document.createElement('div');
  conflictEl.className = 'conflict-warning';
  conflictEl.style.display = 'none';

  editBtn.addEventListener('click', () => {
    startRecording(item.actionId, kbd, editBtn, conflictEl, row);
  });

  resetBtn.addEventListener('click', () => {
    _registry.reset(item.actionId);
    kbd.textContent = _registry.formatBinding(_registry.getBinding(item.actionId));
    resetBtn.style.display = 'none';
    conflictEl.style.display = 'none';
  });

  right.appendChild(kbd);
  right.appendChild(editBtn);
  right.appendChild(resetBtn);

  row.appendChild(desc);
  row.appendChild(right);
  row.appendChild(conflictEl);

  row._refs = { kbd, editBtn, resetBtn, conflictEl };
  return row;
}

// ── Recording ───────────────────────────────────────────────────────

function startRecording(actionId, kbdEl, editBtn, conflictEl, rowEl) {
  cancelRecording();

  kbdEl.classList.add('recording');
  kbdEl.textContent = 'Press keys\u2026';
  editBtn.textContent = 'Cancel';

  _recordingState = { actionId, kbdEl, editBtn, conflictEl, rowEl };

  editBtn.onclick = () => cancelRecording();

  _onRecordKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelRecording();
      return;
    }

    if (MODIFIER_KEYS.has(e.key)) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const newBinding = _registry.captureBinding(e);
    const { actionId: aid, kbdEl: kEl, editBtn: eBtn, conflictEl: cEl, rowEl: rEl } = _recordingState;

    // Check conflicts
    const groups = _registry.getAll();
    let conflict = null;
    const newFormatted = _registry.formatBinding(newBinding);
    Object.values(groups).flat().forEach(item => {
      if (item.actionId !== aid && _registry.formatBinding(item.binding) === newFormatted) {
        conflict = item;
      }
    });

    _registry.rebind(aid, newBinding);

    if (conflict) {
      cEl.textContent = 'Conflicts with: ' + (conflict.description || conflict.actionId);
      cEl.style.display = '';
    } else {
      cEl.style.display = 'none';
    }

    finishRecording();
    kEl.textContent = _registry.formatBinding(newBinding);
    rEl._refs.resetBtn.style.display = '';
  };

  document.addEventListener('keydown', _onRecordKeydown, true);
}

function cancelRecording() {
  if (!_recordingState) return;
  const { actionId, kbdEl } = _recordingState;
  const binding = _registry.getBinding(actionId);
  kbdEl.textContent = binding ? _registry.formatBinding(binding) : 'None';
  finishRecording();
}

function finishRecording() {
  if (!_recordingState) return;
  const { kbdEl, editBtn, actionId } = _recordingState;
  kbdEl.classList.remove('recording');
  editBtn.textContent = 'Edit';

  if (_onRecordKeydown) {
    document.removeEventListener('keydown', _onRecordKeydown, true);
    _onRecordKeydown = null;
  }

  // Re-bind edit button properly
  const row = _recordingState.rowEl;
  const refs = row._refs;
  editBtn.onclick = () => startRecording(actionId, refs.kbd, refs.editBtn, refs.conflictEl, row);

  _recordingState = null;
}

// ── Header button handlers ──────────────────────────────────────────

function bindToolbarActions() {
  if (!_container) return;

  _container.querySelector('#km-btn-reset-all').addEventListener('click', () => {
    _registry.resetAll();
    render();
  });

  _container.querySelector('#km-btn-export').addEventListener('click', () => {
    const json = _registry.exportConfig();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'devglide-keybindings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  const fileInput = _container.querySelector('#km-file-input');
  _container.querySelector('#km-btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        _registry.importConfig(reader.result);
        render();
      } catch (err) {
        console.error('Keymap import failed:', err);
      }
    };
    reader.readAsText(file);
    fileInput.value = '';
  });
}

// ── Exports ─────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
  _registry = typeof KeymapRegistry !== 'undefined' ? KeymapRegistry : null;

  // 1. Scope the container
  container.classList.add('page-keymap', 'app-page');

  // 2. Build HTML
  container.innerHTML = BODY_HTML;

  if (!_registry) {
    container.querySelector('#km-shortcut-groups').innerHTML =
      '<p class="empty-state">KeymapRegistry not loaded.</p>';
    return;
  }

  // 3. Bind toolbar buttons
  bindToolbarActions();

  // 4. Initial render
  render();

  // 5. Listen for external binding changes
  _unsubRegistry = _registry.onChange(() => {
    if (!_recordingState) render();
  });
}

export function unmount(container) {
  // 1. Cancel any active recording
  cancelRecording();

  // 2. Unsubscribe from registry changes
  if (_unsubRegistry) {
    _unsubRegistry();
    _unsubRegistry = null;
  }

  // 3. Remove keydown listener if still active
  if (_onRecordKeydown) {
    document.removeEventListener('keydown', _onRecordKeydown, true);
    _onRecordKeydown = null;
  }

  // 4. Remove scope class & clear HTML
  container.classList.remove('page-keymap', 'app-page');
  container.innerHTML = '';

  // 5. Clear module references
  _container = null;
  _registry = null;
  _recordingState = null;
}

export function onProjectChange(project) {
  // Keymap app is project-agnostic — no action needed
}
