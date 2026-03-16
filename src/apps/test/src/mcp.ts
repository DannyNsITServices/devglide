import { z } from "zod";
import { createDevglideMcpServer } from "../../../packages/mcp-utils/src/index.js";
import { ScenarioManager } from "./services/scenario-manager.js";
import { ScenarioStore } from "./services/scenario-store.js";
import { getActiveProject } from "../../../project-context.js";

const UNIFIED_BASE = `http://localhost:${process.env.PORT ?? 7000}`;

/** POST/GET helper that proxies to the unified server's HTTP API */
async function unifiedFetch(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${UNIFIED_BASE}${path}`, opts);
}

export function createTestMcpServer() {
  const server = createDevglideMcpServer(
    "devglide-test",
    "0.1.0",
    "AI-driven browser test automation. Describe what to test in natural language and " +
    "scenarios are generated and executed automatically against your live UI. " +
    "External apps enable automation via <script src=\"http://localhost:7000/devtools.js\"></script> — " +
    "the active project context provides the target automatically. " +
    "DevGlide monorepo apps need no setup. " +
    "Targets can be absolute paths or simple app names (e.g. 'kanban', 'dashboard')."
  );
  const scenarioManager = ScenarioManager.getInstance();

  server.tool(
    "test_commands",
    "List available browser automation commands",
    {},
    async () => {
      const catalog = scenarioManager.getCommandsCatalog();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }],
      };
    }
  );

  server.tool(
    "test_run_scenario",
    "Generate and run a browser test scenario from a natural language description or explicit steps. The browser must have devtools.js loaded (via <script src=\"http://localhost:7000/devtools.js\"></script>).",
    {
      name: z.string().optional().describe("Scenario name"),
      description: z.string().optional().describe("Scenario description"),
      target: z
        .string()
        .optional()
        .describe(
          "Target identifier — defaults to active project. Can be an absolute path or a simple app name (e.g. 'kanban', 'dashboard') which is resolved automatically"
        ),
      steps: z
        .array(
          z.object({
            command: z.string().describe("Command name"),
            selector: z.string().optional(),
            text: z.string().optional(),
            value: z.string().optional(),
            timeout: z.number().optional(),
            ms: z.number().optional(),
            clear: z.boolean().optional(),
            contains: z.boolean().optional(),
            path: z.string().optional(),
          })
        )
        .describe("Steps to execute sequentially"),
    },
    async ({ name, description, target, steps }) => {
      const res = await unifiedFetch("/api/test/trigger/scenarios", "POST", {
        name, description, target, steps,
      });
      const data = await res.json();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "test_save_scenario",
    "Save a scenario to the library for later reuse",
    {
      name: z.string().describe("Scenario name"),
      description: z.string().optional().describe("Scenario description"),
      target: z
        .string()
        .optional()
        .describe(
          "Target identifier — defaults to active project name. Can be an absolute path or a simple app name (e.g. 'kanban', 'dashboard')"
        ),
      steps: z
        .array(
          z.object({
            command: z.string().describe("Command name"),
            selector: z.string().optional(),
            text: z.string().optional(),
            value: z.string().optional(),
            timeout: z.number().optional(),
            ms: z.number().optional(),
            clear: z.boolean().optional(),
            contains: z.boolean().optional(),
            path: z.string().optional(),
          })
        )
        .describe("Steps to execute sequentially"),
    },
    async ({ name, description, target, steps }) => {
      const effectiveTarget = target || getActiveProject()?.name || '';
      const saved = await ScenarioStore.getInstance().save({
        name, description, target: effectiveTarget, steps,
        projectId: getActiveProject()?.id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(saved, null, 2) }],
      };
    }
  );

  server.tool(
    "test_list_saved",
    "List saved scenarios — defaults to active project when no target is given",
    {
      target: z.string().optional().describe(
        "Target to filter by — app name (e.g. 'devglide', 'kanban') or absolute path. Defaults to active project."
      ),
    },
    async ({ target }) => {
      const effectiveTarget = target || getActiveProject()?.name || getActiveProject()?.path || '';
      const store = ScenarioStore.getInstance();
      const scenarios = effectiveTarget
        ? await store.list(effectiveTarget)
        : await store.listAll();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(scenarios, null, 2) }],
      };
    }
  );

  server.tool(
    "test_run_saved",
    "Run a saved scenario by ID",
    {
      id: z.string().describe("Saved scenario ID"),
    },
    async ({ id }) => {
      const res = await unifiedFetch(`/api/test/trigger/scenarios/saved/${id}/run`, "POST");
      if (res.status === 404) {
        return {
          content: [{ type: "text" as const, text: `Scenario not found: ${id}` }],
        };
      }
      const data = await res.json();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "test_delete_saved",
    "Delete a saved scenario from the library",
    {
      id: z.string().describe("Saved scenario ID"),
    },
    async ({ id }) => {
      const deleted = await ScenarioStore.getInstance().delete(id);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted ? `Scenario ${id} deleted` : `Scenario not found: ${id}`,
          },
        ],
      };
    }
  );

  server.tool(
    "test_get_result",
    "Get the execution result of a scenario by ID. Returns status (passed/failed), failed step index, error message, and duration.",
    {
      id: z.string().describe("Scenario ID to fetch the result for"),
    },
    async ({ id }) => {
      const res = await unifiedFetch(`/api/test/trigger/scenarios/${id}/result`);
      if (res.status === 404) {
        return {
          content: [{ type: "text" as const, text: `No result found for scenario: ${id}` }],
        };
      }
      const data = await res.json();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}
