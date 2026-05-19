// ── Prompts App — Page Module ────────────────────────────────────────
// ES module: mount(container, ctx), unmount(container), onProjectChange(project)
// Migrated to shared-ui: api helper, search bar, delete confirmation, shared CSS classes.

import { escapeHtml } from '/shared-assets/ui-utils.js';
import { createApi } from '/shared-ui/app-page.js';
import { createSearchBar, bindSearchBar } from '/shared-ui/components/search-bar.js';
import { confirmModal } from '/shared-ui/components/modal.js';
import { createHeader } from '/shared-ui/components/header.js';

let _container = null;
let _entries = [];
let _categories = [];
let _activeFilter = { category: null };
let _searchBinding = null;

const api = createApi('prompts');

// ── HTML ─────────────────────────────────────────────────────────────

const BODY_HTML = `
  ${createHeader({
    brand: 'Prompts',
    meta: '<span id="pr-count"></span>',
    actions: `
      <select id="pr-filter-category" class="filter-select" title="Filter by category">
        <option value="">All categories</option>
      </select>
      <button class="btn btn-primary" id="pr-btn-add">+ New Prompt</button>
    `,
  })}

  <main>
    <div class="content-container" id="pr-container">
      ${createSearchBar({ placeholder: 'Search prompts...', id: 'pr-search' })}
      <div class="pr-entries" id="pr-entries"></div>
    </div>
  </main>
`;

// ── Stars ────────────────────────────────────────────────────────────

