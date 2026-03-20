import type { IPty } from 'node-pty';

export interface PtyEntry {
  ptyProcess: IPty;
  chunks: string[];
  totalLen: number;
}

export interface PaneInfo {
  id: string;
  shellType: string;
  title: string;
  num: number;
  cwd: string | null;
  url?: string;
  projectId: string | null;
}

export interface DashboardState {
  panes: PaneInfo[];
  activeTab: string;
  activePaneId: string | null;
}

export interface ShellConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Minimal emitter interface — socket.io Namespace in router mode, no-op in standalone MCP. */
export interface ShellEmitter {
  to(room: string): ShellEmitter;
  emit(event: string, data?: unknown): ShellEmitter;
}

export const NOOP_EMITTER: ShellEmitter = {
  to() { return this; },
  emit() { return this; },
};

export interface McpState {
  globalPtys: Map<string, PtyEntry>;
  dashboardState: DashboardState;
  io: ShellEmitter;
  spawnGlobalPty: (id: string, command: string, args: string[], env: Record<string, string>, cols: number, rows: number, trackCwd: boolean, oscOnly: boolean, startCwd: string | null) => IPty;
  SHELL_CONFIGS: Record<string, ShellConfig>;
  MAX_PANES: number;
  nextPaneId: () => string;
  paneActiveSocket: Map<string, string>;
  socketDimensions: Map<string, Map<string, { cols: number; rows: number }>>;
}
