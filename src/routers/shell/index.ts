import { createShellMcpServer } from '../../apps/shell/src/mcp.js';
import { mountMcpHttp } from '../../packages/mcp-utils/src/index.js';
import type { McpState } from '../../apps/shell/src/shell-types.js';
import {
  globalPtys,
  dashboardState,
  getShellNsp,
  MAX_PANES,
  nextPaneId,
  paneActiveSocket,
  socketDimensions,
} from './shell-state.js';
import { SHELL_CONFIGS } from './shell-config.js';
import { killPty, spawnGlobalPty } from './pty-manager.js';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from '../../apps/shell/src/shell-types.js';
export { router } from './shell-routes.js';
export { initShell } from './shell-socket.js';

// ── MCP integration ─────────────────────────────────────────────────────────

function getShellMcpState(): McpState {
  return {
    globalPtys,
    dashboardState,
    io: getShellNsp() as any,
    spawnGlobalPty,
    SHELL_CONFIGS,
    MAX_PANES,
    nextPaneId,
    paneActiveSocket,
    socketDimensions,
  };
}

export function mountShellMcp(app: any, prefix: string): void {
  mountMcpHttp(app, () => createShellMcpServer(getShellMcpState()), prefix);
}

// ── Shutdown ────────────────────────────────────────────────────────────────

export function shutdownShell(): void {
  for (const { ptyProcess } of globalPtys.values()) {
    killPty(ptyProcess);
  }
  globalPtys.clear();
}
