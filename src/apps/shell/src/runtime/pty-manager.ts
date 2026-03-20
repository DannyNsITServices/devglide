import pty, { type IPty } from 'node-pty';
import fs from 'fs';
import type { PtyEntry, PaneInfo, ShellEmitter } from '../shell-types.js';
import {
  globalPtys,
  dashboardState,
  getShellNsp,
  SCROLLBACK_LIMIT,
} from './shell-state.js';

/** Send SIGHUP, then SIGKILL after 2 s if still alive. */
export function killPty(p: IPty): void {
  try {
    p.kill();
  } catch {
    return;
  }

  const { pid } = p;
  setTimeout(() => {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }, 2000).unref();
}

export function readCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    fs.readlink(`/proc/${pid}/cwd`, (err: NodeJS.ErrnoException | null, linkPath: string) => {
      resolve(err ? null : linkPath);
    });
  });
}

function updatePaneCwd(id: string, cwd: string): void {
  const pane = dashboardState.panes.find((p: PaneInfo) => p.id === id);
  if (pane) pane.cwd = cwd;
}

export function spawnGlobalPty(
  id: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cols: number,
  rows: number,
  trackCwd: boolean,
  oscOnly: boolean,
  startCwd: string | null,
  emitter?: ShellEmitter,
): IPty {
  cols = Number.isInteger(cols) && cols >= 1 ? Math.min(cols, 500) : 80;
  rows = Number.isInteger(rows) && rows >= 1 ? Math.min(rows, 500) : 24;

  const spawnOpts = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startCwd || process.env.HOME || process.env.USERPROFILE || '/',
    env,
    ...(process.platform === 'win32' ? { useConpty: true, conptyInheritCursor: true } : {}),
  };
  const ptyProcess: IPty = pty.spawn(command, args, spawnOpts as Parameters<typeof pty.spawn>[2]);

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

    const io = emitter ?? getShellNsp()!;
    io.to(`pane:${id}`).emit('terminal:data', { id, data });

    if (trackCwd) {
      const oscMatch = data.match(/\x1b\]7;([^\x07\x1b]+)\x07/);
      if (oscMatch) {
        const cwd = oscMatch[1];
        updatePaneCwd(id, cwd);
        io.emit('terminal:cwd', { id, cwd });
      } else if (!oscOnly) {
        if (cwdTimer) clearTimeout(cwdTimer);
        cwdTimer = setTimeout(async () => {
          if (!globalPtys.has(id)) return;
          const cwd = await readCwd(ptyProcess.pid);
          if (cwd) {
            updatePaneCwd(id, cwd);
            io.emit('terminal:cwd', { id, cwd });
          }
        }, 300);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (cwdTimer) clearTimeout(cwdTimer);
    if (!globalPtys.delete(id)) return;
    (emitter ?? getShellNsp()!).emit('terminal:exit', { id, code: exitCode });
  });

  return ptyProcess;
}
