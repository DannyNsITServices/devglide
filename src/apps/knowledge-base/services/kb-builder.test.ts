import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  KnowledgeBaseStore,
  KB_INBOX_DIR,
  KB_NOTES_DIR,
} from './knowledge-base-store.js';
import {
  KbBuilder,
  findBestMatch,
  deriveCreateTarget,
  jaccardSimilarity,
  validateSynthesizeOutput,
  computeDiff,
  hashPromptInput,
} from './kb-builder.js';
import { KbBuildRunStore, generateBuildRunId, KB_BUILD_RUNS_DIR } from './kb-build-run-store.js';
import type {
  ActionPlan,
  ClusterPlan,
  LlmClient,
  LlmClusterInput,
  LlmSynthesizeInput,
  ProposedPage,
} from './kb-builder-types.js';
import { BUILDER_PROMPT_VERSION } from './kb-builder-types.js';
import type { KbNote } from '../types.js';

// ── Test harness ────────────────────────────────────────────────────────────
//
// Phase 2 of KB v2 (`zepfafcw7yeejvpbrcowf37t`) delivers the dry-run pipeline.
// This suite verifies:
//   - Pure helpers (jaccard, validate, diff, hash, findBestMatch, deriveCreateTarget)
//   - KbBuildRunStore write/read/list/remove round-trip
//   - Stage 1 scan partitions notes correctly
//   - Stage 2 cluster validates LLM output (drops hallucinations, handles orphans)
//   - Stage 3 planActions matches existing wikis by sourceRefs overlap
//   - Stage 4 synthesize validates output and isolates failures as needsReview
//   - End-to-end dry-run produces a valid BuildRun audit record
//   - Determinism: same input + same fixture LLM = same output hash
//   - Only the build-run audit file is written — no commits, no consumedBy updates

let tmpRoot: string;
let store: KnowledgeBaseStore;
let runStore: KbBuildRunStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-builder-'));
  store = KnowledgeBaseStore.resetForTests(tmpRoot);
  runStore = new KbBuildRunStore(tmpRoot);
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Fixture LLM client ──────────────────────────────────────────────────────
//
// A deterministic LLM client that takes pre-recorded cluster/synthesize
// outputs and returns them. Any call with an unknown input throws so tests
// fail loudly instead of silently using a fallback.

interface FixtureMap {
  clusters?: Array<{
    matches: (input: LlmClusterInput) => boolean;
    clusters: ClusterPlan[];
  }>;
  synthesizes?: Array<{
    matches: (input: LlmSynthesizeInput) => boolean;
    output: { title: string; body: string; tags: string[]; sourceRefs: string[] };
  }>;
}

function createFixtureLlmClient(fixtures: FixtureMap): LlmClient {
  return {
    cluster: async (input) => {
      const hit = fixtures.clusters?.find((c) => c.matches(input));
      if (!hit) throw new Error(`FixtureLlmClient: no cluster fixture for input with ${input.sources.length} sources`);
      return {
        clusters: hit.clusters,
        tokens: { model: 'fixture', inputTokens: input.sources.length * 10, outputTokens: 50, durationMs: 1 },
      };
    },
    synthesize: async (input) => {
      const hit = fixtures.synthesizes?.find((s) => s.matches(input));
      if (!hit) throw new Error(`FixtureLlmClient: no synthesize fixture for plan ${input.plan.type} cluster "${input.plan.cluster.clusterName}"`);
      return {
        output: hit.output,
        tokens: { model: 'fixture', inputTokens: input.sources.reduce((acc, s) => acc + s.body.length, 0), outputTokens: hit.output.body.length, durationMs: 1 },
      };
    },
  };
}

/**
 * A fixture client that throws for every call. Used when testing pure-code
 * stages that should never invoke the LLM.
 */
