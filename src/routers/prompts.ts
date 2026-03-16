import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PromptStore } from '../apps/prompts/services/prompt-store.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createPromptSchema = z.object({
  title: z.string().min(1, 'title is required'),
  content: z.string().min(1, 'content is required'),
  description: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().optional(),
});

const updatePromptSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  model: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().nullable().optional(),
});

const renderSchema = z.object({
  vars: z.record(z.string()).default({}),
});

export { createPromptsMcpServer } from '../apps/prompts/mcp.js';

export const router: Router = Router();

const store = PromptStore.getInstance();

// GET /context — compiled markdown for LLM injection
router.get('/context', async (_req: Request, res: Response) => {
  try {
    const markdown = await store.getCompiledContext();
    res.type('text/markdown').send(markdown || 'No prompts defined.');
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /entries — list prompts
router.get('/entries', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const tagsParam = req.query.tags as string | undefined;
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const search = req.query.search as string | undefined;
    const entries = await store.list({ category, tags, search });
    res.json(entries);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// GET /entries/:id — get by ID
router.get('/entries/:id', async (req: Request, res: Response) => {
  try {
    const entry = await store.get(req.params.id);
    if (!entry) { res.status(404).json({ error: 'Prompt not found' }); return; }
    res.json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /entries — create
router.post('/entries', async (req: Request, res: Response) => {
  try {
    const parsed = createPromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }
    const entry = await store.save(parsed.data);
    res.status(201).json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// PUT /entries/:id — update
router.put('/entries/:id', async (req: Request, res: Response) => {
  try {
    const parsed = updatePromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }

    const entry = await store.update(req.params.id, parsed.data);
    if (!entry) { res.status(404).json({ error: 'Prompt not found' }); return; }
    res.json(entry);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// DELETE /entries/:id — delete
router.delete('/entries/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await store.delete(req.params.id);
    if (deleted) { res.json({ ok: true }); return; }
    res.status(404).json({ error: 'Prompt not found' });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// POST /entries/:id/render — render with variable substitution
router.post('/entries/:id/render', async (req: Request, res: Response) => {
  try {
    const parsed = renderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }
    const rendered = await store.render(req.params.id, parsed.data.vars);
    if (rendered === null) { res.status(404).json({ error: 'Prompt not found' }); return; }
    res.json({ rendered });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});
