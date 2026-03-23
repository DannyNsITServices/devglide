import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PromptStore } from '../apps/prompts/services/prompt-store.js';
import { asyncHandler } from '../packages/error-middleware.js';

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

const promptIdParamSchema = z.object({
  id: z.string().min(1, 'prompt id is required'),
});

const listPromptsQuerySchema = z.object({
  category: z.string().optional(),
  tags: z.string().optional(),
  search: z.string().optional(),
});

export { createPromptsMcpServer } from '../apps/prompts/src/mcp.js';

export const router: Router = Router();

const store = PromptStore.getInstance();

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

// GET /context — compiled markdown for LLM injection
router.get('/context', asyncHandler(async (_req: Request, res: Response) => {
  const markdown = await store.getCompiledContext();
  res.type('text/markdown').send(markdown || 'No prompts defined.');
}));

// GET /entries — list prompts
router.get('/entries', asyncHandler(async (req: Request, res: Response) => {
  const query = listPromptsQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const category = query.data.category;
  const tagsParam = query.data.tags;
  const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const search = query.data.search;
  const entries = await store.list({ category, tags, search });
  res.json(entries);
}));

// GET /entries/:id — get by ID
router.get('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = promptIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const entry = await store.get(params.data.id);
  if (!entry) { notFound(res, 'Prompt not found'); return; }
  res.json(entry);
}));

// POST /entries — create
router.post('/entries', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const entry = await store.save(parsed.data);
  res.status(201).json(entry);
}));

// PUT /entries/:id — update
router.put('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = promptIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const parsed = updatePromptSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }

  const entry = await store.update(params.data.id, parsed.data);
  if (!entry) { notFound(res, 'Prompt not found'); return; }
  res.json(entry);
}));

// DELETE /entries/:id — delete
router.delete('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = promptIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const deleted = await store.delete(params.data.id);
  if (deleted) { res.json({ ok: true }); return; }
  notFound(res, 'Prompt not found');
}));

// POST /entries/:id/render — render with variable substitution
router.post('/entries/:id/render', asyncHandler(async (req: Request, res: Response) => {
  const params = promptIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const parsed = renderSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const rendered = await store.render(params.data.id, parsed.data.vars);
  if (rendered === null) { notFound(res, 'Prompt not found'); return; }
  res.json({ rendered });
}));
