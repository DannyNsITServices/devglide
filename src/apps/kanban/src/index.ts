import { createKanbanMcpServer } from "./mcp.js";
import { runStdio } from "../../../packages/mcp-utils/src/index.js";
import { readActiveProjectId } from "./db.js";

if (process.argv.includes("--stdio")) {
  // MCP mode — pin to active project at startup
  const projectId = readActiveProjectId();
  if (projectId) {
    console.error(`Devglide Kanban MCP server bound to project ${projectId}`);
  }
  const mcpServer = createKanbanMcpServer(projectId);
  await runStdio(mcpServer);
  console.error("Devglide Kanban MCP server running on stdio");
}
