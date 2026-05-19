import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VocabularyStore } from '../services/vocabulary-store.js';
import { jsonResult, errorResult, createDevglideMcpServer } from '../../../packages/mcp-utils/src/index.js';

export function createVocabularyMcpServer(): McpServer {
  const server = createDevglideMcpServer(
    'devglide-vocabulary',
    '0.1.0',
    'Project-scoped domain vocabulary for LLM context enrichment',
    {
      instructions: [
        '## Vocabulary — Usage Conventions',
        '',
        '### Purpose',
        '- Vocabulary entries define domain-specific terms, abbreviations, and jargon.',
        '- The LLM uses these to accurately interpret short or ambiguous user language.',
        '',
        '### Managing vocabulary',
        '- Use `vocabulary_list` to see all terms.',
        '- Use `vocabulary_lookup` to expand a term by name or alias.',
        '- Use `vocabulary_add` to define a new term.',
        '- Use `vocabulary_update` to modify an existing entry.',
        '- Use `vocabulary_remove` to delete a term.',
        '- Use `vocabulary_context` to get all terms as compiled markdown for LLM injection.',
      ],
    },
  );

  const store = VocabularyStore.getInstance();

  // ── 1. vocabulary_list ────────────────────────────────────────────────────

  server.tool(
    'vocabulary_list',
    'List all vocabulary entries. Optionally filter by category or tag.',
    {
      category: z.string().optional().describe('Filter by category'),
      tag: z.string().optional().describe('Filter by tag'),
    },
    async ({ category, tag }) => {
      const entries = await store.list({ category, tag });
      return jsonResult(entries);
    },
  );

  // ── 2. vocabulary_lookup ──────────────────────────────────────────────────

  server.tool(
    'vocabulary_lookup',
    'Look up a term by name or alias. Returns the full entry with definition.',
    {
      term: z.string().describe('Term or alias to look up'),
    },
    async ({ term }) => {
      const entry = await store.lookup(term);
      if (!entry) return errorResult(`Term "${term}" not found`);
      return jsonResult(entry);
    },
  );

  // ── 3. vocabulary_add ─────────────────────────────────────────────────────

  server.tool(
    'vocabulary_add',
    'Add a new vocabulary entry. Define a domain term with its full definition.',
    {
      term: z.string().describe('The short term or abbreviation'),
      definition: z.string().describe('Full definition or expansion of the term'),
      aliases: z.string().optional().describe('JSON array of alternative names for this term'),
      category: z.string().optional().describe('Category to group the term under (e.g. "API", "Database", "Business")'),
      tags: z.string().optional().describe('JSON array of tag strings'),
    },
    async ({ term, definition, aliases, category, tags }) => {
      const existing = await store.lookup(term);
      if (existing) return errorResult(`Term "${term}" already exists (id: ${existing.id})`);

      let parsedAliases: string[] | undefined;
      if (aliases) {
        try { parsedAliases = JSON.parse(aliases); } catch { return errorResult('Invalid JSON for aliases'); }
      }

      let parsedTags: string[] = [];
      if (tags) {
        try { parsedTags = JSON.parse(tags); } catch { return errorResult('Invalid JSON for tags'); }
      }

      const entry = await store.save({
        term,
        definition,
        aliases: parsedAliases,
        category,
        tags: parsedTags,
      });

      return jsonResult(entry);
    },
  );

  // ── 4. vocabulary_update ──────────────────────────────────────────────────

  server.tool(
    'vocabulary_update',
    'Update an existing vocabulary entry by ID.',
    {
      id: z.string().describe('Entry ID'),
      term: z.string().optional().describe('New term'),
      definition: z.string().optional().describe('New definition'),
      aliases: z.string().optional().describe('JSON array of alternative names'),
      category: z.string().optional().describe('New category'),
      tags: z.string().optional().describe('JSON array of tag strings'),
    },
    async ({ id, term, definition, aliases, category, tags }) => {
      const existing = await store.get(id);
      if (!existing) return errorResult('Entry not found');

      let parsedAliases: string[] | undefined = existing.aliases;
      if (aliases) {
        try { parsedAliases = JSON.parse(aliases); } catch { return errorResult('Invalid JSON for aliases'); }
      }

      let parsedTags: string[] = existing.tags;
      if (tags) {
        try { parsedTags = JSON.parse(tags); } catch { return errorResult('Invalid JSON for tags'); }
      }

      const updated = await store.save({
        id,
        term: term ?? existing.term,
        definition: definition ?? existing.definition,
        aliases: parsedAliases,
        category: category ?? existing.category,
        tags: parsedTags,
        projectId: existing.projectId,
      });

      return jsonResult(updated);
    },
  );

  // ── 5. vocabulary_remove ──────────────────────────────────────────────────

  server.tool(
    'vocabulary_remove',
    'Remove a vocabulary entry by ID.',
    {
      id: z.string().describe('Entry ID'),
    },
    async ({ id }) => {
      const deleted = await store.delete(id);
      if (!deleted) return errorResult('Entry not found');
      return jsonResult({ ok: true });
    },
  );

  // ── 6. vocabulary_context ─────────────────────────────────────────────────

  server.tool(
    'vocabulary_context',
    'Get all vocabulary entries compiled as markdown context for LLM injection. Optionally filter by project.',
    {
      projectId: z.string().optional().describe('Optional project ID to filter entries'),
    },
    async ({ projectId }) => {
      const markdown = await store.getCompiledContext(projectId);
      return {
        content: [{ type: 'text' as const, text: markdown || 'No vocabulary entries defined.' }],
      };
    },
  );

  return server;
}