function createThrowingLlmClient(): LlmClient {
  return {
    cluster: async () => { throw new Error('LLM should not have been called'); },
    synthesize: async () => { throw new Error('LLM should not have been called'); },
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });
  it('computes a partial overlap correctly', () => {
    const s = jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
    expect(s).toBeCloseTo(0.5); // |{b,c}| / |{a,b,c,d}| = 2/4
  });
  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe('deriveCreateTarget', () => {
  it('maps a single-word topic to notes/<topic>/', () => {
    const t = deriveCreateTarget({ clusterName: 'auth', rawIds: ['kb_x'], confidence: 'high' });
    expect(t.targetPath).toBe('notes/auth');
    expect(t.targetSlug).toBe('auth');
  });
  it('splits a slash-hinted cluster name into path + slug', () => {
    const t = deriveCreateTarget({ clusterName: 'auth/oauth-flow', rawIds: ['kb_x'], confidence: 'high' });
    expect(t.targetPath).toBe('notes/auth');
    expect(t.targetSlug).toBe('oauth-flow');
  });
  it('falls back to notes/drafts for multi-word names', () => {
    const t = deriveCreateTarget({ clusterName: 'my weird topic', rawIds: ['kb_x'], confidence: 'low' });
    expect(t.targetPath).toBe('notes/drafts');
    expect(t.targetSlug).toBe('my-weird-topic');
  });
  it('returns "draft" slug for an empty cluster name', () => {
    const t = deriveCreateTarget({ clusterName: '', rawIds: ['kb_x'], confidence: 'low' });
    expect(t.targetSlug).toBe('draft');
    expect(t.targetPath).toBe('notes/drafts');
  });
});

describe('validateSynthesizeOutput', () => {
  const ids = new Set(['kb_a', 'kb_b']);
  it('accepts a well-formed output with resolved citations', () => {
    expect(
      validateSynthesizeOutput(
        { title: 'T', body: 'hello [^kb_a] world [^kb_b]', tags: [], sourceRefs: ['kb_a', 'kb_b'] },
        ids,
      ),
    ).toBeNull();
  });
  it('rejects an empty title', () => {
    expect(
      validateSynthesizeOutput({ title: '   ', body: 'x', tags: [], sourceRefs: ['kb_a'] }, ids),
    ).toContain('title');
  });
  it('rejects an empty body', () => {
    expect(
      validateSynthesizeOutput({ title: 'T', body: '', tags: [], sourceRefs: ['kb_a'] }, ids),
    ).toContain('body');
  });
  it('rejects an empty sourceRefs array', () => {
    expect(
      validateSynthesizeOutput({ title: 'T', body: 'b', tags: [], sourceRefs: [] }, ids),
    ).toContain('sourceRefs');
  });
  it('rejects a hallucinated id in sourceRefs', () => {
    expect(
      validateSynthesizeOutput({ title: 'T', body: 'b', tags: [], sourceRefs: ['kb_ghost'] }, ids),
    ).toContain('hallucination');
  });
  it('rejects a body citation that is not in sourceRefs', () => {
    expect(
      validateSynthesizeOutput(
        { title: 'T', body: 'hi [^kb_a] and [^kb_unknown]', tags: [], sourceRefs: ['kb_a'] },
        ids,
      ),
    ).toContain('not in sourceRefs');
  });
});

describe('computeDiff', () => {
  it('returns "(no changes)" for identical bodies', () => {
    expect(computeDiff('hello\nworld', 'hello\nworld')).toBe('(no changes)');
  });
  it('emits +/- lines for modified lines', () => {
    const d = computeDiff('hello\nworld', 'hello\nthere');
    expect(d).toContain('- world');
    expect(d).toContain('+ there');
    expect(d).not.toContain('hello'); // unchanged lines are not emitted
  });
});

describe('hashPromptInput', () => {
  it('is deterministic for the same input', () => {
    const a = hashPromptInput({ foo: 'bar', baz: [1, 2] });
    const b = hashPromptInput({ foo: 'bar', baz: [1, 2] });
    expect(a).toBe(b);
  });
  it('differs for different inputs', () => {
    expect(hashPromptInput({ foo: 'a' })).not.toBe(hashPromptInput({ foo: 'b' }));
  });
});

// ── KbBuildRunStore ─────────────────────────────────────────────────────────

