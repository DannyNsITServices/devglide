// ── Kanban App — Native Page Module ───────────────────────────────────────────
// ES module: mount(container, ctx), unmount(container), onProjectChange(project)
//
// This replaces the iframe-based page module with a fully native implementation.
// All DOM queries are scoped to `_root` (the container).

import { escapeHtml, escapeAttr, normalizeEscapes, sanitizeHtml } from '/shared-assets/ui-utils.js';

let _root = null;
let _projectId = null;
let _navigate = null;

// ── Vendor library loading ───────────────────────────────────────────────────

let _vendorsReady = null;

function loadVendors() {
  if (_vendorsReady) return _vendorsReady;
  // Load sequentially: the AMD shim sets window.define=undefined then restores it
  // in onload. Loading in parallel causes the second script to capture the already-
  // cleared window.define, so when the first script's onload restores Monaco's AMD
  // define, the second script executes with define present and registers via AMD
  // instead of setting window.marked/window.Sortable.
  _vendorsReady = loadScript('/app/kanban/vendor/sortable.min.js', 'Sortable')
    .then(() => loadScript('/app/kanban/vendor/marked.min.js', 'marked'));
  return _vendorsReady;
}

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      // Script tag exists — wait for global to appear (may still be loading)
      if (window[globalName]) { resolve(); return; }
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    // Hide AMD define so UMD scripts don't conflict with Monaco's loader
    const amdDefine = window.define;
    window.define = undefined;
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { window.define = amdDefine; resolve(); };
    s.onerror = (e) => { window.define = amdDefine; reject(e); };
    document.head.appendChild(s);
  });
}

// ── API helpers ──────────────────────────────────────────────────────────────

function apiFetch(url, options = {}) {
  const headers = { ...options.headers };
  if (_projectId) headers['x-project-id'] = _projectId;
  return fetch(url, { ...options, headers });
}

let _toastTimer = null;
function showToast(msg, type = 'error') {
  if (!_root) return;
  let toast = _root.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    _root.appendChild(toast);
  }
  toast.textContent = msg;
  toast.dataset.type = type;
  toast.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

// ── Scoped query helpers ─────────────────────────────────────────────────────

function $(sel) { return _root?.querySelector(sel) ?? null; }
function $$(sel) { return _root?.querySelectorAll(sel) ?? []; }

// ── Constants ────────────────────────────────────────────────────────────────

const FEATURE_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6',
];

// Canonical values: src/packages/shared-types/src/index.ts (KANBAN_PRIORITIES)
const PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' };

// ── State ────────────────────────────────────────────────────────────────────

let features = [];
let pollTimer = null;
let boardFeature = null;
let boardPollTimer = null;
let isDragging = false;
let isDialogOpen = false;
let searchQuery = '';
let featureSearchQuery = '';
let featureSortBy = 'name';
let sortableInstances = [];
let selectedColor = FEATURE_COLORS[0];
let deleteTargetFeature = null;
let editTargetFeature = null;
let dialogState = null;
let pendingObjectURLs = [];
let _visibilityHandler = null;
let _searchKeydownHandler = null;
let _escapeHandler = null;
let _voiceHandler = null;

// ── Router (internal hash-based within the kanban page) ──────────────────────

function getRoute() {
  const hash = location.hash || '#/';
  const featureMatch = hash.match(/^#\/features\/(.+)$/);
  if (featureMatch) return { page: 'board', featureId: featureMatch[1] };
  return { page: 'list' };
}

function internalNavigate(hash) {
  location.hash = hash;
}

// ── Feature list rendering ───────────────────────────────────────────────────

function renderFeatureList() {
  if (!_root) return;
  _root.innerHTML = `
    <div class="sync-indicator" aria-live="polite">
      <span class="sync-dot"></span>
      Board updated
    </div>
    <header class="app-header">
      <span class="app-name">Kanban</span>
      <div class="header-actions">
        <span class="sync-badge hidden" data-sync="list-sync">
          <span class="sync-dot"></span> Updated
        </span>
        <button class="btn btn-primary" data-action="new-feature">+ New Feature</button>
      </div>
    </header>
    <div class="board-search" role="search">
      <div class="search-bar">
        <input type="text" class="search-input" data-field="feature-search-input" placeholder="Search features...  ( / )" value="${escapeAttr(featureSearchQuery)}" autocomplete="off">
        <button class="search-clear ${featureSearchQuery ? '' : 'hidden'}" data-action="feature-search-clear" aria-label="Clear search">&times;</button>
      </div>
      <select id="feature-sort" class="feature-sort-select" title="Sort features">
        <option value="name"${featureSortBy === 'name' ? ' selected' : ''}>Name</option>
        <option value="issues"${featureSortBy === 'issues' ? ' selected' : ''}>Issue count</option>
        <option value="updated"${featureSortBy === 'updated' ? ' selected' : ''}>Recently updated</option>
      </select>
    </div>
    <main class="features-container"></main>
    ${_getDialogHTML()}
  `;

  $('[data-action="new-feature"]')?.addEventListener('click', openNewFeatureDialog);
  initFeatureSearch();
  _bindModalOverlays();
  renderFeatures();
}

function initFeatureSearch() {
  const input = $('[data-field="feature-search-input"]');
  const clear = $('[data-action="feature-search-clear"]');
  if (!input) return;

  input.addEventListener('input', () => {
    featureSearchQuery = input.value;
    clear?.classList.toggle('hidden', !featureSearchQuery);
    renderFeatures();
  });

  clear?.addEventListener('click', () => {
    featureSearchQuery = '';
    input.value = '';
    clear.classList.add('hidden');
    input.focus();
    renderFeatures();
  });

  $('#feature-sort')?.addEventListener('change', (e) => {
    featureSortBy = e.target.value;
    renderFeatures();
  });
}

function getFilteredFeatures() {
  let filtered = features;
  const q = featureSearchQuery.toLowerCase().trim();
  if (q) {
    filtered = filtered.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.description || '').toLowerCase().includes(q)
    );
  }
  const sorted = [...filtered];
  if (featureSortBy === 'issues') {
    sorted.sort((a, b) => (b._count.issues) - (a._count.issues));
  } else if (featureSortBy === 'updated') {
    sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  return sorted;
}

