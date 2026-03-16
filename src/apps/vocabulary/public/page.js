// ── Vocabulary App — Page Module ─────────────────────────────────────
// ES module that exports mount(container, ctx), unmount(container),
// and onProjectChange(project).

import { escapeHtml } from '/shared-assets/ui-utils.js';

let _container = null;
let _entries = [];
let _categories = [];
let _activeFilter = { category: null, tag: null };
let _deleteTarget = null;

// ── API helpers ─────────────────────────────────────────────────────

async function api(path, opts) {
  const res = await fetch('/api/vocabulary' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res;
}

// ── HTML ────────────────────────────────────────────────────────────

const BODY_HTML = `
  <header>
    <div class="brand">Vocabulary</div>
    <div class="header-meta">
      <span id="vc-count"></span>
    </div>
    <div class="toolbar-actions">
      <select id="vc-filter-category" class="vc-filter-select" title="Filter by category">
        <option value="">All categories</option>
      </select>
      <button class="btn btn-primary" id="vc-btn-add">+ Add Term</button>
    </div>
  </header>

  <main>
    <div class="vc-container" id="vc-container">
      <div class="vc-search-bar">
        <input type="text" id="vc-search" class="vc-search-input" placeholder="Search terms..." autocomplete="off" />
      </div>
      <div class="vc-entries" id="vc-entries"></div>
    </div>
  </main>

  <!-- Delete Confirmation Dialog -->
  <div class="modal-overlay hidden" id="vc-delete-overlay" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="modal-header">
        <h2>Delete Term</h2>
        <p class="modal-desc" id="vc-delete-msg"></p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="vc-delete-cancel">Cancel</button>
        <button class="btn btn-danger" id="vc-delete-confirm">Delete</button>
      </div>
    </div>
  </div>
`;

// ── Data loading ────────────────────────────────────────────────────

async function loadEntries() {
  if (!_container) return;
  try {
    const params = new URLSearchParams();
    if (_activeFilter.category) params.set('category', _activeFilter.category);
    if (_activeFilter.tag) params.set('tag', _activeFilter.tag);
    const qs = params.toString();
    const res = await api('/entries' + (qs ? '?' + qs : ''));
    _entries = await res.json();
    _categories = [...new Set(_entries.map(e => e.category).filter(Boolean))].sort();
    renderEntries();
    updateCategoryFilter();
    updateCount();
  } catch (err) {
    console.error('[vocabulary] Failed to load entries:', err);
  }
}

// ── Rendering ───────────────────────────────────────────────────────

function updateCount() {
  const el = _container?.querySelector('#vc-count');
  if (el) el.textContent = `${_entries.length} term${_entries.length !== 1 ? 's' : ''}`;
}

function updateCategoryFilter() {
  const select = _container?.querySelector('#vc-filter-category');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">All categories</option>';
  for (const cat of _categories) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === current) opt.selected = true;
    select.appendChild(opt);
  }
}

function getFilteredEntries() {
  const search = _container?.querySelector('#vc-search')?.value?.toLowerCase() ?? '';
  if (!search) return _entries;
  return _entries.filter(e =>
    e.term.toLowerCase().includes(search) ||
    e.definition.toLowerCase().includes(search) ||
    (e.aliases || []).some(a => a.toLowerCase().includes(search)) ||
    (e.category || '').toLowerCase().includes(search)
  );
}

