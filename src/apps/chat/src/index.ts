#!/usr/bin/env node
import { createChatMcpServer } from "../mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const server = createChatMcpServer();
  await runStdio(server);
  console.error("Devglide Chat MCP server running on stdio");
}