function renderFeatures() {
  const main = $('.features-container');
  if (!main) return;

  if (features.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <img src="/favicon.svg" alt="" style="width:28px;height:28px;opacity:0.5">
        </div>
        <p class="empty-text">No features yet</p>
        <button class="btn btn-primary" data-action="empty-create">+ Create your first feature</button>
      </div>
    `;
    $('[data-action="empty-create"]')?.addEventListener('click', openNewFeatureDialog);
    return;
  }

  const filtered = getFilteredFeatures();
  const countLabel = featureSearchQuery
    ? `${filtered.length} of ${features.length} feature${features.length !== 1 ? 's' : ''}`
    : `${features.length} feature${features.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    main.innerHTML = `
      <h1 class="section-title">${escapeHtml(countLabel)}</h1>
      <div class="empty-state">
        <div class="empty-icon" style="font-size:48px;opacity:0.15">\u{1F50D}</div>
        <p class="empty-text">No matching features</p>
      </div>
    `;
    return;
  }

  main.innerHTML = `
    <h1 class="section-title">${escapeHtml(countLabel)}</h1>
    <div class="features-grid">
      ${filtered.map(f => `
        <a href="#/features/${f.id}" class="feature-card" data-id="${f.id}">
          <div class="feature-card-top">
            <div class="feature-card-icon" style="background-color: ${f.color}30">
              <div class="feature-card-dot" style="background-color: ${f.color}"></div>
            </div>
            <div class="feature-card-info">
              <p class="feature-card-name">${escapeHtml(f.name)}</p>
              <p class="feature-card-desc">${f.description ? escapeHtml(f.description) : ''}</p>
            </div>
          </div>
          <div class="feature-card-footer">
            <span class="feature-card-count"># ${f._count.issues} active item${f._count.issues !== 1 ? 's' : ''}</span>
            <button class="feature-edit-btn" data-id="${f.id}" title="Edit feature" aria-label="Edit feature ${escapeHtml(f.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
            <button class="feature-delete-btn" data-id="${f.id}" title="Delete feature" aria-label="Delete feature ${escapeHtml(f.name)}">&times;</button>
          </div>
        </a>
      `).join('')}
    </div>
  `;

  main.querySelectorAll('.feature-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.id;
      const feature = features.find(f => f.id === id);
      if (feature) openEditFeatureDialog(feature);
    });
  });

  main.querySelectorAll('.feature-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.id;
      const feature = features.find(f => f.id === id);
      if (feature) openDeleteFeatureDialog(feature);
    });
  });
}

// ── Feature polling ──────────────────────────────────────────────────────────

function featureSignature(fs) {
  return fs.map(f => `${f.id}:${f._count.issues}`).join('|');
}

function startFeaturePolling() {
  pollTimer = setInterval(async () => {
    try {
      const res = await apiFetch('/api/kanban/features');
      if (!res.ok) return;
      const fresh = await res.json();
      if (featureSignature(fresh) === featureSignature(features)) return;
      features = fresh;
      renderFeatures();
      showSyncFlash('list-sync');
    } catch { /* ignore */ }
  }, 5000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Sync flash ───────────────────────────────────────────────────────────────

function showSyncFlash(name) {
  const el = $(`[data-sync="${name}"]`);
  if (!el) return;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 1500);
}

// ── New Feature Dialog ───────────────────────────────────────────────────────

function openNewFeatureDialog() {
  const dialog = $('.modal-overlay[data-dialog="new-feature"]');
  if (!dialog) return;
  const nameInput = dialog.querySelector('[data-field="nf-name"]');
  const descInput = dialog.querySelector('[data-field="nf-desc"]');
  const colorsDiv = dialog.querySelector('[data-field="nf-colors"]');

  nameInput.value = '';
  descInput.value = '';
  selectedColor = FEATURE_COLORS[0];

  colorsDiv.innerHTML = FEATURE_COLORS.map(c =>
    `<button type="button" class="color-swatch ${c === selectedColor ? 'selected' : ''}"
      data-color="${c}" style="background-color: ${c}" aria-label="Select color ${c}"></button>`
  ).join('');

  colorsDiv.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedColor = btn.dataset.color;
      colorsDiv.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  dialog.classList.remove('hidden');
  nameInput.focus();
}

function _bindNewFeatureDialog() {
  const dialog = $('.modal-overlay[data-dialog="new-feature"]');
  if (!dialog) return;

  dialog.querySelector('[data-action="nf-cancel"]')?.addEventListener('click', () => {
    dialog.classList.add('hidden');
  });

  dialog.querySelector('[data-action="nf-create"]')?.addEventListener('click', async () => {
    const name = dialog.querySelector('[data-field="nf-name"]').value.trim();
    if (!name) return;

    const createBtn = dialog.querySelector('[data-action="nf-create"]');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';

    try {
      const res = await apiFetch('/api/kanban/features', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: dialog.querySelector('[data-field="nf-desc"]').value,
          color: selectedColor,
        }),
      });
      const feature = await res.json();
      features.unshift({ ...feature, description: feature.description || null, _count: { issues: 0 } });
      renderFeatures();
      dialog.classList.add('hidden');
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create Feature';
    }
  });

  dialog.querySelector('[data-field="nf-name"]')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dialog.querySelector('[data-action="nf-create"]')?.click();
  });
}

// ── Delete Feature Dialog ────────────────────────────────────────────────────

function openDeleteFeatureDialog(feature) {
  deleteTargetFeature = feature;
  const dialog = $('.modal-overlay[data-dialog="delete-feature"]');
  if (!dialog) return;
  const msg = dialog.querySelector('[data-field="delete-feature-msg"]');
  let text = `Are you sure you want to delete <strong>${escapeHtml(feature.name)}</strong>?`;
  if (feature._count.issues > 0) {
    text += ` This will permanently remove ${feature._count.issues} item${feature._count.issues !== 1 ? 's' : ''}.`;
  }
  msg.innerHTML = text;
  dialog.classList.remove('hidden');
}

function _bindDeleteFeatureDialog() {
  const dialog = $('.modal-overlay[data-dialog="delete-feature"]');
  if (!dialog) return;

  dialog.querySelector('[data-action="df-cancel"]')?.addEventListener('click', () => {
    dialog.classList.add('hidden');
    deleteTargetFeature = null;
  });

  dialog.querySelector('[data-action="df-confirm"]')?.addEventListener('click', async () => {
    if (!deleteTargetFeature) return;
    await apiFetch(`/api/kanban/features/${deleteTargetFeature.id}`, { method: 'DELETE' });
    features = features.filter(f => f.id !== deleteTargetFeature.id);
    renderFeatures();
    dialog.classList.add('hidden');
    deleteTargetFeature = null;
  });
}

function _bindDeleteIssueDialog() {
  const dialog = $('.modal-overlay[data-dialog="delete-issue"]');
  if (!dialog) return;

  dialog.querySelector('[data-action="di-cancel"]')?.addEventListener('click', () => {
    dialog.classList.add('hidden');
    $('.modal-overlay[data-dialog="issue"]')?.classList.remove('hidden');
  });

  dialog.querySelector('[data-action="di-confirm"]')?.addEventListener('click', async () => {
    const s = dialogState;
    if (!s.issue) return;
    dialog.classList.add('hidden');
    await apiFetch(`/api/kanban/issues/${s.issue.id}`, { method: 'DELETE' });
    s.onDelete(s.issue.id);
    closeDialog();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.classList.add('hidden');
      $('.modal-overlay[data-dialog="issue"]')?.classList.remove('hidden');
    }
  });
}

