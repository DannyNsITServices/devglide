#!/usr/bin/env node
import { createDocumentationMcpServer } from "./mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const server = createDocumentationMcpServer();
  await runStdio(server);
  console.error("Devglide Documentation MCP server running on stdio");
}
