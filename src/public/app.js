// ── Devglide Unified App Shell ─────────────────────────────────────────────────
// SPA router with page module loading, sidebar navigation, project selector,
// voice widget, and mobile drawer support.

import {
  dashboardSocket,
  activeProject,
  onProjectChange,
  onProjectListChange,
  getProjectList,
  getActiveProject,
} from './state.js';

// ── App registry ──────────────────────────────────────────────────────────────

const APPS = [
  { id: 'kanban',   name: 'Kanban',    desc: 'Task management',         ctx: 'project', icon: '\u25A6' },
  { id: 'log',      name: 'Log',       desc: 'Browser console capture',  ctx: 'project', icon: '\u2261' },
  { id: 'test',     name: 'Test',      desc: 'LLM-driven UI automation', ctx: 'project', icon: '\u2713' },
  { id: 'shell',    name: 'Shell',     desc: 'Terminal multiplexer',     ctx: 'project', icon: '\u276F' },
  { id: 'coder',    name: 'Coder',     desc: 'In-browser IDE',           ctx: 'project', icon: '\u2039\u203A' },
  { id: 'workflow',   name: 'Workflow',   desc: 'Task automation',          ctx: 'project', icon: '\u2942' },
  { id: 'vocabulary', name: 'Vocabulary', desc: 'Domain terminology',     ctx: 'project', icon: '\u2338' },
  { id: 'prompts',    name: 'Prompts',    desc: 'Reusable prompt library', ctx: 'project', icon: '\u270E' },
  { id: 'documentation', name: 'Documentation', desc: 'Product docs & guides', ctx: 'tool', icon: '\u2630' },
  { id: 'voice',    name: 'Voice',     desc: 'Speech-to-text',           ctx: 'tool',    icon: '\u25C9' },
  { id: 'keymap',   name: 'Keymap',    desc: 'Keyboard shortcuts',       ctx: 'tool',    icon: '\u2328' },
];

const DEFAULT_TOOL_APP = 'documentation';

// ── State ─────────────────────────────────────────────────────────────────────

let _storedId;
try { _storedId = localStorage.getItem('dashboard:activeApp'); } catch { _storedId = null; }
let activeId = APPS.some(a => a.id === _storedId) ? _storedId : DEFAULT_TOOL_APP;

const pageCache = {};
let currentApp = null;
let currentModule = null;

// ── Sidebar order ─────────────────────────────────────────────────────────────

function getOrderedServices(ctx) {
  const pool = APPS.filter(s => s.ctx === ctx);
  let saved;
  try { saved = JSON.parse(localStorage.getItem('dashboard:menuOrder:' + ctx) ?? 'null'); } catch { saved = null; }
  if (!saved) return [...pool];
  const known = new Map(pool.map(s => [s.id, s]));
  const ordered = saved.filter(id => known.has(id)).map(id => known.get(id));
  pool.forEach(s => { if (!saved.includes(s.id)) ordered.push(s); });
  return ordered;
}

function saveOrder(sectionEl) {
  const ctx = sectionEl.dataset.section;
  const ids = [...sectionEl.querySelectorAll('.service-item')].map(el => el.dataset.id);
  localStorage.setItem('dashboard:menuOrder:' + ctx, JSON.stringify(ids));
}

// ── Sidebar disabled state ───────────────────────────────────────────────────

function updateSidebarDisabledState() {
  const hasProject = !!getActiveProject();
  const section = document.querySelector('[data-section="project"]');
  if (!section) return;

  // Update section label hint
  const label = section.querySelector('.nav-section-label');
  if (label) {
    label.textContent = hasProject ? 'Project' : 'Project (select a project)';
  }

  section.querySelectorAll('.service-item').forEach(el => {
    if (hasProject) {
      el.classList.remove('disabled');
      el.removeAttribute('disabled');
      el.removeAttribute('aria-disabled');
      el.removeAttribute('title');
      el.draggable = true;
    } else {
      el.classList.add('disabled');
      el.setAttribute('disabled', '');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', 'Select a project first');
      el.draggable = false;
    }
  });
}

// ── Build sidebar ─────────────────────────────────────────────────────────────

const nav = document.getElementById('service-nav');
let dragSrcId = null;
let dragSrcCtx = null;