// ── Edit Feature Dialog ──────────────────────────────────────────────────────

function openEditFeatureDialog(feature) {
  editTargetFeature = feature;
  const dialog = $('.modal-overlay[data-dialog="edit-feature"]');
  if (!dialog) return;

  const nameInput = dialog.querySelector('[data-field="ef-name"]');
  const descInput = dialog.querySelector('[data-field="ef-desc"]');
  const colorsDiv = dialog.querySelector('[data-field="ef-colors"]');

  nameInput.value = feature.name || '';
  descInput.value = feature.description || '';
  selectedColor = feature.color || FEATURE_COLORS[0];

  colorsDiv.innerHTML = FEATURE_COLORS.map(c =>
    `<button type="button" class="color-swatch ${c === selectedColor ? 'selected' : ''}"
      data-color="${c}" style="background-color: ${c}" aria-label="Select color ${c}"></button>`
  ).join('');

  colorsDiv.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedColor = btn.dataset.color;
      colorsDiv.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  dialog.classList.remove('hidden');
  nameInput.focus();
}

function _bindEditFeatureDialog() {
  const dialog = $('.modal-overlay[data-dialog="edit-feature"]');
  if (!dialog) return;

  dialog.querySelector('[data-action="ef-cancel"]')?.addEventListener('click', () => {
    dialog.classList.add('hidden');
    editTargetFeature = null;
  });

  dialog.querySelector('[data-action="ef-save"]')?.addEventListener('click', async () => {
    if (!editTargetFeature) return;
    const name = dialog.querySelector('[data-field="ef-name"]').value.trim();
    if (!name) return;

    const saveBtn = dialog.querySelector('[data-action="ef-save"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const res = await apiFetch(`/api/kanban/features/${editTargetFeature.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: dialog.querySelector('[data-field="ef-desc"]').value,
          color: selectedColor,
        }),
      });
      const updated = await res.json();

      // Update in features list
      const idx = features.findIndex(f => f.id === editTargetFeature.id);
      if (idx !== -1) {
        features[idx] = { ...features[idx], ...updated };
        renderFeatures();
      }

      // Update board header if viewing this feature
      if (boardFeature && boardFeature.id === editTargetFeature.id) {
        boardFeature = { ...boardFeature, ...updated };
        const nameEl = $('.app-name');
        if (nameEl) nameEl.textContent = updated.name;
      }

      dialog.classList.add('hidden');
      editTargetFeature = null;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });

  dialog.querySelector('[data-field="ef-name"]')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dialog.querySelector('[data-action="ef-save"]')?.click();
  });
}

// ── Modal overlays (close on click outside / Escape) ─────────────────────────

function _bindModalOverlays() {
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  _bindNewFeatureDialog();
  _bindDeleteFeatureDialog();
  _bindDeleteIssueDialog();
  _bindEditFeatureDialog();
}

// ── Kanban Board ─────────────────────────────────────────────────────────────

async function renderBoard(featureId) {
  stopBoardPolling();
  searchQuery = '';

  if (!_root) return;
  _root.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await apiFetch(`/api/kanban/features/${featureId}`);
    if (!res.ok) { internalNavigate('#/'); return; }
    boardFeature = await res.json();
  } catch {
    internalNavigate('#/');
    return;
  }

  renderBoardUI();
  startBoardPolling();
}

function renderBoardUI() {
  if (!_root || !boardFeature) return;
  const f = boardFeature;

  _root.innerHTML = `
    <div class="sync-indicator" aria-live="polite">
      <span class="sync-dot"></span>
      Board updated
    </div>
    <header class="app-header">
      <a href="#/" class="back-btn" title="Back to features">&larr;</a>
      <span class="app-name">${escapeHtml(f.name)}</span>
      <button class="board-edit-btn" data-action="edit-board-feature" title="Edit feature"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
      <div class="header-actions">
        <span class="sync-badge hidden" data-sync="board-sync">
          <span class="sync-dot"></span> Updated
        </span>
      </div>
    </header>
    <div class="board-search" role="search">
      <div class="search-bar">
        <input type="text" class="search-input" data-field="search-input" placeholder="Search issues...  ( / )" value="${escapeHtml(searchQuery)}">
        <button class="search-clear ${searchQuery ? '' : 'hidden'}" data-action="search-clear" aria-label="Clear search">&times;</button>
      </div>
    </div>
    <div class="board-columns" data-region="board-columns">
      ${getFilteredColumns().map(col => renderColumn(col)).join('')}
    </div>
    ${_getDialogHTML()}
  `;

  _bindModalOverlays();
  $('[data-action="edit-board-feature"]')?.addEventListener('click', () => {
    if (boardFeature) openEditFeatureDialog(boardFeature);
  });
  initSearch();
  initSortable();
  initAddIssueButtons();
  initCardClicks();
}

function getFilteredColumns() {
  if (!boardFeature) return [];
  if (!searchQuery.trim()) return boardFeature.columns;
  const q = searchQuery.toLowerCase();
  return boardFeature.columns.map(col => ({
    ...col,
    issues: col.issues.filter(issue => {
      let labels = [];
      try { labels = JSON.parse(issue.labels || '[]'); } catch { labels = []; }
      return (
        issue.title.toLowerCase().includes(q) ||
        (issue.description || '').toLowerCase().includes(q) ||
        labels.some(l => l.toLowerCase().includes(q))
      );
    }),
  }));
}

function renderColumn(col) {
  const INTAKE = ['Backlog', 'Todo'];
  const canAdd = INTAKE.includes(col.name);
  return `
    <div class="kanban-column" data-column-id="${col.id}">
      <div class="column-header">
        <span class="column-dot" style="background-color: ${col.color}"></span>
        <span class="column-name">${escapeHtml(col.name)}</span>
        <span class="column-count">${col.issues.length}</span>
      </div>
      <div class="column-drop-zone" data-column-id="${col.id}">
        ${col.issues.map(issue => renderCard(issue)).join('')}
        ${canAdd ? `<button class="add-issue-btn" data-column-id="${col.id}">+ Add issue</button>` : ''}
      </div>
    </div>
  `;
}