describe('KbBuildRunStore', () => {
  const mkRun = (runId: string): import('./kb-builder-types.js').BuildRun => ({
    runId,
    startedAt: '2026-04-08T00:00:00.000Z',
    completedAt: '2026-04-08T00:00:01.000Z',
    trigger: 'test',
    promptVersion: BUILDER_PROMPT_VERSION,
    scope: {},
    scan: { eligibleSources: [], staleWikis: [], freshWikis: [] },
    clusters: [],
    actions: [],
    proposals: [],
    decisions: [],
    committed: null,
    reverted: false,
    llmCalls: [],
  });

  it('write + get round-trips a BuildRun', async () => {
    const run = mkRun(generateBuildRunId());
    await runStore.write(run);
    const loaded = await runStore.get(run.runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe(run.runId);
    expect(loaded?.trigger).toBe('test');
  });

  it('get returns null for a missing run', async () => {
    const loaded = await runStore.get('run_nonexistent_abc');
    expect(loaded).toBeNull();
  });

  it('list returns newest run first', async () => {
    const a = mkRun('run_20260408_000000_aaaa');
    const b = mkRun('run_20260408_000001_bbbb');
    const c = mkRun('run_20260408_000002_cccc');
    await runStore.write(a);
    await runStore.write(b);
    await runStore.write(c);
    const summaries = await runStore.list(10);
    expect(summaries.map((s) => s.runId)).toEqual([c.runId, b.runId, a.runId]);
  });

  it('list honors the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await runStore.write(mkRun(`run_2026040800000${i}_xxxxxxxx`));
    }
    const summaries = await runStore.list(2);
    expect(summaries).toHaveLength(2);
  });

  it('remove() deletes a run and returns true, false if absent', async () => {
    const run = mkRun(generateBuildRunId());
    await runStore.write(run);
    expect(await runStore.remove(run.runId)).toBe(true);
    expect(await runStore.remove(run.runId)).toBe(false);
    expect(await runStore.get(run.runId)).toBeNull();
  });

  it('rejects invalid run ids to prevent path traversal', async () => {
    const run = mkRun('run_../../etc/passwd');
    await expect(runStore.write(run)).rejects.toThrow(/Invalid build run id/);
  });

  it('skips malformed files in list() instead of throwing', async () => {
    await runStore.ensureDir();
    await fs.writeFile(
      path.join(tmpRoot, KB_BUILD_RUNS_DIR, 'run_bogus.json'),
      '{not json',
      'utf-8',
    );
    const good = mkRun('run_20260408000003_good1234');
    await runStore.write(good);
    const summaries = await runStore.list(10);
    expect(summaries.map((s) => s.runId)).toContain('run_20260408000003_good1234');
  });

  it('generateBuildRunId produces unique ids', () => {
    const a = generateBuildRunId('2026-04-08T00:00:00.000Z');
    const b = generateBuildRunId('2026-04-08T00:00:00.000Z');
    expect(a).toMatch(/^run_\d{8}_\d{6}_[a-z0-9]{8}$/);
    expect(b).toMatch(/^run_\d{8}_\d{6}_[a-z0-9]{8}$/);
    expect(a).not.toBe(b); // cuid8 suffix differs
  });
});

// ── Stage 1 — scan ──────────────────────────────────────────────────────────

