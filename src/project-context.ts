/**
 * Shared active-project state for the unified Devglide server.
 *
 * Replaces the per-app connectProjectContext() socket.io connections.
 * All routers import from this module to read/write the active project.
 */

export interface ActiveProject {
  id: string;
  name: string;
  path: string;
}

let activeProject: ActiveProject | null = null;

const listeners: Set<(p: ActiveProject | null) => void> = new Set();

export function setActiveProject(p: ActiveProject | null): void {
  activeProject = p;
  for (const fn of listeners) {
    try {
      fn(p);
    } catch (err) {
      console.error('[project-context] listener error:', err);
    }
  }
}

export function onProjectChange(fn: (p: ActiveProject | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getActiveProject(): ActiveProject | null {
  return activeProject;
}