function renderEntries() {
  const listEl = _container?.querySelector('#vc-entries');
  if (!listEl) return;

  const filtered = getFilteredEntries();

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div style="font-size:48px;opacity:0.15">\u2261</div>
        <div>${_entries.length === 0 ? 'No vocabulary entries yet' : 'No matching entries'}</div>
        ${_entries.length === 0 ? '<div style="font-size:var(--df-font-size-xs);color:var(--df-color-text-secondary);text-transform:none;letter-spacing:normal">Add domain-specific terms so the LLM understands your shorthand</div>' : ''}
      </div>
    `;
    return;
  }

  // Group by category
  const groups = new Map();
  for (const entry of filtered) {
    const cat = entry.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(entry);
  }

  listEl.innerHTML = '';

  for (const [category, entries] of groups) {
    const section = document.createElement('section');
    section.className = 'vc-group';

    const title = document.createElement('h2');
    title.className = 'vc-group-title';
    title.textContent = category;
    const countBadge = document.createElement('span');
    countBadge.className = 'badge';
    countBadge.textContent = entries.length;
    title.appendChild(countBadge);
    section.appendChild(title);

    for (const entry of entries) {
      section.appendChild(buildEntryRow(entry));
    }

    listEl.appendChild(section);
  }
}

function buildEntryRow(entry) {
  const row = document.createElement('div');
  row.className = 'vc-entry-row';
  row.dataset.id = entry.id;

  const left = document.createElement('div');
  left.className = 'vc-entry-left';

  const termEl = document.createElement('div');
  termEl.className = 'vc-entry-term';
  termEl.textContent = entry.term;

  const defEl = document.createElement('div');
  defEl.className = 'vc-entry-def';
  defEl.textContent = entry.definition;

  left.appendChild(termEl);
  left.appendChild(defEl);

  if (entry.aliases?.length) {
    const aliasEl = document.createElement('div');
    aliasEl.className = 'vc-entry-aliases';
    aliasEl.textContent = 'aka: ' + entry.aliases.join(', ');
    left.appendChild(aliasEl);
  }

  if (entry.tags?.length) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'vc-entry-tags';
    for (const tag of entry.tags) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = tag;
      tagsEl.appendChild(badge);
    }
    left.appendChild(tagsEl);
  }

  const actions = document.createElement('div');
  actions.className = 'vc-entry-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-sm btn-secondary';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openModal('edit', entry);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-sm btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDeleteDialog(entry);
  });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  row.appendChild(left);
  row.appendChild(actions);

  return row;
}

// ── Delete confirmation dialog ──────────────────────────────────────

function openDeleteDialog(entry) {
  _deleteTarget = entry;
  const overlay = _container?.querySelector('#vc-delete-overlay');
  if (!overlay) return;
  const msg = overlay.querySelector('#vc-delete-msg');
  if (msg) msg.innerHTML = `Are you sure you want to delete <strong>${escapeHtml(entry.term)}</strong>? This action cannot be undone.`;
  overlay.classList.remove('hidden');
}

function closeDeleteDialog() {
  _deleteTarget = null;
  _container?.querySelector('#vc-delete-overlay')?.classList.add('hidden');
}

function bindDeleteDialog() {
  const overlay = _container?.querySelector('#vc-delete-overlay');
  if (!overlay) return;

  overlay.querySelector('#vc-delete-cancel').addEventListener('click', closeDeleteDialog);

  overlay.querySelector('#vc-delete-confirm').addEventListener('click', async () => {
    if (!_deleteTarget) return;
    await api('/entries/' + _deleteTarget.id, { method: 'DELETE' });
    closeDeleteDialog();
    loadEntries();
  });
}

// ── Modal ───────────────────────────────────────────────────────────

function openModal(mode, entry) {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'vc-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const isEdit = mode === 'edit';
  const title = isEdit ? 'Edit Term' : 'Add Term';
  const submitLabel = isEdit ? 'Save' : 'Add';

  modal.innerHTML = `
    <div class="modal-header">
      <h2>${title}</h2>
      <p class="modal-desc">${isEdit ? 'Update term details.' : 'Add a domain-specific term for LLM context.'}</p>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label for="vc-m-term">Term</label>
        <input type="text" id="vc-m-term" value="${isEdit ? escapeHtml(entry.term) : ''}" placeholder="e.g. PR, LGTM, K8s" autocomplete="off" />
      </div>

      <div class="form-group">
        <label for="vc-m-definition">Definition</label>
        <textarea id="vc-m-definition" rows="3" placeholder="What this term means in your domain...">${isEdit ? escapeHtml(entry.definition) : ''}</textarea>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="vc-m-category">Category</label>
          <input type="text" id="vc-m-category" value="${isEdit && entry.category ? escapeHtml(entry.category) : ''}" placeholder="e.g. API, Database" list="vc-m-category-list" autocomplete="off" />
          <datalist id="vc-m-category-list">
            ${_categories.map(c => `<option value="${escapeHtml(c)}">`).join('')}
          </datalist>
        </div>

        <div class="form-group">
          <label for="vc-m-aliases">Aliases <span style="text-transform:none;letter-spacing:normal;color:var(--df-color-text-muted)">(comma-separated)</span></label>
          <input type="text" id="vc-m-aliases" value="${isEdit && entry.aliases ? escapeHtml(entry.aliases.join(', ')) : ''}" placeholder="e.g. pull request, merge request" autocomplete="off" />
        </div>
      </div>

      <div class="form-group">
        <label for="vc-m-tags">Tags <span style="text-transform:none;letter-spacing:normal;color:var(--df-color-text-muted)">(comma-separated)</span></label>
        <input type="text" id="vc-m-tags" value="${isEdit && entry.tags ? escapeHtml(entry.tags.join(', ')) : ''}" placeholder="e.g. git, review, workflow" autocomplete="off" />
      </div>

      <div class="vc-modal-error" id="vc-m-error"></div>

      <div class="modal-actions">
        <button class="btn btn-secondary" id="vc-m-cancel">Cancel</button>
        <button class="btn btn-primary" id="vc-m-submit">${submitLabel}</button>
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const termInput = document.getElementById('vc-m-term');
  requestAnimationFrame(() => termInput.focus());

  async function handleSubmit() {
    const term = document.getElementById('vc-m-term').value.trim();
    const definition = document.getElementById('vc-m-definition').value.trim();
    const category = document.getElementById('vc-m-category').value.trim() || undefined;
    const aliasesRaw = document.getElementById('vc-m-aliases').value.trim();
    const tagsRaw = document.getElementById('vc-m-tags').value.trim();

    const aliases = aliasesRaw ? aliasesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    const errorEl = document.getElementById('vc-m-error');

    if (!term) { errorEl.textContent = 'Term is required'; termInput.focus(); return; }
    if (!definition) { errorEl.textContent = 'Definition is required'; document.getElementById('vc-m-definition').focus(); return; }

    try {
      if (isEdit) {
        const res = await api('/entries/' + entry.id, {
          method: 'PUT',
          body: JSON.stringify({ term, definition, category, aliases, tags }),
        });
        if (!res.ok) {
          const data = await res.json();
          errorEl.textContent = data.error || 'Failed to update';
          return;
        }
      } else {
        const res = await api('/entries', {
          method: 'POST',
          body: JSON.stringify({ term, definition, category, aliases, tags }),
        });
        if (!res.ok) {
          const data = await res.json();
          errorEl.textContent = data.error || 'Failed to add';
          return;
        }
      }
      closeModal();
      loadEntries();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  document.getElementById('vc-m-submit').addEventListener('click', handleSubmit);
  document.getElementById('vc-m-cancel').addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'Enter' && e.ctrlKey) handleSubmit();
  }
  document.addEventListener('keydown', onKeyDown);
  overlay._keydownHandler = onKeyDown;
}

function closeModal() {
  const existing = document.getElementById('vc-modal-overlay');
  if (existing) {
    if (existing._keydownHandler) {
      document.removeEventListener('keydown', existing._keydownHandler);
    }
    existing.remove();
  }
}

// ── Event binding ───────────────────────────────────────────────────

function bindEvents() {
  if (!_container) return;

  _container.querySelector('#vc-btn-add').addEventListener('click', () => openModal('add'));

  _container.querySelector('#vc-filter-category').addEventListener('change', (e) => {
    _activeFilter.category = e.target.value || null;
    loadEntries();
  });

  let searchTimer;
  _container.querySelector('#vc-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderEntries, 150);
  });

  bindDeleteDialog();
}

// ── Exports ─────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
  _entries = [];
  _categories = [];
  _activeFilter = { category: null, tag: null };

  container.classList.add('page-vocabulary');
  container.innerHTML = BODY_HTML;

  bindEvents();
  loadEntries();
}

export function unmount(container) {
  closeModal();
  container.classList.remove('page-vocabulary');
  container.innerHTML = '';
  _container = null;
  _entries = [];
  _categories = [];
  _deleteTarget = null;
}

export function onProjectChange(project) {
  _activeFilter = { category: null, tag: null };
  loadEntries();
}
