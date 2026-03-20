import { createShellMcpServer } from './mcp.js';
import { runStdio } from '../../../packages/mcp-utils/src/index.js';
import { createShellMcpState, shutdownAllPtys } from './create-mcp-state.js';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from './shell-types.js';

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(): void {
  console.log('\nShutting down — killing PTY processes...');
  shutdownAllPtys();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
const mcpServer = createShellMcpServer(createShellMcpState());
await runStdio(mcpServer);
console.error('Devglide Shell MCP server running on stdio');