function renderCard(issue) {
  let labels = [];
  try { labels = JSON.parse(issue.labels || '[]'); } catch { labels = []; }
  const isOverdue = issue.dueDate && issue.dueDate.split('T')[0] < new Date().toISOString().split('T')[0];
  const type = issue.type || 'TASK';
  const priorityClass = `badge-${issue.priority.toLowerCase()}`;
  const typeClass = type === 'BUG' ? 'badge-bug' : 'badge-secondary';

  return `
    <div class="issue-card" data-issue-id="${issue.id}" data-column-id="${issue.columnId}">
      <p class="issue-card-title">${escapeHtml(issue.title)}</p>
      <div class="issue-card-badges">
        <span class="badge ${priorityClass}">${PRIORITY_LABELS[issue.priority]}</span>
        <span class="badge ${typeClass}">${type === 'BUG' ? 'Bug' : 'Task'}</span>
        ${labels.map(l => `<span class="badge badge-secondary">${escapeHtml(l)}</span>`).join('')}
        ${issue.dueDate ? `<span class="badge ${isOverdue ? 'badge-due-overdue' : 'badge-due'}">${formatDate(issue.dueDate)}</span>` : ''}
        ${issue.reviewCount > 0 ? `<span class="badge badge-review" title="Has review feedback">Review ${issue.reviewCount}</span>` : ''}
        ${issue.workLogCount > 0 ? `<span class="badge badge-worklog" title="Has work log">Log ${issue.workLogCount}</span>` : ''}
      </div>
    </div>
  `;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Search ───────────────────────────────────────────────────────────────────

function initSearch() {
  const input = $('[data-field="search-input"]');
  const clear = $('[data-action="search-clear"]');
  if (!input) return;

  input.addEventListener('input', () => {
    searchQuery = input.value;
    clear?.classList.toggle('hidden', !searchQuery);
    rerenderColumns();
  });

  clear?.addEventListener('click', () => {
    searchQuery = '';
    input.value = '';
    clear.classList.add('hidden');
    input.focus();
    rerenderColumns();
  });
}

function _handleSearchKeydown(e) {
  // Support both board search and feature-list search inputs
  const input = $('[data-field="search-input"]') || $('[data-field="feature-search-input"]');
  if (!input) return;

  const isFeatureList = input.dataset.field === 'feature-search-input';
  const action = typeof KeymapRegistry !== 'undefined' ? KeymapRegistry.resolve(e) : null;
  const isFocusSearch = action === 'kanban:focus-search' || (!action && e.key === '/');
  const isClearSearch = action === 'kanban:clear-search' || (!action && e.key === 'Escape');

  if (isFocusSearch && !isDialogOpen &&
      document.activeElement !== input &&
      !(document.activeElement instanceof HTMLInputElement) &&
      !(document.activeElement instanceof HTMLTextAreaElement)) {
    e.preventDefault();
    input.focus();
  }
  if (isClearSearch && document.activeElement === input) {
    input.value = '';
    input.blur();
    if (isFeatureList) {
      featureSearchQuery = '';
      $('[data-action="feature-search-clear"]')?.classList.add('hidden');
      renderFeatures();
    } else {
      searchQuery = '';
      $('[data-action="search-clear"]')?.classList.add('hidden');
      rerenderColumns();
    }
  }
}

function rerenderColumns() {
  const container = $('[data-region="board-columns"]');
  if (!container) return;
  container.innerHTML = getFilteredColumns().map(col => renderColumn(col)).join('');
  initSortable();
  initAddIssueButtons();
  initCardClicks();
}

// ── SortableJS drag-and-drop ─────────────────────────────────────────────────

function initSortable() {
  sortableInstances.forEach(s => s.destroy());
  sortableInstances = [];

  $$('.column-drop-zone').forEach(zone => {
    const sortable = new Sortable(zone, {
      group: 'kanban',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      filter: '.add-issue-btn',
      draggable: '.issue-card',
      onStart: () => { isDragging = true; },
      onEnd: async (evt) => {
        isDragging = false;
        const issueId = evt.item.dataset.issueId;
        const newColumnId = evt.to.dataset.columnId;
        const newOrder = evt.newIndex;

        updateLocalState(issueId, newColumnId, newOrder);

        try {
          const res = await apiFetch('/api/kanban/issues/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ issueId, newColumnId, newOrder }),
          });
          if (!res.ok) throw new Error('reorder failed');
        } catch {
          try {
            const res = await apiFetch(`/api/kanban/features/${boardFeature.id}`);
            if (res.ok) {
              boardFeature = await res.json();
              rerenderColumns();
            }
          } catch { /* ignore */ }
        }
      },
    });
    sortableInstances.push(sortable);
  });
}

function updateLocalState(issueId, newColumnId, newOrder) {
  if (!boardFeature) return;
  let movedIssue = null;

  for (const col of boardFeature.columns) {
    const idx = col.issues.findIndex(i => i.id === issueId);
    if (idx >= 0) {
      movedIssue = col.issues.splice(idx, 1)[0];
      break;
    }
  }

  if (!movedIssue) return;
  movedIssue.columnId = newColumnId;

  const targetCol = boardFeature.columns.find(c => c.id === newColumnId);
  if (targetCol) {
    targetCol.issues.splice(newOrder, 0, movedIssue);
  }
}

// ── Add issue buttons ────────────────────────────────────────────────────────

function initAddIssueButtons() {
  $$('.add-issue-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const columnId = btn.dataset.columnId;
      isDialogOpen = true;
      openIssueDialog({
        issue: null,
        columns: boardFeature.columns,
        featureId: boardFeature.id,
        defaultColumnId: columnId,
        onSave: handleIssueSaved,
        onDelete: handleIssueDeleted,
        onClose: () => { isDialogOpen = false; },
      });
    });
  });
}

// ── Card clicks (edit) ───────────────────────────────────────────────────────

function initCardClicks() {
  $$('.issue-card').forEach(card => {
    card.addEventListener('click', () => {
      const issueId = card.dataset.issueId;
      let issue = null;
      for (const col of boardFeature.columns) {
        issue = col.issues.find(i => i.id === issueId);
        if (issue) break;
      }
      if (!issue) return;

      isDialogOpen = true;
      openIssueDialog({
        issue,
        columns: boardFeature.columns,
        featureId: boardFeature.id,
        defaultColumnId: null,
        onSave: handleIssueSaved,
        onDelete: handleIssueDeleted,
        onClose: () => { isDialogOpen = false; },
      });
    });
  });
}

// ── Issue save/delete callbacks ──────────────────────────────────────────────

function handleIssueSaved(savedIssue) {
  if (!boardFeature) return;
  for (const col of boardFeature.columns) {
    col.issues = col.issues.filter(i => i.id !== savedIssue.id);
  }
  const targetCol = boardFeature.columns.find(c => c.id === savedIssue.columnId);
  if (targetCol) {
    targetCol.issues.push(savedIssue);
    targetCol.issues.sort((a, b) => a.order - b.order);
  }
  rerenderColumns();
}

function handleIssueDeleted(issueId) {
  if (!boardFeature) return;
  for (const col of boardFeature.columns) {
    col.issues = col.issues.filter(i => i.id !== issueId);
  }
  rerenderColumns();
}

// ── Board polling ────────────────────────────────────────────────────────────

