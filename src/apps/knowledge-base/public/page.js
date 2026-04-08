// ── Knowledge Base — Page Module ──────────────────────────────────────
// ES module: mount(container, ctx), unmount(container)
//
// Three-pane layout:
//   left   — folder tree (inbox/, notes/ and their subfolders)
//   middle — note list for the selected folder  (flips to source drill-down when a wiki is selected)
//   right  — markdown viewer/editor for the selected note  (Rendered / Source / History tabs for wikis)
//
// KB v2 (Phase 4): adds the Build wiki / Build history toolbar actions, the
// build modal + proposal review panel, kind/status badges in the tree and
// list, citation-aware markdown rendering, and the build history drawer with
// per-run revert. All new UI is additive — v1 notes and flows still work
// exactly as before.

import { escapeHtml } from '/shared-assets/ui-utils.js';
import { showModal, confirmModal, promptModal } from '/shared-ui/components/modal.js';
import { showToast, clearToasts } from '/shared-ui/components/toast.js';

const API = '/api/knowledge-base';

let _container = null;
let _state = null;

function init() {
  return {
    folderPath: '',
    notes: [],
    folders: [],
    selectedNoteId: null,
    selectedNote: null,
    dirty: false,
    searchHits: null,
    searchQuery: '',
    // v2: editor tab for wiki pages (rendered | source | history)
    editorTab: 'rendered',
    // v2: cached history for the currently selected wiki
    wikiHistory: null,
  };
}

// ── HTML scaffolding ──────────────────────────────────────────────────

const PAGE_HTML = `
<div class="kb-shell">
  <div class="kb-toolbar">
    <span class="kb-brand">Knowledge Base</span>
    <div class="kb-toolbar-spacer"></div>
    <input type="search" id="kb-search-input" class="kb-search" placeholder="Search notes…" />
    <button class="kb-btn" id="kb-btn-search">Search</button>
    <button class="kb-btn" id="kb-btn-clear-search" hidden>Clear</button>
    <button class="kb-btn kb-btn-primary" id="kb-btn-new">+ New note</button>
    <button class="kb-btn" id="kb-btn-import">Import pipe</button>
    <button class="kb-btn kb-btn-accent" id="kb-btn-build" title="Compose a wiki page from selected raw notes">Compose wiki</button>
    <button class="kb-btn" id="kb-btn-history" title="Legacy build history" hidden>History</button>
  </div>
  <div class="kb-body">
    <aside class="kb-tree" id="kb-tree" aria-label="Folder tree"></aside>
    <section class="kb-list" id="kb-list" aria-label="Note list"></section>
    <section class="kb-editor" id="kb-editor" aria-label="Note editor"></section>
  </div>
</div>
`;

// ── HTTP helpers ──────────────────────────────────────────────────────

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* tolerate empty */ }
  if (!res.ok) {
    const msg = (body && body.error) || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = body?.code;
    err.body = body;
    throw err;
  }
  return body;
}

// Toast surrogate — delegates to the shared toast component so KB matches the
// rest of the dashboard (kanban / workflow / vocabulary / prompts). The kind
// passed in is mapped to the shared toast type taxonomy: 'ok' → 'success',
// 'error' → 'error', anything else → 'info'.
function setStatus(msg, kind) {
  if (!_container || !msg) return;
  const type = kind === 'ok' ? 'success' : kind === 'error' ? 'error' : 'info';
  showToast(_container, msg, type);
}

// ── Tree ──────────────────────────────────────────────────────────────

async function loadTree() {
  // Walk the root and the two top-level folders. Lazy-expand subfolders on click.
  const root = await jsonFetch(`${API}/walk?path=`);
  const tree = { name: '/', path: '', folders: root.folders ?? [], expanded: true, children: [] };
  for (const folder of tree.folders) {
    tree.children.push({
      name: folder,
      path: folder,
      expanded: false,
      loaded: false,
      folders: [],
      children: [],
    });
  }
  return tree;
}

async function expandNode(node) {
  if (node.loaded) return;
  const data = await jsonFetch(`${API}/walk?path=${encodeURIComponent(node.path)}`);
  node.folders = data.folders ?? [];
  node.children = (data.folders ?? []).map((name) => ({
    name,
    path: node.path ? `${node.path}/${name}` : name,
    expanded: false,
    loaded: false,
    folders: [],
    children: [],
  }));
  node.loaded = true;
}

function renderTree(tree) {
  const el = _container?.querySelector('#kb-tree');
  if (!el) return;
  el.replaceChildren();
  el.appendChild(buildTreeNode(tree));
}

function buildTreeNode(node) {
  const wrapper = document.createElement('div');
  wrapper.className = 'kb-tree-node';
  const row = document.createElement('div');
  row.className = 'kb-tree-row';
  if (node.path === _state.folderPath) row.classList.add('selected');

  if (node.children.length > 0 || !node.loaded) {
    const toggle = document.createElement('button');
    toggle.className = 'kb-tree-toggle';
    toggle.type = 'button';
    toggle.textContent = node.expanded ? '\u25BE' : '\u25B8';
    toggle.setAttribute('aria-label', node.expanded ? 'Collapse' : 'Expand');
    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!node.expanded) {
        await expandNode(node);
      }
      node.expanded = !node.expanded;
      renderTree(_state.tree);
    });
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'kb-tree-toggle-spacer';
    row.appendChild(spacer);
  }

  const label = document.createElement('button');
  label.className = 'kb-tree-label';
  label.type = 'button';
  label.textContent = node.name === '/' ? '(root)' : node.name;
  label.addEventListener('click', async () => {
    if (!node.loaded) await expandNode(node);
    node.expanded = true;
    _state.folderPath = node.path;
    await loadList();
    renderTree(_state.tree);
  });
  row.appendChild(label);
  wrapper.appendChild(row);

  if (node.expanded && node.children.length > 0) {
    const children = document.createElement('div');
    children.className = 'kb-tree-children';
    for (const child of node.children) {
      children.appendChild(buildTreeNode(child));
    }
    wrapper.appendChild(children);
  }
  return wrapper;
}

// ── Note list ─────────────────────────────────────────────────────────

async function loadList() {
  if (_state.searchHits) {
    renderList(_state.searchHits.map((h) => h.note), `Search: ${_state.searchQuery}`);
    return;
  }
  // Use walk() rather than list({path}) so the middle pane shows only the
  // *direct* children of the selected folder, not the recursive prefix tree.
  // This preserves the memory-palace hierarchy (clicking a parent folder must
  // not flatten its descendants into the same view). walk() also already
  // excludes `_index.md` from children, which is what we want here.
  const data = await jsonFetch(`${API}/walk?path=${encodeURIComponent(_state.folderPath)}`);
  _state.notes = data.children ?? [];
  renderList(_state.notes, _state.folderPath || '(root)');
}