describe('KbBuilder.scan', () => {
  it('partitions raw sources as eligible when they have no consumedBy', async () => {
    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    await store.add({ title: 'Raw one', content: 'body one' });
    await store.add({ title: 'Raw two', content: 'body two' });
    const scan = await builder.scan();
    expect(scan.eligibleSources.length).toBeGreaterThanOrEqual(2);
    // The welcome _index is kind=index, not raw → should NOT be in eligibleSources
    for (const s of scan.eligibleSources) expect(s.slug).not.toBe('_index');
  });

  it('classifies a wiki page as fresh when its sourceRefs are unchanged', async () => {
    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const src = await store.add({ title: 'Source A', content: 'stable body' });
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    const storeAny = store as unknown as { writeNoteFile: (f: string, n: KbNote) => Promise<void> };
    const hash = KnowledgeBaseStore.hashBody(src.body);
    const wiki: KbNote = {
      id: 'kb_wiki_fresh',
      title: 'Fresh wiki',
      slug: 'fresh',
      path: 'notes/test',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'stable wiki body',
      kind: 'wiki',
      sourceRefs: [src.id],
      lastSourceHashes: { [src.id]: hash },
    };
    await storeAny.writeNoteFile(path.join(wikiDir, 'fresh.md'), wiki);
    await store.rebuildIndex();
    const scan = await builder.scan();
    expect(scan.freshWikis.map((w) => w.id)).toContain('kb_wiki_fresh');
    expect(scan.staleWikis.map((w) => w.id)).not.toContain('kb_wiki_fresh');
  });

  it('classifies a wiki as stale when a cited source body has changed', async () => {
    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const src = await store.add({ title: 'Source B', content: 'original body' });
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    const storeAny = store as unknown as { writeNoteFile: (f: string, n: KbNote) => Promise<void> };
    const wiki: KbNote = {
      id: 'kb_wiki_stale',
      title: 'Stale wiki',
      slug: 'stale',
      path: 'notes/test',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'wiki body',
      kind: 'wiki',
      sourceRefs: [src.id],
      lastSourceHashes: { [src.id]: 'an-old-hash-that-no-longer-matches' },
    };
    await storeAny.writeNoteFile(path.join(wikiDir, 'stale.md'), wiki);
    await store.rebuildIndex();
    const scan = await builder.scan();
    expect(scan.staleWikis.map((w) => w.id)).toContain('kb_wiki_stale');
    expect(scan.freshWikis.map((w) => w.id)).not.toContain('kb_wiki_stale');
  });
});

// ── Stage 2 — cluster ───────────────────────────────────────────────────────

describe('KbBuilder.cluster', () => {
  it('returns empty clusters for empty input', async () => {
    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const result = await builder.cluster([]);
    expect(result.clusters).toEqual([]);
  });

  it('drops hallucinated ids that are not in the input', async () => {
    const src = await store.add({ title: 'Real', content: 'body' });
    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [{
          clusterName: 'topic',
          rawIds: [src.id, 'kb_hallucinated'],
          confidence: 'high',
        }],
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const scan = await builder.scan();
    const result = await builder.cluster(scan.eligibleSources);
    const allIds = result.clusters.flatMap((c) => c.rawIds);
    expect(allIds).toContain(src.id);
    expect(allIds).not.toContain('kb_hallucinated');
  });

  it('places orphan ids into a needs-review cluster', async () => {
    const srcA = await store.add({ title: 'A', content: 'a' });
    const srcB = await store.add({ title: 'B', content: 'b' });
    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [{
          clusterName: 'topic',
          rawIds: [srcA.id], // drops srcB → orphan
          confidence: 'high',
        }],
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const scan = await builder.scan();
    const result = await builder.cluster(scan.eligibleSources);
    const needsReview = result.clusters.find((c) => c.clusterName === 'needs-review');
    expect(needsReview).toBeDefined();
    expect(needsReview?.rawIds).toContain(srcB.id);
  });

  it('drops duplicate placements (same id in multiple clusters)', async () => {
    const src = await store.add({ title: 'Once', content: 'body' });
    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [
          { clusterName: 'first', rawIds: [src.id], confidence: 'high' },
          { clusterName: 'second', rawIds: [src.id], confidence: 'medium' }, // duplicate
        ],
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const scan = await builder.scan();
    const result = await builder.cluster(scan.eligibleSources);
    const allIds = result.clusters.flatMap((c) => c.rawIds);
    const occurrences = allIds.filter((id) => id === src.id).length;
    expect(occurrences).toBe(1);
  });
});

// ── Stage 3 — planActions ───────────────────────────────────────────────────