function boardSignature() {
  if (!boardFeature) return '';
  return boardFeature.columns.flatMap(c =>
    c.issues.map(i => `${i.id}:${i.columnId}:${i.order}:${i.updatedAt}`)
  ).join('|');
}

function stopBoardPolling() {
  if (boardPollTimer) { clearInterval(boardPollTimer); boardPollTimer = null; }
}

function startBoardPolling() {
  boardPollTimer = setInterval(async () => {
    if (isDragging || isDialogOpen) return;
    try {
      const res = await apiFetch(`/api/kanban/features/${boardFeature.id}`);
      if (!res.ok) return;
      const fresh = await res.json();
      const freshSig = fresh.columns.flatMap(c =>
        c.issues.map(i => `${i.id}:${i.columnId}:${i.order}:${i.updatedAt}`)
      ).join('|');

      if (freshSig === boardSignature()) return;
      boardFeature = fresh;
      rerenderColumns();
      showSyncFlash('board-sync');
    } catch { /* ignore */ }
  }, 5000);
}

// ── Issue Dialog (create/edit) ───────────────────────────────────────────────

function revokePendingObjectURLs() {
  pendingObjectURLs.forEach(url => URL.revokeObjectURL(url));
  pendingObjectURLs = [];
}

function openIssueDialog({ issue, columns, featureId, defaultColumnId, onSave, onDelete, onClose }) {
  revokePendingObjectURLs();

  dialogState = {
    issue,
    columns,
    featureId,
    defaultColumnId,
    onSave,
    onDelete,
    onClose,
    title: issue?.title ?? '',
    description: issue?.description ?? '',
    priority: issue?.priority ?? 'MEDIUM',
    columnId: issue?.columnId ?? defaultColumnId ?? columns[0]?.id ?? '',
    type: issue?.type ?? 'TASK',
    dueDate: issue?.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : '',
    labels: JSON.parse(issue?.labels ?? '[]'),
    attachments: [],
    pendingFiles: [],
    previewMode: !!issue,
    saving: false,
    uploading: false,
    workLog: [],
    reviewHistory: [],
  };

  renderDialog();

  if (issue?.id) {
    apiFetch(`/api/kanban/issues/${issue.id}`)
      .then(r => r.json())
      .then(data => {
        if (data.attachments) {
          dialogState.attachments = data.attachments;
          renderAttachments();
        }
        if (data.workLog) dialogState.workLog = data.workLog;
        if (data.reviewHistory) dialogState.reviewHistory = data.reviewHistory;
        renderVersionedEntries();
      })
      .catch(() => {});
  }

  const overlay = $('.modal-overlay[data-dialog="issue"]');
  overlay?.classList.remove('hidden');
  $('[data-field="dlg-title"]')?.focus();
}

function renderDialog() {
  const s = dialogState;
  if (!s) return;
  const isEdit = !!s.issue;
  const overlay = $('.modal-overlay[data-dialog="issue"]');
  if (!overlay) return;
  const modal = overlay.querySelector('.modal');

  modal.innerHTML = `
    <div class="modal-header">
      <h2>${isEdit ? 'Edit Item' : 'New Item'}</h2>
      <p class="modal-desc">${isEdit ? 'Update task or bug details.' : 'Add a new task or bug to the board.'}</p>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>Title</label>
        <input type="text" data-field="dlg-title" value="${escapeAttr(s.title)}" placeholder="Issue title...">
      </div>

      <div class="form-group">
        <div class="description-header">
          <label>Description</label>
          <div class="description-tabs">
            <button type="button" class="description-tab ${!s.previewMode ? 'active' : ''}" data-mode="write">Write</button>
            <button type="button" class="description-tab ${s.previewMode ? 'active' : ''}" data-mode="preview">Preview</button>
          </div>
        </div>
        <div data-region="dlg-desc-write" class="${s.previewMode ? 'hidden' : ''}">
          <textarea data-field="dlg-desc" rows="8" placeholder="Add a description... (Markdown supported)">${escapeHtml(s.description)}</textarea>
        </div>
        <div data-region="dlg-desc-preview" class="markdown-preview ${!s.previewMode ? 'hidden' : ''}">
          ${s.description ? sanitizeHtml(marked.parse(normalizeEscapes(s.description))) : '<span class="text-muted">Nothing to preview</span>'}
        </div>
      </div>

      ${isEdit ? `
      <div class="form-group">
        <div class="versioned-columns">
          <div class="versioned-tab-content">
            <div class="versioned-column-header">Review</div>
            <div data-region="dlg-review-entries" class="versioned-entries"></div>
            <textarea data-field="dlg-new-review" rows="3" placeholder="Add review feedback..."></textarea>
            <button type="button" class="btn btn-secondary" data-action="dlg-add-review">+ Add Feedback</button>
          </div>
          <div class="versioned-tab-content">
            <div class="versioned-column-header">Work Log</div>
            <div data-region="dlg-worklog-entries" class="versioned-entries"></div>
            <textarea data-field="dlg-new-worklog" rows="3" placeholder="Add work log entry..."></textarea>
            <button type="button" class="btn btn-secondary" data-action="dlg-add-worklog">+ Add Entry</button>
          </div>
        </div>
      </div>
      ` : ''}

      <div class="form-group">
        <label>Attachments</label>
        <div data-region="dlg-attachments" class="attachment-gallery"></div>
        <div data-region="dlg-drop-zone" class="attachment-drop-zone">
          <input type="file" data-field="dlg-file-input" accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml" multiple class="hidden">
          <span>${s.uploading ? 'Uploading...' : 'Drop images here or click to upload'}</span>
        </div>
      </div>

      <div class="field-row">
        <div class="form-group">
          <label>Priority</label>
          <select data-field="dlg-priority">
            ${Object.entries(PRIORITY_LABELS).map(([v, l]) =>
              `<option value="${v}" ${s.priority === v ? 'selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Column</label>
          <select data-field="dlg-column">
            ${s.columns.map(c =>
              `<option value="${c.id}" ${s.columnId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Type</label>
          <select data-field="dlg-type">
            <option value="TASK" ${s.type === 'TASK' ? 'selected' : ''}>Task</option>
            <option value="BUG" ${s.type === 'BUG' ? 'selected' : ''}>Bug</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Due Date</label>
        <input type="date" data-field="dlg-due" value="${s.dueDate}" class="date-input">
      </div>

      <div class="form-group">
        <label>Labels</label>
        <div data-region="dlg-labels" class="labels-list">
          ${s.labels.map((l, i) => `
            <span class="label-badge">
              ${escapeHtml(l)}
              <button type="button" class="label-remove" data-index="${i}" aria-label="Remove label">&times;</button>
            </span>
          `).join('')}
        </div>
        <div class="label-input-row">
          <input type="text" data-field="dlg-new-label" placeholder="Add label...">
          <button type="button" class="btn btn-secondary" data-action="dlg-add-label">+</button>
        </div>
      </div>

    </div>
    <div class="modal-footer">
      ${isEdit ? `<button class="btn btn-danger" data-action="dlg-delete">Delete</button>` : ''}
      <div class="modal-footer-right">
        <button class="btn btn-secondary" data-action="dlg-cancel">Cancel</button>
        <button class="btn btn-primary" data-action="dlg-save" ${!s.title.trim() ? 'disabled' : ''}>
          ${s.saving ? 'Saving...' : (isEdit ? 'Save' : 'Create')}
        </button>
      </div>
    </div>
  `;

  renderAttachments();
  bindDialogEvents();
}

function renderAttachments() {
  const container = $('[data-region="dlg-attachments"]');
  if (!container || !dialogState) return;

  const s = dialogState;
  let html = '';

  s.attachments.forEach(att => {
    html += `
      <div class="attachment-thumb">
        <img src="/api/kanban/attachments/${att.id}" alt="${escapeAttr(att.filename)}" class="attachment-img" data-url="/api/kanban/attachments/${att.id}">
        <button type="button" class="attachment-thumb-delete" data-att-id="${att.id}" aria-label="Remove attachment">&times;</button>
      </div>
    `;
  });

  revokePendingObjectURLs();

  s.pendingFiles.forEach((file, i) => {
    const objUrl = URL.createObjectURL(file);
    pendingObjectURLs.push(objUrl);
    html += `
      <div class="attachment-thumb attachment-pending">
        <img src="${objUrl}" alt="${escapeAttr(file.name)}" class="attachment-img">
        <button type="button" class="attachment-thumb-delete" data-pending-index="${i}" aria-label="Remove pending attachment">&times;</button>
      </div>
    `;
  });

  container.innerHTML = html;

  // Image click -> preview
  container.querySelectorAll('.attachment-img').forEach(img => {
    img.addEventListener('click', () => {
      const url = img.dataset.url || img.src;
      const preview = $('.image-preview-overlay');
      if (!preview) return;
      preview.querySelector('img').src = url;
      preview.classList.remove('hidden');
    });
  });

  // Delete server attachment
  container.querySelectorAll('[data-att-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.attId;
      await apiFetch(`/api/kanban/attachments/${id}`, { method: 'DELETE' });
      s.attachments = s.attachments.filter(a => a.id !== id);
      renderAttachments();
    });
  });

  // Delete pending file
  container.querySelectorAll('[data-pending-index]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.pendingIndex);
      s.pendingFiles.splice(idx, 1);
      renderAttachments();
    });
  });
}