function renderList(notes, header) {
  const el = _container?.querySelector('#kb-list');
  if (!el) return;
  el.replaceChildren();

  const headerEl = document.createElement('div');
  headerEl.className = 'kb-list-header';
  headerEl.textContent = header;
  el.appendChild(headerEl);

  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'kb-list-empty';
    empty.textContent = 'No notes here yet';
    el.appendChild(empty);
    return;
  }

  for (const note of notes) {
    const item = document.createElement('button');
    item.className = 'kb-list-item';
    item.type = 'button';
    if (note.id === _state.selectedNoteId) item.classList.add('selected');

    const titleRow = document.createElement('div');
    titleRow.className = 'kb-list-item-title-row';

    // v2: kind icon before the title so wiki/raw/index are visually distinct
    const icon = document.createElement('span');
    icon.className = 'kb-note-icon';
    icon.textContent = iconForKind(note.kind, note.slug);
    icon.title = note.kind ?? (note.slug === '_index' ? 'index' : 'raw');
    titleRow.appendChild(icon);

    const title = document.createElement('div');
    title.className = 'kb-list-item-title';
    title.textContent = note.title;
    titleRow.appendChild(title);

    // v2: build-status badge for wiki pages (published / draft / stale)
    if (note.buildStatus) {
      const badge = document.createElement('span');
      badge.className = `kb-badge kb-badge-${note.buildStatus}`;
      badge.textContent = note.buildStatus;
      titleRow.appendChild(badge);
    }
    item.appendChild(titleRow);

    const meta = document.createElement('div');
    meta.className = 'kb-list-item-meta';
    const tags = (note.tags ?? []).join(', ');
    meta.textContent = `${note.path}${tags ? ' • ' + tags : ''}`;
    item.appendChild(meta);

    item.addEventListener('click', () => loadNote(note.id));
    el.appendChild(item);
  }
}

/**
 * v2: map a note's `kind` (or derived default) to a visual icon for the
 * tree and list rendering. Kept as plain text glyphs so the UI stays
 * dependency-free; the shared-ui styles handle sizing/alignment.
 */
function iconForKind(kind, slug) {
  const effective = kind ?? (slug === '_index' ? 'index' : 'raw');
  if (effective === 'wiki') return '📖';
  if (effective === 'index') return '🏠';
  return '📄'; // raw
}

// ── Editor ────────────────────────────────────────────────────────────

async function loadNote(id) {
  if (_state.dirty) {
    const ok = await confirmModal(_container, {
      title: 'Discard changes?',
      message: 'You have unsaved changes in the current note. Switching notes will discard them.',
      confirmLabel: 'Discard',
      confirmCls: 'btn-danger',
    });
    if (!ok) return;
  }
  try {
    const data = await jsonFetch(`${API}/notes/${encodeURIComponent(id)}`);
    _state.selectedNote = data.note;
    _state.selectedNoteId = id;
    _state.dirty = false;
    // v2: reset per-wiki transient state on note switch
    _state.wikiHistory = null;
    const effectiveKind = data.note.kind ?? (data.note.slug === '_index' ? 'index' : 'raw');
    if (effectiveKind === 'wiki') {
      _state.editorTab = 'rendered';
    } else {
      _state.editorTab = 'source';
    }
    renderEditor();
    renderList(_state.searchHits ? _state.searchHits.map((h) => h.note) : _state.notes,
               _state.searchHits ? `Search: ${_state.searchQuery}` : (_state.folderPath || '(root)'));
  } catch (err) {
    setStatus(`Failed to load note: ${err.message}`, 'error');
  }
}

