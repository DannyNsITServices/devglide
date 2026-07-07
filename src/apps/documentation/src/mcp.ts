import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DocumentationStore } from '../services/documentation-store.js';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../../packages/mcp-utils/src/index.js';
import type { DocType } from '../types.js';

export function createDocumentationMcpServer(): McpServer {
  const server = createDevglideMcpServer(
    'devglide-documentation',
    '0.1.0',
    'Operational guidance for DevGlide tools — workflows, troubleshooting, examples',
    {
      instructions: [
        '## Documentation — Usage Conventions',
        '',
        '### Purpose',
        '- The documentation server provides operational guidance that tool schemas alone cannot carry.',
        '- It answers: how does this tool execute, what must be running, what does a failure mean, what to do next.',
        '- Content types: tool guides, workflows, examples, troubleshooting, project overrides.',
        '',
        '### When to use',
        '- **Before using devglide-test or devglide-log** for a verification task, call `docs_context` with your task description to get the full operational loop.',
        '- **When a tool run fails with a known symptom**, call `docs_get_troubleshooting` or `docs_match` to find diagnosis and fix guidance.',
        '- **To discover available documentation**, call `docs_list` or `docs_match` with a keyword query.',
        '',
        '### Reading documentation',
        '- Use `docs_list` to browse all available documentation entries, optionally filtered by type or tool name.',
        '- Use `docs_match` to search documentation by keyword query — returns ranked results.',
        '- Use `docs_get_tool_guide` to get the full operational guide for a specific tool.',
        '- Use `docs_get_workflow` to get a step-by-step workflow by name.',
        '- Use `docs_get_troubleshooting` to find troubleshooting entries by tool name and symptom.',
        '- Use `docs_context` to get a compiled markdown bundle relevant to a task query — best for injection into your working context.',
        '',
        '### Writing documentation',
        '- Use `docs_add` to create a new documentation entry (tool guide, workflow, example, troubleshooting, or project override).',
        '- Use `docs_update` to modify an existing entry by ID.',
        '- Use `docs_remove` to delete an entry by ID.',
      ],
    },
  );

  const store = DocumentationStore.getInstance();

  // ── 1. docs_list ──────────────────────────────────────────────────────────

  server.tool(
    'docs_list',
    'List all documentation entries. Optionally filter by type, tool name, or tag.',
    {
      type: z.string().optional().describe('Filter by content type: tool-guide, workflow, example, troubleshooting, project-override'),
      toolName: z.string().optional().describe('Filter by tool name (e.g. "devglide-test")'),
      tag: z.string().optional().describe('Filter by tag'),
    },
    async ({ type, toolName, tag }) => {
      const entries = await store.list({
        type: type as DocType | undefined,
        toolName,
        tag,
      });
      return jsonResult(entries);
    },
  );

  // ── 2. docs_match ─────────────────────────────────────────────────────────

  server.tool(
    'docs_match',
    'Search documentation by keyword query. Returns ranked summaries with IDs for discovery.',
    {
      query: z.string().describe('Search query — keywords to match against titles, summaries, tags, and types'),
    },
    async ({ query }) => {
      const results = await store.match(query);
      return jsonResult(results);
    },
  );

  // ── 3. docs_get_tool_guide ────────────────────────────────────────────────

  server.tool(
    'docs_get_tool_guide',
    'Get the full operational guide for a specific tool. Returns execution model, prerequisites, result semantics, patterns, and anti-patterns.',
    {
      toolName: z.string().describe('Tool name (e.g. "devglide-test", "devglide-log")'),
    },
    async ({ toolName }) => {
      const guide = await store.getToolGuide(toolName);
      if (!guide) return errorResult(`No tool guide found for "${toolName}"`);
      return jsonResult(guide);
    },
  );

  // ── 4. docs_get_workflow ──────────────────────────────────────────────────

  server.tool(
    'docs_get_workflow',
    'Get a step-by-step workflow by name. Returns the full sequence with preflight, steps, success criteria, and failure branches.',
    {
      name: z.string().describe('Workflow name (e.g. "verify-ui-flow-with-devglide-test-and-devglide-log")'),
    },
    async ({ name }) => {
      const workflow = await store.getWorkflow(name);
      if (!workflow) return errorResult(`No workflow found for "${name}"`);
      return jsonResult(workflow);
    },
  );

  // ── 5. docs_get_troubleshooting ───────────────────────────────────────────

  server.tool(
    'docs_get_troubleshooting',
    'Find troubleshooting entries by tool name and symptom. Returns likely causes, diagnosis steps, and fix instructions.',
    {
      toolName: z.string().describe('Tool name (e.g. "devglide-test")'),
      symptom: z.string().describe('Symptom description (e.g. "no result found", "scenario never runs")'),
    },
    async ({ toolName, symptom }) => {
      const entries = await store.getTroubleshooting(toolName, symptom);
      if (entries.length === 0) return errorResult(`No troubleshooting entry found for "${toolName}" with symptom "${symptom}"`);
      return jsonResult(entries);
    },
  );

  // ── 6. docs_context ───────────────────────────────────────────────────────

  server.tool(
    'docs_context',
    'Get compiled documentation as markdown for a task query. Returns the most relevant tool guides, workflows, examples, and troubleshooting bundled for LLM context injection.',
    {
      query: z.string().optional().describe('Task description to match relevant docs (e.g. "test club creation and verify logs"). Omit to get all docs.'),
      projectId: z.string().optional().describe('Optional project ID to include project-specific overrides'),
    },
    async ({ query, projectId }) => {
      const markdown = await store.getCompiledContext(query, projectId);
      return {
        content: [{ type: 'text' as const, text: markdown || 'No documentation entries found.' }],
      };
    },
  );

  // ── 7. docs_add ───────────────────────────────────────────────────────────

  server.tool(
    'docs_add',
    'Create a new documentation entry. Provide the full content as a JSON string matching the content type schema.',
    {
      type: z.string().describe('Content type: tool-guide, workflow, example, troubleshooting, project-override'),
      content: z.string().describe('JSON string with the full entry content (all fields for the chosen type)'),
    },
    async ({ type, content }) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        return errorResult('Invalid JSON in content field');
      }

      parsed.type = type;
      if (!parsed.tags) parsed.tags = [];

      try {
        const entry = await store.save(parsed as any);
        return jsonResult(entry);
      } catch (err) {
        return errorResult(`Validation failed: ${(err as Error).message}`);
      }
    },
  );

  // ── 8. docs_update ────────────────────────────────────────────────────────

  server.tool(
    'docs_update',
    'Update an existing documentation entry by ID. Provide only the fields to change as a JSON string.',
    {
      id: z.string().describe('Entry ID'),
      content: z.string().describe('JSON string with the fields to update'),
    },
    async ({ id, content }) => {
      let updates: Record<string, unknown>;
      try {
        updates = JSON.parse(content);
      } catch {
        return errorResult('Invalid JSON in content field');
      }
      // Never let a payload change identity or type
      delete updates.id;
      delete updates.type;
      delete updates.projectId;

      try {
        // Atomic read-merge-write inside the store lock — a separate
        // get()+save() here loses concurrent field updates.
        const entry = await store.update(id, updates as Parameters<typeof store.update>[1]);
        if (!entry) return errorResult('Entry not found');
        return jsonResult(entry);
      } catch (err) {
        return errorResult(`Validation failed: ${(err as Error).message}`);
      }
    },
  );

  // ── 9. docs_remove ────────────────────────────────────────────────────────

  server.tool(
    'docs_remove',
    'Remove a documentation entry by ID.',
    {
      id: z.string().describe('Entry ID'),
    },
    async ({ id }) => {
      const deleted = await store.delete(id);
      if (!deleted) return errorResult('Entry not found');
      return jsonResult({ ok: true });
    },
  );

  return server;
}