function bindDialogEvents() {
  const s = dialogState;
  if (!s) return;

  // Title input
  const titleInput = $('[data-field="dlg-title"]');
  titleInput?.addEventListener('input', () => {
    s.title = titleInput.value;
    const saveBtn = $('[data-action="dlg-save"]');
    if (saveBtn) saveBtn.disabled = !s.title.trim();
  });

  // Description write/preview tabs
  $$('.description-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      s.previewMode = mode === 'preview';
      $$('.description-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const writeDiv = $('[data-region="dlg-desc-write"]');
      const previewDiv = $('[data-region="dlg-desc-preview"]');

      if (s.previewMode) {
        s.description = $('[data-field="dlg-desc"]')?.value ?? s.description;
        writeDiv?.classList.add('hidden');
        previewDiv?.classList.remove('hidden');
        if (previewDiv) {
          previewDiv.innerHTML = s.description ? sanitizeHtml(marked.parse(normalizeEscapes(s.description))) : '<span class="text-muted">Nothing to preview</span>';
        }
      } else {
        writeDiv?.classList.remove('hidden');
        previewDiv?.classList.add('hidden');
      }
    });
  });

  // Description textarea
  $('[data-field="dlg-desc"]')?.addEventListener('input', (e) => {
    s.description = e.target.value;
  });

  // Add review feedback
  $('[data-action="dlg-add-review"]')?.addEventListener('click', async () => {
    const textarea = $('[data-field="dlg-new-review"]');
    const content = textarea?.value.trim();
    if (!content || !s.issue?.id) return;
    const btn = $('[data-action="dlg-add-review"]');
    btn.disabled = true;
    btn.textContent = 'Adding...';
    try {
      const res = await apiFetch(`/api/kanban/issues/${s.issue.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`Error: ${res.status}`);
      const entry = await res.json();
      s.reviewHistory.push(entry);
      textarea.value = '';
      renderVersionedEntries();
    } catch (err) {
      showToast('Failed to add review feedback: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '+ Add Feedback';
    }
  });

  // Add work log entry
  $('[data-action="dlg-add-worklog"]')?.addEventListener('click', async () => {
    const textarea = $('[data-field="dlg-new-worklog"]');
    const content = textarea?.value.trim();
    if (!content || !s.issue?.id) return;
    const btn = $('[data-action="dlg-add-worklog"]');
    btn.disabled = true;
    btn.textContent = 'Adding...';
    try {
      const res = await apiFetch(`/api/kanban/issues/${s.issue.id}/work-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`Error: ${res.status}`);
      const entry = await res.json();
      s.workLog.push(entry);
      textarea.value = '';
      renderVersionedEntries();
    } catch (err) {
      showToast('Failed to add work log entry: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '+ Add Entry';
    }
  });

  renderVersionedEntries();

  // Priority, Column, Type selects
  $('[data-field="dlg-priority"]')?.addEventListener('change', (e) => { s.priority = e.target.value; });
  $('[data-field="dlg-column"]')?.addEventListener('change', (e) => { s.columnId = e.target.value; });
  $('[data-field="dlg-type"]')?.addEventListener('change', (e) => { s.type = e.target.value; });

  // Due date
  $('[data-field="dlg-due"]')?.addEventListener('change', (e) => { s.dueDate = e.target.value; });

  // Labels
  $('[data-action="dlg-add-label"]')?.addEventListener('click', addLabel);
  $('[data-field="dlg-new-label"]')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLabel();
  });
  $$('.label-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      s.labels.splice(parseInt(btn.dataset.index), 1);
      renderLabels();
    });
  });

  // File upload
  const dropZone = $('[data-region="dlg-drop-zone"]');
  const fileInput = $('[data-field="dlg-file-input"]');

  dropZone?.addEventListener('click', () => fileInput?.click());
  dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  fileInput?.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  // Save
  $('[data-action="dlg-save"]')?.addEventListener('click', handleSave);

  // Cancel
  $('[data-action="dlg-cancel"]')?.addEventListener('click', closeDialog);

  // Delete — show styled confirmation dialog
  $('[data-action="dlg-delete"]')?.addEventListener('click', () => {
    if (!s.issue) return;
    const dialog = $('.modal-overlay[data-dialog="delete-issue"]');
    if (!dialog) return;
    const msg = dialog.querySelector('[data-field="delete-issue-msg"]');
    if (msg) msg.innerHTML = `Are you sure you want to delete <strong>${escapeHtml(s.issue.title)}</strong>? This action cannot be undone.`;
    $('.modal-overlay[data-dialog="issue"]')?.classList.add('hidden');
    dialog.classList.remove('hidden');
  });

  // Close on overlay click
  const overlay = $('.modal-overlay[data-dialog="issue"]');
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  // Image preview close
  $('.image-preview-close')?.addEventListener('click', () => {
    $('.image-preview-overlay')?.classList.add('hidden');
  });
  $('.image-preview-overlay')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('image-preview-overlay')) {
      e.target.classList.add('hidden');
    }
  });
}

