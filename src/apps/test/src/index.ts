import { createTestMcpServer } from "./mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";

// ── Stdio MCP mode ──────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const mcpServer = createTestMcpServer();
  await runStdio(mcpServer);
  console.error("Devglide Test MCP server running on stdio");
}
