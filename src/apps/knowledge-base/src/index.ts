#!/usr/bin/env node
import { createKnowledgeBaseMcpServer } from "./mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

if (process.argv.includes("--stdio")) {
  const server = createKnowledgeBaseMcpServer();
  await runStdio(server);
  console.error("Devglide Knowledge Base MCP server running on stdio");
}
