// ── Global State Module ───────────────────────────────────────────────────────
// Provides project context, socket connections, and API helpers.
// All page modules import from this.

// Socket.io connections (using window.io set by socket.io client script)
const io = window.io;

// Single socket on default namespace — dashboard (project:*) and shell
// (terminal:*/state:*/browser:*) events share it for backward compat.
export const dashboardSocket = io();
export const shellSocket = dashboardSocket;

// ── Reconnect handling ───────────────────────────────────────────────────────
// After a server restart, stale HTTP keep-alive connections cause the page to
// hang. Socket.io's reconnect also stalls on these dead connections, so the
// 'connect' event never fires. Instead, detect disconnect and reload after a
// short delay to give the new server time to start.
let _hasConnected = false;
let _reloadTimer = null;

dashboardSocket.on('connect', () => {
  if (_reloadTimer) { clearTimeout(_reloadTimer); _reloadTimer = null; }
  if (_hasConnected) {
    // Reconnected after a disconnect — reload to clear stale state
    window.location.reload();
  }
  _hasConnected = true;
});

dashboardSocket.on('disconnect', (reason) => {
  if (!_hasConnected) return;
  if (reason === 'io client disconnect') return; // intentional
  // Server died — reload after delay (gives new server time to start)
  _reloadTimer = setTimeout(() => window.location.reload(), 3000);
});

// ── Project context ───────────────────────────────────────────────────────────

export let activeProject = null;
let projectList = [];

const projectListeners = new Set();
const projectListListeners = new Set();

dashboardSocket.on('project:active', (project) => {
  activeProject = project;
  // Set cookie for backward compat with apps using cookie-based project context
  if (project) {
    document.cookie = `devglide-project-id=${project.id}; path=/; SameSite=Lax`;
  } else {
    document.cookie = 'devglide-project-id=; path=/; max-age=0';
  }
  for (const fn of projectListeners) fn(project);
});

dashboardSocket.on('project:list', (store) => {
  projectList = store.projects || [];
  for (const fn of projectListListeners) fn(projectList);
});

export function onProjectChange(fn) {
  projectListeners.add(fn);
  return () => projectListeners.delete(fn);
}

export function onProjectListChange(fn) {
  projectListListeners.add(fn);
  return () => projectListListeners.delete(fn);
}

export function getProjectList() { return projectList; }
export function getActiveProject() { return activeProject; }

// ── API helper ────────────────────────────────────────────────────────────────

export function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}
