import type { Namespace } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { getActiveProject } from '../../project-context.js';
import type { PaneInfo, ShellConfig } from '../../apps/shell/src/shell-types.js';
import {
  globalPtys,
  dashboardState,
  getAdjacentPaneIdWithinProject,
  getPaneInfo,
  isPaneOwnedByProject,
  MAX_PANES,
  nextPaneId,
  panesForProject,
  nextNumForProject,
  renumberPanes,
  paneActiveSocket,
  socketDimensions,
  setShellNsp,
} from '../../apps/shell/src/runtime/shell-state.js';
import { SHELL_CONFIGS, safeEnv } from '../../apps/shell/src/runtime/shell-config.js';
import { spawnGlobalPty, killPty } from '../../apps/shell/src/runtime/pty-manager.js';
import { detectEntryPoint } from './shell-routes.js';
import { onPaneClosed as onChatPaneClosed } from '../../apps/chat/services/chat-registry.js';
import {
  consumePendingCursorReportRequests,
  countStandaloneCursorReportResponses,
} from '../../apps/shell/src/runtime/cursor-report.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// â”€â”€ Socket.io namespace initializer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function initShell(nsp: Namespace): void {
  setShellNsp(nsp);

  nsp.on('connection', (socket) => {
    console.log(`[shell:connect] ${socket.id}`);

    // Send full state snapshot to every newly connected client
    const scrollbacks: Record<string, string> = {};
    for (const [id, entry] of globalPtys) {
      scrollbacks[id] = entry.chunks.join('');
      socket.join(`pane:${id}`);
    }
    // Also join rooms for browser panes (no PTY)
    for (const p of dashboardState.panes) {
      if (!globalPtys.has(p.id)) socket.join(`pane:${p.id}`);
    }
    socket.emit('state:snapshot', { ...dashboardState, scrollbacks, activeProject: getActiveProject() || null });

    // Re-send snapshot on demand (for SPA page modules that mount after socket is already connected)
    socket.on('state:request-snapshot', () => {
      const sb: Record<string, string> = {};
      for (const [id, entry] of globalPtys) {
        sb[id] = entry.chunks.join('');
        socket.join(`pane:${id}`);
      }
      for (const p of dashboardState.panes) {
        if (!globalPtys.has(p.id)) socket.join(`pane:${p.id}`);
      }
      socket.emit('state:snapshot', { ...dashboardState, scrollbacks: sb, activeProject: getActiveProject() || null });
    });

    // â”€â”€ Create browser pane â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('browser:create', ({ url, currentTab }: { url?: string; currentTab?: string }) => {
      const currentProjectId = getActiveProject()?.id || null;
      if (panesForProject(currentProjectId) >= MAX_PANES) {
        socket.emit('terminal:error', { message: `Maximum pane limit (${MAX_PANES}) per project reached` });
        return;
      }

      // Auto-detect index.html in active project when no URL is provided
      let resolvedUrl: string = url || '';
      if (!resolvedUrl && getActiveProject()?.path) {
        const entry = detectEntryPoint(getActiveProject().path);
        if (entry) {
          resolvedUrl = `/api/shell/preview/${entry.file}`;
        }
      }

      const id: string    = nextPaneId();
      const projectId: string | null = getActiveProject()?.id || null;
      const num: number   = nextNumForProject(projectId);
      const title: string = String(num);

      const paneInfo: PaneInfo = { id, shellType: 'browser', title, num, cwd: null, url: resolvedUrl, projectId };
      const switchTab: boolean = currentTab !== 'grid';

      dashboardState.panes.push(paneInfo);
      dashboardState.activePaneId = id;
      if (switchTab) dashboardState.activeTab = id;

      nsp.emit('state:pane-added', paneInfo);
      if (switchTab) nsp.emit('state:active-tab', { tabId: id });
      nsp.emit('state:active-pane', { paneId: id });
    });

    // â”€â”€ Create terminal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('terminal:create', ({ shellType, cwd, cols, rows, currentTab }: { shellType: string; cwd?: string; cols?: number; rows?: number; currentTab?: string }) => {
      const currentProjectId = getActiveProject()?.id || null;
      if (panesForProject(currentProjectId) >= MAX_PANES) {
        socket.emit('terminal:error', { message: `Maximum pane limit (${MAX_PANES}) per project reached` });
        return;
      }

      const id: string    = nextPaneId();
      const num: number   = nextNumForProject(currentProjectId);
      const title: string = String(num);
      const config: ShellConfig = SHELL_CONFIGS[shellType] || SHELL_CONFIGS.default;
      let args: string[]     = config.args;
      let startCwd: string = getActiveProject()?.path || process.env.HOME || process.env.USERPROFILE || '/';

      if (cwd) {
        if (!path.isAbsolute(cwd) || cwd.includes('\0') || /\.\.[\\/]/.test(cwd)) {
          socket.emit('terminal:error', { message: 'Invalid CWD path: must be absolute without traversal' });
          return;
        }
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          socket.emit('terminal:error', { message: 'CWD path does not exist or is not a directory' });
          return;
        }
        startCwd = cwd;
      }

      try {
        // Join all connected sockets to the new pane room BEFORE spawning the PTY.
        // The PTY emits data on the next event-loop tick via nsp.to(`pane:${id}`),
        // so sockets must already be in the room to receive the initial prompt.
        nsp.socketsJoin(`pane:${id}`);

        spawnGlobalPty(id, config.command, args, { ...config.env, DEVGLIDE_PANE_ID: id }, cols ?? 80, rows ?? 24,
          true, false, startCwd);

        const paneInfo: PaneInfo = { id, shellType, title, num, cwd: startCwd, projectId: getActiveProject()?.id || null };
        const switchTab: boolean = currentTab !== 'grid';

        paneActiveSocket.set(id, socket.id);
        dashboardState.panes.push(paneInfo);
        dashboardState.activePaneId = id;
        if (switchTab) dashboardState.activeTab = id;

        nsp.emit('state:pane-added', paneInfo);
        if (switchTab) nsp.emit('state:active-tab', { tabId: id });
        nsp.emit('state:active-pane', { paneId: id });
      } catch (err: unknown) {
        socket.emit('terminal:data', { id, data: `\r\nFailed to start ${shellType}: ${errorMessage(err)}\r\n` });
        socket.emit('terminal:exit', { id, code: 1 });
      }
    });

    // â”€â”€ SSH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('ssh:connect', ({ host, user, port, keyPath: kp, cols, rows }: { host: string; user: string; port?: number; keyPath?: string; cols?: number; rows?: number }) => {
      const currentProjectId = getActiveProject()?.id || null;
      if (panesForProject(currentProjectId) >= MAX_PANES) {
        socket.emit('terminal:error', { message: `Maximum pane limit (${MAX_PANES}) per project reached` });
        return;
      }

      if (typeof host !== 'string' || !host || typeof user !== 'string' || !user) {
        socket.emit('terminal:error', { message: 'SSH requires valid host and user' });
        return;
      }
      // Validate hostname (RFC 952) and username format
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(host) || host.length > 253) {
        socket.emit('terminal:error', { message: 'Invalid hostname format' });
        return;
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_\-\.]*$/.test(user) || user.length > 64) {
        socket.emit('terminal:error', { message: 'Invalid username format' });
        return;
      }
      const sshPort: number = Number(port);
      if (port !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
        socket.emit('terminal:error', { message: 'Invalid SSH port' });
        return;
      }
      if (kp !== undefined && (typeof kp !== 'string' || kp.includes('..') || kp.includes('\0'))) {
        socket.emit('terminal:error', { message: 'Invalid key path' });
        return;
      }

      const id: string = nextPaneId();
      const num: number = nextNumForProject(currentProjectId);
      const title: string = `${num}: ${user}@${host}`;

      const sshArgs: string[] = ['-tt'];
      if (port)  sshArgs.push('-p', String(port));
      if (kp)    sshArgs.push('-i', kp);
      sshArgs.push(`${user}@${host}`);

      try {
        spawnGlobalPty(id, 'ssh', sshArgs, safeEnv(), cols ?? 80, rows ?? 24, false, false, null);

        const paneInfo: PaneInfo = { id, shellType: 'ssh', title, num, cwd: null, projectId: getActiveProject()?.id || null };
        paneActiveSocket.set(id, socket.id);
        dashboardState.panes.push(paneInfo);
        dashboardState.activePaneId = id;

        nsp.emit('state:pane-added', paneInfo);
        nsp.emit('state:active-pane', { paneId: id });
      } catch (err: unknown) {
        socket.emit('terminal:data', { id, data: `\r\nSSH failed: ${errorMessage(err)}\r\n` });
        socket.emit('terminal:exit', { id, code: 1 });
      }
    });

    // â”€â”€ Subscribe / unsubscribe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('terminal:subscribe', ({ id }: { id: string }) => {
      if (globalPtys.has(id) || dashboardState.panes.some((p: PaneInfo) => p.id === id)) {
        socket.join(`pane:${id}`);
      }
    });

    socket.on('terminal:unsubscribe', ({ id }: { id: string }) => {
      socket.leave(`pane:${id}`);
    });

    // â”€â”€ Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('terminal:input', ({ id, data }: { id: string; data: string }) => {
      if (typeof data !== 'string' || data.length > 65536) return;

      const entry = globalPtys.get(id);
      if (!entry) return;

      const cursorReportCount = countStandaloneCursorReportResponses(data);
      if (cursorReportCount > 0) {
        const activeSocketId = paneActiveSocket.get(id);
        if (activeSocketId && activeSocketId !== socket.id) return;
        if (!consumePendingCursorReportRequests(entry, cursorReportCount)) return;

        try { entry.ptyProcess.write(data); } catch (e: unknown) { console.warn(`[write] ${id}:`, errorMessage(e)); }
        return;
      }

      // Auto-join room on first interaction
      socket.join(`pane:${id}`);

      // If this socket wasn't the active typer, take ownership and resize PTY
      // to its own dimensions first â€” prevents SIGWINCH corruption on the prev device
      if (paneActiveSocket.get(id) !== socket.id) {
        paneActiveSocket.set(id, socket.id);
        const dims = socketDimensions.get(socket.id)?.get(id);
        if (dims) {
          try { entry.ptyProcess.resize(dims.cols, dims.rows); } catch (e: unknown) { console.warn(`[resize] ${id}:`, errorMessage(e)); }
        }
      }

      try { entry.ptyProcess.write(data); } catch (e: unknown) { console.warn(`[write] ${id}:`, errorMessage(e)); }
    });

    // â”€â”€ Resize â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('terminal:resize', ({ id, cols, rows }: { id: string; cols: number; rows: number }) => {
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      cols = Math.max(1, Math.min(500, cols));
      rows = Math.max(1, Math.min(500, rows));

      // Always record this socket's current dimensions
      if (!socketDimensions.has(socket.id)) socketDimensions.set(socket.id, new Map());
      socketDimensions.get(socket.id)!.set(id, { cols, rows });

      // Only apply to PTY if this socket is the active typer (or pane is brand new)
      const active = paneActiveSocket.get(id);
      if (!active || active === socket.id) {
        const entry = globalPtys.get(id);
        if (entry) {
          try { entry.ptyProcess.resize(cols, rows); } catch (e: unknown) { console.warn(`[resize] ${id}:`, errorMessage(e)); }
        }
      }
    });

    // â”€â”€ Close terminal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('terminal:close', ({ id }: { id: string }) => {
      const paneToClose = getPaneInfo(id);
      if (!paneToClose) return;

      const currentProjectId = getActiveProject()?.id || null;
      if (!isPaneOwnedByProject(paneToClose, currentProjectId)) {
        console.warn(`[terminal:close] rejected pane ${id} for project ${currentProjectId ?? 'null'}`);
        return;
      }

      const ptyEntry = globalPtys.get(id);
      const nextPaneId = getAdjacentPaneIdWithinProject(paneToClose.projectId, id);
      const shouldUpdateActivePane = dashboardState.activePaneId === id || dashboardState.activeTab === id;

      if (ptyEntry) {
        killPty(ptyEntry.ptyProcess);
        globalPtys.delete(id);
      }

      onChatPaneClosed(id, paneToClose.projectId ?? null);
      dashboardState.panes = dashboardState.panes.filter((p: PaneInfo) => p.id !== id);
      nsp.emit('state:pane-removed', { id });

      paneActiveSocket.delete(id);
      for (const dims of socketDimensions.values()) dims.delete(id);

      renumberPanes();
      if (dashboardState.panes.length > 0) {
        nsp.emit('state:panes-renumbered', dashboardState.panes.map(({ id: pid, num }: { id: string; num: number }) => ({ id: pid, num })));
      }

      if (dashboardState.activeTab === id) {
        const next: string = nextPaneId ?? 'grid';
        dashboardState.activeTab = next;
        nsp.emit('state:active-tab', { tabId: next });
      }

      if (shouldUpdateActivePane) {
        dashboardState.activePaneId = nextPaneId;
        nsp.emit('state:active-pane', { paneId: nextPaneId });
      }
    });

    // â”€â”€ Active tab / pane sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Use socket.broadcast so the sender (who already applied locally) is excluded.
    socket.on('state:set-active-tab', ({ tabId }: { tabId: string }) => {
      if (tabId !== 'grid' && !dashboardState.panes.some((p: PaneInfo) => p.id === tabId)) return;
      dashboardState.activeTab = tabId;
      socket.broadcast.emit('state:active-tab', { tabId });
    });

    socket.on('state:set-active-pane', ({ paneId }: { paneId: string | null }) => {
      if (paneId !== null && !dashboardState.panes.some((p: PaneInfo) => p.id === paneId)) return;
      dashboardState.activePaneId = paneId;
      socket.broadcast.emit('state:active-pane', { paneId });
    });

    // â”€â”€ Drag-to-reorder persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('state:reorder-panes', ({ order }: { order: string[] }) => {
      if (!Array.isArray(order) || order.length === 0) return;
      // Validate every ID exists in dashboardState
      const paneIds = new Set(dashboardState.panes.map((p: PaneInfo) => p.id));
      if (!order.every(id => typeof id === 'string' && paneIds.has(id))) return;

      // Rebuild panes array in the requested order, appending any panes not in the order list
      const byId = new Map(dashboardState.panes.map((p: PaneInfo) => [p.id, p]));
      const reordered: PaneInfo[] = [];
      for (const id of order) {
        const pane = byId.get(id);
        if (pane) reordered.push(pane);
      }
      // Append any panes that weren't in the order array (e.g. from another project)
      for (const p of dashboardState.panes) {
        if (!order.includes(p.id)) reordered.push(p);
      }
      dashboardState.panes = reordered;

      // Broadcast to other clients so they sync
      socket.broadcast.emit('state:panes-reordered', { order: reordered.map((p: PaneInfo) => p.id) });
    });

    // â”€â”€ Disconnect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    socket.on('disconnect', () => {
      console.log(`[shell:disconnect] ${socket.id}`);
      // PTY processes outlive individual socket connections.
      // Release resize ownership so the next active socket can take over.
      socketDimensions.delete(socket.id);
      for (const [paneId, activeSocketId] of paneActiveSocket) {
        if (activeSocketId === socket.id) paneActiveSocket.delete(paneId);
      }
    });
  });
}
