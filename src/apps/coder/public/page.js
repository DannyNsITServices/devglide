// ── Coder App — Page Module ───────────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).
// Renders a Monaco-based code editor with file tree sidebar natively
// in the SPA shell (no iframe).

import { escapeHtml } from '/shared-assets/ui-utils.js';
import { createApi } from '/shared-ui/app-page.js';
import { createHeader } from '/shared-ui/components/header.js';
import { confirmModal } from '/shared-ui/components/modal.js';

const api = createApi('coder');

const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2';

// Proxy worker through a blob URL so cross-origin importScripts succeeds
window.MonacoEnvironment = {
  getWorkerUrl(_moduleId, label) {
    const workerPath = MONACO_CDN + '/min/vs/base/worker/workerMain.js';
    const blob = new Blob(
      [`importScripts("${workerPath}");`],
      { type: 'application/javascript' }
    );
    return URL.createObjectURL(blob);
  },
};

let _container = null;
let _editor = null;
let _voiceHandler = null;
let _currentRoot = null;
let _tabs = new Map(); // path -> { model, dirty }
let _activeFile = null;
let _treeGen = 0;
let _statusTimer = null;
let _monacoReady = false;

// ── HTML ─────────────────────────────────────────────────────────────

const BODY_HTML = `
  ${createHeader({ brand: 'Coder', meta: '<span class="save-status"></span>' })}

  <div class="coder-layout">
    <div class="coder-sidebar" aria-label="File explorer">
      <div class="tree-header">Explorer</div>
      <div class="file-tree" role="tree" aria-label="File tree"></div>
    </div>

    <div class="coder-editor-area">
      <div class="coder-tab-bar"></div>
      <div class="coder-editor-wrap">
        <div class="coder-editor-container"></div>
      </div>
      <div class="coder-no-file">
        <div class="hint">&lt;/&gt;</div>
        <div class="sub">Open a file from the explorer</div>
      </div>
      <div class="coder-status-bar"></div>
    </div>
  </div>
`;

// ── Monaco loader ───────────────────────────────────────────────────

let _monacoLoadPromise = null;

function loadMonaco() {
  if (_monacoLoadPromise) return _monacoLoadPromise;
  _monacoLoadPromise = new Promise((resolve, reject) => {
    // If Monaco is already available globally (loaded by another module)
    if (typeof monaco !== 'undefined' && monaco.editor) {
      _monacoReady = true;
      resolve();
      return;
    }

    // Check if the AMD loader script is already present
    if (typeof require !== 'undefined' && typeof require.config === 'function') {
      require.config({
        paths: { vs: MONACO_CDN + '/min/vs' },
      });
      require(['vs/editor/editor.main'], () => {
        _monacoReady = true;
        resolve();
      });
      return;
    }

    // Load the AMD loader script
    const script = document.createElement('script');
    script.src = MONACO_CDN + '/min/vs/loader.js';
    script.onload = () => {
      require.config({
        paths: { vs: MONACO_CDN + '/min/vs' },
      });
      require(['vs/editor/editor.main'], () => {
        _monacoReady = true;
        resolve();
      });
    };
    script.onerror = () => reject(new Error('Failed to load Monaco editor'));
    document.head.appendChild(script);
  });
  return _monacoLoadPromise;
}

// ── Monaco theme ────────────────────────────────────────────────────

function applyMonacoTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  monaco.editor.defineTheme('devglide', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment',  foreground: v('--df-color-text-muted').replace('#','') },
      { token: 'keyword',  foreground: v('--df-color-accent-default').replace('#','') },
      { token: 'string',   foreground: v('--df-color-state-success').replace('#','') },
      { token: 'number',   foreground: v('--df-color-accent-bright').replace('#','') },
    ],
    colors: {
      'editor.background':              v('--df-color-bg-base'),
      'editor.foreground':              v('--df-color-text-primary'),
      'editor.lineHighlightBackground': v('--df-color-bg-raised'),
      'editor.selectionBackground':     v('--df-color-accent-dim'),
      'editorCursor.foreground':        v('--df-color-accent-default'),
      'editorLineNumber.foreground':    v('--df-color-text-muted'),
      'editorGutter.background':        v('--df-color-bg-base'),
      'editorWidget.background':        v('--df-color-bg-surface'),
      'editorWidget.border':            v('--df-color-border-default'),
      'minimap.background':             v('--df-color-bg-base'),
    },
  });
  monaco.editor.setTheme('devglide');
}

// ── Helpers ──────────────────────────────────────────────────────────

function langFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    json: 'json', css: 'css', html: 'html',
    md: 'markdown', sh: 'shell', bash: 'shell',
    yaml: 'yaml', yml: 'yaml', py: 'python',
    prisma: 'prisma', toml: 'toml', sql: 'sql',
  }[ext] ?? 'plaintext';
}

function extBadge(name) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map = {
    ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS',
    json: '{}', css: '~~', html: '<>', md: 'MD',
    svg: 'SG', sh: '$_', py: 'PY', prisma: 'DB',
    yaml: 'YL', yml: 'YL', toml: 'TM', sql: 'SQ',
  };
  return map[ext] ?? '\u00b7\u00b7';
}

