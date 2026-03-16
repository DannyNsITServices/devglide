#!/usr/bin/env node
import { createWorkflowMcpServer } from "../mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const server = createWorkflowMcpServer();
  await runStdio(server);
  console.error("Devglide Workflow MCP server running on stdio");
}
