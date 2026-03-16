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

export interface McpState {
  globalPtys: Map<string, PtyEntry>;
  dashboardState: DashboardState;
  io: any;
  spawnGlobalPty: (id: string, command: string, args: string[], env: Record<string, string>, cols: number, rows: number, trackCwd: boolean, oscOnly: boolean, startCwd: string | null) => IPty;
  SHELL_CONFIGS: Record<string, ShellConfig>;
  MAX_PANES: number;
  nextPaneId: () => string;
  paneActiveSocket: Map<string, string>;
  socketDimensions: Map<string, Map<string, { cols: number; rows: number }>>;
}
