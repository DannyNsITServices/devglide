import { createLogMcpServer } from "./mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const mcpServer = createLogMcpServer();
  await runStdio(mcpServer);
  console.error("Devglide Log MCP server running on stdio");
}