function renderStars(rating) {
  if (!rating) return '';
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="pr-star${i < rating ? ' filled' : ''}">\u2605</span>`
  ).join('');
}

// ── Data loading ─────────────────────────────────────────────────────

async function loadEntries() {
  if (!_container) return;
  try {
    const params = new URLSearchParams();
    if (_activeFilter.category) params.set('category', _activeFilter.category);
    const qs = params.toString();
    const res = await api('/entries' + (qs ? '?' + qs : ''));
    if (!res.ok) throw new Error(`Failed to load prompts (${res.status})`);
    _entries = await res.json();
    _categories = [...new Set(_entries.map(e => e.category).filter(Boolean))].sort();
    renderEntries();
    updateCategoryFilter();
    updateCount();
  } catch (err) {
    console.error('[prompts] Failed to load entries:', err);
  }
}

// ── Rendering ────────────────────────────────────────────────────────

function updateCount() {
  const el = _container?.querySelector('#pr-count');
  if (el) el.textContent = `${_entries.length} prompt${_entries.length !== 1 ? 's' : ''}`;
}

function updateCategoryFilter() {
  const select = _container?.querySelector('#pr-filter-category');
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
  const search = _container?.querySelector('#pr-search')?.value?.toLowerCase() ?? '';
  if (!search) return _entries;
  return _entries.filter(e =>
    e.title.toLowerCase().includes(search) ||
    (e.description || '').toLowerCase().includes(search) ||
    (e.category || '').toLowerCase().includes(search) ||
    (e.tags || []).some(t => t.toLowerCase().includes(search))
  );
}

function renderEntries() {
  const listEl = _container?.querySelector('#pr-entries');
  if (!listEl) return;

  const filtered = getFilteredEntries();

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div style="font-size:48px;opacity:0.15">\u270E</div>
        <div>${_entries.length === 0 ? 'No prompts yet' : 'No matching prompts'}</div>
        ${_entries.length === 0 ? '<div style="font-size:var(--df-font-size-xs);color:var(--df-color-text-secondary);text-transform:none;letter-spacing:normal">Save your best prompt templates for reuse and evaluation</div>' : ''}
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
    section.className = 'group';

    const title = document.createElement('h2');
    title.className = 'group-title';
    title.textContent = category;
    const countBadge = document.createElement('span');
    countBadge.className = 'badge';
    countBadge.textContent = entries.length;
    title.appendChild(countBadge);
    section.appendChild(title);

    for (const entry of entries) {
      section.appendChild(buildEntryCard(entry));
    }

    listEl.appendChild(section);
  }
}

function buildEntryCard(entry) {
  const card = document.createElement('div');
  card.className = 'pr-entry-card';
  card.dataset.id = entry.id;

  const meta = document.createElement('div');
  meta.className = 'pr-entry-meta';

  const titleEl = document.createElement('div');
  titleEl.className = 'pr-entry-title';
  titleEl.textContent = entry.title;

  meta.appendChild(titleEl);

  if (entry.rating) {
    const starsEl = document.createElement('div');
    starsEl.className = 'pr-entry-stars';
    starsEl.innerHTML = renderStars(entry.rating);
    meta.appendChild(starsEl);
  }

  card.appendChild(meta);

  if (entry.description) {
    const descEl = document.createElement('div');
    descEl.className = 'pr-entry-desc';
    descEl.textContent = entry.description;
    card.appendChild(descEl);
  }

  const footer = document.createElement('div');
  footer.className = 'pr-entry-footer';

  const tagsEl = document.createElement('div');
  tagsEl.className = 'pr-entry-tags';
  for (const tag of (entry.tags || [])) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = tag;
    tagsEl.appendChild(badge);
  }
  footer.appendChild(tagsEl);

  const updatedEl = document.createElement('div');
  updatedEl.className = 'pr-entry-updated';
  updatedEl.textContent = new Date(entry.updatedAt).toLocaleDateString();
  footer.appendChild(updatedEl);

  card.appendChild(footer);

  const actions = document.createElement('div');
  actions.className = 'entry-actions entry-actions--hover';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-sm btn-secondary';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const res = await api('/entries/' + entry.id);
      if (!res.ok) { copyBtn.textContent = 'Error'; return; }
      const full = await res.json();
      await navigator.clipboard.writeText(full.content);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch {
      copyBtn.textContent = 'Failed';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    }
  });

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-sm btn-secondary';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openModal('edit', entry.id);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-sm btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const confirmed = await confirmModal(_container, {
      title: 'Delete Prompt',
      message: `Are you sure you want to delete <strong>${escapeHtml(entry.title)}</strong>? This cannot be undone.`,
    });
    if (confirmed) {
      const res = await api('/entries/' + entry.id, { method: 'DELETE' });
      if (!res.ok) console.error('[prompts] Failed to delete:', res.status);
      loadEntries();
    }
  });

  actions.appendChild(copyBtn);
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  card.appendChild(actions);

  return card;
}

// ── Modal ────────────────────────────────────────────────────────────

async function openModal(mode, entryId) {
  closeModal();

  let entry = null;
  if (mode === 'edit' && entryId) {
    const res = await api('/entries/' + entryId);
    if (res.ok) entry = await res.json();
  }

  const isEdit = mode === 'edit' && entry;

  const overlay = document.createElement('div');
  overlay.className = 'sui-modal-overlay';
  overlay.id = 'pr-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const modal = document.createElement('div');
  modal.className = 'sui-modal sui-modal-lg';

  modal.innerHTML = `
    <div class="sui-modal-header">
      <h2>${isEdit ? 'Edit Prompt' : 'New Prompt'}</h2>
    </div>
    <div class="sui-modal-body">
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label for="pr-m-title">Title</label>
          <input type="text" id="pr-m-title" value="${isEdit ? escapeHtml(entry.title) : ''}" placeholder="e.g. Code Review Checklist" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="pr-m-category">Category</label>
          <input type="text" id="pr-m-category" value="${isEdit && entry.category ? escapeHtml(entry.category) : ''}" placeholder="e.g. code-review" list="pr-m-category-list" autocomplete="off" />
          <datalist id="pr-m-category-list">
            ${_categories.map(c => `<option value="${escapeHtml(c)}">`).join('')}
          </datalist>
        </div>
      </div>

      <div class="form-group">
        <label for="pr-m-description">Description</label>
        <input type="text" id="pr-m-description" value="${isEdit && entry.description ? escapeHtml(entry.description) : ''}" placeholder="What does this prompt do?" autocomplete="off" />
      </div>

      <div class="form-group">
        <label for="pr-m-content">
          Prompt Content
          <span class="pr-vars-hint" id="pr-vars-hint"></span>
        </label>
        <textarea id="pr-m-content" rows="8" placeholder="Enter your prompt... use {{varName}} for variables">${isEdit ? escapeHtml(entry.content) : ''}</textarea>
        <div class="pr-vars-detected" id="pr-vars-detected"></div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="pr-m-tags">Tags <span style="text-transform:none;letter-spacing:normal;color:var(--df-color-text-muted)">(comma-separated)</span></label>
          <input type="text" id="pr-m-tags" value="${isEdit && entry.tags ? escapeHtml(entry.tags.join(', ')) : ''}" placeholder="e.g. review, refactor" autocomplete="off" />
        </div>
        <div class="form-group">
          <label for="pr-m-model">Model hint</label>
          <input type="text" id="pr-m-model" value="${isEdit && entry.model ? escapeHtml(entry.model) : ''}" placeholder="e.g. claude-opus-4-6" autocomplete="off" />
        </div>
        <div class="form-group" style="flex:0 0 100px">
          <label for="pr-m-temperature">Temperature</label>
          <input type="number" id="pr-m-temperature" value="${isEdit && entry.temperature != null ? entry.temperature : ''}" placeholder="0\u20132" min="0" max="2" step="0.1" />
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Rating</label>
          <div class="pr-rating-input" id="pr-rating-input">
            ${[1,2,3,4,5].map(n => `<button type="button" class="pr-rating-star${isEdit && entry.rating >= n ? ' active' : ''}" data-val="${n}">\u2605</button>`).join('')}
          </div>
        </div>
        <div class="form-group" style="flex:2">
          <label for="pr-m-notes">Notes</label>
          <input type="text" id="pr-m-notes" value="${isEdit && entry.notes ? escapeHtml(entry.notes) : ''}" placeholder="Evaluation notes..." autocomplete="off" />
        </div>
      </div>

      <div class="sui-modal-error" id="pr-m-error"></div>

      <div class="sui-modal-actions">
        <button class="btn btn-secondary" id="pr-m-cancel">Cancel</button>
        <button class="btn btn-primary" id="pr-m-submit">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  _container.appendChild(overlay);

  // Live variable detection
  const contentArea = document.getElementById('pr-m-content');
  const varsDetected = document.getElementById('pr-vars-detected');
  function updateVars() {
    const content = contentArea.value;
    const matches = [...content.matchAll(/\{\{([\w.-]+)\}\}/g)].map(m => m[1]);
    const unique = [...new Set(matches)];
    if (unique.length > 0) {
      varsDetected.innerHTML = 'Variables: ' + unique.map(v => `<span class="badge">${escapeHtml(v)}</span>`).join(' ');
    } else {
      varsDetected.innerHTML = '';
    }
  }
  contentArea.addEventListener('input', updateVars);
  updateVars();

  // Rating input
  let selectedRating = isEdit ? (entry.rating || 0) : 0;
  const ratingBtns = modal.querySelectorAll('.pr-rating-star');
  function updateRatingUI() {
    ratingBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.val) <= selectedRating);
    });
  }
  ratingBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.val);
      selectedRating = selectedRating === val ? 0 : val;
      updateRatingUI();
    });
    btn.addEventListener('mouseenter', () => {
      ratingBtns.forEach(b => b.classList.toggle('hover', parseInt(b.dataset.val) <= parseInt(btn.dataset.val)));
    });
    btn.addEventListener('mouseleave', () => {
      ratingBtns.forEach(b => b.classList.remove('hover'));
    });
  });

  const titleInput = document.getElementById('pr-m-title');
  requestAnimationFrame(() => titleInput.focus());

  async function handleSubmit() {
    const title = document.getElementById('pr-m-title').value.trim();
    const content = document.getElementById('pr-m-content').value.trim();
    const description = document.getElementById('pr-m-description').value.trim() || undefined;
    const category = document.getElementById('pr-m-category').value.trim() || undefined;
    const tagsRaw = document.getElementById('pr-m-tags').value.trim();
    const model = document.getElementById('pr-m-model').value.trim() || undefined;
    const tempRaw = document.getElementById('pr-m-temperature').value.trim();
    const temperature = tempRaw ? parseFloat(tempRaw) : undefined;
    const notes = document.getElementById('pr-m-notes').value.trim() || undefined;
    const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const rating = selectedRating || undefined;

    const errorEl = document.getElementById('pr-m-error');
    if (!title) { errorEl.textContent = 'Title is required'; titleInput.focus(); return; }
    if (!content) { errorEl.textContent = 'Content is required'; contentArea.focus(); return; }

    const body = { title, content, description, category, tags, model, temperature, rating, notes };

    try {
      let res;
      if (isEdit) {
        res = await api('/entries/' + entry.id, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        res = await api('/entries', { method: 'POST', body: JSON.stringify(body) });
      }
      if (!res.ok) {
        const data = await res.json();
        errorEl.textContent = data.error || 'Failed to save';
        return;
      }
      closeModal();
      loadEntries();
    } catch (err) {
      document.getElementById('pr-m-error').textContent = err.message;
    }
  }

  document.getElementById('pr-m-submit').addEventListener('click', handleSubmit);
  document.getElementById('pr-m-cancel').addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'Enter' && e.ctrlKey) handleSubmit();
  }
  document.addEventListener('keydown', onKeyDown);
  overlay._keydownHandler = onKeyDown;
}