function setStatus(msg, cls) {
  if (!_container) return;
  const el = _container.querySelector('.save-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'save-status' + (cls ? ' ' + cls : '');
}

function showEditor(visible) {
  if (!_container) return;
  const wrap = _container.querySelector('.coder-editor-wrap');
  const noFile = _container.querySelector('.coder-no-file');
  if (wrap) wrap.style.display = visible ? 'block' : 'none';
  if (noFile) noFile.style.display = visible ? 'none' : 'flex';
}

function updateTreeHeader() {
  if (!_container) return;
  const header = _container.querySelector('.tree-header');
  if (header) header.textContent = _currentRoot ? _currentRoot.split('/').pop() : 'Explorer';
}

// ── File tree ───────────────────────────────────────────────────────

async function fetchTree() {
  if (!_container) return;
  const gen = ++_treeGen;
  const tree = _container.querySelector('.file-tree');
  if (!tree) return;
  try {
    const url = _currentRoot
      ? `/tree?root=${encodeURIComponent(_currentRoot)}`
      : '/tree';
    const res = await api(url);
    const nodes = await res.json();
    if (gen !== _treeGen) return;
    tree.innerHTML = '';
    renderTree(nodes, tree, 0);
  } catch (e) {
    if (gen !== _treeGen) return;
    tree.innerHTML = '';
    tree.textContent = 'Failed to load tree.';
  }
}

function renderTree(nodes, container, depth) {
  for (const node of nodes) {
    if (node.type === 'dir') {
      const wrap = document.createElement('div');

      const label = document.createElement('div');
      label.className = 'tree-item tree-dir';
      label.setAttribute('role', 'treeitem');
      label.setAttribute('aria-expanded', 'false');
      label.style.paddingLeft = `${depth * 14 + 8}px`;
      label.innerHTML =
        `<span class="dir-icon">&#9658;</span><span class="item-name">${escapeHtml(node.name)}</span>`;

      const children = document.createElement('div');
      children.className = 'tree-children collapsed';
      children.setAttribute('role', 'group');
      if (node.children?.length) renderTree(node.children, children, depth + 1);

      label.addEventListener('click', () => {
        const collapsed = children.classList.toggle('collapsed');
        label.querySelector('.dir-icon').innerHTML = collapsed ? '&#9658;' : '&#9660;';
        label.setAttribute('aria-expanded', String(!collapsed));
      });

      wrap.appendChild(label);
      wrap.appendChild(children);
      container.appendChild(wrap);
    } else {
      const item = document.createElement('div');
      item.className = 'tree-item tree-file';
      item.setAttribute('role', 'treeitem');
      item.style.paddingLeft = `${depth * 14 + 8}px`;
      item.dataset.path = node.path;
      item.innerHTML =
        `<span class="ext-badge">${extBadge(node.name)}</span><span class="item-name">${escapeHtml(node.name)}</span>`;
      item.addEventListener('click', () => openFile(node.path));
      container.appendChild(item);
    }
  }
}

// ── File open / tabs ────────────────────────────────────────────────

async function openFile(path) {
  if (_tabs.has(path)) { activateTab(path); return; }
  if (!_monacoReady || !_editor) return;
  try {
    const rootParam = _currentRoot ? `&root=${encodeURIComponent(_currentRoot)}` : '';
    const res = await api(`/file?path=${encodeURIComponent(path)}${rootParam}`);
    if (!res.ok) { setStatus((await res.json()).error, 'err'); return; }
    const { content } = await res.json();
    const model = monaco.editor.createModel(content, langFromPath(path));
    model.onDidChangeContent(() => markDirty(path));
    _tabs.set(path, { model, dirty: false });
    addTab(path);
    activateTab(path);
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

function addTab(path) {
  if (!_container) return;
  const name = path.split('/').pop();
  const tab = document.createElement('button');
  tab.className = 'tab';
  tab.dataset.path = path;
  tab.title = path;
  const escaped = escapeHtml(name);
  tab.innerHTML = `<span class="tab-name">${escaped}</span><span class="tab-close" title="Close" aria-label="Close ${escaped}">&#215;</span>`;
  tab.addEventListener('click', e => {
    if (e.target.classList.contains('tab-close')) closeTab(path);
    else activateTab(path);
  });
  _container.querySelector('.coder-tab-bar').appendChild(tab);
}

function activateTab(path) {
  if (!_container || !_editor) return;
  _activeFile = path;
  _container.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.path === path));
  _container.querySelectorAll('.tree-file').forEach(el =>
    el.classList.toggle('active', el.dataset.path === path));
  _editor.setModel(_tabs.get(path).model);
  showEditor(true);
  const statusBar = _container.querySelector('.coder-status-bar');
  if (statusBar) statusBar.textContent = `${path}  \u00b7  ${langFromPath(path)}`;
}

async function closeTab(path) {
  if (!_container) return;
  const tab = _tabs.get(path);
  if (tab?.dirty) {
    const ok = await confirmModal(_container, { title: 'Unsaved Changes', message: `Unsaved changes in ${path.split('/').pop()}. Close anyway?`, confirmLabel: 'Close Anyway', confirmCls: 'btn-danger' });
    if (!ok) return;
  }
  tab?.model?.dispose();
  _tabs.delete(path);
  _container.querySelector(`.tab[data-path="${CSS.escape(path)}"]`)?.remove();
  if (_activeFile === path) {
    const remaining = [..._tabs.keys()];
    if (remaining.length) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      _activeFile = null;
      if (_editor) _editor.setModel(null);
      showEditor(false);
      const statusBar = _container.querySelector('.coder-status-bar');
      if (statusBar) statusBar.textContent = '';
    }
  }
}

