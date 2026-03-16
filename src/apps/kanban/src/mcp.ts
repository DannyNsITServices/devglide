import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDevglideMcpServer } from "../../../packages/mcp-utils/src/index.js";
import { registerFeatureTools } from "./tools/feature-tools.js";
import { registerItemTools } from "./tools/item-tools.js";
import { registerVersionedEntryTools } from "./tools/versioned-entry-tools.js";

// ── Factory ──────────────────────────────────────────────────────────────────

export function createKanbanMcpServer(
  projectId?: string | null
): McpServer {
  const server = createDevglideMcpServer(
    "devglide-kanban",
    "0.1.0",
    "Kanban board management for features, tasks, and bugs",
    {
      instructions: [
        "## Kanban — Workflow Conventions",
        "",
        "### Picking up work",
        "- When looking for tasks to work on, search the **Todo** column by default (columnName: 'Todo') unless the user specifies a different column or a specific task.",
        "- Each feature has its own kanban board with columns: Backlog → Todo → In Progress → In Review → Testing → Done.",
        "",
        "### Updating task status",
        "- Move items to **In Progress** when starting work.",
        "- Move items to **In Review** or **Testing** when work is complete.",
        "- **Never** move items to **Done** — only the user can mark items as done.",
        "",
        "### Creating items",
        "- New items can only be created in **Backlog** or **Todo** columns.",
        "- Default priority is MEDIUM if not specified.",
        "- Use labels to categorize work (e.g. 'ui', 'api', 'search', 'research').",
        "",
        "### Review feedback",
        "- Items in **In Review** may have review history with versioned notes on what needs to change.",
        "- Use `hasReviewFeedback: true` on kanban_list_items to find items that need revisions.",
        "- Use `kanban_append_review` to add new review feedback (append-only, versioned).",
        "- Use `kanban_get_review_history` to read the full review history.",
        "",
        "### Work log",
        "- Use `kanban_append_work_log` to record what was done while working on a task.",
        "- Use `kanban_get_work_log` to read the full work log history.",
        "- Work log entries are append-only with automatic versioning.",
        "",
        "### Quick reference — commonly confused parameters",
        "- `kanban_append_work_log(id, content)` — `content` is the log text (not `entry` or `text`).",
        "- `kanban_append_review(id, content)` — `content` is the review feedback text.",
        "- `kanban_create_item(title, featureId, ...)` — `title` and `featureId` are required. Use `columnName` (e.g. 'Todo') or `columnId` to place it.",
        "- `kanban_move_item(id, ...)` — use `columnName` (e.g. 'In Progress') or `columnId` to set destination.",
      ],
    }
  );

  registerFeatureTools(server, projectId);
  registerItemTools(server, projectId);
  registerVersionedEntryTools(server, projectId);

  return server;
}
