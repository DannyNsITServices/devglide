/**
 * Shared factory for creating ShellMcpState — used by both the standalone
 * stdio MCP server and the unified HTTP server's shell integration.
 * Centralizes state wiring so neither path duplicates the other.
 */
import { spawnGlobalPty, killPty } from './runtime/pty-manager.js';
import { SHELL_CONFIGS } from './runtime/shell-config.js';
import {
  globalPtys,
  dashboardState,
  MAX_PANES,
  nextPaneId,
  paneActiveSocket,
  socketDimensions,
} from './runtime/shell-state.js';
import { NOOP_EMITTER } from './shell-types.js';
import type { McpState, ShellEmitter } from './shell-types.js';

/** Create a McpState wired to the given emitter (NOOP_EMITTER for standalone, shellEmitterProxy for unified server). */
export function createShellMcpState(io: ShellEmitter = NOOP_EMITTER): McpState {
  return {
    globalPtys,
    dashboardState,
    io,
    spawnGlobalPty,
    SHELL_CONFIGS,
    MAX_PANES,
    nextPaneId,
    paneActiveSocket,
    socketDimensions,
  };
}

/** Kill all active PTY processes and clear state. */
export function shutdownAllPtys(): void {
  for (const { ptyProcess } of globalPtys.values()) {
    try { killPty(ptyProcess); } catch { /* ignore */ }
  }
  globalPtys.clear();
}