function markDirty(path) {
  const tab = _tabs.get(path);
  if (!tab || tab.dirty) return;
  tab.dirty = true;
  if (!_container) return;
  const nameEl = _container.querySelector(`.tab[data-path="${CSS.escape(path)}"] .tab-name`);
  if (nameEl) nameEl.textContent = path.split('/').pop() + ' \u25cf';
}

// ── Save ────────────────────────────────────────────────────────────

async function saveActive() {
  if (!_activeFile) return;
  const tab = _tabs.get(_activeFile);
  if (!tab) return;
  const content = tab.model.getValue();
  setStatus('Saving\u2026', '');
  try {
    const res = await api('/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _activeFile, content, root: _currentRoot }),
    });
    if (!res.ok) throw new Error('Server error');
    tab.dirty = false;
    if (_container) {
      const nameEl = _container.querySelector(`.tab[data-path="${CSS.escape(_activeFile)}"] .tab-name`);
      if (nameEl) nameEl.textContent = _activeFile.split('/').pop();
    }
    setStatus('Saved \u2713', 'ok');
    if (_statusTimer) clearTimeout(_statusTimer);
    _statusTimer = setTimeout(() => setStatus('', ''), 2000);
  } catch (e) {
    setStatus('Save failed!', 'err');
  }
}

// ── Refresh tree (on project change) ────────────────────────────────

function refreshTree() {
  // Close all tabs and clear editor
  for (const [p] of _tabs) closeTab(p);
  if (_container) {
    const tree = _container.querySelector('.file-tree');
    if (tree) tree.innerHTML = '';
  }
  fetchTree();
}

// ── Exports ─────────────────────────────────────────────────────────

export async function mount(container, ctx) {
  _container = container;
  _tabs = new Map();
  _activeFile = null;
  _treeGen = 0;

  // 1. Scope the container
  container.classList.add('page-coder', 'app-page');

  // 2. Build HTML
  container.innerHTML = BODY_HTML;

  // 3. Show empty state initially
  showEditor(false);

  // 4. Set initial project from context
  _currentRoot = ctx?.project?.path || null;
  updateTreeHeader();

  // 5. Load Monaco and initialize editor
  try {
    await loadMonaco();
    // Guard against unmount during async load
    if (!_container) return;

    applyMonacoTheme();

    const editorContainer = container.querySelector('.coder-editor-container');
    _editor = monaco.editor.create(editorContainer, {
      theme: 'devglide',
      automaticLayout: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: 'selection',
    });

    // Ctrl/Cmd+S to save
    _editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);

    // 6. Load file tree
    fetchTree();
  } catch (e) {
    if (_container) {
      const tree = container.querySelector('.file-tree');
      if (tree) tree.textContent = 'Failed to load editor: ' + e.message;
    }
    return;
  }

  // 7. Voice input: insert dictated text at cursor when editor is focused
  _voiceHandler = (e) => {
    if (!_editor || !_container) return;
    if (!_editor.hasTextFocus()) return;
    const text = e.detail?.text;
    if (!text) return;
    const selection = _editor.getSelection();
    if (selection) {
      _editor.executeEdits('voice', [{
        range: selection,
        text: text,
        forceMoveMarkers: true,
      }]);
    }
  };
  document.addEventListener('voice:result', _voiceHandler);
}

export function unmount(container) {
  // 1. Clear status timer
  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }

  // 2. Remove voice handler
  if (_voiceHandler) {
    document.removeEventListener('voice:result', _voiceHandler);
    _voiceHandler = null;
  }

  // 3. Dispose all Monaco models
  for (const [, tab] of _tabs) {
    tab.model?.dispose();
  }
  _tabs = new Map();
  _activeFile = null;

  // 4. Dispose Monaco editor instance
  if (_editor) {
    _editor.dispose();
    _editor = null;
  }

  // 5. Remove scope class & clear HTML
  container.classList.remove('page-coder', 'app-page');
  container.innerHTML = '';

  // 6. Clear module references
  _container = null;
  _currentRoot = null;
}

export function onProjectChange(project) {
  const newRoot = project?.path || null;
  if (newRoot && newRoot !== _currentRoot) {
    _currentRoot = newRoot;
    updateTreeHeader();
    refreshTree();
  } else if (!newRoot) {
    _currentRoot = null;
    updateTreeHeader();
    refreshTree();
  }
}
