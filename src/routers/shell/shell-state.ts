import type { Namespace } from 'socket.io';
import type { PtyEntry, PaneInfo, DashboardState } from '../../apps/shell/src/shell-types.js';

export type { PtyEntry, PaneInfo, DashboardState };

// ── Global shared state (survives individual socket disconnects) ────────────

export const globalPtys: Map<string, PtyEntry> = new Map();

export const dashboardState: DashboardState = {
  panes: [],
  activeTab: 'grid',
  activePaneId: null,
};

let paneIdCounter: number = 0;
export function nextPaneId(): string { return `pane-${++paneIdCounter}`; }

export const SCROLLBACK_LIMIT: number = 200_000;
export const MAX_PANES: number = 9; // per project context

/** Count panes belonging to the given project (null = no project). */
export function panesForProject(projectId: string | null): number {
  return dashboardState.panes.filter((p: PaneInfo) => p.projectId === projectId).length;
}

/** Next sequential number for a pane within its project context. */
export function nextNumForProject(projectId: string | null): number {
  return panesForProject(projectId) + 1;
}

/** Renumber panes per-project (1-based sequential within each project). */
export function renumberPanes(): void {
  const counters = new Map<string, number>();
  for (const p of dashboardState.panes) {
    const key = p.projectId || '__none__';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    p.num = next;
    p.title = String(next);
  }
}

// ── Multi-client resize arbitration ─────────────────────────────────────────
// Each PTY has one "active" socket — the one that last sent input.
// Only that socket's resize events are forwarded to the PTY.
// When a different socket starts typing it takes over and immediately
// resizes the PTY to its own dimensions, preventing SIGWINCH corruption.
export const paneActiveSocket: Map<string, string> = new Map();   // paneId -> socketId
export const socketDimensions: Map<string, Map<string, { cols: number; rows: number }>> = new Map(); // socketId -> Map<paneId, {cols, rows}>

// ── Module-level namespace reference (set by initShell) ─────────────────────
let shellNsp: Namespace | null = null;

export function getShellNsp(): Namespace | null { return shellNsp; }

export function setShellNsp(nsp: Namespace): void {
  shellNsp = nsp;
}