function renderEditor() {
  const el = _container?.querySelector('#kb-editor');
  if (!el) return;
  el.replaceChildren();
  if (!_state.selectedNote) {
    const placeholder = document.createElement('div');
    placeholder.className = 'kb-editor-empty';
    placeholder.textContent = 'Select a note to view or edit';
    el.appendChild(placeholder);
    return;
  }

  const note = _state.selectedNote;
  const effectiveKind = note.kind ?? (note.slug === '_index' ? 'index' : 'raw');
  const isWiki = effectiveKind === 'wiki';

  const header = document.createElement('div');
  header.className = 'kb-editor-header';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'kb-editor-title';
  titleInput.value = note.title;
  titleInput.addEventListener('input', () => { _state.dirty = true; });
  header.appendChild(titleInput);

  // v2: kind + buildStatus badges in the header so the mode is always clear
  const headerBadges = document.createElement('div');
  headerBadges.className = 'kb-editor-header-badges';
  const kindBadge = document.createElement('span');
  kindBadge.className = `kb-badge kb-badge-${effectiveKind}`;
  kindBadge.textContent = `${iconForKind(note.kind, note.slug)} ${effectiveKind}`;
  headerBadges.appendChild(kindBadge);
  if (note.buildStatus) {
    const statusBadge = document.createElement('span');
    statusBadge.className = `kb-badge kb-badge-${note.buildStatus}`;
    statusBadge.textContent = note.buildStatus;
    headerBadges.appendChild(statusBadge);
  }
  if (isWiki && (note.sourceRefs ?? []).length > 0) {
    const rebuildBtn = document.createElement('button');
    rebuildBtn.className = 'kb-btn kb-btn-accent kb-btn-tiny';
    rebuildBtn.type = 'button';
    rebuildBtn.textContent = 'Rebuild';
    rebuildBtn.addEventListener('click', () => rebuildComposedWiki(note.id));
    headerBadges.appendChild(rebuildBtn);
  }
  header.appendChild(headerBadges);

  const meta = document.createElement('div');
  meta.className = 'kb-editor-meta';
  const tagsList = (note.tags ?? []).join(', ');
  meta.textContent = `${note.path}/${note.slug}.md  •  ${note.id}${tagsList ? '  •  [' + tagsList + ']' : ''}${note.source ? '  •  ' + note.source : ''}`;
  header.appendChild(meta);
  el.appendChild(header);

  // v2: editor tab strip for wiki pages (Rendered / Source / History).
  // Raw notes and index pages use the v1 single-textarea editor unchanged.
  if (isWiki) {
    const tabs = document.createElement('div');
    tabs.className = 'kb-editor-tabs';
    const tabDefs = [
      { key: 'rendered', label: 'Rendered' },
      { key: 'source', label: 'Source' },
      { key: 'history', label: 'History' },
    ];
    for (const def of tabDefs) {
      const btn = document.createElement('button');
      btn.className = `kb-editor-tab${_state.editorTab === def.key ? ' selected' : ''}`;
      btn.type = 'button';
      btn.textContent = def.label;
      btn.addEventListener('click', () => {
        _state.editorTab = def.key;
        renderEditor();
        if (def.key === 'history' && !_state.wikiHistory) loadWikiHistory(note.id);
      });
      tabs.appendChild(btn);
    }
    el.appendChild(tabs);
  } else {
    // Non-wiki notes always land on the source tab.
    _state.editorTab = 'source';
  }

  // Route rendering based on the active tab. All branches still get the
  // Promote/Delete action bar at the end; only the Source tab renders the
  // textarea + Save button.
  const showSourceEditor = !isWiki || _state.editorTab === 'source';

  if (isWiki && _state.editorTab === 'rendered') {
    const rendered = document.createElement('div');
    rendered.className = 'kb-editor-rendered';
    rendered.innerHTML = renderMarkdownWithCitations(note.body ?? '', note.sourceRefs ?? []);
    // Citation jump-to-source: click any [^kb_id] footnote to load the source.
    rendered.addEventListener('click', (e) => {
      const target = e.target.closest('[data-kb-cite]');
      if (target && target.dataset.kbCite) {
        e.preventDefault();
        loadNote(target.dataset.kbCite);
      }
    });
    el.appendChild(rendered);

    // Sources panel below the rendered view for easy drill-down access.
    if ((note.sourceRefs ?? []).length > 0) {
      renderSourcesPanel(el, note);
    }
  } else if (isWiki && _state.editorTab === 'history') {
    const historyEl = document.createElement('div');
    historyEl.className = 'kb-editor-history';
    if (!_state.wikiHistory) {
      historyEl.textContent = 'Loading history…';
    } else if (_state.wikiHistory.length === 0) {
      historyEl.textContent = 'No build runs have touched this page yet.';
    } else {
      for (const entry of _state.wikiHistory) {
        const row = document.createElement('div');
        row.className = 'kb-history-row';
        const label = document.createElement('div');
        label.className = 'kb-history-label';
        label.textContent = `${entry.runId}  •  ${entry.startedAt}  •  ${entry.trigger}${entry.reverted ? '  •  (reverted)' : ''}`;
        row.appendChild(label);
        if (!entry.reverted) {
          const revertBtn = document.createElement('button');
          revertBtn.className = 'kb-btn kb-btn-danger kb-btn-tiny';
          revertBtn.type = 'button';
          revertBtn.textContent = 'Revert';
          revertBtn.addEventListener('click', () => revertBuildRun(entry.runId));
          row.appendChild(revertBtn);
        }
        historyEl.appendChild(row);
      }
    }
    el.appendChild(historyEl);
  }

  // Source-mode editable fields. In rendered/history tabs these are skipped.
  let textarea = null;
  let tagsInput = null;
  if (showSourceEditor) {
    const tagsRow = document.createElement('div');
    tagsRow.className = 'kb-editor-tags-row';
    const tagsLabel = document.createElement('label');
    tagsLabel.textContent = 'Tags (comma-separated)';
    tagsLabel.className = 'kb-editor-tags-label';
    tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.className = 'kb-editor-tags-input';
    tagsInput.value = (note.tags ?? []).join(', ');
    tagsInput.addEventListener('input', () => { _state.dirty = true; });
    tagsRow.appendChild(tagsLabel);
    tagsRow.appendChild(tagsInput);
    el.appendChild(tagsRow);

    textarea = document.createElement('textarea');
    textarea.className = 'kb-editor-textarea';
    textarea.value = note.body ?? '';
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => { _state.dirty = true; });
    el.appendChild(textarea);
  }

  const actions = document.createElement('div');
  actions.className = 'kb-editor-actions';

  if (showSourceEditor && textarea && tagsInput) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'kb-btn kb-btn-primary';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      try {
        const payload = {
          title: titleInput.value.trim(),
          content: textarea.value,
          tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
        };
        const data = await jsonFetch(`${API}/notes/${encodeURIComponent(note.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        _state.selectedNote = data.note;
        _state.dirty = false;
        setStatus('Saved', 'ok');
        await loadList();
        renderEditor();
      } catch (err) {
        setStatus(`Save failed: ${err.message}`, 'error');
      }
    });
    actions.appendChild(saveBtn);
  }

  const promoteBtn = document.createElement('button');
  promoteBtn.className = 'kb-btn';
  promoteBtn.type = 'button';
  promoteBtn.textContent = 'Promote';
  promoteBtn.addEventListener('click', async () => {
    const target = await promptModal(_container, {
      title: 'Promote note',
      message: `Move <strong>${escapeHtml(note.title)}</strong> into the curated tree.`,
      label: 'Target folder',
      defaultValue: note.path.startsWith('inbox') ? 'notes/' : note.path,
      placeholder: 'notes/topic',
      confirmLabel: 'Promote',
      confirmCls: 'btn-primary',
    });
    if (!target) return;
    try {
      const data = await jsonFetch(`${API}/notes/${encodeURIComponent(note.id)}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: target }),
      });
      _state.selectedNote = data.note;
      _state.folderPath = data.note.path;
      setStatus(`Promoted to ${data.note.path}`, 'ok');
      _state.tree = await loadTree();
      renderTree(_state.tree);
      await loadList();
      renderEditor();
    } catch (err) {
      setStatus(`Promote failed: ${err.message}`, 'error');
    }
  });
  actions.appendChild(promoteBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'kb-btn kb-btn-danger';
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    const ok = await confirmModal(_container, {
      title: 'Delete Note',
      message: `Are you sure you want to delete <strong>${escapeHtml(note.title)}</strong>? This action cannot be undone.`,
      confirmLabel: 'Delete',
      confirmCls: 'btn-danger',
    });
    if (!ok) return;
    try {
      await jsonFetch(`${API}/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
      _state.selectedNote = null;
      _state.selectedNoteId = null;
      setStatus('Deleted', 'ok');
      await loadList();
      renderEditor();
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`, 'error');
    }
  });
  actions.appendChild(deleteBtn);

  el.appendChild(actions);
}

// ── Top-bar actions ───────────────────────────────────────────────────

async function runSearch() {
  const input = _container?.querySelector('#kb-search-input');
  const q = input?.value?.trim() ?? '';
  if (!q) {
    clearSearch();
    return;
  }
  try {
    const data = await jsonFetch(`${API}/search?q=${encodeURIComponent(q)}`);
    _state.searchHits = data.hits ?? [];
    _state.searchQuery = q;
    _container.querySelector('#kb-btn-clear-search').hidden = false;
    renderList(_state.searchHits.map((h) => h.note), `Search: ${q} (${_state.searchHits.length})`);
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, 'error');
  }
}

