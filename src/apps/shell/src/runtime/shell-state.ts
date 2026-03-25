import type { Namespace } from 'socket.io';
import type { PtyEntry, PaneInfo, DashboardState } from '../shell-types.js';

export type { PtyEntry, PaneInfo, DashboardState };

// ── Global shared state (survives individual socket disconnects) ────────────

export const globalPtys: Map<string, PtyEntry> = new Map();

export const dashboardState: DashboardState = {
  panes: [],
  activeTab: 'grid',
  activePaneId: null,
};

let paneIdCounter = 0;

export function nextPaneId(): string {
  return `pane-${++paneIdCounter}`;
}

export const SCROLLBACK_LIMIT = 200_000;
export const MAX_PANES = 9; // per project context

/** Count panes belonging to the given project (null = no project). */
export function panesForProject(projectId: string | null): number {
  return dashboardState.panes.filter((p: PaneInfo) => p.projectId === projectId).length;
}

/** Next sequential number for a pane within its project context. */
export function nextNumForProject(projectId: string | null): number {
  return panesForProject(projectId) + 1;
}

function permissionModeSuffix(mode?: string | null): string {
  if (!mode || mode === 'supervised') return '';
  return mode === 'auto-accept' ? ' [AUTO]' : ' [UNRESTRICTED]';
}

/** Renumber panes per-project (1-based sequential within each project). */
export function renumberPanes(): void {
  const counters = new Map<string, number>();
  for (const p of dashboardState.panes) {
    const key = p.projectId || '__none__';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    p.num = next;
    const label = p.chatName || String(next);
    p.title = `${next}: ${label}${permissionModeSuffix(p.permissionMode)}`;
  }
}

// ── Multi-client resize arbitration ─────────────────────────────────────────

export const paneActiveSocket: Map<string, string> = new Map();
export const socketDimensions: Map<string, Map<string, { cols: number; rows: number }>> = new Map();

// ── Module-level namespace reference (set by initShell) ─────────────────────

let shellNsp: Namespace | null = null;

export function getShellNsp(): Namespace | null {
  return shellNsp;
}

export function setShellNsp(nsp: Namespace): void {
  shellNsp = nsp;
}
