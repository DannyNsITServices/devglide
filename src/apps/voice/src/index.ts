#!/usr/bin/env node
import { createVoiceMcpServer } from "./mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const mcpServer = createVoiceMcpServer();
  await runStdio(mcpServer);
  console.error("Devglide Voice MCP server running on stdio");
}
