/* ── Log page module ─────────────────────────────────────────────── */

import { escapeHtml, timeAgo } from '/shared-assets/ui-utils.js';

const HTML = `
  <header>
    <div class="brand" data-action="show-sessions">Log</div>
    <div class="header-meta">
      <span id="file-count-badge" class="badge">
        <span id="file-count">0</span> app<span id="file-plural">s</span>
      </span>
      <button id="btn-clear-all" class="btn-danger" data-action="clear-all" disabled style="display:none"
        title="Clear log files for all active sessions">
        Clear all logs
      </button>
      <span>
        auto-refresh 3s
        <span class="refresh-indicator" id="refresh-dot"></span>
      </span>
    </div>
  </header>

  <main>
    <!-- -- File list view --------------------------------------------- -->
    <div id="view-sessions">
      <div class="section-title">Log Files</div>
      <div id="file-list" class="file-list">
        <div class="empty" id="empty-state">
          No log files visible.<br/>
          Add <code>&lt;script src="http://localhost:7000/devtools.js?target=/path/to/app"&gt;&lt;/script&gt;</code> to any external app, or use the devtools middleware for DevGlide monorepo apps.
        </div>
      </div>
    </div>

    <!-- -- Log viewer view -------------------------------------------- -->
    <div id="view-log" class="hidden">
      <div class="viewer-header">
        <div class="viewer-header-left">
          <button class="btn-secondary" data-action="show-sessions">&larr; Back</button>
          <span class="viewer-title" id="viewer-title"></span>
          <span class="source-badge" id="viewer-source-badge"></span>
        </div>
        <button class="btn-danger" id="btn-clear-session" data-action="clear-session">Clear</button>
      </div>
      <div class="source-toggle" id="source-toggle">
        <button class="active" data-source="all" aria-label="Show all sources" aria-pressed="true">All</button>
        <button data-source="browser" aria-label="Show browser logs only" aria-pressed="false">Browser</button>
        <button data-source="server" aria-label="Show server logs only" aria-pressed="false">Server</button>
        <button data-source="file" aria-label="Show file logs only" aria-pressed="false">File</button>
      </div>
      <div class="filter-bar" id="filter-bar"></div>
      <div class="log-entries" id="log-entries" role="log" aria-live="polite" aria-label="Log entries"></div>
    </div>
  </main>
`;

/* ── Constants ──────────────────────────────────────────────────────── */
const NOW_ACTIVE_MS = 10_000;
const NOW_IDLE_MS   = 60_000;
const ERROR_TYPES = new Set(['ERROR', 'WINDOW_ERROR', 'UNHANDLED_REJECTION', 'SERVER_ERROR', 'FILE_ERROR']);
const WARN_TYPES  = new Set(['WARN', 'SERVER_WARN', 'FILE_WARN']);

/* ── Helpers (pure) ─────────────────────────────────────────────────── */
const reltime = timeAgo;

function fileStatus(lastSeen) {
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < NOW_ACTIVE_MS) return 'active';
  if (diff < NOW_IDLE_MS)   return 'idle';
  return 'stale';
}

const escHtml = escapeHtml;

function entrySource(entry) {
  const t = entry.type || '';
  if (t.startsWith('FILE_')) return 'file';
  return t.startsWith('SERVER_') ? 'server' : 'browser';
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch { return ''; }
}

function appName(targetPath) {
  const parts = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const appsIdx = parts.lastIndexOf('apps');
  if (appsIdx !== -1 && parts[appsIdx + 1]) return parts[appsIdx + 1];
  return parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1] || targetPath;
}

function appKey(targetPath) {
  const parts = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const appsIdx = parts.lastIndexOf('apps');
  if (appsIdx !== -1 && parts[appsIdx + 1]) {
    return '/' + parts.slice(0, appsIdx + 2).join('/');
  }
  return '/' + parts.slice(0, -1).join('/');
}

function groupByApp(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = appKey(s.targetPath);
    if (!map.has(key)) {
      map.set(key, { key, name: appName(s.targetPath), targetPaths: new Set(), sources: new Set(), logCount: 0, errorCount: 0, lastSeen: s.lastSeen });
    }
    const app = map.get(key);
    app.targetPaths.add(s.targetPath);
    app.sources.add(s.source);
    app.logCount += s.logCount || 0;
    app.errorCount += s.errorCount || 0;
    if (new Date(s.lastSeen) > new Date(app.lastSeen)) app.lastSeen = s.lastSeen;
  }
  return [...map.values()]
    .map(a => ({ ...a, targetPaths: [...a.targetPaths], sources: [...a.sources] }))
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
}

/* ── Module state (per-mount) ───────────────────────────────────────── */
let _container = null;
let _pollTimer = null;
let _visibilityHandler = null;

let currentView = 'sessions';
let currentTargetPaths = [];
let activeFilters = new Set();
let sourceFilter = 'all';
let allEntries = [];
let allSessions = [];
let activeProjectPath = null;

/* ── DOM helpers ────────────────────────────────────────────────────── */
function $(sel) { return _container.querySelector(sel); }
function $$(sel) { return _container.querySelectorAll(sel); }