describe('KbBuilder.planActions', () => {
  it('plans a create action when no matching wiki exists', async () => {
    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const clusters: ClusterPlan[] = [{ clusterName: 'auth', rawIds: ['kb_a'], confidence: 'high' }];
    const actions = await builder.planActions(clusters);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('create');
    if (actions[0]?.type === 'create') {
      expect(actions[0].targetPath).toBe('notes/auth');
    }
  });

  it('plans a merge action when an existing wiki cites ≥50% of cluster sources', async () => {
    const srcA = await store.add({ title: 'Src A', content: 'a body' });
    const srcB = await store.add({ title: 'Src B', content: 'b body' });
    // Write an existing wiki citing both sources.
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'auth');
    await fs.mkdir(wikiDir, { recursive: true });
    const storeAny = store as unknown as { writeNoteFile: (f: string, n: KbNote) => Promise<void> };
    const existingWiki: KbNote = {
      id: 'kb_wiki_existing_auth',
      title: 'Existing auth',
      slug: 'existing',
      path: 'notes/auth',
      tags: ['auth'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'wiki',
      kind: 'wiki',
      sourceRefs: [srcA.id, srcB.id],
    };
    await storeAny.writeNoteFile(path.join(wikiDir, 'existing.md'), existingWiki);
    await store.rebuildIndex();

    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const clusters: ClusterPlan[] = [{
      clusterName: 'auth',
      rawIds: [srcA.id, srcB.id],
      confidence: 'high',
    }];
    const actions = await builder.planActions(clusters);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('merge');
    if (actions[0]?.type === 'merge') {
      expect(actions[0].existingWikiId).toBe('kb_wiki_existing_auth');
    }
  });

  it('skips clusters named needs-review', async () => {
    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const clusters: ClusterPlan[] = [{ clusterName: 'needs-review', rawIds: ['kb_x'], confidence: 'low' }];
    const actions = await builder.planActions(clusters);
    expect(actions[0]?.type).toBe('skip');
  });
});

// ── Stage 4 — synthesize ────────────────────────────────────────────────────