function addLabel() {
  const input = $('[data-field="dlg-new-label"]');
  const trimmed = input?.value.trim();
  if (trimmed && !dialogState.labels.includes(trimmed)) {
    dialogState.labels.push(trimmed);
    renderLabels();
  }
  if (input) input.value = '';
}

function renderLabels() {
  const container = $('[data-region="dlg-labels"]');
  if (!container) return;
  container.innerHTML = dialogState.labels.map((l, i) => `
    <span class="label-badge">
      ${escapeHtml(l)}
      <button type="button" class="label-remove" data-index="${i}" aria-label="Remove label">&times;</button>
    </span>
  `).join('');
  container.querySelectorAll('.label-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      dialogState.labels.splice(parseInt(btn.dataset.index), 1);
      renderLabels();
    });
  });
}

async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const s = dialogState;

  if (s.issue?.id) {
    s.uploading = true;
    for (const f of files) {
      const form = new FormData();
      form.append('file', f);
      form.append('issueId', s.issue.id);
      const res = await apiFetch('/api/kanban/attachments', { method: 'POST', body: form });
      if (res.ok) {
        const att = await res.json();
        s.attachments.push(att);
      }
    }
    s.uploading = false;
    renderAttachments();
  } else {
    s.pendingFiles.push(...files);
    renderAttachments();
  }
}

async function handleSave() {
  const s = dialogState;
  if (!s || !s.title.trim() || s.saving) return;

  s.saving = true;
  const saveBtn = $('[data-action="dlg-save"]');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  if (!s.previewMode) {
    s.description = $('[data-field="dlg-desc"]')?.value ?? s.description;
  }

  const data = {
    title: s.title.trim(),
    description: s.description || undefined,
    priority: s.priority,
    columnId: s.columnId,
    dueDate: s.dueDate ? new Date(s.dueDate).toISOString() : null,
    labels: JSON.stringify(s.labels),
    type: s.type,
  };

  let savedIssue;

  try {
    if (s.issue) {
      const res = await apiFetch(`/api/kanban/issues/${s.issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      savedIssue = await res.json();
    } else {
      const res = await apiFetch('/api/kanban/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, featureId: s.featureId, columnId: s.columnId }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      savedIssue = await res.json();

      if (savedIssue.id && s.pendingFiles.length > 0) {
        for (const f of s.pendingFiles) {
          const form = new FormData();
          form.append('file', f);
          form.append('issueId', savedIssue.id);
          await apiFetch('/api/kanban/attachments', { method: 'POST', body: form });
        }
      }
    }

    s.saving = false;
    s.onSave(savedIssue);
    closeDialog();
  } catch (err) {
    s.saving = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = s.issue ? 'Save' : 'Create';
    }
    showToast('Failed to save issue: ' + err.message);
  }
}

function closeDialog() {
  revokePendingObjectURLs();
  $('.modal-overlay[data-dialog="issue"]')?.classList.add('hidden');
  if (dialogState?.onClose) dialogState.onClose();
  dialogState = null;
}

function formatEntryDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderVersionedEntries() {
  if (!dialogState) return;
  const s = dialogState;

  const renderList = (entries, selector) => {
    const container = $(selector);
    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = '<div class="versioned-entries-empty">No entries yet</div>';
      return;
    }
    container.innerHTML = [...entries].reverse().map(e => `
      <div class="versioned-entry">
        <div class="versioned-entry-header">
          <span class="badge badge-secondary">v${e.version}</span>
          <span class="versioned-entry-date">${formatEntryDate(e.createdAt)}</span>
        </div>
        <div class="versioned-entry-content markdown-preview">${sanitizeHtml(marked.parse(normalizeEscapes(e.content)))}</div>
      </div>
    `).join('');
  };

  renderList(s.reviewHistory, '[data-region="dlg-review-entries"]');
  renderList(s.workLog, '[data-region="dlg-worklog-entries"]');
}

// ── Shared Dialog HTML ───────────────────────────────────────────────────────

function _getDialogHTML() {
  return `
    <!-- New Feature Dialog -->
    <div class="modal-overlay hidden" data-dialog="new-feature" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="modal-header">
          <h2>New Feature</h2>
          <p class="modal-desc">Create a new feature with a kanban board.</p>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Name</label>
            <input type="text" data-field="nf-name" placeholder="Feature name...">
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea data-field="nf-desc" placeholder="Optional description..." rows="2"></textarea>
          </div>
          <div class="form-group">
            <label>Color</label>
            <div data-field="nf-colors" class="color-picker"></div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-action="nf-cancel">Cancel</button>
            <button class="btn btn-primary" data-action="nf-create">Create Feature</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete Feature Confirmation Dialog -->
    <div class="modal-overlay hidden" data-dialog="delete-feature" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="modal-header">
          <h2>Delete Feature</h2>
          <p class="modal-desc" data-field="delete-feature-msg"></p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-action="df-cancel">Cancel</button>
          <button class="btn btn-danger" data-action="df-confirm">Delete</button>
        </div>
      </div>
    </div>

    <!-- Delete Issue Confirmation Dialog -->
    <div class="modal-overlay hidden" data-dialog="delete-issue" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="modal-header">
          <h2>Delete Item</h2>
          <p class="modal-desc" data-field="delete-issue-msg"></p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-action="di-cancel">Cancel</button>
          <button class="btn btn-danger" data-action="di-confirm">Delete</button>
        </div>
      </div>
    </div>

    <!-- Edit Feature Dialog -->
    <div class="modal-overlay hidden" data-dialog="edit-feature" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="modal-header">
          <h2>Edit Feature</h2>
          <p class="modal-desc">Update feature details.</p>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Name</label>
            <input type="text" data-field="ef-name" placeholder="Feature name...">
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea data-field="ef-desc" placeholder="Optional description..." rows="6"></textarea>
          </div>
          <div class="form-group">
            <label>Color</label>
            <div data-field="ef-colors" class="color-picker"></div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-action="ef-cancel">Cancel</button>
            <button class="btn btn-primary" data-action="ef-save">Save Changes</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Issue Dialog (create/edit) -->
    <div class="modal-overlay hidden" data-dialog="issue" role="dialog" aria-modal="true">
      <div class="modal modal-lg">
        <!-- Populated by renderDialog() -->
      </div>
    </div>

    <!-- Image Preview Overlay -->
    <div class="image-preview-overlay hidden">
      <img src="" alt="Preview">
      <button class="image-preview-close" aria-label="Close image preview">&times;</button>
    </div>
  `;
}

// ── Route handler ────────────────────────────────────────────────────────────

let _hashHandler = null;

async function onRouteChange() {
  if (!_root) return;
  const route = getRoute();
  stopPolling();
  stopBoardPolling();

  if (route.page === 'board') {
    await renderBoard(route.featureId);
  } else {
    renderFeatureList();
    startFeaturePolling();
  }
}

// ── Visibility change handler ────────────────────────────────────────────────

function _handleVisibility() {
  if (document.hidden) {
    stopPolling();
    stopBoardPolling();
  } else {
    const route = getRoute();
    if (route.page === 'list') {
      startFeaturePolling();
    } else if (route.page === 'board' && boardFeature) {
      startBoardPolling();
    }
  }
}

// ── Voice input handler ──────────────────────────────────────────────────────

function _handleVoiceResult(e) {
  if (!_root) return;
  const text = e.detail?.text;
  if (!text) return;

  // Insert voice text into the currently focused input/textarea within the kanban container
  const active = document.activeElement;
  if (active && _root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    const start = active.selectionStart ?? active.value.length;
    const end = active.selectionEnd ?? active.value.length;
    active.value = active.value.slice(0, start) + text + active.value.slice(end);
    active.selectionStart = active.selectionEnd = start + text.length;
    active.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ── Escape key handler (close modals) ────────────────────────────────────────

function _handleEscape(e) {
  if (e.key === 'Escape') {
    $$('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    const imgPreview = $('.image-preview-overlay:not(.hidden)');
    if (imgPreview) imgPreview.classList.add('hidden');
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

export async function mount(container, ctx) {
  _root = container;
  _projectId = ctx?.project?.id || null;
  _navigate = ctx?.navigate || null;

  // 1. Scope the container
  container.classList.add('page-kanban');

  // 2. Show loading state while vendors load
  container.innerHTML = '<div class="loading">Loading...</div>';

  // 3. Load vendor libraries (SortableJS + marked.js)
  await loadVendors();

  // 4. Configure marked to escape raw HTML and neutralize dangerous URLs
  if (typeof marked !== 'undefined' && marked.use) {
    const dangerousUrlRe = /^\s*(javascript|vbscript|data)\s*:/i;
    marked.use({
      breaks: true,
      renderer: {
        html({ text }) {
          return escapeHtml(text);
        },
        link({ href, title, tokens }) {
          const text = this.parser.parseInline(tokens);
          if (dangerousUrlRe.test(href)) return text;
          const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
          return `<a href="${escapeAttr(href)}"${titleAttr}>${text}</a>`;
        },
        image({ href, title, text }) {
          if (dangerousUrlRe.test(href)) return escapeHtml(text);
          const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
          return `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}"${titleAttr}>`;
        },
      },
    });
  }

  // 5. Reset state
  features = [];
  boardFeature = null;
  searchQuery = '';
  isDragging = false;
  isDialogOpen = false;
  dialogState = null;
  sortableInstances = [];
  pendingObjectURLs = [];

  // 6. Fetch initial features
  try {
    const res = await apiFetch('/api/kanban/features');
    features = await res.json();
  } catch { features = []; }

  // 7. Bind global event listeners
  _hashHandler = onRouteChange;
  window.addEventListener('hashchange', _hashHandler);

  _visibilityHandler = _handleVisibility;
  document.addEventListener('visibilitychange', _visibilityHandler);

  _searchKeydownHandler = _handleSearchKeydown;
  document.addEventListener('keydown', _searchKeydownHandler);

  _escapeHandler = _handleEscape;
  document.addEventListener('keydown', _escapeHandler);

  _voiceHandler = _handleVoiceResult;
  document.addEventListener('voice:result', _voiceHandler);

  // 8. Render based on current route
  await onRouteChange();
}

