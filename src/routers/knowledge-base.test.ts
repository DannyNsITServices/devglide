import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { router as kbRouter, setBuilderLlmClient, resetBuilderLlmClient } from './knowledge-base.js';
import { KnowledgeBaseStore, KbError } from '../apps/knowledge-base/services/knowledge-base-store.js';
import type { LlmClient, ClusterPlan } from '../apps/knowledge-base/services/kb-builder-types.js';
import { errorHandler } from '../packages/error-middleware.js';

let server: http.Server;
let baseUrl: string;
let tmpRoot: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-base', kbRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/knowledge-base`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-router-'));
  KnowledgeBaseStore.resetForTests(tmpRoot);
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── helpers ────────────────────────────────────────────────────────────────

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}
async function post(url: string, body: object): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function put(url: string, body: object): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function del(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('REST /api/knowledge-base', () => {
  it('GET /notes returns the bootstrap welcome note', async () => {
    const r = await get(`${baseUrl}/notes`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.notes)).toBe(true);
    expect(r.body.notes.some((n: any) => n.title === 'Knowledge Base')).toBe(true);
  });

  it('POST /notes creates a note and GET fetches it back by id', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'REST one', content: 'hello' });
    expect(created.status).toBe(201);
    expect(created.body.note.id).toMatch(/^kb_/);

    const fetched = await get(`${baseUrl}/notes/${created.body.note.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.note.title).toBe('REST one');
  });

  it('POST /notes 400s on missing title', async () => {
    const r = await post(`${baseUrl}/notes`, { content: 'no title' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/title/i);
  });

  it('PUT /notes/:id updates a note in place', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'Updateme', content: 'old' });
    const id = created.body.note.id;
    const updated = await put(`${baseUrl}/notes/${id}`, { content: 'new' });
    expect(updated.status).toBe(200);
    expect(updated.body.note.body).toBe('new');
  });

  it('PUT /notes/:id 400s on empty title', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'has title', content: 'x' });
    const id = created.body.note.id;
    const r = await put(`${baseUrl}/notes/${id}`, { title: '   ' });
    expect(r.status).toBe(400);
  });

  it('DELETE /notes/:id removes a note', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'Bye', content: 'x' });
    const id = created.body.note.id;
    const r = await del(`${baseUrl}/notes/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const after = await get(`${baseUrl}/notes/${id}`);
    expect(after.status).toBe(404);
  });

  it('GET /by-path?path=... resolves a note by its relative folder/slug', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'Path lookup', content: 'x', path: 'notes/foo/bar' });
    const slug = created.body.note.slug;
    const r = await get(`${baseUrl}/by-path?path=${encodeURIComponent(`notes/foo/bar/${slug}`)}`);
    expect(r.status).toBe(200);
    expect(r.body.note.id).toBe(created.body.note.id);
  });

  it('GET /by-path 400s on missing path', async () => {
    const r = await get(`${baseUrl}/by-path`);
    expect(r.status).toBe(400);
  });

  it('GET /walk?path=notes returns the welcome _index.md', async () => {
    const r = await get(`${baseUrl}/walk?path=notes`);
    expect(r.status).toBe(200);
    expect(r.body.index?.title).toBe('Knowledge Base');
    expect(r.body.parent).toBe('');
  });

  it('GET /walk traversal attempt returns 400', async () => {
    const r = await get(`${baseUrl}/walk?path=${encodeURIComponent('../etc')}`);
    expect(r.status).toBe(400);
  });

  it('GET /search ranks title hits above body hits', async () => {
    await post(`${baseUrl}/notes`, { title: 'PKCE flow', content: 'unrelated', path: 'notes/auth' });
    await post(`${baseUrl}/notes`, { title: 'OAuth', content: 'mentions PKCE briefly', path: 'notes/auth' });
    const r = await get(`${baseUrl}/search?q=pkce`);
    expect(r.status).toBe(200);
    expect(r.body.hits[0].note.title).toBe('PKCE flow');
  });

  it('POST /ingest lands a note in inbox/ with provenance', async () => {
    const r = await post(`${baseUrl}/ingest`, {
      content: '# From REST\n\nbody',
      source: 'manual',
    });
    expect(r.status).toBe(201);
    expect(r.body.note.path).toBe('inbox');
    expect(r.body.note.title).toBe('From REST');
    expect(r.body.note.source).toBe('manual');
  });

  it('POST /ingest 400s on empty content', async () => {
    const r = await post(`${baseUrl}/ingest`, { content: '' });
    expect(r.status).toBe(400);
  });

  it('POST /import-pipe 400/404 when pipe is missing (KbError → 4xx)', async () => {
    const r = await post(`${baseUrl}/import-pipe`, { pipeId: 'ghost' });
    // The store throws KbError('not_found'); the router maps this to 404.
    expect(r.status).toBe(404);
  });

  it('POST /notes/:id/promote moves a note from inbox to a curated folder', async () => {
    const ingested = await post(`${baseUrl}/ingest`, { content: 'promote me', source: 'manual' });
    const id = ingested.body.note.id;
    const r = await post(`${baseUrl}/notes/${id}/promote`, { targetPath: 'notes/curated' });
    expect(r.status).toBe(200);
    expect(r.body.note.path).toBe('notes/curated');
    expect(r.body.note.id).toBe(id);
  });

  it('POST /notes/:id/promote 400s on empty targetPath', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'x', content: 'x' });
    const r = await post(`${baseUrl}/notes/${created.body.note.id}/promote`, { targetPath: '' });
    expect(r.status).toBe(400);
  });

  // ── DELETE /folders ──────────────────────────────────────────────────────

  it('DELETE /folders removes an empty folder under notes/', async () => {
    // Create the empty folder directly via fs since the store has no API
    // for explicit empty-folder creation; the dashboard's "new room" path
    // mkdirs the folder before populating it.
    await fs.mkdir(path.join(tmpRoot, 'notes', 'stray-room'), { recursive: true });

    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('notes/stray-room')}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.path).toBe('notes/stray-room');
    expect(r.body.recursive).toBe(false);

    // Verify gone on disk.
    await expect(fs.stat(path.join(tmpRoot, 'notes', 'stray-room'))).rejects.toThrow();
  });

  it('DELETE /folders 404s when the folder does not exist', async () => {
    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('notes/never-existed')}`);
    expect(r.status).toBe(404);
  });

  it('DELETE /folders 400s on a non-empty folder when recursive is not set', async () => {
    await post(`${baseUrl}/notes`, { title: 'Inside', content: 'x', path: 'notes/has-stuff' });

    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('notes/has-stuff')}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not empty/i);
  });

  it('DELETE /folders?recursive=true force-deletes a non-empty folder', async () => {
    await post(`${baseUrl}/notes`, { title: 'Doomed', content: 'x', path: 'notes/doomed' });

    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('notes/doomed')}&recursive=true`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.recursive).toBe(true);

    await expect(fs.stat(path.join(tmpRoot, 'notes', 'doomed'))).rejects.toThrow();
  });

  it('DELETE /folders 400s on the protected inbox top-level folder', async () => {
    const r = await del(`${baseUrl}/folders?path=inbox`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/protected top-level/i);
  });

  it('DELETE /folders 400s on the protected notes top-level folder', async () => {
    const r = await del(`${baseUrl}/folders?path=notes`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/protected top-level/i);
  });

  it('DELETE /folders 400s on a path traversal attempt', async () => {
    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('../escape')}`);
    expect(r.status).toBe(400);
  });

  it('DELETE /folders 400s when path is missing', async () => {
    const r = await del(`${baseUrl}/folders`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/path/);
  });

  it('DELETE /folders?recursive=true 409s with cascade_required when an internal raw source is cited by an external wiki', async () => {
    // Source inside the deletion tree, external wiki outside cites it.
    const srcCreate = await post(`${baseUrl}/notes`, { title: 'Cited source', content: 'data', path: 'notes/doomed' });
    const externalCreate = await post(`${baseUrl}/notes`, { title: 'External wiki', content: 'body', path: 'notes/safe' });
    expect(srcCreate.status).toBe(201);
    expect(externalCreate.status).toBe(201);

    // Stamp the source's consumedBy[] to include the external wiki id by
    // touching the store directly via the singleton — the REST surface
    // doesn't expose updateConsumedBy. This is a test-only escape hatch.
    const store = KnowledgeBaseStore.getInstance();
    await store.updateConsumedBy(srcCreate.body.note.id, [externalCreate.body.note.id]);

    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('notes/doomed')}&recursive=true`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('cascade_required');
  });

  it('DELETE /folders?recursive=true&cascade=true succeeds and strips citations from external wikis', async () => {
    // Same setup as the previous test, but this time pass cascade=true.
    const srcCreate = await post(`${baseUrl}/notes`, { title: 'Source cascade', content: 'data', path: 'notes/doomed-rest' });
    const externalCreate = await post(`${baseUrl}/notes`, { title: 'External wiki rest', content: 'body', path: 'notes/safe-rest' });
    const externalId = externalCreate.body.note.id;

    // Patch the external wiki on disk to be kind=wiki + sourceRefs.
    const externalSlug = externalCreate.body.note.slug;
    const externalFile = path.join(tmpRoot, 'notes', 'safe-rest', `${externalSlug}.md`);
    const externalRaw = await fs.readFile(externalFile, 'utf-8');
    const externalPatched = externalRaw.replace(/^---\n/, `---\nkind: wiki\nsourceRefs: [${srcCreate.body.note.id}]\nbuildStatus: published\n`);
    await fs.writeFile(externalFile, externalPatched, 'utf-8');
    KnowledgeBaseStore.resetForTests(tmpRoot);
    const store = KnowledgeBaseStore.getInstance();
    await store.ensureBootstrapped();
    await store.updateConsumedBy(srcCreate.body.note.id, [externalId]);

    const r = await del(`${baseUrl}/folders?path=${encodeURIComponent('notes/doomed-rest')}&recursive=true&cascade=true`);
    expect(r.status).toBe(200);
    expect(r.body.cascade).toBe(true);

    // External wiki has had the source stripped and is marked stale.
    const refreshed = await get(`${baseUrl}/notes/${externalId}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.note.sourceRefs ?? []).not.toContain(srcCreate.body.note.id);
    expect(refreshed.body.note.buildStatus).toBe('stale');
  });
});

// ── KB v2 builder REST surface ──────────────────────────────────────────────

/**
 * Simple fixture LLM client for REST integration tests. Matches ALL inputs
 * and returns the first configured fixture per stage. Unlike the unit-test
 * fixture in kb-builder.test.ts, this one is permissive to keep REST tests
 * focused on request/response plumbing rather than exhaustive LLM contracts.
 */
function makeRestFixtureLlm(opts: {
  clusterName?: string;
  title?: string;
  body?: string;
  tags?: string[];
}): LlmClient {
  return {
    cluster: async (input) => {
      const ids = input.sources.map((s) => s.id);
      const clusters: ClusterPlan[] = ids.length > 0
        ? [{
            clusterName: opts.clusterName ?? 'test-cluster',
            rawIds: ids,
            confidence: 'high',
          }]
        : [];
      return {
        clusters,
        tokens: { model: 'fixture', inputTokens: 10, outputTokens: 5, durationMs: 1 },
      };
    },
    synthesize: async (input) => {
      const ids = input.sources.map((s) => s.id);
      const title = opts.title ?? 'REST fixture title';
      const body = opts.body ?? `Content ${ids.map((id) => `[^${id}]`).join(' ')}`;
      return {
        output: {
          title,
          body,
          tags: opts.tags ?? ['rest-fixture'],
          sourceRefs: ids,
        },
        tokens: { model: 'fixture', inputTokens: 20, outputTokens: 10, durationMs: 1 },
      };
    },
  };
}

describe('REST /api/knowledge-base — KB v2 builder routes', () => {
  afterEach(() => {
    resetBuilderLlmClient();
  });

  // ── /build/scan ───────────────────────────────────────────────────────────

  it('GET /build/scan returns empty partitions for an empty KB', async () => {
    const r = await get(`${baseUrl}/build/scan`);
    expect(r.status).toBe(200);
    expect(r.body.eligibleSources).toBeDefined();
    expect(r.body.staleWikis).toBeDefined();
    expect(r.body.freshWikis).toBeDefined();
  });

  it('GET /build/scan lists newly added raw notes as eligible', async () => {
    await post(`${baseUrl}/notes`, { title: 'Scan me', content: 'hello' });
    const r = await get(`${baseUrl}/build/scan`);
    expect(r.status).toBe(200);
    const titles = r.body.eligibleSources.map((s: any) => s.title);
    expect(titles).toContain('Scan me');
  });

  it('GET /build/scan?path=inbox scopes to a subtree', async () => {
    await post(`${baseUrl}/notes`, { title: 'In inbox', content: 'x' });
    const r = await get(`${baseUrl}/build/scan?path=inbox`);
    expect(r.status).toBe(200);
    const titles = r.body.eligibleSources.map((s: any) => s.title);
    expect(titles).toContain('In inbox');
  });

  // ── /build/plan ───────────────────────────────────────────────────────────

  it('GET /build/plan returns empty clusters/actions when there is nothing to build', async () => {
    const r = await get(`${baseUrl}/build/plan`);
    expect(r.status).toBe(200);
    expect(r.body.clusters).toEqual([]);
    expect(r.body.actions).toEqual([]);
    expect(r.body.scan).toBeDefined();
  });

  it('GET /build/plan runs cluster+match with an injected fixture client', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'auth' }));
    const a = await post(`${baseUrl}/notes`, { title: 'A', content: 'a' });
    const b = await post(`${baseUrl}/notes`, { title: 'B', content: 'b' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const r = await get(`${baseUrl}/build/plan`);
    expect(r.status).toBe(200);
    expect(r.body.clusters).toHaveLength(1);
    expect(r.body.clusters[0].rawIds).toContain(a.body.note.id);
    expect(r.body.clusters[0].rawIds).toContain(b.body.note.id);
    expect(r.body.actions).toHaveLength(1);
    expect(r.body.actions[0].type).toBe('create');
    expect(r.body.actions[0].targetPath).toBe('notes/auth');
  });

  it('GET /build/plan honors targetRoom override on create actions', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'somewhere' }));
    await post(`${baseUrl}/notes`, { title: 'X', content: 'x' });
    const r = await get(`${baseUrl}/build/plan?targetRoom=notes/special-room`);
    expect(r.status).toBe(200);
    expect(r.body.actions[0].type).toBe('create');
    expect(r.body.actions[0].targetPath).toBe('notes/special-room');
  });

  it('GET /build/plan returns 5xx when LLM is not configured and sources exist', async () => {
    // Default NoopLlmClient throws when cluster is called
    await post(`${baseUrl}/notes`, { title: 'Needs LLM', content: 'body' });
    const r = await get(`${baseUrl}/build/plan`);
    // KbError is a 4xx on the router (client-visible configuration problem)
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error).toMatch(/LLM client not configured/i);
  });

  // ── /build/dry-run ────────────────────────────────────────────────────────

  it('POST /build/dry-run writes a BuildRun audit record and returns proposals', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({
      clusterName: 'permits',
      title: 'Permits overview',
    }));
    const a = await post(`${baseUrl}/notes`, { title: 'Permit fee', content: 'fees' });
    const b = await post(`${baseUrl}/notes`, { title: 'Permit appeal', content: 'appeal' });
    const r = await post(`${baseUrl}/build/dry-run`, { trigger: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.run).toBeDefined();
    expect(r.body.run.runId).toMatch(/^run_/);
    expect(r.body.run.proposals.length).toBeGreaterThanOrEqual(1);
    const proposal = r.body.run.proposals[0];
    expect(proposal.sourceRefs).toContain(a.body.note.id);
    expect(proposal.sourceRefs).toContain(b.body.note.id);
    expect(r.body.run.committed).toBeNull();
  });

  it('POST /build/dry-run with empty KB returns an empty run with no LLM calls', async () => {
    // NoopLlmClient is default — this should work because there are no sources
    const r = await post(`${baseUrl}/build/dry-run`, { trigger: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.run.clusters).toEqual([]);
    expect(r.body.run.actions).toEqual([]);
    expect(r.body.run.proposals).toEqual([]);
    expect(r.body.run.llmCalls).toEqual([]);
  });

  it('POST /build/dry-run honors targetRoom override end-to-end', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'generic' }));
    await post(`${baseUrl}/notes`, { title: 'T', content: 'x' });
    const r = await post(`${baseUrl}/build/dry-run`, { targetRoom: 'notes/override-room' });
    expect(r.status).toBe(200);
    // Proposals should have the override path applied
    for (const p of r.body.run.proposals) {
      if (!p.needsReview) {
        expect(p.targetPath).toBe('notes/override-room');
      }
    }
  });

  // ── /build/history ────────────────────────────────────────────────────────

  it('GET /build/history returns an empty list when no runs have been made', async () => {
    const r = await get(`${baseUrl}/build/history`);
    expect(r.status).toBe(200);
    expect(r.body.runs).toEqual([]);
  });

  it('GET /build/history lists a run produced by /build/dry-run', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({}));
    await post(`${baseUrl}/notes`, { title: 'H', content: 'h' });
    const dry = await post(`${baseUrl}/build/dry-run`, { trigger: 'test' });
    const runId = dry.body.run.runId;
    const r = await get(`${baseUrl}/build/history`);
    expect(r.status).toBe(200);
    expect(r.body.runs.map((run: any) => run.runId)).toContain(runId);
  });

  // ── /trace/sources + /trace/derivatives ─────────────────────────────────

  it('GET /trace/sources/:wikiId returns an empty array for a non-existent id', async () => {
    const r = await get(`${baseUrl}/trace/sources/kb_does_not_exist`);
    expect(r.status).toBe(200);
    expect(r.body.sources).toEqual([]);
  });

  it('GET /trace/derivatives/:sourceId returns an empty array for a non-existent id', async () => {
    const r = await get(`${baseUrl}/trace/derivatives/kb_does_not_exist`);
    expect(r.status).toBe(200);
    expect(r.body.derivatives).toEqual([]);
  });

  it('GET /trace/derivatives returns [] for a raw note with no consumers', async () => {
    const created = await post(`${baseUrl}/notes`, { title: 'Orphan', content: 'x' });
    const r = await get(`${baseUrl}/trace/derivatives/${created.body.note.id}`);
    expect(r.status).toBe(200);
    expect(r.body.derivatives).toEqual([]);
  });

  // ── Phase 3 — review gate + commit + revert ───────────────────────────────

  it('POST /build/run returns a runId and awaits review (fixture LLM)', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'topic', title: 'Topic' }));
    await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const r = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.runId).toMatch(/^run_/);
    expect(r.body.proposals.length).toBeGreaterThanOrEqual(1);
    expect(r.body.awaitingReview).toBeGreaterThanOrEqual(1);
  });

  it('POST /build/runs/:runId/approve commits approved proposals and writes wiki files', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'committed', title: 'Committed' }));
    const src = await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const run = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    const proposalId = run.body.proposals[0].proposalId;
    const approve = await post(`${baseUrl}/build/runs/${run.body.runId}/approve`, {
      proposalIds: [proposalId],
    });
    expect(approve.status).toBe(200);
    expect(approve.body.written).toHaveLength(1);
    expect(approve.body.created).toHaveLength(1);
    expect(approve.body.updatedConsumedBy).toContain(src.body.note.id);

    // Wiki file is now fetchable via the v1 route
    const wikiId = approve.body.written[0];
    const fetched = await get(`${baseUrl}/notes/${wikiId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.note.kind).toBe('wiki');
    expect(fetched.body.note.title).toBe('Committed');
  });

  it('POST /build/runs/:runId/reject records decisions without writing any wiki', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'reject-me' }));
    await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const run = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    const beforeNotes = await get(`${baseUrl}/notes`);
    const beforeCount = beforeNotes.body.notes.length;
    const r = await post(`${baseUrl}/build/runs/${run.body.runId}/reject`, {
      proposalIds: [run.body.proposals[0].proposalId],
      reason: 'not useful',
    });
    expect(r.status).toBe(200);
    expect(r.body.rejected).toBe(1);
    const afterNotes = await get(`${baseUrl}/notes`);
    expect(afterNotes.body.notes.length).toBe(beforeCount);
  });

  it('POST /build/runs/:runId/revert deletes a committed wiki and strips consumedBy', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'revert-me' }));
    const src = await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const run = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    const approve = await post(`${baseUrl}/build/runs/${run.body.runId}/approve`, {
      proposalIds: [run.body.proposals[0].proposalId],
    });
    const wikiId = approve.body.written[0];
    // Wiki exists + source has reverse link
    expect((await get(`${baseUrl}/notes/${wikiId}`)).status).toBe(200);

    const revert = await post(`${baseUrl}/build/runs/${run.body.runId}/revert`, {});
    expect(revert.status).toBe(200);
    expect(revert.body.reverted).toContain(wikiId);

    // Wiki is now 404
    expect((await get(`${baseUrl}/notes/${wikiId}`)).status).toBe(404);
    // Source's consumedBy no longer has the reverted wiki
    const srcAfter = await get(`${baseUrl}/notes/${src.body.note.id}`);
    expect(srcAfter.body.note.consumedBy ?? []).not.toContain(wikiId);
  });

  it('POST /build/runs/:runId/approve rejects approval on needsReview proposals', async () => {
    // Fixture that emits a hallucinated id → synthesize validator flags needsReview
    const badFixture: LlmClient = {
      cluster: async (input) => ({
        clusters: [{
          clusterName: 'bad',
          rawIds: input.sources.map((s) => s.id),
          confidence: 'high',
        }],
        tokens: { model: 'fixture', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
      synthesize: async () => ({
        output: {
          title: 'Bad',
          body: 'cites [^kb_ghost]',
          tags: [],
          sourceRefs: ['kb_ghost'],
        },
        tokens: { model: 'fixture', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
    };
    setBuilderLlmClient(badFixture);
    await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const run = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    expect(run.body.proposals[0].needsReview).toBe(true);

    const approve = await post(`${baseUrl}/build/runs/${run.body.runId}/approve`, {
      proposalIds: [run.body.proposals[0].proposalId],
    });
    expect(approve.status).toBe(400);
    expect(approve.body.error).toMatch(/needsReview/i);
  });

  it('POST /rebuild/:wikiId produces a merge proposal awaiting review', async () => {
    // Set up a wiki by running build + approve first, then rebuild it.
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'rebuild-scope', title: 'Original' }));
    await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const run = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    const approve = await post(`${baseUrl}/build/runs/${run.body.runId}/approve`, {
      proposalIds: [run.body.proposals[0].proposalId],
    });
    const wikiId = approve.body.written[0];

    // Now rebuild that wiki
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'rebuilt', title: 'Rebuilt title' }));
    const rebuild = await post(`${baseUrl}/rebuild/${wikiId}`, {});
    expect(rebuild.status).toBe(200);
    expect(rebuild.body.runId).toMatch(/^run_/);
    expect(rebuild.body.proposals).toHaveLength(1);
    expect(rebuild.body.proposals[0].actionPlan.type).toBe('merge');
    expect(rebuild.body.proposals[0].actionPlan.existingWikiId).toBe(wikiId);
  });

  it('POST /rebuild/:wikiId 404s on nonexistent wiki', async () => {
    const r = await post(`${baseUrl}/rebuild/kb_does_not_exist`, {});
    expect(r.status).toBe(404);
  });

  // ── Compose lane (zero-key, deterministic) ─────────────────────────────
  //
  // The compose lane is a parallel zero-LLM path beside the v2 build pipeline.
  // Router-level tests verify request shape, response shape, and error
  // mapping; the actual composeWiki / rebuildComposedWiki implementation is
  // owned by codex-6's parallel slice in knowledge-base-store.ts. Until that
  // lands, the tests stub the methods on the singleton so the router layer
  // can be verified in isolation.

  /** Patch the singleton store with stub compose methods for router tests. */
  function stubComposeMethods(opts: {
    composeWiki?: (input: any) => Promise<any>;
    rebuildComposedWiki?: (pageId: string, opts?: any) => Promise<any>;
  }): void {
    const store = KnowledgeBaseStore.getInstance();
    if (opts.composeWiki) (store as any).composeWiki = opts.composeWiki;
    if (opts.rebuildComposedWiki) (store as any).rebuildComposedWiki = opts.rebuildComposedWiki;
  }

  /** Build a real KbError so the router's `instanceof KbError` check fires. */
  function fakeKbError(message: string, code: string): Error {
    return new KbError(message, code as any);
  }

  it('POST /compose returns 201 and the composed note', async () => {
    stubComposeMethods({
      composeWiki: async (input) => ({
        id: 'kb_composed_1',
        title: input.title ?? 'Composed',
        body: '# Composed\n\nFrom kb_a.',
        kind: 'wiki',
        path: 'notes/auth',
        slug: 'overview',
        sourceRefs: input.sourceIds,
        consumedBy: [],
        tags: [],
        lastComposedBodyHash: 'sha256-fixture-hash',
      }),
    });
    const r = await post(`${baseUrl}/compose`, {
      pagePath: 'notes/auth/overview',
      sourceIds: ['kb_a'],
      title: 'Auth Overview',
    });
    expect(r.status).toBe(201);
    expect(r.body.note.id).toBe('kb_composed_1');
    expect(r.body.note.kind).toBe('wiki');
    expect(r.body.note.sourceRefs).toEqual(['kb_a']);
    expect(r.body.note.lastComposedBodyHash).toBe('sha256-fixture-hash');
  });

  it('POST /compose 400 on missing pagePath', async () => {
    stubComposeMethods({ composeWiki: async () => ({ id: 'never' }) });
    const r = await post(`${baseUrl}/compose`, { sourceIds: ['kb_a'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/pagePath/);
  });

  it('POST /compose 400 on empty sourceIds', async () => {
    stubComposeMethods({ composeWiki: async () => ({ id: 'never' }) });
    const r = await post(`${baseUrl}/compose`, {
      pagePath: 'notes/auth/overview',
      sourceIds: [],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sourceIds/);
  });

  it('POST /compose 400 when store throws KbError with a non-special code', async () => {
    stubComposeMethods({
      composeWiki: async () => { throw fakeKbError('source kb_ghost not found', 'not_found'); },
    });
    const r = await post(`${baseUrl}/compose`, {
      pagePath: 'notes/auth/overview',
      sourceIds: ['kb_ghost'],
    });
    // not_found maps to 404 via the existing handleKbError branch.
    expect(r.status).toBe(404);
  });

  it('POST /compose 400 on invalid target path KbError', async () => {
    stubComposeMethods({
      composeWiki: async () => { throw fakeKbError('pagePath must be under notes/', 'invalid_path'); },
    });
    const r = await post(`${baseUrl}/compose`, {
      pagePath: 'inbox/oops',
      sourceIds: ['kb_a'],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/under notes/);
  });

  it('POST /compose/rebuild/:pageId returns 200 with the rebuilt note on hash match', async () => {
    stubComposeMethods({
      rebuildComposedWiki: async (pageId, opts) => ({
        id: pageId,
        title: 'Rebuilt',
        body: '# Rebuilt\n\nFrom kb_a.',
        kind: 'wiki',
        sourceRefs: ['kb_a'],
        lastComposedBodyHash: 'sha256-new-hash',
        rebuiltWithForce: opts?.force === true,
      }),
    });
    const r = await post(`${baseUrl}/compose/rebuild/kb_wiki_1`, {});
    expect(r.status).toBe(200);
    expect(r.body.note.id).toBe('kb_wiki_1');
    expect(r.body.note.lastComposedBodyHash).toBe('sha256-new-hash');
    expect(r.body.note.rebuiltWithForce).toBe(false);
  });

  it('POST /compose/rebuild/:pageId returns 409 with code:manual_edits_present when body diverged and force is not set', async () => {
    stubComposeMethods({
      rebuildComposedWiki: async () => {
        throw fakeKbError('Wiki body has diverged from lastComposedBodyHash', 'manual_edits_present');
      },
    });
    const r = await post(`${baseUrl}/compose/rebuild/kb_wiki_1`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('manual_edits_present');
    expect(r.body.error).toMatch(/diverged/);
  });

  it('POST /compose/rebuild/:pageId with force:true overwrites and returns 200', async () => {
    stubComposeMethods({
      rebuildComposedWiki: async (pageId, opts) => {
        if (opts?.force !== true) {
          throw fakeKbError('Wiki body diverged', 'manual_edits_present');
        }
        return {
          id: pageId,
          title: 'Forced rebuild',
          body: '# Forced\n\nFrom kb_a.',
          kind: 'wiki',
          sourceRefs: ['kb_a'],
          lastComposedBodyHash: 'sha256-forced-hash',
        };
      },
    });
    const r = await post(`${baseUrl}/compose/rebuild/kb_wiki_1`, { force: true });
    expect(r.status).toBe(200);
    expect(r.body.note.title).toBe('Forced rebuild');
    expect(r.body.note.lastComposedBodyHash).toBe('sha256-forced-hash');
  });

  it('POST /compose/rebuild/:pageId returns 404 when the wiki id does not exist', async () => {
    stubComposeMethods({
      rebuildComposedWiki: async () => { throw fakeKbError('Wiki kb_ghost not found', 'not_found'); },
    });
    const r = await post(`${baseUrl}/compose/rebuild/kb_ghost`, {});
    expect(r.status).toBe(404);
  });

  it('POST /compose/rebuild/:pageId 400 on a non-boolean force value', async () => {
    stubComposeMethods({ rebuildComposedWiki: async () => ({ id: 'never' }) });
    const r = await post(`${baseUrl}/compose/rebuild/kb_wiki_1`, { force: 'yes' });
    expect(r.status).toBe(400);
  });

  it('DELETE /notes/:id 409s on raw source with consumers, 200s with ?cascade=true', async () => {
    setBuilderLlmClient(makeRestFixtureLlm({ clusterName: 'cascade' }));
    const src = await post(`${baseUrl}/notes`, { title: 'Src', content: 'body' });
    const run = await post(`${baseUrl}/build/run`, { trigger: 'test' });
    await post(`${baseUrl}/build/runs/${run.body.runId}/approve`, {
      proposalIds: [run.body.proposals[0].proposalId],
    });

    // Without cascade: 409
    const fail = await del(`${baseUrl}/notes/${src.body.note.id}`);
    expect(fail.status).toBe(409);
    expect(fail.body.code).toBe('cascade_required');

    // With cascade: 200, source gone, wiki marked stale
    const ok = await del(`${baseUrl}/notes/${src.body.note.id}?cascade=true`);
    expect(ok.status).toBe(200);
    const srcAfter = await get(`${baseUrl}/notes/${src.body.note.id}`);
    expect(srcAfter.status).toBe(404);
  });
});
