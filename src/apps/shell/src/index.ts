import { createShellMcpServer } from './mcp.js';
import { runStdio } from '../../../packages/mcp-utils/src/index.js';
import { NOOP_EMITTER } from './shell-types.js';
import type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from './shell-types.js';
import { spawnGlobalPty, killPty, readCwd } from '../../../routers/shell/pty-manager.js';
import { SHELL_CONFIGS } from '../../../routers/shell/shell-config.js';
import { globalPtys, dashboardState } from '../../../routers/shell/shell-state.js';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState };

// ── State (standalone MCP) ──────────────────────────────────────────────────

const MAX_PANES = 9;
let paneIdCounter = 0;
function nextPaneId(): string { return `pane-${++paneIdCounter}`; }

const paneActiveSocket: Map<string, string> = new Map();
const socketDimensions: Map<string, Map<string, { cols: number; rows: number }>> = new Map();

// Wrap spawnGlobalPty to always pass NOOP_EMITTER in standalone MCP mode
function spawnPty(
  id: string, command: string, args: string[], env: Record<string, string>,
  cols: number, rows: number, trackCwd: boolean, oscOnly: boolean, startCwd: string | null,
) {
  return spawnGlobalPty(id, command, args, env, cols, rows, trackCwd, oscOnly, startCwd, NOOP_EMITTER);
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(): void {
  console.log('\nShutting down — killing PTY processes...');
  for (const { ptyProcess } of globalPtys.values()) {
    try { killPty(ptyProcess); } catch {}
  }
  globalPtys.clear();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
const mcpState: McpState = {
  globalPtys, dashboardState, io: NOOP_EMITTER,
  spawnGlobalPty: spawnPty, SHELL_CONFIGS, MAX_PANES, nextPaneId,
  paneActiveSocket, socketDimensions,
};
const mcpServer = createShellMcpServer(mcpState);
await runStdio(mcpServer);
console.error('Devglide Shell MCP server running on stdio');