function closeModal() {
  const existing = document.getElementById('pr-modal-overlay');
  if (existing) {
    if (existing._keydownHandler) document.removeEventListener('keydown', existing._keydownHandler);
    existing.remove();
  }
}

// ── Events ───────────────────────────────────────────────────────────

function bindEvents() {
  if (!_container) return;

  _container.querySelector('#pr-btn-add').addEventListener('click', () => openModal('add'));

  _container.querySelector('#pr-filter-category').addEventListener('change', (e) => {
    _activeFilter.category = e.target.value || null;
    loadEntries();
  });

  _searchBinding = bindSearchBar(_container, {
    id: 'pr-search',
    onSearch: () => renderEntries(),
    debounceMs: 150,
  });
}

// ── Exports ──────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
  _entries = [];
  _categories = [];
  _activeFilter = { category: null };

  container.classList.add('page-prompts', 'app-page');
  container.innerHTML = BODY_HTML;

  bindEvents();
  loadEntries();
}

export function unmount(container) {
  _searchBinding?.destroy();
  _searchBinding = null;
  closeModal();
  container.classList.remove('page-prompts', 'app-page');
  container.innerHTML = '';
  _container = null;
  _entries = [];
  _categories = [];
}

export function onProjectChange(project) {
  _activeFilter = { category: null };
  loadEntries();
}
