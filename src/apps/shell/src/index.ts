import pty, { type IPty } from 'node-pty';
import fs from 'fs';
import { createShellMcpServer } from './mcp.js';
import { runStdio } from '../../../packages/mcp-utils/src/index.js';

import type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from './shell-types.js';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState };

// ── Helpers ───────────────────────────────────────────────────────────────────

function readCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    fs.readlink(`/proc/${pid}/cwd`, (err: NodeJS.ErrnoException | null, linkPath: string) => resolve(err ? null : linkPath));
  });
}

const ENV_ALLOWLIST_UNIX: string[] = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'];

function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  if (process.platform === 'win32') {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    return { ...env, ...extra };
  }
  const env: Record<string, string> = { TERM: 'xterm-256color' };
  for (const key of ENV_ALLOWLIST_UNIX) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

// ── No-op emitter (standalone MCP mode has no socket clients) ────────────────
const io = { to(_room: string) { return this; }, emit(_event: string, _data?: unknown) { return this; }, close() {} };

// ── Shell configs ─────────────────────────────────────────────────────────────

const SHELL_CONFIGS: Record<string, ShellConfig> = {
  bash: {
    command: 'bash',
    args: [],
    env: safeEnv()
  },
  cmd: {
    command: 'cmd.exe',
    args: [],
    env: safeEnv()
  },
  default: { command: 'cmd.exe', args: [], env: safeEnv() },
};

// ── Global shared state (survives individual socket disconnects) ───────────────

const globalPtys: Map<string, PtyEntry> = new Map(); // id -> { ptyProcess, chunks, totalLen }

const dashboardState: DashboardState = {
  panes: [],          // [{ id, shellType, title, num, cwd }] — ordered
  activeTab: 'grid',
  activePaneId: null,
};

let paneIdCounter: number = 0;           // strictly for unique IDs, never reused
function nextPaneId(): string { return `pane-${++paneIdCounter}`; }
const SCROLLBACK_LIMIT: number = 200_000; // bytes
const MAX_PANES: number = 9;

// ── Multi-client resize arbitration ──────────────────────────────────────────
const paneActiveSocket: Map<string, string> = new Map();  // paneId -> socketId
const socketDimensions: Map<string, Map<string, { cols: number; rows: number }>> = new Map();  // socketId -> Map<paneId, {cols, rows}>

// ── PTY lifecycle ─────────────────────────────────────────────────────────────

function spawnGlobalPty(
  id: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cols: number,
  rows: number,
  trackCwd: boolean,
  oscOnly: boolean,
  startCwd: string | null
): IPty {
  cols = Number.isInteger(cols) && cols >= 1 ? Math.min(cols, 500) : 80;
  rows = Number.isInteger(rows) && rows >= 1 ? Math.min(rows, 500) : 24;

  const ptyProcess: IPty = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startCwd || process.env.HOME || process.env.USERPROFILE || '/',
    env,
    ...(process.platform === 'win32' ? { useConpty: true, conptyInheritCursor: true } : {}),
  } as any);

  const entry: PtyEntry = { ptyProcess, chunks: [], totalLen: 0 };
  globalPtys.set(id, entry);

  let cwdTimer: ReturnType<typeof setTimeout> | null = null;

  ptyProcess.onData((data: string) => {
    entry.chunks.push(data);
    entry.totalLen += data.length;
    if (entry.totalLen > SCROLLBACK_LIMIT * 1.5) {
      const joined = entry.chunks.join('').slice(-SCROLLBACK_LIMIT);
      entry.chunks = [joined];
      entry.totalLen = joined.length;
    }

    io.to(`pane:${id}`).emit('terminal:data', { id, data });

    if (trackCwd) {
      const oscMatch = data.match(/\x1b\]7;([^\x07\x1b]+)\x07/);
      if (oscMatch) {
        const cwd = oscMatch[1];
        _updatePaneCwd(id, cwd);
        io.emit('terminal:cwd', { id, cwd });
      } else if (!oscOnly) {
        if (cwdTimer) clearTimeout(cwdTimer);
        cwdTimer = setTimeout(async () => {
          if (!globalPtys.has(id)) return;  // PTY exited before timer fired
          const cwd = await readCwd(ptyProcess.pid);
          if (cwd) {
            _updatePaneCwd(id, cwd);
            io.emit('terminal:cwd', { id, cwd });
          }
        }, 300);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (cwdTimer) clearTimeout(cwdTimer);
    if (!globalPtys.delete(id)) return;  // already cleaned up by terminal:close
    io.emit('terminal:exit', { id, code: exitCode });
  });

  return ptyProcess;
}

function _updatePaneCwd(id: string, cwd: string): void {
  const pane = dashboardState.panes.find((p: PaneInfo) => p.id === id);
  if (pane) pane.cwd = cwd;
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(): void {
  console.log('\nShutting down — killing PTY processes...');
  for (const { ptyProcess } of globalPtys.values()) {
    try { ptyProcess.kill(); } catch {}
  }
  globalPtys.clear();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Stdio MCP mode ───────────────────────────────────────────────────────────
const mcpState: McpState = { globalPtys, dashboardState, io, spawnGlobalPty, SHELL_CONFIGS, MAX_PANES, nextPaneId, paneActiveSocket, socketDimensions };
const mcpServer = createShellMcpServer(mcpState);
await runStdio(mcpServer);
console.error('Devglide Shell MCP server running on stdio');