async function clearSearch() {
  _state.searchHits = null;
  _state.searchQuery = '';
  const input = _container?.querySelector('#kb-search-input');
  if (input) input.value = '';
  _container.querySelector('#kb-btn-clear-search').hidden = true;
  await loadList();
}

async function newNote() {
  const raw = await promptModal(_container, {
    title: 'New note',
    label: 'Title',
    defaultValue: '',
    placeholder: 'Untitled',
    confirmLabel: 'Create',
    confirmCls: 'btn-primary',
  });
  const title = raw?.trim();
  if (!title) return;
  try {
    const data = await jsonFetch(`${API}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        content: `# ${title}\n\n`,
        path: _state.folderPath || 'inbox',
        source: 'manual',
      }),
    });
    setStatus('Created', 'ok');
    await loadList();
    await loadNote(data.note.id);
  } catch (err) {
    setStatus(`Create failed: ${err.message}`, 'error');
  }
}

async function importPipe() {
  const raw = await promptModal(_container, {
    title: 'Import pipe transcript',
    message: 'Pull a chat pipe transcript into <code>inbox/</code> as a markdown digest.',
    label: 'Pipe id',
    defaultValue: '',
    placeholder: '#pipe-abc123, pipe-abc123, or just abc123',
    confirmLabel: 'Import',
    confirmCls: 'btn-primary',
  });
  const pipeId = raw?.trim();
  if (!pipeId) return;
  try {
    const data = await jsonFetch(`${API}/import-pipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeId }),
    });
    setStatus(`Imported pipe → ${data.note.title}`, 'ok');
    _state.folderPath = 'inbox';
    await loadList();
    await loadNote(data.note.id);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, 'error');
  }
}

// ── Draft persistence ─────────────────────────────────────────────────
// The shell unmounts pages without confirmation, so unsaved edits would be
// silently lost on sidebar navigation. To avoid that, we always persist dirty
// edits to localStorage on unmount and offer to restore them on next mount.

const DRAFT_KEY = 'kb:draft';

function readEditorFields() {
  if (!_container) return null;
  const titleEl = _container.querySelector('.kb-editor-title');
  const tagsEl = _container.querySelector('.kb-editor-tags-input');
  const bodyEl = _container.querySelector('.kb-editor-textarea');
  if (!titleEl || !bodyEl) return null;
  return {
    title: titleEl.value,
    tags: tagsEl ? tagsEl.value : '',
    body: bodyEl.value,
  };
}

function saveDraftToLocalStorage() {
  if (!_state?.dirty || !_state?.selectedNote) return;
  const fields = readEditorFields();
  if (!fields) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      noteId: _state.selectedNote.id,
      title: fields.title,
      tags: fields.tags,
      body: fields.body,
      savedAt: new Date().toISOString(),
    }));
  } catch { /* localStorage may be disabled */ }
}

async function maybeRestoreDraft() {
  let raw;
  try { raw = localStorage.getItem(DRAFT_KEY); } catch { return; }
  if (!raw) return;
  let draft;
  try { draft = JSON.parse(raw); } catch { localStorage.removeItem(DRAFT_KEY); return; }
  if (!draft?.noteId) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    return;
  }
  const ok = await confirmModal(_container, {
    title: 'Restore draft?',
    message: `You have an unsaved Knowledge Base draft for <strong>${escapeHtml(draft.title || '(untitled)')}</strong> saved at <em>${escapeHtml(draft.savedAt || '')}</em>. Restore it?`,
    confirmLabel: 'Restore',
    confirmCls: 'btn-primary',
  });
  if (!ok) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    return;
  }
  try {
    await loadNote(draft.noteId);
    // Navigate the surrounding chrome to the restored note's folder so the
    // tree, list, and editor stay coherent (the draft might belong to a
    // different folder than whatever was on screen at unmount time).
    if (_state.selectedNote && _state.selectedNote.path !== _state.folderPath) {
      _state.folderPath = _state.selectedNote.path;
      try {
        await expandAncestorsTo(_state.folderPath);
        renderTree(_state.tree);
      } catch { /* tree refresh is best-effort */ }
      await loadList();
    }
    const fields = readEditorFields();
    if (fields) {
      const title = _container.querySelector('.kb-editor-title');
      const tags = _container.querySelector('.kb-editor-tags-input');
      const body = _container.querySelector('.kb-editor-textarea');
      if (title) title.value = draft.title;
      if (tags) tags.value = draft.tags;
      if (body) body.value = draft.body;
      _state.dirty = true;
      setStatus('Draft restored — Save to persist', 'ok');
    }
  } catch (err) {
    setStatus(`Could not restore draft: ${err.message}`, 'error');
  } finally {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }
}

/**
 * Expand the tree along the chain of folders that lead to `targetPath`,
 * lazy-loading each level via `walk()`. Used by draft restore so the tree
 * does not look detached from the editor's current note.
 */
async function expandAncestorsTo(targetPath) {
  if (!targetPath || !_state?.tree) return;
  const segments = targetPath.split('/').filter(Boolean);
  let cursor = _state.tree;
  let prefix = '';
  for (const seg of segments) {
    if (!cursor.loaded) {
      await expandNode(cursor);
    }
    cursor.expanded = true;
    prefix = prefix ? `${prefix}/${seg}` : seg;
    const next = cursor.children.find((c) => c.path === prefix);
    if (!next) break;
    cursor = next;
  }
  if (cursor && !cursor.loaded) await expandNode(cursor);
  if (cursor) cursor.expanded = true;
}

// ── KB v2: Rendered-mode markdown + citations ─────────────────────────
//
// Phase 4 doesn't pull in a full markdown renderer — the KB stays
// dependency-light. This minimal renderer handles the subset of markdown
// the builder synthesizes (headers, paragraphs, lists, inline emphasis,
// and — most importantly — `[^kb_id]` footnote citations). Citations get
// wrapped in a `<sup class="kb-citation" data-kb-cite="kb_id">` span so
// the click handler in `renderEditor` can open the source.

/**
 * Render markdown with KB citations into sanitized HTML. Accepts a body
 * string and a sourceRefs array; only citations pointing at ids in
 * `sourceRefs` are rendered as jump links (unknown citations render as
 * plain text so broken wikis don't throw).
 */
export function renderMarkdownWithCitations(body, sourceRefs = []) {
  const refSet = new Set(sourceRefs);
  // Parse the body line-by-line into block-level HTML. We escape everything
  // first, then apply inline transforms (bold / italic / code / citation).
  const lines = (body ?? '').split('\n');
  const out = [];
  let i = 0;
  let listOpen = false;

  const flushList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  const renderInline = (raw) => {
    let s = escapeHtml(raw);
    // Inline code (single backticks)
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold + italic
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Citations: `[^kb_abc123]`. Cross-reference against sourceRefs so the
    // click handler has a guaranteed-resolvable target.
    s = s.replace(/\[\^(kb_[a-z0-9_]+)\]/g, (_m, id) => {
      if (refSet.has(id)) {
        return `<sup class="kb-citation" data-kb-cite="${escapeHtml(id)}">[${escapeHtml(id.slice(0, 10))}]</sup>`;
      }
      return `<sup class="kb-citation kb-citation-broken" title="source not in sourceRefs">[${escapeHtml(id)}]</sup>`;
    });
    return s;
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++; continue;
    }
    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${renderInline(line.replace(/^[-*]\s+/, ''))}</li>`);
      i++; continue;
    }
    // Blank line
    if (line.trim() === '') {
      flushList();
      i++; continue;
    }
    // Default: paragraph. Collect consecutive non-blank non-list non-header lines.
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i]?.trim() !== '' && !/^(#{1,6}\s|[-*]\s)/.test(lines[i] ?? '')) {
      paraLines.push(lines[i] ?? '');
      i++;
    }
    flushList();
    out.push(`<p>${paraLines.map(renderInline).join(' ')}</p>`);
  }
  flushList();
  return out.join('\n');
}

