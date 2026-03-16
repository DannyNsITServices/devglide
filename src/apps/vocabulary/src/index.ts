#!/usr/bin/env node
import { createVocabularyMcpServer } from "../mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const server = createVocabularyMcpServer();
  await runStdio(server);
  console.error("Devglide Vocabulary MCP server running on stdio");
}
