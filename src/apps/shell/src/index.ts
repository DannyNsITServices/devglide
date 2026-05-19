import { createShellMcpServer } from './mcp.js';
import { runStdio } from '../../../packages/mcp-utils/src/index.js';

export type { PtyEntry, PaneInfo, DashboardState, ShellConfig, McpState } from './shell-types.js';

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
// All tools proxy to the unified HTTP server's REST API — no local PTY state needed.
const mcpServer = createShellMcpServer();
await runStdio(mcpServer);
console.error('Devglide Shell MCP server running on stdio');