/**
 * Render the "sources" panel below a wiki's rendered view. Lists each
 * cited source by title with click-to-open behavior.
 */
function renderSourcesPanel(container, note) {
  const panel = document.createElement('div');
  panel.className = 'kb-sources-panel';

  const header = document.createElement('div');
  header.className = 'kb-sources-header';
  header.textContent = `Sources (${note.sourceRefs.length})`;
  panel.appendChild(header);

  for (const srcId of note.sourceRefs) {
    const row = document.createElement('button');
    row.className = 'kb-source-row';
    row.type = 'button';
    row.textContent = srcId; // we don't block-fetch every source body on render
    row.title = `Open source ${srcId}`;
    row.addEventListener('click', () => loadNote(srcId));
    panel.appendChild(row);
  }
  container.appendChild(panel);
}

/**
 * Load the build history for the current wiki into state. Filters
 * `/build/history` server-side summaries by `committedWikis.includes(wikiId)`
 * — Phase 4 review fix #3 (codex-2). Phase 3 added `committedWikis` to the
 * `BuildRunSummary` type so this filter is O(N) over the summary list with
 * no additional roundtrips.
 */
async function loadWikiHistory(wikiId) {
  try {
    const data = await jsonFetch(`${API}/build/history?limit=200`);
    const runs = (data.runs ?? []).filter((r) =>
      Array.isArray(r.committedWikis) && r.committedWikis.includes(wikiId),
    );
    _state.wikiHistory = runs.map((r) => ({
      runId: r.runId,
      startedAt: r.startedAt,
      trigger: r.trigger,
      reverted: r.reverted,
    }));
    if (_state.selectedNoteId === wikiId) renderEditor();
  } catch (err) {
    setStatus(`Failed to load history: ${err.message}`, 'error');
    _state.wikiHistory = [];
    if (_state.selectedNoteId === wikiId) renderEditor();
  }
}

// ── KB v2: Build modal ─────────────────────────────────────────────────

/**
 * Open the Build modal. Collects scope + targetRoom + dry-run-vs-build +
 * auto-approve, then kicks off the build via REST and opens the review
 * panel with the returned proposals.
 */
async function openBuildModal() {
  // Get a list of existing room names so the targetRoom autocomplete is
  // useful. Best-effort: fall back to a free-text input if walk() fails.
  let existingRooms = [];
  try {
    const notesWalk = await jsonFetch(`${API}/walk?path=notes`);
    existingRooms = notesWalk.folders ?? [];
  } catch { /* ignore */ }

  const scopeOptions = [
    { value: '', label: 'All inbox' },
    { value: 'inbox', label: 'inbox/ only' },
  ];
  const body = `
    <div class="kb-build-modal">
      <div class="kb-form-row">
        <label>Scope</label>
        <select id="kb-build-scope" class="kb-build-input">
          ${scopeOptions.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div class="kb-form-row">
        <label>Target room (optional)</label>
        <input id="kb-build-target-room" class="kb-build-input" type="text" list="kb-build-rooms" placeholder="notes/architecture" />
        <datalist id="kb-build-rooms">
          ${existingRooms.map((r) => `<option value="notes/${escapeHtml(r)}"></option>`).join('')}
        </datalist>
      </div>
      <div class="kb-form-row">
        <label><input id="kb-build-dry-run" type="checkbox" /> Dry-run only (no review panel, just audit)</label>
      </div>
      <div class="kb-form-row">
        <label><input id="kb-build-auto-approve" type="checkbox" /> Auto-approve all non-needsReview proposals (typed confirmation required)</label>
      </div>
      <div class="kb-form-hint">Builder runs scan → cluster → match → synthesize. No writes to notes/ until you approve proposals in the review panel.</div>
    </div>
  `;
  // Capture ref-handles to the modal inputs via rAF AFTER calling showModal.
  // The inputs survive overlay detachment as JavaScript objects, so we can
  // still read .value / .checked after the promise resolves even though
  // the DOM overlay is gone. This is the simplest reliable pattern with
  // the current shared modal primitive (which lacks pre-resolve hooks).
  const refs = {
    scope: null,
    targetRoom: null,
    dryRun: null,
    autoApprove: null,
  };
  const modalPromise = showModal(_container, {
    title: 'Build wiki',
    body,
    buttons: [
      { key: 'cancel', label: 'Cancel', cls: 'btn-secondary' },
      { key: 'run', label: 'Run build', cls: 'btn-primary' },
    ],
  });
  requestAnimationFrame(() => {
    refs.scope = _container.querySelector('#kb-build-scope');
    refs.targetRoom = _container.querySelector('#kb-build-target-room');
    refs.dryRun = _container.querySelector('#kb-build-dry-run');
    refs.autoApprove = _container.querySelector('#kb-build-auto-approve');
  });
  const result = await modalPromise;
  if (result !== 'run') return;

  const scope = refs.scope?.value ?? '';
  const targetRoom = refs.targetRoom?.value?.trim() ?? '';
  const dryRun = refs.dryRun?.checked ?? false;
  const autoApprove = refs.autoApprove?.checked ?? false;

  if (autoApprove) {
    const ok = await confirmModal(_container, {
      title: 'Confirm auto-approve',
      message:
        'Auto-approve will commit all non-needsReview proposals without a review panel. ' +
        'This is destructive and not recommended for v1. Continue?',
      confirmLabel: 'Auto-approve',
      confirmCls: 'btn-danger',
    });
    if (!ok) return;
  }

  try {
    const payload = {
      ...(scope ? { path: scope } : {}),
      ...(targetRoom ? { targetRoom } : {}),
      trigger: 'manual',
    };
    const endpoint = dryRun ? `${API}/build/dry-run` : `${API}/build/run`;
    const data = await jsonFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (dryRun) {
      setStatus(`Dry-run complete: runId ${data.run?.runId ?? data.runId}, ${data.run?.proposals?.length ?? data.proposals?.length ?? 0} proposals audit-only`, 'ok');
      return;
    }
    setStatus(`Build run ${data.runId}: ${data.awaitingReview} proposals awaiting review`, 'ok');
    await openReviewPanel(data.runId, data.proposals ?? [], { autoApprove });
  } catch (err) {
    setStatus(`Build failed: ${err.message}`, 'error');
  }
}

