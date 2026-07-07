import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DocumentationStore } from '../apps/documentation/services/documentation-store.js';
import { asyncHandler, badRequest, notFound } from '../packages/error-middleware.js';
import type { DocType } from '../apps/documentation/types.js';

// ── Zod schemas for HTTP input validation ────────────────────────────────────

const listQuerySchema = z.object({
  type: z.string().optional(),
  toolName: z.string().optional(),
  tag: z.string().optional(),
});

const matchQuerySchema = z.object({
  q: z.string().min(1, 'query parameter q is required'),
});

const idParamSchema = z.object({
  id: z.string().min(1, 'entry id is required'),
});

const createEntrySchema = z.object({
  type: z.enum(['tool-guide', 'workflow', 'example', 'troubleshooting', 'project-override']),
  content: z.record(z.unknown()),
});

const updateEntrySchema = z.object({
  content: z.record(z.unknown()),
});

const contextQuerySchema = z.object({
  q: z.string().optional(),
  projectId: z.string().optional(),
});

const toolGuideQuerySchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
});

const workflowQuerySchema = z.object({
  name: z.string().min(1, 'name is required'),
});

const troubleshootingQuerySchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  symptom: z.string().min(1, 'symptom is required'),
});

export { createDocumentationMcpServer } from '../apps/documentation/src/mcp.js';

export const router: Router = Router();

const store = DocumentationStore.getInstance();

// GET /entries — list all documentation entries
router.get('/entries', asyncHandler(async (req: Request, res: Response) => {
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { type, toolName, tag } = query.data;
  const entries = await store.list({ type: type as DocType | undefined, toolName, tag });
  res.json(entries);
}));

// GET /entries/match — search documentation by keyword
router.get('/entries/match', asyncHandler(async (req: Request, res: Response) => {
  const query = matchQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const results = await store.match(query.data.q);
  res.json(results);
}));

// GET /entries/tool-guide — get tool guide by tool name
router.get('/entries/tool-guide', asyncHandler(async (req: Request, res: Response) => {
  const query = toolGuideQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const guide = await store.getToolGuide(query.data.toolName);
  if (!guide) { notFound(res, `No tool guide found for "${query.data.toolName}"`); return; }
  res.json(guide);
}));

// GET /entries/workflow — get workflow by name
router.get('/entries/workflow', asyncHandler(async (req: Request, res: Response) => {
  const query = workflowQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const workflow = await store.getWorkflow(query.data.name);
  if (!workflow) { notFound(res, `No workflow found for "${query.data.name}"`); return; }
  res.json(workflow);
}));

// GET /entries/troubleshooting — get troubleshooting by tool + symptom
router.get('/entries/troubleshooting', asyncHandler(async (req: Request, res: Response) => {
  const query = troubleshootingQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const entries = await store.getTroubleshooting(query.data.toolName, query.data.symptom);
  res.json(entries);
}));

// GET /entries/:id — get a single entry by ID
router.get('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
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

  const { type, content } = parsed.data;
  const entryData = { ...content, type, tags: (content.tags as string[]) ?? [] };
  const entry = await store.save(entryData as any);
  res.status(201).json(entry);
}));

// PUT /entries/:id — update an existing entry
router.put('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const parsed = updateEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    return;
  }

  // Atomic read-merge-write inside the store lock — a separate get()+save()
  // here loses concurrent field updates. Identity/type stay immutable.
  const updates = { ...parsed.data.content } as Record<string, unknown>;
  delete updates.id;
  delete updates.type;
  delete updates.projectId;
  const entry = await store.update(params.data.id, updates as Parameters<typeof store.update>[1]);
  if (!entry) { notFound(res, 'Entry not found'); return; }
  res.json(entry);
}));

// DELETE /entries/:id — remove an entry
router.delete('/entries/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const deleted = await store.delete(params.data.id);
  if (deleted) { res.json({ ok: true }); return; }
  notFound(res, 'Entry not found');
}));

// GET /context — get compiled documentation as markdown
router.get('/context', asyncHandler(async (req: Request, res: Response) => {
  const query = contextQuerySchema.safeParse(req.query);
  if (!query.success) {
    badRequest(res, query.error.issues[0]?.message ?? 'Invalid input');
    return;
  }
  const { q, projectId } = query.data;
  const markdown = await store.getCompiledContext(q, projectId);
  res.setHeader('Content-Type', 'text/markdown');
  res.send(markdown || 'No documentation entries found.');
}));
