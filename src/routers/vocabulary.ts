import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { VocabularyStore } from '../apps/vocabulary/services/vocabulary-store.js';

// ── Zod schemas for HTTP input validation ────────────────────────────────────

const createEntrySchema = z.object({
  term: z.string().min(1, 'term is required'),
  definition: z.string().min(1, 'definition is required'),
  aliases: z.array(z.string()).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateEntrySchema = z.object({
  term: z.string().optional(),
  definition: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export { createVocabularyMcpServer } from '../apps/vocabulary/mcp.js';

export const router: Router = Router();

const store = VocabularyStore.getInstance();

// GET /entries — list all vocabulary entries
router.get('/entries', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const tag = req.query.tag as string | undefined;
    const entries = await store.list({ category, tag });
    res.json(entries);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /entries/lookup — lookup a term by name or alias
router.get('/entries/lookup', async (req: Request, res: Response) => {
  try {
    const term = req.query.term as string;
    if (!term) { res.status(400).json({ error: 'term query parameter is required' }); return; }

    const entry = await store.lookup(term);
    if (!entry) { res.status(404).json({ error: `Term "${term}" not found` }); return; }
    res.json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /entries/:id — get a single entry by ID
router.get('/entries/:id', async (req: Request, res: Response) => {
  try {
    const entry = await store.get(req.params.id);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }
    res.json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /entries — create a new entry
router.post('/entries', async (req: Request, res: Response) => {
  try {
    const parsed = createEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }

    const { term, definition, aliases, category, tags } = parsed.data;

    const existing = await store.lookup(term);
    if (existing) {
      res.status(409).json({ error: `Term "${term}" already exists`, id: existing.id });
      return;
    }

    const entry = await store.save({
      term,
      definition,
      aliases,
      category,
      tags: tags ?? [],
    });

    res.status(201).json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /entries/:id — update an existing entry
router.put('/entries/:id', async (req: Request, res: Response) => {
  try {
    const existing = await store.get(req.params.id);
    if (!existing) { res.status(404).json({ error: 'Entry not found' }); return; }

    const parsed = updateEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }

    const { term, definition, aliases, category, tags } = parsed.data;

    const entry = await store.save({
      id: req.params.id,
      term: term ?? existing.term,
      definition: definition ?? existing.definition,
      aliases: aliases ?? existing.aliases,
      category: category ?? existing.category,
      tags: tags ?? existing.tags,
      projectId: existing.projectId,
    });

    res.json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /entries/:id — remove an entry
router.delete('/entries/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await store.delete(req.params.id);
    if (deleted) { res.json({ ok: true }); return; }
    res.status(404).json({ error: 'Entry not found' });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /context — get compiled vocabulary as markdown
router.get('/context', async (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const markdown = await store.getCompiledContext(projectId);
    res.setHeader('Content-Type', 'text/markdown');
    res.send(markdown || 'No vocabulary entries defined.');
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});