describe('KbBuilder.synthesize', () => {
  it('produces a valid ProposedPage for a create action', async () => {
    const src = await store.add({ title: 'Src', content: 'source body here' });
    const fixture = createFixtureLlmClient({
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'Synthesized',
          body: `Pulled from [^${src.id}].`,
          tags: ['syn'],
          sourceRefs: [src.id],
        },
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const plan: ActionPlan = {
      type: 'create',
      cluster: { clusterName: 'syn', rawIds: [src.id], confidence: 'high' },
      targetPath: 'notes/syn',
      targetSlug: 'syn-note',
    };
    const { proposals, llmUsage } = await builder.synthesize([plan]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.title).toBe('Synthesized');
    expect(proposals[0]?.sourceRefs).toEqual([src.id]);
    expect(proposals[0]?.kind).toBe('wiki');
    expect(proposals[0]?.needsReview).toBeUndefined();
    expect(llmUsage).toHaveLength(1);
  });

  it('flags a proposal needsReview when LLM cites a hallucinated id', async () => {
    const src = await store.add({ title: 'Src', content: 'body' });
    const fixture = createFixtureLlmClient({
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'Bad',
          body: 'Cites [^kb_fake_ghost]',
          tags: [],
          sourceRefs: ['kb_fake_ghost'], // not in input
        },
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const plan: ActionPlan = {
      type: 'create',
      cluster: { clusterName: 'c', rawIds: [src.id], confidence: 'high' },
      targetPath: 'notes/c',
      targetSlug: 'c',
    };
    const { proposals } = await builder.synthesize([plan]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.needsReview).toBe(true);
    expect(proposals[0]?.needsReviewReason).toMatch(/sourceRefs is empty|hallucination|not in sourceRefs|empty/);
  });

  it('isolates a single failed proposal without failing the whole stage', async () => {
    const srcA = await store.add({ title: 'A', content: 'a' });
    const srcB = await store.add({ title: 'B', content: 'b' });
    let callCount = 0;
    const fixture: LlmClient = {
      cluster: async () => { throw new Error('unused'); },
      synthesize: async (input) => {
        callCount++;
        if (callCount === 1) {
          // First call fails
          throw new Error('simulated LLM outage');
        }
        // Second call succeeds
        return {
          output: {
            title: 'OK',
            body: `Cite [^${input.sources[0]?.id}]`,
            tags: [],
            sourceRefs: [input.sources[0]?.id ?? ''],
          },
          tokens: { model: 'fixture', inputTokens: 10, outputTokens: 5, durationMs: 1 },
        };
      },
    };
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const plans: ActionPlan[] = [
      {
        type: 'create',
        cluster: { clusterName: 'first', rawIds: [srcA.id], confidence: 'high' },
        targetPath: 'notes/first',
        targetSlug: 'first',
      },
      {
        type: 'create',
        cluster: { clusterName: 'second', rawIds: [srcB.id], confidence: 'high' },
        targetPath: 'notes/second',
        targetSlug: 'second',
      },
    ];
    const { proposals } = await builder.synthesize(plans);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.needsReview).toBe(true);
    expect(proposals[1]?.needsReview).toBeUndefined();
    expect(proposals[1]?.title).toBe('OK');
  });

  it('flattens skip actions into needsReview proposals', async () => {
    const fixture = createFixtureLlmClient({});
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const plan: ActionPlan = {
      type: 'skip',
      cluster: { clusterName: 'needs-review', rawIds: ['kb_x'], confidence: 'low' },
      reason: 'test skip',
    };
    const { proposals } = await builder.synthesize([plan]);
    expect(proposals[0]?.needsReview).toBe(true);
    expect(proposals[0]?.needsReviewReason).toBe('test skip');
  });
});

// ── End-to-end dry run ──────────────────────────────────────────────────────

describe('KbBuilder.buildDryRun (end-to-end)', () => {
  it('produces a valid BuildRun record for a fixture corpus', async () => {
    const srcA = await store.add({ title: 'Permit expedition fee', content: 'fee details here' });
    const srcB = await store.add({ title: 'Permit appeal process', content: 'appeal docs' });

    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [{
          clusterName: 'permits',
          rawIds: [srcA.id, srcB.id],
          confidence: 'high',
        }],
      }],
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'Permits overview',
          body: `Permit fees are described in [^${srcA.id}]. The appeal process lives in [^${srcB.id}].`,
          tags: ['permits'],
          sourceRefs: [srcA.id, srcB.id],
        },
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });

    const run = await builder.buildDryRun({ trigger: 'test' });

    // Structure checks
    expect(run.runId).toMatch(/^run_/);
    expect(run.promptVersion).toBe(BUILDER_PROMPT_VERSION);
    expect(run.completedAt).not.toBeNull();
    expect(run.scan.eligibleSources.length).toBeGreaterThanOrEqual(2);
    expect(run.clusters.length).toBeGreaterThanOrEqual(1);
    expect(run.actions.length).toBeGreaterThanOrEqual(1);
    expect(run.proposals.length).toBeGreaterThanOrEqual(1);
    expect(run.llmCalls.length).toBeGreaterThanOrEqual(2); // 1 cluster + 1 synthesize
    expect(run.committed).toBeNull(); // dry run — no commit
    expect(run.reverted).toBe(false);

    // The proposal should be valid (not needsReview)
    const proposal = run.proposals[0];
    expect(proposal?.needsReview).toBeUndefined();
    expect(proposal?.sourceRefs).toContain(srcA.id);
    expect(proposal?.sourceRefs).toContain(srcB.id);
  });

  it('persists the BuildRun to the build-runs/ audit directory', async () => {
    const src = await store.add({ title: 'T', content: 'body' });
    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [{ clusterName: 't', rawIds: [src.id], confidence: 'high' }],
      }],
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'T',
          body: `cite [^${src.id}]`,
          tags: [],
          sourceRefs: [src.id],
        },
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const run = await builder.buildDryRun({ trigger: 'test' });

    // File exists on disk
    const buildRunsDir = path.join(tmpRoot, KB_BUILD_RUNS_DIR);
    const files = await fs.readdir(buildRunsDir);
    expect(files).toContain(`${run.runId}.json`);

    // File content round-trips via the store
    const loaded = await runStore.get(run.runId);
    expect(loaded?.runId).toBe(run.runId);
    expect(loaded?.proposals.length).toBe(run.proposals.length);
  });

  it('does NOT write any wiki pages or update consumedBy indices', async () => {
    const src = await store.add({ title: 'T', content: 'body' });
    const initialNotes = await store.list();
    const initialCount = initialNotes.length;
    const initialSource = await store.get(src.id);
    const initialConsumedBy = initialSource?.consumedBy ?? [];

    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [{ clusterName: 't', rawIds: [src.id], confidence: 'high' }],
      }],
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'T',
          body: `cite [^${src.id}]`,
          tags: [],
          sourceRefs: [src.id],
        },
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    await builder.buildDryRun({ trigger: 'test' });

    // No new notes landed on disk (no wiki page was committed)
    const afterNotes = await store.list();
    expect(afterNotes.length).toBe(initialCount);

    // The source's consumedBy is unchanged
    const afterSource = await store.get(src.id);
    expect(afterSource?.consumedBy ?? []).toEqual(initialConsumedBy);
  });

  it('works when there are zero eligible sources', async () => {
    const builder = new KbBuilder({
      store,
      runStore,
      llm: createThrowingLlmClient(), // should never be called
    });
    const run = await builder.buildDryRun({ trigger: 'test' });
    expect(run.scan.eligibleSources).toEqual([]);
    expect(run.clusters).toEqual([]);
    expect(run.actions).toEqual([]);
    expect(run.proposals).toEqual([]);
    expect(run.llmCalls).toEqual([]);
    expect(run.completedAt).not.toBeNull();
  });

  it('honors targetRoom override on create proposals end-to-end', async () => {
    // Regression test for codex-2 Phase 2 review finding #2: `targetRoom` was
    // accepted by buildDryRun but never applied to create actions/proposals.
    const src = await store.add({ title: 'T', content: 'body' });
    const fixture = createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        // Deliberately use a cluster name that would normally route to
        // `notes/auth` via deriveCreateTarget, so we can verify the
        // override actually takes precedence.
        clusters: [{ clusterName: 'auth', rawIds: [src.id], confidence: 'high' }],
      }],
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'Overridden',
          body: `cite [^${src.id}]`,
          tags: [],
          sourceRefs: [src.id],
        },
      }],
    });
    const builder = new KbBuilder({ store, runStore, llm: fixture });
    const run = await builder.buildDryRun({
      trigger: 'test',
      targetRoom: 'notes/custom-room',
    });

    // Default heuristic would have produced `notes/auth`. The override must win.
    expect(run.actions).toHaveLength(1);
    const action = run.actions[0];
    expect(action?.type).toBe('create');
    if (action?.type === 'create') {
      expect(action.targetPath).toBe('notes/custom-room');
    }
    // And the proposal must carry the overridden path too.
    expect(run.proposals[0]?.targetPath).toBe('notes/custom-room');
    // scope should also record the targetRoom for audit visibility.
    expect(run.scope.targetRoom).toBe('notes/custom-room');
  });

  it('collectSourcesForBuild bridges stale-wiki sources into the cluster set', async () => {
    // Regression test for codex-2 Phase 2 review finding #3: build_plan and
    // build_dry_run must agree on the same source set. This test verifies the
    // shared helper adds stale-wiki-cited sources to eligible sources.
    const usedSource = await store.add({ title: 'Used', content: 'used body' });
    const neverUsed = await store.add({ title: 'Fresh', content: 'fresh body' });

    // Write a wiki that cites `usedSource` with a stale hash.
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    const storeAny = store as unknown as { writeNoteFile: (f: string, n: KbNote) => Promise<void> };
    const wiki: KbNote = {
      id: 'kb_wiki_stale_bridge',
      title: 'Stale bridge',
      slug: 'stale',
      path: 'notes/test',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'wiki body',
      kind: 'wiki',
      sourceRefs: [usedSource.id],
      lastSourceHashes: { [usedSource.id]: 'an-old-hash-that-does-not-match' },
    };
    await storeAny.writeNoteFile(path.join(wikiDir, 'stale.md'), wiki);
    await store.rebuildIndex();

    const builder = new KbBuilder({ store, runStore, llm: createThrowingLlmClient() });
    const scan = await builder.scan();

    // `usedSource` is already cited (consumedBy populated? no — we didn't set
    // consumedBy on the raw note when writing the wiki manually, so the scan
    // classifies it as eligible-or-not based on the raw note's own state).
    // The important check is that the shared helper includes sources cited by
    // stale wikis, not whether usedSource is already in eligibleSources.
    const allSources = await builder.collectSourcesForBuild(scan);
    // `neverUsed` should appear because it's never been consumed.
    // `usedSource` should appear because the stale wiki cites it.
    const allIds = allSources.map((s) => s.id);
    expect(allIds).toContain(neverUsed.id);
    expect(allIds).toContain(usedSource.id);
    // No duplicates
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

// ── Determinism regression ──────────────────────────────────────────────────

describe('KbBuilder determinism', () => {
  it('same input + same fixture client = same proposal hash', async () => {
    const src = await store.add({ title: 'Det', content: 'deterministic body' });

    const mkFixture = (): LlmClient => createFixtureLlmClient({
      clusters: [{
        matches: () => true,
        clusters: [{ clusterName: 'topic', rawIds: [src.id], confidence: 'high' }],
      }],
      synthesizes: [{
        matches: () => true,
        output: {
          title: 'Fixed',
          body: `Pulled from [^${src.id}].`,
          tags: ['fixed'],
          sourceRefs: [src.id],
        },
      }],
    });

    const runA = await new KbBuilder({ store, runStore, llm: mkFixture() }).buildDryRun({ trigger: 'test' });
    const runB = await new KbBuilder({ store, runStore, llm: mkFixture() }).buildDryRun({ trigger: 'test' });

    // Strip non-deterministic fields (runId, timestamps, proposalId, durationMs)
    const normalize = (run: import('./kb-builder-types.js').BuildRun) => ({
      scan: run.scan,
      clusters: run.clusters,
      actions: run.actions,
      proposals: run.proposals.map((p) => ({
        ...p,
        proposalId: '<normalized>',
      })),
      promptVersion: run.promptVersion,
      llmCalls: run.llmCalls.map((c) => ({ ...c, durationMs: 0 })),
    });

    const hashA = hashPromptInput(normalize(runA));
    const hashB = hashPromptInput(normalize(runB));
    expect(hashA).toBe(hashB);
  });
});

// ── findBestMatch ───────────────────────────────────────────────────────────

describe('findBestMatch', () => {
  it('returns null when no candidate meets the threshold', () => {
    const clusters: ClusterPlan = { clusterName: 'nothing', rawIds: ['kb_x'], confidence: 'low' };
    const result = findBestMatch(clusters, [], new Map());
    expect(result).toBeNull();
  });

  it('matches by sourceRefs overlap', () => {
    const cluster: ClusterPlan = { clusterName: 'topic', rawIds: ['kb_a', 'kb_b'], confidence: 'high' };
    const existing: KbNote = {
      id: 'kb_wiki_match',
      title: 'Topic wiki',
      slug: 'topic-wiki',
      path: 'notes/topic',
      tags: [],
      createdAt: '2026-04-08T00:00:00Z',
      updatedAt: '2026-04-08T00:00:00Z',
      body: 'body',
      kind: 'wiki',
      sourceRefs: ['kb_a', 'kb_b'],
    };
    const summary = {
      id: existing.id,
      title: existing.title,
      slug: existing.slug,
      path: existing.path,
      tags: existing.tags,
      updatedAt: existing.updatedAt,
    };
    const result = findBestMatch(cluster, [summary], new Map([[existing.id, existing]]));
    expect(result?.id).toBe('kb_wiki_match');
  });
});
