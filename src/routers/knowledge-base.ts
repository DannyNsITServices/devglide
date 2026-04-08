import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { KnowledgeBaseStore, KbError } from '../apps/knowledge-base/services/knowledge-base-store.js';
import { KbBuilder } from '../apps/knowledge-base/services/kb-builder.js';
import { KbBuildRunStore } from '../apps/knowledge-base/services/kb-build-run-store.js';
import type { LlmClient } from '../apps/knowledge-base/services/kb-builder-types.js';
import { selectLlmClient } from '../apps/knowledge-base/services/kb-llm-client.js';
import { asyncHandler, badRequest, notFound } from '../packages/error-middleware.js';

export { createKnowledgeBaseMcpServer } from '../apps/knowledge-base/src/mcp.js';

// ── Zod schemas ──────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  path: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  includeHidden: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  title: z.string().min(1, 'title is required'),
  content: z.string(),
  path: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  slug: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  path: z.string().optional(),
  slug: z.string().optional(),
});

const ingestSchema = z.object({
  content: z.string().min(1, 'content is required'),
  title: z.string().optional(),
  source: z.string().optional(),
});

const importPipeSchema = z.object({
  pipeId: z.string().min(1, 'pipeId is required'),
  title: z.string().optional(),
  path: z.string().optional(),
});

const promoteSchema = z.object({
  targetPath: z.string().min(1, 'targetPath is required'),
  newSlug: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.string().min(1),
});

const byPathQuerySchema = z.object({
  path: z.string().min(1, 'path is required'),
});

const walkQuerySchema = z.object({
  path: z.string().optional().default(''),
  includeHidden: z.coerce.boolean().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1, 'q is required'),
  path: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  includeHidden: z.coerce.boolean().optional(),
});

// ── KB v2 builder schemas ────────────────────────────────────────────────────

const buildScanQuerySchema = z.object({
  path: z.string().optional(),
  sinceISO: z.string().optional(),
});

const buildPlanQuerySchema = z.object({
  path: z.string().optional(),
  targetRoom: z.string().optional(),
});

const buildDryRunBodySchema = z.object({
  path: z.string().optional(),
  targetRoom: z.string().optional(),
  trigger: z.enum(['manual', 'scheduled', 'rebuild', 'test']).optional(),
});

const buildHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(500).optional(),
});

const wikiIdParamSchema = z.object({
  wikiId: z.string().min(1),
});

const sourceIdParamSchema = z.object({
  sourceId: z.string().min(1),
});

// ── KB compose lane schemas (zero-key, deterministic) ───────────────────────
//
// Parallel to the v2 build pipeline. The store handles composition and
// `lastComposedBodyHash` bookkeeping; the router only maps HTTP shape and
// the `manual_edits_present` 409 case.

const composeBodySchema = z.object({
  pagePath: z.string().min(1, 'pagePath is required'),
  sourceIds: z.array(z.string().min(1)).min(1, 'sourceIds must be a non-empty array'),
  title: z.string().optional(),
});

const composeRebuildBodySchema = z.object({
  // Boolean only — pass `true` to overwrite a wiki whose body has diverged
  // from `lastComposedBodyHash`. Strings or other types are rejected so
  // callers cannot accidentally force-rebuild via a truthy non-bool.
  force: z.boolean().optional(),
});

const pageIdParamSchema = z.object({
  pageId: z.string().min(1),
});

// ── Router ──────────────────────────────────────────────────────────────────

export const router: Router = Router();

/**
 * Resolve the current KB store singleton dynamically on every request.
 *
 * This matters for test isolation: `KnowledgeBaseStore.resetForTests(tmpRoot)`
 * swaps the static singleton to a new tmpdir-backed instance, but a
 * module-load-time capture (`const store = getInstance()`) would hold the
 * pre-reset reference forever. Looking up the singleton per-request keeps
 * router tests properly isolated and also lets the same router work against
 * arbitrary swapped stores in integration tests.
 */
function getStore(): KnowledgeBaseStore {
  return KnowledgeBaseStore.getInstance();
}

/** Format the first zod issue as `<field>: <message>` so clients see which field is wrong. */
function formatZodError(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const fieldPath = issue.path.length > 0 ? issue.path.join('.') : null;
  return fieldPath ? `${fieldPath}: ${issue.message}` : issue.message;
}

