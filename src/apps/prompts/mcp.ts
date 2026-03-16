import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PromptStore } from './services/prompt-store.js';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../packages/mcp-utils/src/index.js';

export function createPromptsMcpServer(): McpServer {
  const server = createDevglideMcpServer(
    'devglide-prompts',
    '0.1.0',
    'Reusable prompt library with variable interpolation and ratings',
    {
      instructions: [
        '## Prompts — Usage Conventions',
        '',
        '### Purpose',
        '- The prompt library stores reusable LLM prompt templates with {{variable}} placeholders.',
        '- Use it to avoid rewriting the same prompt from scratch in every conversation.',
        '',
        '### Managing prompts',
        '- Use `prompts_list` and `prompts_render` to reuse existing prompts before writing new ones from scratch.',
        '- Use `prompts_get` to retrieve the full prompt including content and variables.',
        '- Use `prompts_add` to save a new reusable prompt template.',
        '- Use `prompts_update` to refine content, adjust rating, or add evaluation notes.',
        '- Use `prompts_remove` to delete a prompt by ID.',
        '- Use `prompts_context` to get all prompts as compiled markdown for LLM context injection.',
      ],
    },
  );

  const store = PromptStore.getInstance();

  // ── 1. prompts_list ───────────────────────────────────────────────────────

  server.tool(
    'prompts_list',
    'List all prompts. Optionally filter by category, tags, or keyword search.',
    {
      category: z.string().optional().describe('Filter by category'),
      tags: z.string().optional().describe('JSON array of tags to filter by (all must match)'),
      search: z.string().optional().describe('Text search across title, description, category, and tags'),
    },
    async ({ category, tags, search }) => {
      let parsedTags: string[] | undefined;
      if (tags) {
        try { parsedTags = JSON.parse(tags); } catch { return errorResult('Invalid JSON for tags'); }
      }
      const entries = await store.list({ category, tags: parsedTags, search });
      return jsonResult(entries);
    },
  );

  // ── 2. prompts_get ────────────────────────────────────────────────────────

  server.tool(
    'prompts_get',
    'Get the full prompt by ID, including content and detected variables.',
    {
      id: z.string().describe('Prompt ID'),
    },
    async ({ id }) => {
      const entry = await store.get(id);
      if (!entry) return errorResult(`Prompt "${id}" not found`);
      return jsonResult(entry);
    },
  );

  // ── 3. prompts_render ─────────────────────────────────────────────────────

  server.tool(
    'prompts_render',
    'Render a prompt template by substituting {{varName}} placeholders with provided values.',
    {
      id: z.string().describe('Prompt ID'),
      vars: z.string().optional().describe('JSON object mapping variable names to values, e.g. {"name":"World"}'),
    },
    async ({ id, vars }) => {
      let parsedVars: Record<string, string> = {};
      if (vars) {
        try { parsedVars = JSON.parse(vars); } catch { return errorResult('Invalid JSON for vars'); }
      }
      const rendered = await store.render(id, parsedVars);
      if (rendered === null) return errorResult(`Prompt "${id}" not found`);
      return { content: [{ type: 'text' as const, text: rendered }] };
    },
  );

  // ── 4. prompts_add ────────────────────────────────────────────────────────

  server.tool(
    'prompts_add',
    'Add a new prompt template to the library.',
    {
      title: z.string().describe('Human-readable name for this prompt'),
      content: z.string().describe('Prompt text; use {{varName}} for variable placeholders'),
      description: z.string().optional().describe('What this prompt does'),
      category: z.string().optional().describe('Grouping category (e.g. "code-review", "refactor")'),
      tags: z.string().optional().describe('JSON array of tag strings'),
      model: z.string().optional().describe('Preferred model hint (e.g. "claude-opus-4-6")'),
      temperature: z.number().min(0).max(2).optional().describe('Preferred temperature hint'),
      rating: z.number().int().min(1).max(5).optional().describe('Quality rating 1–5'),
      notes: z.string().optional().describe('Evaluation notes'),
      scope: z.enum(['project', 'global']).optional().describe('Save as project-scoped or global (default: project if active, else global)'),
    },
    async ({ title, content, description, category, tags, model, temperature, rating, notes, scope }) => {
      let parsedTags: string[] = [];
      if (tags) {
        try { parsedTags = JSON.parse(tags); } catch { return errorResult('Invalid JSON for tags'); }
      }
      const entry = await store.save({ title, content, description, category, tags: parsedTags, model, temperature, rating, notes, scope });
      return jsonResult(entry);
    },
  );

  // ── 5. prompts_update ─────────────────────────────────────────────────────

  server.tool(
    'prompts_update',
    'Update an existing prompt by ID.',
    {
      id: z.string().describe('Prompt ID'),
      title: z.string().optional().describe('New title'),
      content: z.string().optional().describe('New prompt content'),
      description: z.string().nullable().optional().describe('New description (null to clear)'),
      category: z.string().nullable().optional().describe('New category (null to clear)'),
      tags: z.string().nullable().optional().describe('JSON array of tag strings (null to clear)'),
      model: z.string().nullable().optional().describe('Preferred model hint (null to clear)'),
      temperature: z.number().min(0).max(2).nullable().optional().describe('Preferred temperature (null to clear)'),
      rating: z.number().int().min(1).max(5).nullable().optional().describe('Quality rating 1–5 (null to clear)'),
      notes: z.string().nullable().optional().describe('Evaluation notes (null to clear)'),
    },
    async ({ id, title, content, description, category, tags, model, temperature, rating, notes }) => {
      let parsedTags: string[] | null | undefined;
      if (tags === null) {
        parsedTags = [];
      } else if (tags) {
        try { parsedTags = JSON.parse(tags); } catch { return errorResult('Invalid JSON for tags'); }
      }

      const updated = await store.update(id, { title, content, description, category, tags: parsedTags, model, temperature, rating, notes });
      if (!updated) return errorResult('Prompt not found');
      return jsonResult(updated);
    },
  );

  // ── 6. prompts_remove ─────────────────────────────────────────────────────

  server.tool(
    'prompts_remove',
    'Delete a prompt by ID.',
    {
      id: z.string().describe('Prompt ID'),
    },
    async ({ id }) => {
      const deleted = await store.delete(id);
      if (!deleted) return errorResult('Prompt not found');
      return jsonResult({ ok: true });
    },
  );

  // ── 7. prompts_context ──────────────────────────────────────────────────

  server.tool(
    'prompts_context',
    'Get all prompts as compiled markdown for LLM context injection.',
    {},
    async () => {
      const markdown = await store.getCompiledContext();
      return {
        content: [{ type: 'text' as const, text: markdown || 'No prompts defined.' }],
      };
    },
  );

  return server;
}