function buildSection(ctx, label) {
  const section = document.createElement('div');
  section.className = 'nav-section';
  section.dataset.section = ctx;

  const header = document.createElement('div');
  header.className = 'nav-section-label';
  header.textContent = label;
  section.appendChild(header);

  for (const app of getOrderedServices(ctx)) {
    const item = document.createElement('button');
    item.className = 'service-item';
    item.dataset.id = app.id;
    item.draggable = true;
    item.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">\u2807</span>
      <span class="service-icon">${app.icon}</span>
      <span class="service-name">${app.name}</span>
      <span class="service-desc">${app.desc}</span>
    `;
    item.addEventListener('click', () => {
      if (app.ctx === 'project' && !getActiveProject()) return;
      selectApp(app.id);
    });

    item.addEventListener('dragstart', (e) => {
      dragSrcId = app.id;
      dragSrcCtx = ctx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (app.id === dragSrcId || dragSrcCtx !== ctx) return;
      const rect = item.getBoundingClientRect();
      const below = e.clientY >= rect.top + rect.height / 2;
      item.classList.toggle('drag-over-top', !below);
      item.classList.toggle('drag-over-bottom', below);
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!dragSrcId || dragSrcId === app.id || dragSrcCtx !== ctx) return;
      const draggedEl = section.querySelector(`[data-id="${dragSrcId}"]`);
      if (!draggedEl) return;
      const rect = item.getBoundingClientRect();
      const below = e.clientY >= rect.top + rect.height / 2;
      section.insertBefore(draggedEl, below ? item.nextSibling : item);
      saveOrder(section);
    });

    item.addEventListener('dragend', () => {
      dragSrcId = null;
      dragSrcCtx = null;
      nav.querySelectorAll('.service-item').forEach(el => {
        el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      });
    });

    section.appendChild(item);
  }

  return section;
}

nav.appendChild(buildSection('project', 'Project'));
nav.appendChild(buildSection('tool', 'Tools'));
updateSidebarDisabledState();

// ── Mobile drawer ─────────────────────────────────────────────────────────────

const sidebar   = document.getElementById('sidebar');
const overlay   = document.getElementById('overlay');
const hamburger = document.getElementById('hamburger');

function openDrawer()  { sidebar.classList.add('open');    overlay.classList.add('visible'); }
function closeDrawer() { sidebar.classList.remove('open'); overlay.classList.remove('visible'); }

hamburger.addEventListener('click', () =>
  sidebar.classList.contains('open') ? closeDrawer() : openDrawer()
);
overlay.addEventListener('click', closeDrawer);

// ── App selection / page module mounting ───────────────────────────────────────

async function selectApp(id) {
  // Redirect to default tool app if target is project-scoped with no active project
  const targetApp = APPS.find(a => a.id === id);
  if (targetApp?.ctx === 'project' && !getActiveProject()) {
    id = DEFAULT_TOOL_APP;
  }

  activeId = id;
  localStorage.setItem('dashboard:activeApp', id);
  closeDrawer();

  // Update sidebar active state
  document.querySelectorAll('.service-item').forEach(el => {
    const isActive = el.dataset.id === id;
    el.classList.toggle('active', isActive);
    if (isActive) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });

  // Update mobile topbar title
  const app = APPS.find(a => a.id === id);
  const mobileTitle = document.getElementById('mobile-title');
  if (mobileTitle) mobileTitle.textContent = app ? app.name : 'Devglide';

  const container = document.getElementById('app-content');

  // Unmount current page module
  if (currentModule?.unmount) {
    try { currentModule.unmount(container); } catch (e) { console.warn('[shell] unmount error:', e); }
  }
  container.innerHTML = '';

  // Load and mount page module
  if (!pageCache[id]) {
    pageCache[id] = await import(`/app/${id}/page.js`);
  }
  currentModule = pageCache[id];

  await currentModule.mount(container, {
    project: getActiveProject(),
    navigate: selectApp,
  });

  currentApp = id;
}

// ── Project UI ────────────────────────────────────────────────────────────────

function updateProjectUI() {
  const nameEl = document.getElementById('project-name');
  const selectorEl = document.getElementById('project-selector');
  if (nameEl) {
    const project = getActiveProject();
    nameEl.textContent = project ? project.name : 'No project';
    nameEl.title = project ? project.path : '';
  }
  if (selectorEl) {
    selectorEl.classList.toggle('has-project', !!getActiveProject());
  }
}

function buildProjectDropdown() {
  const dropdown = document.getElementById('project-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = '';

  const projects = getProjectList();

  for (const p of projects) {
    const item = document.createElement('button');
    item.className = 'project-item' + (getActiveProject()?.id === p.id ? ' active' : '');
    item.innerHTML = `
      <div class="project-item-row">
        <div class="project-item-info">
          <span class="project-item-name">${p.name}</span>
          <span class="project-item-path">${p.path}</span>
        </div>
        <div class="project-item-actions">
          <button class="project-item-action edit" title="Edit project">\u270E</button>
          <button class="project-item-action delete" title="Delete project">\u2715</button>
        </div>
      </div>`;

    // Clicking the item activates the project
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      dashboardSocket.emit('project:activate', { id: p.id });
      dropdown.classList.remove('open');
    });

    // Edit button
    const editBtn = item.querySelector('.project-item-action.edit');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      openProjectModal('edit', p);
    });

    // Delete button — inline confirmation
    const deleteBtn = item.querySelector('.project-item-action.delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Replace item content with confirmation
      const originalHTML = item.innerHTML;
      item.innerHTML = '';
      const confirm = document.createElement('div');
      confirm.className = 'project-delete-confirm';
      confirm.innerHTML = `<span>Delete ${p.name}?</span>`;

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'project-modal-btn danger';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dashboardSocket.emit('project:remove', { id: p.id }, (res) => {
          if (!res.ok) showModalError(res.error);
        });
        dropdown.classList.remove('open');
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'project-modal-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        item.innerHTML = originalHTML;
        // Re-attach action listeners after restoring HTML
        rebindItemActions(item, p, dropdown);
      });

      confirm.appendChild(confirmBtn);
      confirm.appendChild(cancelBtn);
      item.appendChild(confirm);
    });

    dropdown.appendChild(item);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'project-item project-add';
  addBtn.textContent = '+ Add Project\u2026';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.remove('open');
    openProjectModal('add');
  });
  dropdown.appendChild(addBtn);
}

/** Re-bind edit/delete listeners after restoring item HTML (e.g. after cancel delete) */
function rebindItemActions(item, project, dropdown) {
  const editBtn = item.querySelector('.project-item-action.edit');
  const deleteBtn = item.querySelector('.project-item-action.delete');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      openProjectModal('edit', project);
    });
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Trigger inline delete confirmation by simulating the same flow
      const originalHTML = item.innerHTML;
      item.innerHTML = '';
      const confirm = document.createElement('div');
      confirm.className = 'project-delete-confirm';
      confirm.innerHTML = `<span>Delete ${project.name}?</span>`;

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'project-modal-btn danger';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dashboardSocket.emit('project:remove', { id: project.id }, (res) => {
          if (!res.ok) showModalError(res.error);
        });
        dropdown.classList.remove('open');
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'project-modal-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        item.innerHTML = originalHTML;
        rebindItemActions(item, project, dropdown);
      });

      confirm.appendChild(confirmBtn);
      confirm.appendChild(cancelBtn);
      item.appendChild(confirm);
    });
  }
}

// ── Project modal ─────────────────────────────────────────────────────────────

function openProjectModal(mode, project) {
  // Remove any existing modal
  closeProjectModal();

  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'project-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'project-modal';

  const title = mode === 'edit' ? 'Edit Project' : 'Add Project';
  const submitLabel = mode === 'edit' ? 'Save' : 'Add';

  modal.innerHTML = `
    <div class="project-modal-title">${title}</div>
    <div class="project-modal-field">
      <label class="project-modal-label" for="pm-name">Name</label>
      <input class="project-modal-input" id="pm-name" type="text" value="${mode === 'edit' && project ? project.name : ''}" autocomplete="off" />
    </div>
    <div class="project-modal-field">
      <label class="project-modal-label" for="pm-path">Path</label>
      <div class="project-modal-path-row">
        <input class="project-modal-input" id="pm-path" type="text" value="${mode === 'edit' && project ? project.path : ''}" placeholder="/absolute/path/to/project" autocomplete="off" />
        <button class="project-modal-btn" id="pm-browse" type="button" title="Browse folders">\u2026</button>
      </div>
      <div class="folder-picker hidden" id="pm-folder-picker">
        <div class="folder-picker-header">
          <button class="folder-picker-up" id="pm-folder-up" title="Go up">\u2191</button>
          <span class="folder-picker-path" id="pm-folder-path"></span>
        </div>
        <div class="folder-picker-list" id="pm-folder-list"></div>
        <div class="folder-picker-actions">
          <button class="project-modal-btn" id="pm-folder-cancel">Cancel</button>
          <button class="project-modal-btn primary" id="pm-folder-select">Select</button>
        </div>
      </div>
    </div>
    <div class="project-modal-error" id="pm-error"></div>
    <div class="project-modal-actions">
      <button class="project-modal-btn" id="pm-cancel">Cancel</button>
      <button class="project-modal-btn primary" id="pm-submit">${submitLabel}</button>
    </div>
  `;

  modalOverlay.appendChild(modal);
  document.body.appendChild(modalOverlay);

  const nameInput = document.getElementById('pm-name');
  const pathInput = document.getElementById('pm-path');
  const cancelBtn = document.getElementById('pm-cancel');
  const submitBtn = document.getElementById('pm-submit');

  // ── Folder picker ──────────────────────────────────────────────────────
  const browseBtn = document.getElementById('pm-browse');
  const folderPicker = document.getElementById('pm-folder-picker');
  const folderPath = document.getElementById('pm-folder-path');
  const folderList = document.getElementById('pm-folder-list');
  const folderUpBtn = document.getElementById('pm-folder-up');
  const folderSelectBtn = document.getElementById('pm-folder-select');
  const folderCancelBtn = document.getElementById('pm-folder-cancel');
  let browseCurrentPath = '';

  async function loadFolder(dirPath) {
    try {
      const url = '/api/dashboard/browse' + (dirPath ? '?path=' + encodeURIComponent(dirPath) : '');
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) { showModalError(data.error || 'Cannot browse'); return; }

      browseCurrentPath = data.path;
      folderPath.textContent = data.path;
      folderPath.title = data.path;
      folderList.innerHTML = '';

      for (const name of data.dirs) {
        const item = document.createElement('button');
        item.className = 'folder-picker-item';
        item.textContent = name;
        item.addEventListener('click', () => loadFolder(data.path + '/' + name));
        folderList.appendChild(item);
      }

      if (data.dirs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'folder-picker-empty';
        empty.textContent = 'No subdirectories';
        folderList.appendChild(empty);
      }
    } catch {
      showModalError('Failed to load directory');
    }
  }

  browseBtn.addEventListener('click', () => {
    folderPicker.classList.toggle('hidden');
    if (!folderPicker.classList.contains('hidden')) {
      loadFolder(pathInput.value.trim() || '');
    }
  });

  folderUpBtn.addEventListener('click', () => {
    const parent = browseCurrentPath.replace(/\/[^/]+$/, '') || '/';
    loadFolder(parent);
  });

  folderSelectBtn.addEventListener('click', () => {
    pathInput.value = browseCurrentPath;
    folderPicker.classList.add('hidden');
    // Auto-fill name from folder basename if empty
    if (!nameInput.value.trim()) {
      const basename = browseCurrentPath.split('/').filter(Boolean).pop();
      if (basename) nameInput.value = basename;
    }
  });

  folderCancelBtn.addEventListener('click', () => {
    folderPicker.classList.add('hidden');
  });

  // Auto-focus name input
  requestAnimationFrame(() => nameInput.focus());

  // Submit handler
  function handleSubmit() {
    const name = nameInput.value.trim();
    const path = pathInput.value.trim();

    // Clear previous errors
    nameInput.classList.remove('error');
    pathInput.classList.remove('error');

    if (!name) {
      nameInput.classList.add('error');
      showModalError('Project name is required.');
      nameInput.focus();
      return;
    }
    if (!path) {
      pathInput.classList.add('error');
      showModalError('Absolute path is required.');
      pathInput.focus();
      return;
    }

    if (mode === 'add') {
      dashboardSocket.emit('project:add', { name, path }, (res) => {
        if (res.ok) {
          closeProjectModal();
        } else {
          showModalError(res.error || 'Failed to add project.');
        }
      });
    } else if (mode === 'edit' && project) {
      dashboardSocket.emit('project:update', { id: project.id, name, path }, (res) => {
        if (res.ok) {
          closeProjectModal();
        } else {
          showModalError(res.error || 'Failed to update project.');
        }
      });
    }
  }

  submitBtn.addEventListener('click', handleSubmit);
  cancelBtn.addEventListener('click', closeProjectModal);

  // Backdrop click closes modal
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeProjectModal();
  });

  // Escape key closes modal
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      closeProjectModal();
    } else if (e.key === 'Enter') {
      handleSubmit();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  // Store cleanup reference so closeProjectModal can remove listener
  modalOverlay._keydownHandler = onKeyDown;
}

function closeProjectModal() {
  const existing = document.querySelector('.project-modal-overlay');
  if (existing) {
    if (existing._keydownHandler) {
      document.removeEventListener('keydown', existing._keydownHandler);
    }
    existing.remove();
  }
}

function showModalError(msg) {
  const errorEl = document.getElementById('pm-error');
  if (errorEl) {
    errorEl.textContent = msg;
  }
}

// ── Project selector toggle ───────────────────────────────────────────────────

const projectSelector = document.getElementById('project-selector');
const projectDropdown = document.getElementById('project-dropdown');

if (projectSelector && projectDropdown) {
  projectSelector.addEventListener('click', (e) => {
    e.stopPropagation();
    buildProjectDropdown();
    projectDropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    projectDropdown.classList.remove('open');
  });
}

// ── Project change propagation ────────────────────────────────────────────────

let _initialLoad = true;

onProjectChange((project) => {
  updateProjectUI();
  updateSidebarDisabledState();

  if (_initialLoad) {
    // First project:active from socket — now we know the project state.
    // Defer initial selectApp to here so the guard has accurate data.
    _initialLoad = false;
    selectApp(activeId);
    return;
  }

  if (!project) {
    // No project — redirect to default tool app if currently on a project-scoped app
    const cur = APPS.find(a => a.id === activeId);
    if (cur?.ctx === 'project') {
      selectApp(DEFAULT_TOOL_APP);
      return;
    }
  }

  if (currentModule?.onProjectChange) {
    try { currentModule.onProjectChange(project); } catch (e) { console.warn('[shell] onProjectChange error:', e); }
  }
});

// Register project list updates
onProjectListChange(() => {
  // Re-build dropdown if it's open
  const dropdown = document.getElementById('project-dropdown');
  if (dropdown?.classList.contains('open')) buildProjectDropdown();
});

// ── Voice widget ──────────────────────────────────────────────────────────────

let voiceWidget = null;

let voiceErrorTimer = null;
function showVoiceError(message) {
  const popup = document.getElementById('voice-error-popup');
  if (!popup) return;
  popup.textContent = message;
  popup.classList.remove('hidden');
  popup.getBoundingClientRect();
  popup.classList.add('visible');
  clearTimeout(voiceErrorTimer);
  voiceErrorTimer = setTimeout(() => {
    popup.classList.remove('visible');
    popup.addEventListener('transitionend', () => popup.classList.add('hidden'), { once: true });
  }, 4000);
}

if (typeof VoiceWidget !== 'undefined') {
  voiceWidget = VoiceWidget.create({
    voiceUrl: window.location.origin,
    onResult(text) {
      document.dispatchEvent(new CustomEvent('voice:result', { detail: { text } }));
    },
    onError(err) {
      const msg = err.message || 'Voice error';
      const isNoMic = /microphone|mic|NotFound|DevicesNotFound/i.test(msg);
      showVoiceError(isNoMic ? 'No microphone found — connect a mic and try again.' : msg);
    },
  });

  const voiceMountEl = document.getElementById('voice-widget-mount');
  if (voiceMountEl) voiceWidget.mount(voiceMountEl);

  // Handle Ctrl+Alt+Shift hold-to-speak when the shell has focus
  let voiceKeyActive = false;
  document.addEventListener('keydown', (e) => {
    const isVoiceHotkey = typeof KeymapRegistry !== 'undefined'
      ? KeymapRegistry.matchesAction(e, 'voice:hold-to-speak')
      : (e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift'));
    if (isVoiceHotkey && !voiceKeyActive) {
      e.preventDefault();
      voiceKeyActive = true;
      voiceWidget.startRecording();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (voiceKeyActive && (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control')) {
      voiceKeyActive = false;
      voiceWidget.stopRecording();
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Initial selectApp is deferred to the first onProjectChange callback
// so the project guard has accurate data from the socket.