export function unmount(container) {
  // 1. Stop all polling
  stopPolling();
  stopBoardPolling();

  // 2. Clean up SortableJS instances
  sortableInstances.forEach(s => s.destroy());
  sortableInstances = [];

  // 3. Revoke object URLs
  revokePendingObjectURLs();

  // 4. Remove event listeners
  if (_hashHandler) {
    window.removeEventListener('hashchange', _hashHandler);
    _hashHandler = null;
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }
  if (_searchKeydownHandler) {
    document.removeEventListener('keydown', _searchKeydownHandler);
    _searchKeydownHandler = null;
  }
  if (_escapeHandler) {
    document.removeEventListener('keydown', _escapeHandler);
    _escapeHandler = null;
  }
  if (_voiceHandler) {
    document.removeEventListener('voice:result', _voiceHandler);
    _voiceHandler = null;
  }

  // 5. Clear container
  container.classList.remove('page-kanban');
  container.innerHTML = '';

  // 6. Reset module state
  _root = null;
  _projectId = null;
  _navigate = null;
  features = [];
  boardFeature = null;
  dialogState = null;
  deleteTargetFeature = null;
  editTargetFeature = null;
  featureSearchQuery = '';
  featureSortBy = 'name';
}

export function onProjectChange(project) {
  // 1. Stop all polling from the previous project context
  stopPolling();
  stopBoardPolling();

  // 2. Update project ID before any fetches so apiFetch sends the new header
  _projectId = project?.id || null;

  // 3. Clear stale state from the previous project immediately
  features = [];
  boardFeature = null;
  searchQuery = '';
  featureSearchQuery = '';
  featureSortBy = 'name';
  dialogState = null;
  deleteTargetFeature = null;
  editTargetFeature = null;
  sortableInstances.forEach(s => s.destroy());
  sortableInstances = [];

  // 4. If currently on the board view, navigate back to list first.
  //    Use location.replace so the hashchange handler fires synchronously
  //    (internalNavigate would cause onRouteChange to race with our fetch below).
  if (getRoute().page === 'board') {
    // Temporarily remove the hash handler to avoid onRouteChange racing with us
    if (_hashHandler) window.removeEventListener('hashchange', _hashHandler);
    location.hash = '#/';
    if (_hashHandler) window.addEventListener('hashchange', _hashHandler);
  }

  // 5. Render the empty list view immediately (shows "No features yet" placeholder)
  renderFeatureList();

  // 6. Fetch fresh features for the new project context
  apiFetch('/api/kanban/features')
    .then(r => r.json())
    .then(fresh => {
      features = fresh;
      renderFeatures();
      startFeaturePolling();
    })
    .catch(() => {
      features = [];
      renderFeatures();
      startFeaturePolling();
    });
}
