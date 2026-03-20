import { createShellMcpServer } from '../../apps/shell/src/mcp.js';
import { mountMcpHttp } from '../../packages/mcp-utils/src/index.js';
import { createShellMcpState, shutdownAllPtys } from '../../apps/shell/src/create-mcp-state.js';
import { NOOP_EMITTER } from '../../apps/shell/src/shell-types.js';
import type { ShellEmitter } from '../../apps/shell/src/shell-types.js';
import { getShellNsp } from '../../apps/shell/src/runtime/shell-state.js';
import type { Express } from 'express';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from '../../apps/shell/src/shell-types.js';
export { router } from './shell-routes.js';
export { initShell } from './shell-socket.js';

// ── MCP integration ─────────────────────────────────────────────────────────

/** Adapt the socket.io Namespace to the ShellEmitter interface used by MCP state. */
function shellEmitterProxy(): ShellEmitter {
  const self: ShellEmitter = {
    to(room: string): ShellEmitter {
      const nsp = getShellNsp();
      if (!nsp) return NOOP_EMITTER;
      const scoped = nsp.to(room);
      return {
        to: (r: string) => self.to(r),
        emit: (ev: string, data?: unknown) => { scoped.emit(ev, data); return self; },
      };
    },
    emit(event: string, data?: unknown): ShellEmitter {
      getShellNsp()?.emit(event, data);
      return self;
    },
  };
  return self;
}

export function mountShellMcp(app: Express, prefix: string): void {
  mountMcpHttp(app, () => createShellMcpServer(createShellMcpState(shellEmitterProxy())), prefix);
}

// ── Shutdown ────────────────────────────────────────────────────────────────

export function shutdownShell(): void {
  shutdownAllPtys();
}
