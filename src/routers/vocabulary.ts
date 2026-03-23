import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { VocabularyStore } from '../apps/vocabulary/services/vocabulary-store.js';
import { asyncHandler } from '../packages/error-middleware.js';

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

const vocabularyIdParamSchema = z.object({
  id: z.string().min(1, 'entry id is required'),
});

const vocabularyListQuerySchema = z.object({
  category: z.string().optional(),
  tag: z.string().optional(),
});

const vocabularyLookupQuerySchema = z.object({
  term: z.string().min(1, 'term query parameter is required'),
});

const vocabularyContextQuerySchema = z.object({
  projectId: z.string().optional(),
});

export { createVocabularyMcpServer } from '../apps/vocabulary/src/mcp.js';

export const router: Router = Router();

const store = VocabularyStore.getInstance();

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

// GET /entries — list all vocabulary entries
router.get('/entries', asyncHandler(async (req: Request, res: Response) => {
  const query = vocabularyListQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { category, tag } = query.data;
  const entries = await store.list({ category, tag });
  res.json(entries);
}));

// GET /entries/lookup — lookup a term by name or alias
router.get('/entries/lookup', asyncHandler(async (req: Request, res: Response) => {
  const query = vocabularyLookupQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { term } = query.data;

  const entry = await store.lookup(term);
  if (!entry) { notFound(res, `Term "${term}" not found`); return; }
  res.json(entry);
}));

// GET /entries/:id — get a single entry by ID
router.get('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = vocabularyIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const entry = await store.get(params.data.id);
  if (!entry) { notFound(res, 'Entry not found'); return; }
  res.json(entry);
}));

// POST /entries — create a new entry
router.post('/entries', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
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
}));

// PUT /entries/:id — update an existing entry
router.put('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = vocabularyIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const existing = await store.get(params.data.id);
  if (!existing) { notFound(res, 'Entry not found'); return; }

  const parsed = updateEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }

  const { term, definition, aliases, category, tags } = parsed.data;

  const entry = await store.save({
    id: params.data.id,
    term: term ?? existing.term,
    definition: definition ?? existing.definition,
    aliases: aliases ?? existing.aliases,
    category: category ?? existing.category,
    tags: tags ?? existing.tags,
    projectId: existing.projectId,
  });

  res.json(entry);
}));

// DELETE /entries/:id — remove an entry
router.delete('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = vocabularyIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const deleted = await store.delete(params.data.id);
  if (deleted) { res.json({ ok: true }); return; }
  notFound(res, 'Entry not found');
}));

// GET /context — get compiled vocabulary as markdown
router.get('/context', asyncHandler(async (req: Request, res: Response) => {
  const query = vocabularyContextQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { projectId } = query.data;
  const markdown = await store.getCompiledContext(projectId);
  res.setHeader('Content-Type', 'text/markdown');
  res.send(markdown || 'No vocabulary entries defined.');
}));