/** Translate KbError into a 4xx response. */
function handleKbError(res: Response, err: unknown): boolean {
  if (err instanceof KbError) {
    if (err.code === 'not_found') {
      notFound(res, err.message);
    } else if (err.code === 'cascade_required') {
      // 409 Conflict: the request is well-formed but conflicts with the
      // current resource state (the raw source has live consumers). The
      // caller should re-issue the delete with ?cascade=true.
      res.status(409).json({ error: err.message, code: 'cascade_required' });
    } else if (err.code === 'manual_edits_present') {
      // 409 Conflict: the wiki body has diverged from `lastComposedBodyHash`
      // since the last compose/rebuild (or the wiki predates the compose lane
      // and has no hash at all). The caller should re-issue with `force:true`
      // to overwrite, or fetch + manually merge before retrying.
      res.status(409).json({ error: err.message, code: 'manual_edits_present' });
    } else {
      badRequest(res, err.message);
    }
    return true;
  }
  return false;
}

// GET /notes — list with filters
router.get('/notes', asyncHandler(async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const notes = await getStore().list(parsed.data);
    res.json({ notes });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /notes — add
router.post('/notes', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().add(parsed.data);
    res.status(201).json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /notes/by-path?path=... — fetch by relative folder/slug
// (separate from /notes/:id because Express 5 cannot route a `:param` that
// contains slashes; ids are flat so they live under /notes/:id, paths use a
// query string).
router.get('/by-path', asyncHandler(async (req: Request, res: Response) => {
  const parsed = byPathQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const note = await getStore().get(parsed.data.path);
    if (!note) { notFound(res, 'Note not found'); return; }
    res.json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /notes/:id — fetch by id
router.get('/notes/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, 'id is required');
    return;
  }
  try {
    const note = await getStore().get(params.data.id);
    if (!note) { notFound(res, 'Note not found'); return; }
    res.json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// PUT /notes/:id — update by id
router.put('/notes/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, 'id is required');
    return;
  }
  const body = updateSchema.safeParse(req.body);
  if (!body.success) {
    badRequest(res, formatZodError(body.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().update(params.data.id, body.data);
    if (!note) { notFound(res, 'Note not found'); return; }
    res.json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// DELETE /notes/:id — remove by id
router.delete('/notes/:id', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, 'id is required');
    return;
  }
  // KB v2: support ?cascade=true to opt into deleting a raw source that
  // has wiki consumers. Default (no flag) hits the delete-cascade guard
  // in store.remove() and throws KbError('cascade_required').
  const cascade = req.query.cascade === 'true' || req.query.cascade === '1';
  try {
    const ok = await getStore().remove(params.data.id, { cascade });
    if (!ok) { notFound(res, 'Note not found'); return; }
    res.json({ ok: true });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// DELETE /folders?path=...&recursive=true&cascade=true — remove a folder
// under the KB root. Mirrors the MCP `knowledge_base_remove_folder` tool.
// Path lives in the query string because Express 5 / path-to-regexp 8 cannot
// route a `:param` containing slashes (same constraint that motivates
// GET /by-path). The recursive path is cascade-aware: external wiki citations
// of raw sources inside the tree trigger a 409 cascade_required unless
// `cascade=true` is also passed.
router.delete('/folders', asyncHandler(async (req: Request, res: Response) => {
  const parsed = byPathQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  const recursive = req.query.recursive === 'true' || req.query.recursive === '1';
  const cascade = req.query.cascade === 'true' || req.query.cascade === '1';
  try {
    const ok = await getStore().removeFolder(parsed.data.path, { recursive, cascade });
    if (!ok) { notFound(res, 'Folder not found'); return; }
    res.json({ ok: true, path: parsed.data.path, recursive, cascade });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /notes/:id/promote — explicit promote verb
router.post('/notes/:id/promote', asyncHandler(async (req: Request, res: Response) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, 'id is required');
    return;
  }
  const body = promoteSchema.safeParse(req.body);
  if (!body.success) {
    badRequest(res, formatZodError(body.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().promote(params.data.id, body.data.targetPath, { newSlug: body.data.newSlug });
    res.json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /walk?path=&includeHidden=
router.get('/walk', asyncHandler(async (req: Request, res: Response) => {
  const parsed = walkQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const result = await getStore().walk(parsed.data.path, { includeHidden: parsed.data.includeHidden });
    res.json(result);
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /search?q=&path=&limit=&includeHidden=
router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const hits = await getStore().search(parsed.data.q, {
      path: parsed.data.path,
      limit: parsed.data.limit,
      includeHidden: parsed.data.includeHidden,
    });
    res.json({ hits });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /ingest
router.post('/ingest', asyncHandler(async (req: Request, res: Response) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().ingest(parsed.data.content, { title: parsed.data.title, source: parsed.data.source });
    res.status(201).json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /import-pipe
router.post('/import-pipe', asyncHandler(async (req: Request, res: Response) => {
  const parsed = importPipeSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().importPipe(parsed.data.pipeId, { title: parsed.data.title, path: parsed.data.path });
    res.status(201).json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// ── KB compose lane (zero-key, deterministic) ───────────────────────────────
//
// Parallel zero-LLM path beside the v2 build pipeline. The store handles the
// actual composition via `composeWiki(...)` and `rebuildComposedWiki(...)`.
// The router maps HTTP shape and the `manual_edits_present → 409` error case;
// everything else is delegated.

// POST /compose — create a wiki page from a deterministic composition over
// selected raw source notes. Returns 201 with the created wiki note. The
// store snapshots `lastComposedBodyHash` so future rebuilds can detect
// manual edits.
router.post('/compose', asyncHandler(async (req: Request, res: Response) => {
  const parsed = composeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().composeWiki({
      pagePath: parsed.data.pagePath,
      sourceIds: parsed.data.sourceIds,
      title: parsed.data.title,
    });
    res.status(201).json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /compose/rebuild/:pageId — re-run the composition over the wiki's
// current `sourceRefs[]`. Refuses to overwrite a wiki body that has diverged
// from `lastComposedBodyHash` (or a wiki with no hash at all) unless
// `{ force: true }` is passed in the body — in that case the divergence is
// surfaced as HTTP 409 with `{ code: 'manual_edits_present' }`.
router.post('/compose/rebuild/:pageId', asyncHandler(async (req: Request, res: Response) => {
  const params = pageIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  const body = composeRebuildBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    badRequest(res, formatZodError(body.error, 'Invalid body'));
    return;
  }
  try {
    const note = await getStore().rebuildComposedWiki(
      params.data.pageId,
      { force: body.data.force },
    );
    res.json({ note });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// ── KB v2 builder routes ────────────────────────────────────────────────────
//
// Mirror the MCP tool surface: /build/* for pipeline stages, /trace/* for
// provenance queries, /build/history for the audit log listing.
//
// The builder needs an LlmClient for the `cluster` and `synthesize` stages.
// Tests inject a fixture via `setBuilderLlmClient()`; production runs use
// the default NoopLlmClient which throws with a clear error pointing at the
// Phase 4 production LLM wiring. Non-LLM tools (scan, trace, history) work
// regardless of what client is installed.

/**
 * Builder LLM client. Defaults to the production OpenAI-backed client when
 * `OPENAI_API_KEY` is set, else a fail-fast Noop client that throws with
 * a clear message directing the operator at the env var.
 *
 * Tests inject a fixture via `setBuilderLlmClient()` so they don't need a
 * real API key (and stay deterministic).
 */
let _llmClient: LlmClient = selectLlmClient();

/**
 * Test-only setter for the builder LLM client. Allows REST integration tests
 * to swap in a fixture client without needing to rebuild the router.
 */
export function setBuilderLlmClient(client: LlmClient): void {
  _llmClient = client;
}

/**
 * Reset the LLM client back to the production default (re-runs the env var
 * check). Used by REST tests to clean up between tests so a fixture from
 * one test doesn't bleed into the next.
 */
export function resetBuilderLlmClient(): void {
  _llmClient = selectLlmClient();
}

/**
 * Build a fresh KbBuilder on every request. The store is resolved dynamically
 * via `getStore()` so `resetForTests()` isolation works correctly; the
 * KbBuildRunStore and the LlmClient are also read per-request so tests can
 * swap them between requests.
 */
function getBuilder(): KbBuilder {
  const currentStore = getStore();
  const runStore = new KbBuildRunStore(currentStore.getRootDir());
  return new KbBuilder({ store: currentStore, runStore, llm: _llmClient });
}

// GET /build/scan?path=&sinceISO=
router.get('/build/scan', asyncHandler(async (req: Request, res: Response) => {
  const parsed = buildScanQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const result = await getBuilder().scan(parsed.data);
    res.json(result);
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /build/plan?path=&targetRoom=
router.get('/build/plan', asyncHandler(async (req: Request, res: Response) => {
  const parsed = buildPlanQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const builder = getBuilder();
    const scan = await builder.scan({ path: parsed.data.path });
    // Use the shared stage-1 → stage-2 bridge so /build/plan and /build/dry-run
    // agree on the same source set for the same KB state.
    const allSources = await builder.collectSourcesForBuild(scan);
    if (allSources.length === 0) {
      res.json({ scan, clusters: [], actions: [] });
      return;
    }
    const { clusters } = await builder.cluster(allSources);
    const actions = await builder.planActions(clusters, { targetRoom: parsed.data.targetRoom });
    res.json({ scan, clusters, actions });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /build/dry-run { path?, targetRoom?, trigger? }
router.post('/build/dry-run', asyncHandler(async (req: Request, res: Response) => {
  const parsed = buildDryRunBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid body'));
    return;
  }
  try {
    const run = await getBuilder().buildDryRun({
      scope: parsed.data.path ? { path: parsed.data.path } : undefined,
      targetRoom: parsed.data.targetRoom,
      trigger: parsed.data.trigger,
    });
    res.json({ run });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /build/history?limit=
router.get('/build/history', asyncHandler(async (req: Request, res: Response) => {
  const parsed = buildHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid query'));
    return;
  }
  try {
    const runStore = new KbBuildRunStore(getStore().getRootDir());
    const runs = await runStore.list(parsed.data.limit ?? 50);
    res.json({ runs });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /trace/sources/:wikiId — raw sources cited by a wiki
router.get('/trace/sources/:wikiId', asyncHandler(async (req: Request, res: Response) => {
  const params = wikiIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  try {
    const sources = await getStore().traceSources(params.data.wikiId);
    res.json({ sources });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// GET /trace/derivatives/:sourceId — wikis that cite a raw source
router.get('/trace/derivatives/:sourceId', asyncHandler(async (req: Request, res: Response) => {
  const params = sourceIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  try {
    const derivatives = await getStore().traceDerivatives(params.data.sourceId);
    res.json({ derivatives });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// ── Phase 3 builder routes ──────────────────────────────────────────────────

const buildRunBodySchema = z.object({
  path: z.string().optional(),
  targetRoom: z.string().optional(),
  trigger: z.enum(['manual', 'scheduled', 'rebuild', 'test']).optional(),
});

const buildApproveBodySchema = z.object({
  proposalIds: z.array(z.string()).min(1, 'proposalIds must be a non-empty array'),
  edits: z.record(z.string(), z.record(z.string(), z.any())).optional(),
});

const buildRejectBodySchema = z.object({
  proposalIds: z.array(z.string()).min(1, 'proposalIds must be a non-empty array'),
  reason: z.string().optional(),
});

const runIdParamSchema = z.object({
  runId: z.string().min(1),
});

// POST /build/run — run the pipeline and queue for review
router.post('/build/run', asyncHandler(async (req: Request, res: Response) => {
  const parsed = buildRunBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, formatZodError(parsed.error, 'Invalid body'));
    return;
  }
  try {
    const run = await getBuilder().buildRun({
      scope: parsed.data.path ? { path: parsed.data.path } : undefined,
      targetRoom: parsed.data.targetRoom,
      trigger: parsed.data.trigger,
    });
    const awaitingReview = run.proposals.filter((p) => !p.needsReview).length;
    res.json({ runId: run.runId, proposals: run.proposals, awaitingReview });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /build/runs/:runId/approve — commit approved proposals
router.post('/build/runs/:runId/approve', asyncHandler(async (req: Request, res: Response) => {
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  const body = buildApproveBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    badRequest(res, formatZodError(body.error, 'Invalid body'));
    return;
  }
  try {
    const result = await getBuilder().approve(
      params.data.runId,
      body.data.proposalIds,
      body.data.edits as Record<string, Partial<import('../apps/knowledge-base/services/kb-builder-types.js').ProposedPage>> | undefined,
    );
    res.json(result);
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /build/runs/:runId/reject — record reject decisions
router.post('/build/runs/:runId/reject', asyncHandler(async (req: Request, res: Response) => {
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  const body = buildRejectBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    badRequest(res, formatZodError(body.error, 'Invalid body'));
    return;
  }
  try {
    const result = await getBuilder().reject(params.data.runId, body.data.proposalIds, body.data.reason);
    res.json(result);
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /build/runs/:runId/revert — reverse a committed build run
router.post('/build/runs/:runId/revert', asyncHandler(async (req: Request, res: Response) => {
  const params = runIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  try {
    const result = await getBuilder().revert(params.data.runId);
    res.json(result);
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));

// POST /rebuild/:wikiId — re-run the pipeline for a single wiki page
router.post('/rebuild/:wikiId', asyncHandler(async (req: Request, res: Response) => {
  const params = wikiIdParamSchema.safeParse(req.params);
  if (!params.success) {
    badRequest(res, formatZodError(params.error, 'Invalid params'));
    return;
  }
  try {
    const run = await getBuilder().rebuild(params.data.wikiId);
    const awaitingReview = run.proposals.filter((p) => !p.needsReview).length;
    res.json({ runId: run.runId, proposals: run.proposals, awaitingReview });
  } catch (err) {
    if (!handleKbError(res, err)) throw err;
  }
}));