/* ── Rendering ──────────────────────────────────────────────────────── */
function renderSessions(sessions) {
  allSessions = sessions;
  const apps = groupByApp(sessions);
  const count = apps.length;

  $('#file-count').textContent = count;
  $('#file-plural').textContent = count === 1 ? '' : 's';

  const btn = $('#btn-clear-all');
  btn.style.display = count > 0 ? '' : 'none';
  btn.disabled = count === 0;

  const list = $('#file-list');

  if (apps.length === 0) {
    list.innerHTML = '<div class="empty" id="empty-state">No log files visible.<br/>Add <code>&lt;script src="http://localhost:7000/devtools.js?target=/path/to/app"&gt;&lt;/script&gt;</code> to any external app, or use the devtools middleware for DevGlide monorepo apps.</div>';
    return;
  }

  list.innerHTML = apps.map(app => {
    const status = fileStatus(app.lastSeen);
    const hasErrors = app.errorCount > 0;
    const pathsAttr = escHtml(JSON.stringify(app.targetPaths));
    const sourceBadges = app.sources.map(s =>
      `<span class="file-source-item ${s}">${s}</span>`
    ).join('');
    const fileNames = app.targetPaths.map(p => p.split('/').pop()).join(', ');
    return `
      <div class="file-card" data-action="open-viewer" data-paths="${pathsAttr}" data-name="${escHtml(app.name)}">
        <div class="status-dot ${status}"></div>
        <div class="file-main">
          <div class="file-name">${escHtml(app.name)}</div>
          <div class="file-path" title="${escHtml(fileNames)}">${escHtml(fileNames)}</div>
          <div class="file-sources">${sourceBadges}</div>
        </div>
        <div class="file-stats">
          <div class="stat ${hasErrors ? 'has-errors' : ''}">
            ${hasErrors ? '&#9888; ' + app.errorCount + ' error' + (app.errorCount !== 1 ? 's' : '') : app.logCount + ' log' + (app.logCount !== 1 ? 's' : '')}
          </div>
          <div class="last-seen">${reltime(app.lastSeen)}</div>
        </div>
      </div>
    `;
  }).join('');
}

/* ── View switching ─────────────────────────────────────────────────── */
function showSessions() {
  currentView = 'sessions';
  currentTargetPaths = [];
  $('#view-sessions').classList.remove('hidden');
  $('#view-log').classList.add('hidden');
}

function openViewer(targetPaths, name) {
  currentView = 'log';
  currentTargetPaths = Array.isArray(targetPaths) ? targetPaths : [targetPaths];
  activeFilters.clear();
  sourceFilter = 'all';

  $('#view-sessions').classList.add('hidden');
  $('#view-log').classList.remove('hidden');

  $('#viewer-title').textContent = name || appName(currentTargetPaths[0]);
  $('#viewer-source-badge').textContent = '';
  $('#viewer-source-badge').className = 'source-badge';

  // Reset source toggle
  $$('#source-toggle button').forEach(b => {
    const isActive = b.dataset.source === 'all';
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-pressed', isActive);
  });

  refreshLog();
}

