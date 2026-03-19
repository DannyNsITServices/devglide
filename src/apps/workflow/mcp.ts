import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkflowStore } from './services/workflow-store.js';
import { getActiveProject } from '../../project-context.js';
import type { Workflow, WorkflowNode, WorkflowEdge, VariableDefinition } from './types.js';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../packages/mcp-utils/src/index.js';

// ── Zod schemas for validating MCP input ─────────────────────────────────────
const nodeInputSchema = z.array(z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  config: z.record(z.unknown()),
  position: z.object({ x: z.number(), y: z.number() }),
}).passthrough());

const edgeInputSchema = z.array(z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
}).passthrough());

const variableInputSchema = z.array(z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'json']),
}).passthrough());

export function createWorkflowMcpServer(): McpServer {
  const server = createDevglideMcpServer(
    'devglide-workflow',
    '0.1.0',
    'Workflow engine for creating and managing passive instruction templates for LLM integration',
    {
      instructions: [
        '## Workflow — Usage Conventions',
        '',
        '### Workflows',
        '- Workflows are passive instruction templates that LLMs pick up automatically.',
        '- They are directed acyclic graphs (DAGs) of nodes connected by edges.',
        '- Node types include triggers, shell commands, kanban ops, git ops, tests, log, file I/O, LLM, HTTP, decisions, loops, and sub-workflows.',
        '',
        '### Matching workflows to prompts',
        '- Call `workflow_match` **only** when the user\'s prompt explicitly contains the word "workflow".',
        '- If a match is found, follow the returned workflow instructions exactly.',
        '',
        '### Instructions',
        '- Use `workflow_get_instructions` to get compiled instructions from all enabled workflows.',
        '- Use `workflow_toggle` to enable or disable a workflow.',
        '',
        '### Managing workflows',
        '- Use `workflow_list` to see all workflows.',
        '- Use `workflow_get` to get a full workflow by ID.',
        '- Use `workflow_create` to create a new workflow.',
      ],
    },
  );

  const store = WorkflowStore.getInstance();

  // ── 1. workflow_list ──────────────────────────────────────────────────────

  server.tool(
    'workflow_list',
    'List workflows visible to the current project context (project-scoped + global). Returns summaries with id, name, tags, node/edge counts. Pass projectId to scope to a specific project.',
    {
      projectId: z.string().optional().describe('Optional project ID to scope results. Defaults to the active project.'),
    },
    async ({ projectId }) => {
      const scopeId = projectId ?? getActiveProject()?.id;
      const workflows = await store.list(scopeId);
      return jsonResult(workflows);
    },
  );

  // ── 2. workflow_get ───────────────────────────────────────────────────────

  server.tool(
    'workflow_get',
    'Get a workflow by ID. Returns the full workflow graph with nodes, edges, and variables.',
    { id: z.string().describe('Workflow ID') },
    async ({ id }) => {
      const workflow = await store.get(id);
      if (!workflow) return errorResult('Workflow not found');
      return jsonResult(workflow);
    },
  );

  // ── 3. workflow_create ────────────────────────────────────────────────────

  server.tool(
    'workflow_create',
    'Create a new workflow. Nodes and edges are passed as JSON strings.',
    {
      name: z.string().describe('Workflow name'),
      description: z.string().optional().describe('Workflow description'),
      nodes: z.string().describe('JSON array of WorkflowNode objects'),
      edges: z.string().describe('JSON array of WorkflowEdge objects'),
      variables: z.string().optional().describe('JSON array of VariableDefinition objects'),
      tags: z.string().optional().describe('JSON array of tag strings'),
    },
    async ({ name, description, nodes, edges, variables, tags }) => {
      let parsedNodes: WorkflowNode[];
      let parsedEdges: WorkflowEdge[];
      let parsedVariables: VariableDefinition[] = [];
      let parsedTags: string[] = [];

      try {
        const raw = JSON.parse(nodes);
        const result = nodeInputSchema.safeParse(raw);
        if (!result.success) return errorResult(`Invalid nodes: ${result.error.issues[0]?.message}`);
        parsedNodes = result.data as unknown as WorkflowNode[];
      } catch {
        return errorResult('Invalid JSON for nodes');
      }

      try {
        const raw = JSON.parse(edges);
        const result = edgeInputSchema.safeParse(raw);
        if (!result.success) return errorResult(`Invalid edges: ${result.error.issues[0]?.message}`);
        parsedEdges = result.data as WorkflowEdge[];
      } catch {
        return errorResult('Invalid JSON for edges');
      }

      if (variables) {
        try {
          const raw = JSON.parse(variables);
          const result = variableInputSchema.safeParse(raw);
          if (!result.success) return errorResult(`Invalid variables: ${result.error.issues[0]?.message}`);
          parsedVariables = result.data as VariableDefinition[];
        } catch {
          return errorResult('Invalid JSON for variables');
        }
      }

      if (tags) {
        try {
          const raw = JSON.parse(tags);
          const result = z.array(z.string()).safeParse(raw);
          if (!result.success) return errorResult(`Invalid tags: ${result.error.issues[0]?.message}`);
          parsedTags = result.data;
        } catch {
          return errorResult('Invalid JSON for tags');
        }
      }

      const workflow = await store.save({
        name,
        description,
        version: 1,
        nodes: parsedNodes,
        edges: parsedEdges,
        variables: parsedVariables,
        tags: parsedTags,
      });

      return jsonResult(workflow);
    },
  );

  // ── 4. workflow_get_instructions ──────────────────────────────────────────

  server.tool(
    'workflow_get_instructions',
    'Get compiled instructions from all enabled workflows as markdown. Optionally filter by projectId.',
    {
      projectId: z.string().optional().describe('Optional project ID to filter workflows'),
    },
    async ({ projectId }) => {
      const scopeId = projectId ?? getActiveProject()?.id;
      const markdown = await store.getCompiledInstructions(scopeId);
      return {
        content: [{ type: 'text' as const, text: markdown }],
      };
    },
  );

  // ── 5. workflow_match ───────────────────────────────────────────────────────

  server.tool(
    'workflow_match',
    'Match a user prompt against all enabled workflows. Returns only workflows whose name, description, tags, or node content match the prompt, ranked by relevance. Only call this when the user explicitly mentions "workflow" in their prompt.',
    {
      prompt: z.string().describe('The user prompt to match against workflows'),
      projectId: z.string().optional().describe('Optional project ID to scope matching'),
    },
    async ({ prompt, projectId }) => {
      const scopeId = projectId ?? getActiveProject()?.id;
      const result = await store.match(prompt, scopeId);
      if (result.matches.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No matching workflows found.' }],
        };
      }
      return jsonResult(result);
    },
  );

  // ── 6. workflow_toggle ──────────────────────────────────────────────────────

  server.tool(
    'workflow_toggle',
    'Toggle a workflow enabled/disabled. If currently enabled (or undefined), disables it. If disabled, enables it.',
    {
      id: z.string().describe('Workflow ID'),
    },
    async ({ id }) => {
      const workflow = await store.get(id);
      if (!workflow) return errorResult('Workflow not found');

      const newEnabled = workflow.enabled === false ? true : false;
      const updated = await store.save({
        ...workflow,
        enabled: newEnabled,
      });

      return jsonResult(updated);
    },
  );

  return server;
}
