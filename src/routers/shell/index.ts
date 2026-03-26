import { createShellMcpServer } from '../../apps/shell/src/mcp.js';
import { mountMcpHttp } from '../../packages/mcp-utils/src/index.js';
import { shutdownAllPtys } from '../../apps/shell/src/create-mcp-state.js';
import type { Express } from 'express';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from '../../apps/shell/src/shell-types.js';
export { router } from './shell-routes.js';
export { initShell } from './shell-socket.js';

// ── MCP integration ─────────────────────────────────────────────────────────
// Shell MCP tools proxy to the REST API, so no local state wiring is needed.

export function mountShellMcp(app: Express, prefix: string): void {
  mountMcpHttp(app, () => createShellMcpServer(), prefix);
}

// ── Shutdown ────────────────────────────────────────────────────────────────

export function shutdownShell(): void {
  shutdownAllPtys();
}