/* ── Log viewer ─────────────────────────────────────────────────────── */
async function refreshLog() {
  if (currentTargetPaths.length === 0) return;
  try {
    const fetches = currentTargetPaths.map(tp =>
      fetch('/api/log/view?targetPath=' + encodeURIComponent(tp) + '&limit=500')
        .then(r => r.ok ? r.json() : { entries: [] })
        .then(d => d.entries || [])
        .catch(() => [])
    );
    const results = await Promise.all(fetches);
    allEntries = results.flat().sort((a, b) => {
      const ta = a.ts || '';
      const tb = b.ts || '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    renderFilters();
    renderEntries();
  } catch (e) { /* silently ignore */ }
}

function renderFilters() {
  const types = new Set(allEntries.map(e => e.type || 'LOG'));
  const bar = $('#filter-bar');
  const sorted = [...types].sort();
  bar.innerHTML = sorted.map(t => {
    const isActive = activeFilters.has(t);
    const colorClass = ERROR_TYPES.has(t) ? ' red' : WARN_TYPES.has(t) ? ' yellow' : '';
    return `<button class="filter-pill${isActive ? ' active' + colorClass : ''}" data-action="toggle-filter" data-type="${escHtml(t)}" aria-label="Filter by ${escHtml(t)}" aria-pressed="${isActive}">${escHtml(t)}</button>`;
  }).join('');
}

function toggleFilter(type) {
  if (activeFilters.has(type)) activeFilters.delete(type);
  else activeFilters.add(type);
  renderFilters();
  renderEntries();
}

function setSourceFilter(src) {
  sourceFilter = src;
  $$('#source-toggle button').forEach(b => {
    const isActive = b.dataset.source === src;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-pressed', isActive);
  });
  renderEntries();
}

function renderEntries() {
  const el = $('#log-entries');
  let filtered = allEntries;

  if (activeFilters.size > 0) {
    filtered = filtered.filter(e => activeFilters.has(e.type || 'LOG'));
  }
  if (sourceFilter !== 'all') {
    filtered = filtered.filter(e => entrySource(e) === sourceFilter);
  }

  if (filtered.length === 0) {
    el.innerHTML = '<div style="padding:var(--df-space-6);text-align:center;color:var(--df-color-text-muted);text-transform:uppercase;font-size:var(--df-font-size-xs);letter-spacing:var(--df-letter-spacing-wide)">No entries</div>';
    return;
  }

  el.innerHTML = filtered.map(e => {
    const type = e.type || 'LOG';
    const src = entrySource(e);
    const isErr = ERROR_TYPES.has(type);
    const msg = e.message || (e.type === 'SESSION_START' ? 'Session started' : '');
    return `<div class="log-entry${isErr ? ' log-entry-error' : ''}">
      <span class="log-src ${src}">${src === 'file' ? 'F' : src === 'server' ? 'S' : 'B'}</span>
      <span class="log-time">${formatTime(e.ts)}</span>
      <span class="log-level ${type}">${type}</span>
      <span class="log-message">${escHtml(msg)}</span>
    </div>`;
  }).join('');

  // Auto-scroll to bottom only if user is already near the bottom
  const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
  if (isNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

async function clearSessionLog() {
  if (currentTargetPaths.length === 0) return;
  try {
    await Promise.all(currentTargetPaths.map(tp =>
      fetch('/api/log?targetPath=' + encodeURIComponent(tp), { method: 'DELETE' }).catch(() => {})
    ));
    allEntries = [];
    renderEntries();
  } catch (e) { /* silently ignore */ }
}

async function clearAllLogs() {
  const btn = $('#btn-clear-all');
  btn.disabled = true;
  try {
    await fetch('/api/log/all', { method: 'DELETE' });
    await refresh();
  } catch (e) { /* silently ignore */ }
  finally { btn.disabled = false; }
}

/* ── Refresh loop ───────────────────────────────────────────────────── */
async function refresh() {
  try {
    let statusUrl = '/api/log/status';
    if (activeProjectPath) {
      statusUrl += '?projectPath=' + encodeURIComponent(activeProjectPath);
    }
    const res = await fetch(statusUrl);
    if (!res.ok) return;
    const { sessions } = await res.json();
    if (currentView === 'sessions') {
      renderSessions(sessions);
    } else {
      allSessions = sessions;
      refreshLog();
    }
    flash();
  } catch (e) { /* silently ignore */ }
}

function flash() {
  const dot = $('#refresh-dot');
  if (!dot) return;
  dot.classList.add('flash');
  setTimeout(() => dot.classList.remove('flash'), 300);
}

/* ── Delegated event handler ────────────────────────────────────────── */
function handleClick(e) {
  const action = e.target.closest('[data-action]');
  if (!action) return;

  switch (action.dataset.action) {
    case 'show-sessions':
      showSessions();
      break;
    case 'clear-all':
      clearAllLogs();
      break;
    case 'clear-session':
      clearSessionLog();
      break;
    case 'open-viewer': {
      const paths = JSON.parse(action.dataset.paths);
      const name = action.dataset.name;
      openViewer(paths, name);
      break;
    }
    case 'toggle-filter':
      toggleFilter(action.dataset.type);
      break;
  }

  // Source toggle buttons
  if (action.closest('#source-toggle') && action.dataset.source) {
    setSourceFilter(action.dataset.source);
  }
}

function handleSourceToggle(e) {
  const btn = e.target.closest('#source-toggle button[data-source]');
  if (btn) {
    setSourceFilter(btn.dataset.source);
  }
}

/* ── Lifecycle ──────────────────────────────────────────────────────── */

export function mount(container, ctx) {
  _container = container;
  container.classList.add('page-log');

  // Reset module state
  currentView = 'sessions';
  currentTargetPaths = [];
  activeFilters = new Set();
  sourceFilter = 'all';
  allEntries = [];
  allSessions = [];
  activeProjectPath = ctx.project?.path || null;

  // Build HTML
  container.innerHTML = HTML;

  // Attach delegated click handler
  container.addEventListener('click', handleClick);
  container.addEventListener('click', handleSourceToggle);

  // Visibility change handler for pause/resume polling
  _visibilityHandler = () => {
    if (document.hidden) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    } else {
      refresh();
      _pollTimer = setInterval(refresh, 3000);
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  // Initial fetch + start polling
  refresh();
  _pollTimer = setInterval(refresh, 3000);
}

export function unmount(container) {
  // Stop polling
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }

  // Remove visibility handler
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  // Remove delegated listeners
  if (container) {
    container.removeEventListener('click', handleClick);
    container.removeEventListener('click', handleSourceToggle);
  }

  // Clean up container
  if (container) {
    container.classList.remove('page-log');
    container.innerHTML = '';
  }

  _container = null;
}

export function onProjectChange(project) {
  activeProjectPath = project?.path || null;
  // Return to sessions view on project switch to avoid showing stale logs
  if (currentView === 'log') showSessions();
  refresh();
}