// ── KB v2: Review panel ─────────────────────────────────────────────────

/**
 * Open the proposal review panel. Lists proposals with per-proposal
 * approve / edit / reject buttons plus an approve-all button.
 *
 * `opts.autoApprove`: when true (set by the build modal's auto-approve
 * toggle, after the operator has typed-confirmed), bypass the modal
 * entirely and immediately commit every non-needsReview proposal. The
 * modal still surfaces if there are NO approvable proposals so the user
 * can read the needsReview reasons.
 */
async function openReviewPanel(runId, proposals, opts = {}) {
  if (!proposals || proposals.length === 0) {
    setStatus('No proposals to review.', 'info');
    return;
  }

  const approvableIdsRaw = proposals.filter((p) => !p.needsReview).map((p) => p.proposalId);

  // Phase 4 review fix #2: honor the autoApprove option from the build modal.
  // The typed-confirmation in openBuildModal already gated this path; we just
  // skip the review modal and commit straight away.
  if (opts.autoApprove && approvableIdsRaw.length > 0) {
    try {
      const data = await jsonFetch(`${API}/build/runs/${encodeURIComponent(runId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalIds: approvableIdsRaw }),
      });
      setStatus(`Auto-approved ${data.written?.length ?? 0} wiki page(s)`, 'ok');
      _state.tree = await loadTree();
      renderTree(_state.tree);
      await loadList();
      renderEditor();
      // Surface any needsReview proposals that weren't auto-approved.
      const skipped = proposals.length - approvableIdsRaw.length;
      if (skipped > 0) {
        setStatus(`${skipped} proposal(s) flagged needsReview were skipped — review them manually.`, 'info');
      }
    } catch (err) {
      setStatus(`Auto-approve failed: ${err.message}`, 'error');
    }
    return;
  }

  const rows = proposals.map((p, idx) => {
    const needsReview = p.needsReview ? ' (needsReview)' : '';
    const title = escapeHtml(p.title || '(untitled)');
    const target = escapeHtml(`${p.targetPath}/${p.targetSlug}.md`);
    const action = p.actionPlan?.type ?? 'unknown';
    const reason = p.needsReviewReason ? `<div class="kb-review-reason">⚠ ${escapeHtml(p.needsReviewReason)}</div>` : '';
    const citations = (p.sourceRefs ?? []).map((id) => `<code>${escapeHtml(id)}</code>`).join(' ');
    return `
      <div class="kb-review-row" data-proposal-idx="${idx}">
        <div class="kb-review-head">
          <strong>${title}${escapeHtml(needsReview)}</strong>
          <span class="kb-review-meta">${escapeHtml(action)} → ${target}</span>
        </div>
        ${reason}
        <div class="kb-review-body">${escapeHtml((p.body ?? '').slice(0, 500))}${(p.body ?? '').length > 500 ? '…' : ''}</div>
        <div class="kb-review-citations">Cites: ${citations || '<em>(none)</em>'}</div>
      </div>
    `;
  }).join('');

  const result = await showModal(_container, {
    title: `Review ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`,
    body: `
      <div class="kb-review-panel">
        ${rows}
      </div>
    `,
    buttons: [
      { key: 'reject', label: 'Reject all', cls: 'btn-danger' },
      { key: 'cancel', label: 'Cancel (no-op)', cls: 'btn-secondary' },
      { key: 'approve', label: 'Approve all', cls: 'btn-primary' },
    ],
  });

  if (result === 'cancel' || result === null) {
    setStatus('Review cancelled; no changes committed.', 'info');
    return;
  }

  // Reuse the auto-approve list computed at the top of the function so the
  // two code paths don't drift.
  const approvableIds = approvableIdsRaw;

  if (result === 'approve') {
    if (approvableIds.length === 0) {
      setStatus('No proposals are approvable (all flagged needsReview).', 'error');
      return;
    }
    if (approvableIds.length > 3) {
      const confirmed = await confirmModal(_container, {
        title: 'Approve all?',
        message: `You are about to commit <strong>${approvableIds.length}</strong> proposals. This writes ${approvableIds.length} wiki page(s) to disk. Continue?`,
        confirmLabel: 'Approve all',
        confirmCls: 'btn-primary',
      });
      if (!confirmed) return;
    }
    try {
      const data = await jsonFetch(`${API}/build/runs/${encodeURIComponent(runId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalIds: approvableIds }),
      });
      setStatus(`Committed ${data.written?.length ?? 0} wiki page(s)`, 'ok');
      _state.tree = await loadTree();
      renderTree(_state.tree);
      await loadList();
      renderEditor();
    } catch (err) {
      setStatus(`Approve failed: ${err.message}`, 'error');
    }
  } else if (result === 'reject') {
    const rejectIds = proposals.map((p) => p.proposalId);
    try {
      await jsonFetch(`${API}/build/runs/${encodeURIComponent(runId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalIds: rejectIds, reason: 'reviewer rejected all' }),
      });
      setStatus(`Rejected ${rejectIds.length} proposal(s)`, 'ok');
    } catch (err) {
      setStatus(`Reject failed: ${err.message}`, 'error');
    }
  }
}

// ── KB v2: Build history drawer + revert ───────────────────────────────

/**
 * Open the Build history drawer. Shows recent build runs with per-run
 * revert buttons. Uses the shared modal primitive.
 *
 * Phase 4 review fix #4 (codex-2): the in-body revert buttons are now
 * functional. We attach a click delegate to the modal body via rAF after
 * mount. The delegate intercepts clicks on `[data-revert-run-id]` buttons,
 * confirms via `confirmModal`, calls the revert REST endpoint, and
 * rewrites the row in place to reflect the new state. The shared modal
 * itself stays open until the user explicitly closes it via the action
 * row.
 */
async function openHistoryDrawer() {
  try {
    const data = await jsonFetch(`${API}/build/history?limit=50`);
    const runs = data.runs ?? [];
    if (runs.length === 0) {
      setStatus('No build runs recorded yet.', 'info');
      return;
    }
    const rows = runs.map((run) => {
      const canRevert = run.committedCount > 0 && !run.reverted;
      return `
        <div class="kb-history-row" data-run-id="${escapeHtml(run.runId)}">
          <div class="kb-history-label">
            <strong>${escapeHtml(run.runId)}</strong>
            <span class="kb-history-meta">${escapeHtml(run.trigger)} • ${escapeHtml(run.startedAt)} • ${run.committedCount} committed${run.reverted ? ' • <em>reverted</em>' : ''}</span>
          </div>
          ${canRevert ? `<button class="kb-btn kb-btn-danger kb-btn-tiny" data-revert-run-id="${escapeHtml(run.runId)}">Revert</button>` : ''}
        </div>
      `;
    }).join('');
    const modalPromise = showModal(_container, {
      title: `Build history (${runs.length} run${runs.length === 1 ? '' : 's'})`,
      body: `<div class="kb-history-panel">${rows}</div>`,
      buttons: [{ key: 'close', label: 'Close', cls: 'btn-secondary' }],
    });
    // Wire the in-body revert buttons via post-mount event delegation.
    // The shared modal primitive only resolves on `[data-modal-key]` clicks,
    // so we install a separate click handler on the panel container that
    // catches `[data-revert-run-id]` buttons and runs the revert flow
    // without closing the modal.
    requestAnimationFrame(() => {
      const panel = _container.querySelector('.kb-history-panel');
      if (!panel) return;
      panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-revert-run-id]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const runId = btn.dataset.revertRunId;
        if (!runId) return;
        const ok = await confirmModal(_container, {
          title: 'Revert build run?',
          message: `This will delete any wikis created by run <strong>${escapeHtml(runId)}</strong> and restore any merged wikis to their pre-commit state. Sources that no longer exist will block the revert.`,
          confirmLabel: 'Revert',
          confirmCls: 'btn-danger',
        });
        if (!ok) return;
        try {
          btn.disabled = true;
          btn.textContent = 'Reverting…';
          const result = await jsonFetch(`${API}/build/runs/${encodeURIComponent(runId)}/revert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          // Rewrite the row in place: replace the button with a 'reverted' marker.
          const row = btn.closest('.kb-history-row');
          if (row) {
            btn.remove();
            const meta = row.querySelector('.kb-history-meta');
            if (meta && !meta.innerHTML.includes('reverted')) {
              meta.innerHTML += ' • <em>reverted</em>';
            }
          }
          setStatus(`Reverted ${result.reverted?.length ?? 0} wiki(s) from ${runId}`, 'ok');
          // Refresh tree/list/editor in the background since the KB state changed.
          _state.tree = await loadTree();
          renderTree(_state.tree);
          await loadList();
          // If the currently-selected wiki was reverted, clear the editor.
          if (_state.selectedNoteId && result.reverted?.includes(_state.selectedNoteId)) {
            _state.selectedNote = null;
            _state.selectedNoteId = null;
            _state.wikiHistory = null;
          }
          renderEditor();
        } catch (err) {
          setStatus(`Revert failed: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = 'Revert';
        }
      });
    });
    await modalPromise;
  } catch (err) {
    setStatus(`History fetch failed: ${err.message}`, 'error');
  }
}

/**
 * Revert a previously committed build run. Called from the editor History
 * tab. Refreshes the tree + list + editor after success so the reverted
 * wiki pages disappear from the UI.
 */
async function revertBuildRun(runId) {
  const ok = await confirmModal(_container, {
    title: 'Revert build run?',
    message: `This will delete any wikis created by run <strong>${escapeHtml(runId)}</strong> and restore any merged wikis to their pre-commit state. Sources that no longer exist will block the revert.`,
    confirmLabel: 'Revert',
    confirmCls: 'btn-danger',
  });
  if (!ok) return;
  try {
    const data = await jsonFetch(`${API}/build/runs/${encodeURIComponent(runId)}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    setStatus(`Reverted ${data.reverted?.length ?? 0} wiki(s)`, 'ok');
    _state.wikiHistory = null;
    _state.tree = await loadTree();
    renderTree(_state.tree);
    await loadList();
    renderEditor();
  } catch (err) {
    setStatus(`Revert failed: ${err.message}`, 'error');
  }
}

/**
 * Trigger a rebuild for a specific wiki page. Opens the review panel with
 * the single rebuild proposal.
 */
async function rebuildWiki(wikiId) {
  try {
    const data = await jsonFetch(`${API}/rebuild/${encodeURIComponent(wikiId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    setStatus(`Rebuild run ${data.runId}: ${data.awaitingReview} proposal(s) awaiting review`, 'ok');
    await openReviewPanel(data.runId, data.proposals ?? []);
  } catch (err) {
    setStatus(`Rebuild failed: ${err.message}`, 'error');
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────

async function openComposeModal() {
  let existingRooms = [];
  let sourceNotes = [];
  try {
    const [notesWalk, inboxList] = await Promise.all([
      jsonFetch(`${API}/walk?path=notes`),
      jsonFetch(`${API}/notes?path=${encodeURIComponent('inbox')}`),
    ]);
    existingRooms = notesWalk.folders ?? [];
    sourceNotes = (inboxList.notes ?? [])
      .filter((note) => {
        const effectiveKind = note.kind ?? (note.slug === '_index' ? 'index' : 'raw');
        return effectiveKind === 'raw';
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch (err) {
    setStatus(`Failed to load compose options: ${err.message}`, 'error');
    return;
  }

  if (sourceNotes.length === 0) {
    setStatus('No raw notes are available in inbox/. Ingest or create one first.', 'info');
    return;
  }

  const defaultPagePath = _state.folderPath.startsWith('notes/')
    ? `${_state.folderPath}/overview`
    : 'notes/overview';
  const body = `
    <div class="kb-build-modal">
      <div class="kb-form-row">
        <label>Page path</label>
        <input id="kb-compose-page-path" class="kb-build-input" type="text" list="kb-compose-paths" value="${escapeHtml(defaultPagePath)}" placeholder="notes/auth/overview" />
        <datalist id="kb-compose-paths">
          ${existingRooms.map((r) => `<option value="notes/${escapeHtml(r)}/overview"></option>`).join('')}
        </datalist>
      </div>
      <div class="kb-form-row">
        <label>Title (optional)</label>
        <input id="kb-compose-title" class="kb-build-input" type="text" placeholder="Auth Overview" />
      </div>
      <div class="kb-form-row">
        <label>Raw sources</label>
        <div class="kb-compose-sources">
          ${sourceNotes.map((note, idx) => `
            <label class="kb-compose-source">
              <input type="checkbox" data-compose-source-id="${escapeHtml(note.id)}" ${idx === 0 ? 'checked' : ''} />
              <span class="kb-compose-source-body">
                <span class="kb-compose-source-title">${escapeHtml(note.title)}</span>
                <span class="kb-compose-source-meta">${escapeHtml(note.path)} • ${escapeHtml(note.id)}</span>
              </span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="kb-form-hint">Compose writes one wiki page now. Raw notes stay untouched and the wiki keeps explicit sourceRefs.</div>
    </div>
  `;
  const refs = {
    pagePath: null,
    title: null,
    sourceChecks: [],
  };
  const modalPromise = showModal(_container, {
    title: 'Compose wiki',
    body,
    buttons: [
      { key: 'cancel', label: 'Cancel', cls: 'btn-secondary' },
      { key: 'compose', label: 'Compose', cls: 'btn-primary' },
    ],
  });
  requestAnimationFrame(() => {
    refs.pagePath = _container.querySelector('#kb-compose-page-path');
    refs.title = _container.querySelector('#kb-compose-title');
    refs.sourceChecks = Array.from(_container.querySelectorAll('[data-compose-source-id]'));
  });
  const result = await modalPromise;
  if (result !== 'compose') return;

  const pagePath = refs.pagePath?.value?.trim() ?? '';
  const title = refs.title?.value?.trim() ?? '';
  const sourceIds = refs.sourceChecks
    .filter((input) => input.checked)
    .map((input) => input.dataset.composeSourceId)
    .filter(Boolean);

  if (pagePath === '') {
    setStatus('Enter a page path such as notes/auth/overview.', 'error');
    return;
  }
  if (sourceIds.length === 0) {
    setStatus('Select at least one raw note to compose a wiki page.', 'error');
    return;
  }

  try {
    const data = await jsonFetch(`${API}/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pagePath,
        sourceIds,
        ...(title ? { title } : {}),
      }),
    });
    const note = data.note;
    _state.tree = await loadTree();
    renderTree(_state.tree);

    if (_state.dirty) {
      await loadList();
      renderEditor();
      setStatus(`Composed ${note.path}/${note.slug}.md. Current unsaved note stayed open.`, 'ok');
      return;
    }

    _state.searchHits = null;
    _state.searchQuery = '';
    _state.folderPath = note.path;
    await loadList();
    await loadNote(note.id);
    setStatus(`Composed ${note.path}/${note.slug}.md from ${sourceIds.length} source(s).`, 'ok');
  } catch (err) {
    setStatus(`Compose failed: ${err.message}`, 'error');
  }
}

async function rebuildComposedWiki(wikiId) {
  let discardLocalEditsOnSuccess = false;
  if (_state.selectedNoteId === wikiId && _state.dirty) {
    const ok = await confirmModal(_container, {
      title: 'Discard unsaved changes?',
      message: 'Rebuilding will reload this wiki from the server. Your current unsaved edits will be discarded if the rebuild succeeds.',
      confirmLabel: 'Continue',
      confirmCls: 'btn-danger',
    });
    if (!ok) return;
    discardLocalEditsOnSuccess = true;
  }

  const doRebuild = (force) => jsonFetch(`${API}/compose/rebuild/${encodeURIComponent(wikiId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(force ? { force: true } : {}),
  });

  try {
    let data;
    try {
      data = await doRebuild(false);
    } catch (err) {
      if (err.code !== 'manual_edits_present') throw err;
      const ok = await confirmModal(_container, {
        title: 'Overwrite manual edits?',
        message: 'This wiki has diverged from its last composed body. Force rebuild will overwrite the current body using its sourceRefs.',
        confirmLabel: 'Force rebuild',
        confirmCls: 'btn-danger',
      });
      if (!ok) return;
      data = await doRebuild(true);
    }

    if (discardLocalEditsOnSuccess) {
      _state.dirty = false;
    }
    const rebuilt = data.note;
    _state.searchHits = null;
    _state.searchQuery = '';
    _state.folderPath = rebuilt?.path ?? _state.folderPath;
    _state.tree = await loadTree();
    renderTree(_state.tree);
    await loadList();
    await loadNote(rebuilt?.id ?? wikiId);
    setStatus(`Rebuilt ${(rebuilt?.path && rebuilt?.slug) ? `${rebuilt.path}/${rebuilt.slug}.md` : wikiId}.`, 'ok');
  } catch (err) {
    setStatus(`Rebuild failed: ${err.message}`, 'error');
  }
}

export async function mount(container, ctx) {
  _container = container;
  _container.classList.add('page-knowledge-base');
  _container.innerHTML = PAGE_HTML;
  _state = init();

  _container.querySelector('#kb-btn-search').addEventListener('click', runSearch);
  _container.querySelector('#kb-btn-clear-search').addEventListener('click', clearSearch);
  _container.querySelector('#kb-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });
  _container.querySelector('#kb-btn-new').addEventListener('click', newNote);
  _container.querySelector('#kb-btn-import').addEventListener('click', importPipe);
  _container.querySelector('#kb-btn-build').addEventListener('click', openComposeModal);
  _container.querySelector('#kb-btn-history').addEventListener('click', openHistoryDrawer);

  try {
    _state.tree = await loadTree();
    renderTree(_state.tree);
    await loadList();
    renderEditor();
    await maybeRestoreDraft();
  } catch (err) {
    setStatus(`Failed to load Knowledge Base: ${err.message}`, 'error');
  }
}

export function unmount(container) {
  if (_container === container) {
    // Best-effort persistence: the app shell does not support cancellable
    // navigation, so we save dirty edits to localStorage instead of warning.
    // Restored on next mount.
    saveDraftToLocalStorage();
    clearToasts();
    _container.classList.remove('page-knowledge-base');
    _container.replaceChildren();
    _container = null;
    _state = null;
  }
}
