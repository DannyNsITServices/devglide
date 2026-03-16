#!/usr/bin/env node
import { createPromptsMcpServer } from "../mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

if (process.argv.includes("--stdio")) {
  const server = createPromptsMcpServer();
  await runStdio(server);
  console.error("Devglide Prompts MCP server running on stdio");
}
