import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  KnowledgeBaseStore,
  defaultKindForSlug,
  isWikiStale,
  KB_INBOX_DIR,
  KB_NOTES_DIR,
} from './knowledge-base-store.js';
import type { KbNote } from '../types.js';

// ── Test harness ────────────────────────────────────────────────────────────
//
// Phase 1 of KB v2 (`ygvpccl1ujbx89o4t2cb32mf`) adds the schema + read-path
// foundation. This suite verifies:
//   - v2 frontmatter fields round-trip through the store
//   - `kind` defaults per spec §3.2 (raw by default; index for `_index` slug)
//   - `isWikiStale()` detects the three stale conditions (missing, deleted, edited)
//   - `traceSources()` / `traceDerivatives()` / `getByKind()` query helpers work
//   - `hashBody()` is deterministic and canonical
//   - v1 notes (without any v2 fields) continue to parse correctly
//   - `promote` semantics are unchanged (raw → notes/ move without mutation)

let tmpRoot: string;
let store: KnowledgeBaseStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-v2-'));
  store = KnowledgeBaseStore.resetForTests(tmpRoot);
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── defaultKindForSlug ──────────────────────────────────────────────────────

describe('defaultKindForSlug', () => {
  it('returns "index" for the _index slug', () => {
    expect(defaultKindForSlug('_index')).toBe('index');
  });

  it('returns "raw" for any other slug', () => {
    expect(defaultKindForSlug('my-note')).toBe('raw');
    expect(defaultKindForSlug('random-thing')).toBe('raw');
    expect(defaultKindForSlug('')).toBe('raw');
  });
});

// ── hashBody ────────────────────────────────────────────────────────────────

describe('KnowledgeBaseStore.hashBody', () => {
  it('returns a sha256 hex digest of the input', () => {
    const h = KnowledgeBaseStore.hashBody('hello');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // Known sha256("hello") digest
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is deterministic across calls', () => {
    expect(KnowledgeBaseStore.hashBody('abc')).toBe(KnowledgeBaseStore.hashBody('abc'));
  });

  it('produces different hashes for different inputs', () => {
    expect(KnowledgeBaseStore.hashBody('a')).not.toBe(KnowledgeBaseStore.hashBody('b'));
  });
});

// ── v1 backwards compatibility ──────────────────────────────────────────────

describe('v1 backwards compatibility', () => {
  it('a v1 note without any v2 fields parses and gets the raw default', async () => {
    const note = await store.add({ title: 'Legacy', content: 'body' });
    expect(note.kind).toBeUndefined(); // add() doesn't set kind
    const fetched = await store.get(note.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.kind).toBe('raw'); // default on read
    expect(fetched?.sourceRefs).toBeUndefined();
    expect(fetched?.consumedBy).toBeUndefined();
    expect(fetched?.buildStatus).toBeUndefined();
  });

  it('the bootstrap welcome note gets kind=index on read', async () => {
    await store.ensureBootstrapped();
    // The welcome note is at notes/_index.md
    const note = await store.get('notes/_index');
    expect(note).not.toBeNull();
    expect(note?.slug).toBe('_index');
    expect(note?.kind).toBe('index');
  });

  it('v1 write path does not add a kind field to frontmatter', async () => {
    const note = await store.add({ title: 'Clean v1', content: 'body' });
    const raw = await fs.readFile(
      path.join(tmpRoot, KB_INBOX_DIR, `${note.slug}.md`),
      'utf-8',
    );
    // v1 notes should stay clean — no kind field is written when it's not set
    // on the in-memory object (the default comes from the read path).
    expect(raw).not.toContain('kind:');
    expect(raw).not.toContain('sourceRefs:');
    expect(raw).not.toContain('consumedBy:');
    expect(raw).not.toContain('buildStatus:');
  });
});

// ── v2 field round-trip ─────────────────────────────────────────────────────

describe('v2 field round-trip', () => {
  it('a wiki note with all v2 fields round-trips through disk', async () => {
    // Bootstrap + create a raw inbox source first so the wiki can cite it.
    const src = await store.add({ title: 'Source A', content: 'source body one' });

    // Manually write a wiki note to notes/auth/ with full v2 frontmatter.
    const now = new Date().toISOString();
    const wikiId = 'kb_wiki_test_abc';
    const wikiPath = path.join(tmpRoot, KB_NOTES_DIR, 'auth');
    await fs.mkdir(wikiPath, { recursive: true });
    const frontmatter = [
      '---',
      `id: ${wikiId}`,
      'title: "Auth overview"',
      'slug: auth-overview',
      'path: notes/auth',
      'tags: [auth, oauth]',
      `source: import`,
      `createdAt: ${now}`,
      `updatedAt: ${now}`,
      'kind: wiki',
      `sourceRefs: [${src.id}]`,
      `compiledAt: ${now}`,
      'compiledBy: kb-builder-v1',
      'promptVersion: compile.v1',
      'buildStatus: published',
      `lastSourceHashes: ${JSON.stringify(JSON.stringify({ [src.id]: KnowledgeBaseStore.hashBody(src.body) }))}`,
      `manualEditsAfter: ${now}`,
      '---',
      '',
      '# Auth overview',
      '',
      `Cited from [^${src.id}].`,
      '',
    ].join('\n');
    await fs.writeFile(path.join(wikiPath, 'auth-overview.md'), frontmatter, 'utf-8');

    // Force index rebuild so the new file is picked up.
    await store.rebuildIndex();
    const wiki = await store.get(wikiId);
    expect(wiki).not.toBeNull();
    expect(wiki?.kind).toBe('wiki');
    expect(wiki?.sourceRefs).toEqual([src.id]);
    expect(wiki?.compiledAt).toBe(now);
    expect(wiki?.compiledBy).toBe('kb-builder-v1');
    expect(wiki?.promptVersion).toBe('compile.v1');
    expect(wiki?.buildStatus).toBe('published');
    expect(wiki?.manualEditsAfter).toBe(now);
    expect(wiki?.lastSourceHashes).toBeDefined();
    expect(wiki?.lastSourceHashes?.[src.id]).toBe(KnowledgeBaseStore.hashBody(src.body));
  });

  it('a wiki note written via the store persists v2 fields on round-trip', async () => {
    const src = await store.add({ title: 'Source', content: 'source body' });

    // Write a wiki note directly via the store's update() path by first
    // adding it as a plain note, then using the internal write via add().
    // Since add() doesn't accept v2 fields, we go through fs + parse.
    // Simpler path: build a KbNote and round-trip via the write path.
    const wikiNote: KbNote = {
      id: 'kb_wiki_roundtrip',
      title: 'Round trip',
      slug: 'round-trip',
      path: 'notes/test',
      tags: ['test'],
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: `Cited [^${src.id}].`,
      kind: 'wiki',
      sourceRefs: [src.id],
      compiledAt: '2026-04-08T06:00:00Z',
      compiledBy: 'kb-builder-v1',
      promptVersion: 'compile.v1',
      buildStatus: 'published',
      lastSourceHashes: { [src.id]: KnowledgeBaseStore.hashBody(src.body) },
      manualEditsAfter: '2026-04-08T07:00:00Z',
    };

    // Use the same serializer the store would use by calling the private
    // method via a thin subclass. Or: write via the frontmatter helper
    // directly, matching the store's output format.
    // Cleanest path: call the store's internal write via a type-cast.
    const storeAny = store as unknown as {
      writeNoteFile: (file: string, note: KbNote) => Promise<void>;
    };
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    await storeAny.writeNoteFile(path.join(wikiDir, 'round-trip.md'), wikiNote);

    await store.rebuildIndex();
    const read = await store.get('kb_wiki_roundtrip');
    expect(read).not.toBeNull();
    expect(read?.kind).toBe('wiki');
    expect(read?.sourceRefs).toEqual([src.id]);
    expect(read?.compiledAt).toBe('2026-04-08T06:00:00Z');
    expect(read?.compiledBy).toBe('kb-builder-v1');
    expect(read?.promptVersion).toBe('compile.v1');
    expect(read?.buildStatus).toBe('published');
    expect(read?.manualEditsAfter).toBe('2026-04-08T07:00:00Z');
    expect(read?.lastSourceHashes?.[src.id]).toBe(KnowledgeBaseStore.hashBody(src.body));
  });

  it('drops invalid kind values and falls back to the slug default', async () => {
    await store.ensureBootstrapped();
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    const raw = [
      '---',
      'id: kb_invalid_kind',
      'title: "Invalid kind"',
      'slug: invalid-kind',
      'path: notes/test',
      'tags: []',
      'createdAt: 2026-04-08T00:00:00Z',
      'updatedAt: 2026-04-08T00:00:00Z',
      'kind: banana',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    await fs.writeFile(path.join(wikiDir, 'invalid-kind.md'), raw, 'utf-8');
    await store.rebuildIndex();
    const note = await store.get('kb_invalid_kind');
    expect(note?.kind).toBe('raw'); // slug is not _index and kind "banana" is invalid
  });

  it('drops invalid buildStatus values silently', async () => {
    await store.ensureBootstrapped();
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    const raw = [
      '---',
      'id: kb_invalid_status',
      'title: "Invalid status"',
      'slug: invalid-status',
      'path: notes/test',
      'tags: []',
      'createdAt: 2026-04-08T00:00:00Z',
      'updatedAt: 2026-04-08T00:00:00Z',
      'kind: wiki',
      'buildStatus: limbo',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    await fs.writeFile(path.join(wikiDir, 'invalid-status.md'), raw, 'utf-8');
    await store.rebuildIndex();
    const note = await store.get('kb_invalid_status');
    expect(note?.kind).toBe('wiki');
    expect(note?.buildStatus).toBeUndefined();
  });

  it('tolerates malformed lastSourceHashes JSON by dropping the field', async () => {
    await store.ensureBootstrapped();
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'test');
    await fs.mkdir(wikiDir, { recursive: true });
    const raw = [
      '---',
      'id: kb_bad_hashes',
      'title: "Bad hashes"',
      'slug: bad-hashes',
      'path: notes/test',
      'tags: []',
      'createdAt: 2026-04-08T00:00:00Z',
      'updatedAt: 2026-04-08T00:00:00Z',
      'kind: wiki',
      'lastSourceHashes: "{not valid json"',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    await fs.writeFile(path.join(wikiDir, 'bad-hashes.md'), raw, 'utf-8');
    await store.rebuildIndex();
    const note = await store.get('kb_bad_hashes');
    expect(note?.kind).toBe('wiki');
    expect(note?.lastSourceHashes).toBeUndefined();
  });
});

// ── getByKind ───────────────────────────────────────────────────────────────

describe('getByKind', () => {
  it('returns only raw notes when asked for kind=raw', async () => {
    await store.add({ title: 'Raw 1', content: 'a' });
    await store.add({ title: 'Raw 2', content: 'b' });
    const raws = await store.getByKind('raw');
    // At least the two we just added should be present. Plus the welcome
    // index page does NOT count as raw — it has slug _index so it defaults
    // to index. And the welcome note was already bootstrapped above.
    expect(raws.length).toBeGreaterThanOrEqual(2);
    for (const r of raws) expect(r.slug).not.toBe('_index');
  });

  it('returns the welcome note when asked for kind=index', async () => {
    await store.ensureBootstrapped();
    const indexes = await store.getByKind('index');
    expect(indexes.length).toBeGreaterThanOrEqual(1);
    expect(indexes.find((n) => n.slug === '_index')).toBeDefined();
  });

  it('returns an empty array when no notes of that kind exist', async () => {
    await store.ensureBootstrapped();
    const wikis = await store.getByKind('wiki');
    // Bootstrap welcome defaults to index, not wiki. Zero wikis expected.
    expect(wikis).toEqual([]);
  });
});

// ── traceSources / traceDerivatives ─────────────────────────────────────────

describe('traceSources + traceDerivatives', () => {
  it('traceSources() returns cited raw notes for a wiki', async () => {
    const src1 = await store.add({ title: 'Src 1', content: 'one' });
    const src2 = await store.add({ title: 'Src 2', content: 'two' });

    // Write a wiki page citing both sources via the internal write path.
    const wikiNote: KbNote = {
      id: 'kb_wiki_trace_sources',
      title: 'Trace test',
      slug: 'trace-test',
      path: 'notes/trace',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'body',
      kind: 'wiki',
      sourceRefs: [src1.id, src2.id],
    };
    const storeAny = store as unknown as {
      writeNoteFile: (file: string, note: KbNote) => Promise<void>;
    };
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'trace');
    await fs.mkdir(wikiDir, { recursive: true });
    await storeAny.writeNoteFile(path.join(wikiDir, 'trace-test.md'), wikiNote);
    await store.rebuildIndex();

    const sources = await store.traceSources('kb_wiki_trace_sources');
    expect(sources).toHaveLength(2);
    const ids = sources.map((s) => s.id).sort();
    expect(ids).toEqual([src1.id, src2.id].sort());
  });

  it('traceSources() returns [] for a wiki with no sourceRefs', async () => {
    const wikiNote: KbNote = {
      id: 'kb_wiki_no_refs',
      title: 'No refs',
      slug: 'no-refs',
      path: 'notes/trace',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'body',
      kind: 'wiki',
    };
    const storeAny = store as unknown as {
      writeNoteFile: (file: string, note: KbNote) => Promise<void>;
    };
    const wikiDir = path.join(tmpRoot, KB_NOTES_DIR, 'trace');
    await fs.mkdir(wikiDir, { recursive: true });
    await storeAny.writeNoteFile(path.join(wikiDir, 'no-refs.md'), wikiNote);
    await store.rebuildIndex();

    const sources = await store.traceSources('kb_wiki_no_refs');
    expect(sources).toEqual([]);
  });

  it('traceSources() returns [] for a nonexistent id', async () => {
    const sources = await store.traceSources('kb_does_not_exist');
    expect(sources).toEqual([]);
  });

  it('traceDerivatives() returns wikis via consumedBy reverse index', async () => {
    // Create a raw source with a consumedBy entry pointing at a wiki.
    const src: KbNote = {
      id: 'kb_raw_with_derivatives',
      title: 'Has consumers',
      slug: 'has-consumers',
      path: KB_INBOX_DIR,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'source body',
      kind: 'raw',
      consumedBy: ['kb_wiki_derived'],
    };
    const wiki: KbNote = {
      id: 'kb_wiki_derived',
      title: 'Derived wiki',
      slug: 'derived-wiki',
      path: 'notes/derived',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'derived',
      kind: 'wiki',
      sourceRefs: ['kb_raw_with_derivatives'],
    };
    const storeAny = store as unknown as {
      writeNoteFile: (file: string, note: KbNote) => Promise<void>;
    };
    await fs.mkdir(path.join(tmpRoot, KB_INBOX_DIR), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, KB_NOTES_DIR, 'derived'), { recursive: true });
    await storeAny.writeNoteFile(path.join(tmpRoot, KB_INBOX_DIR, 'has-consumers.md'), src);
    await storeAny.writeNoteFile(path.join(tmpRoot, KB_NOTES_DIR, 'derived', 'derived-wiki.md'), wiki);
    await store.rebuildIndex();

    const derivatives = await store.traceDerivatives('kb_raw_with_derivatives');
    expect(derivatives).toHaveLength(1);
    expect(derivatives[0]?.id).toBe('kb_wiki_derived');
  });

  it('traceDerivatives() falls back to disk walk when consumedBy is missing', async () => {
    // Source has NO consumedBy index — the fallback should find the wiki
    // that cites it by walking disk.
    const src: KbNote = {
      id: 'kb_raw_no_index',
      title: 'No index',
      slug: 'no-index',
      path: KB_INBOX_DIR,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'source',
      kind: 'raw',
    };
    const wiki: KbNote = {
      id: 'kb_wiki_uses_raw',
      title: 'Uses raw',
      slug: 'uses-raw',
      path: 'notes/uses',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      body: 'wiki',
      kind: 'wiki',
      sourceRefs: ['kb_raw_no_index'],
    };
    const storeAny = store as unknown as {
      writeNoteFile: (file: string, note: KbNote) => Promise<void>;
    };
    await fs.mkdir(path.join(tmpRoot, KB_INBOX_DIR), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, KB_NOTES_DIR, 'uses'), { recursive: true });
    await storeAny.writeNoteFile(path.join(tmpRoot, KB_INBOX_DIR, 'no-index.md'), src);
    await storeAny.writeNoteFile(path.join(tmpRoot, KB_NOTES_DIR, 'uses', 'uses-raw.md'), wiki);
    await store.rebuildIndex();

    const derivatives = await store.traceDerivatives('kb_raw_no_index');
    expect(derivatives).toHaveLength(1);
    expect(derivatives[0]?.id).toBe('kb_wiki_uses_raw');
  });
});

// ── isWikiStale ─────────────────────────────────────────────────────────────

describe('isWikiStale', () => {
  const mkWiki = (fields: Partial<KbNote> = {}): KbNote => ({
    id: 'kb_wiki_stale_test',
    title: 'Wiki',
    slug: 'wiki',
    path: 'notes/test',
    tags: [],
    createdAt: '2026-04-08T00:00:00Z',
    updatedAt: '2026-04-08T00:00:00Z',
    body: 'wiki body',
    kind: 'wiki',
    ...fields,
  });
  const mkRaw = (id: string, body: string): KbNote => ({
    id,
    title: 'Source',
    slug: 'source',
    path: KB_INBOX_DIR,
    tags: [],
    createdAt: '2026-04-08T00:00:00Z',
    updatedAt: '2026-04-08T00:00:00Z',
    body,
    kind: 'raw',
  });

  it('returns false for a non-wiki note (defensive no-op)', () => {
    const raw = mkWiki({ kind: 'raw' });
    expect(isWikiStale(raw, () => null)).toBe(false);
  });

  it('returns true when sourceRefs is missing', () => {
    const wiki = mkWiki({ sourceRefs: undefined, lastSourceHashes: { kb_x: 'h' } });
    expect(isWikiStale(wiki, () => null)).toBe(true);
  });

  it('returns true when sourceRefs is empty', () => {
    const wiki = mkWiki({ sourceRefs: [], lastSourceHashes: {} });
    expect(isWikiStale(wiki, () => null)).toBe(true);
  });

  it('returns true when lastSourceHashes is missing entirely', () => {
    const wiki = mkWiki({ sourceRefs: ['kb_x'] });
    expect(isWikiStale(wiki, () => null)).toBe(true);
  });

  it('returns true when a cited source has been deleted', () => {
    const wiki = mkWiki({
      sourceRefs: ['kb_gone'],
      lastSourceHashes: { kb_gone: 'anyhash' },
    });
    expect(isWikiStale(wiki, () => null)).toBe(true); // lookup returns null
  });

  it('returns true when a cited source body has changed (hash mismatch)', () => {
    const src = mkRaw('kb_src_1', 'original body');
    const oldHash = KnowledgeBaseStore.hashBody('original body');
    // Now mutate the source and check — the wiki records the OLD hash.
    const edited = { ...src, body: 'EDITED body' };
    const wiki = mkWiki({
      sourceRefs: ['kb_src_1'],
      lastSourceHashes: { kb_src_1: oldHash },
    });
    expect(isWikiStale(wiki, (id) => (id === 'kb_src_1' ? edited : null))).toBe(true);
  });

  it('returns false when every cited source is intact and unchanged', () => {
    const src = mkRaw('kb_src_2', 'stable body');
    const hash = KnowledgeBaseStore.hashBody('stable body');
    const wiki = mkWiki({
      sourceRefs: ['kb_src_2'],
      lastSourceHashes: { kb_src_2: hash },
    });
    expect(isWikiStale(wiki, (id) => (id === 'kb_src_2' ? src : null))).toBe(false);
  });

  it('returns true if any single source among many is stale', () => {
    const a = mkRaw('kb_a', 'a body');
    const b = mkRaw('kb_b', 'b body edited');
    const wiki = mkWiki({
      sourceRefs: ['kb_a', 'kb_b'],
      lastSourceHashes: {
        kb_a: KnowledgeBaseStore.hashBody('a body'),
        kb_b: KnowledgeBaseStore.hashBody('b body original'), // stale
      },
    });
    const lookup = (id: string) => (id === 'kb_a' ? a : id === 'kb_b' ? b : null);
    expect(isWikiStale(wiki, lookup)).toBe(true);
  });
});

// ── v1 → v2 index cache upgrade ─────────────────────────────────────────────
//
// Regression test for the `KB_INDEX_VERSION` bump. An existing v1 installation
// has an `index.json` with `version: 1` on disk. When the v2 code loads it,
// `loadIndex()` must REJECT the v1 cache and fall through to `rebuildIndex()`
// so `list()` immediately returns v2-enriched summaries (with `kind` populated).
// Without the version bump, `list()` would keep serving stale v1 summaries
// until an unrelated write happened, hiding Phase 1 metadata from callers
// (caught by codex-2 in review).

describe('v1 → v2 index cache upgrade', () => {
  it('rejects a v1 index.json and rebuilds so list() returns v2 summaries', async () => {
    // Arrange: write a v1-format index.json by hand that omits the `kind` field
    // on every summary. This simulates a KB that was created under v1 and is
    // now being read by v2 code.
    //
    // We can't use store.add() to set up the state (it would create a v2 index
    // immediately), so we write the raw files + raw index.json directly and
    // then create a fresh store pointed at this dir.
    const inboxDir = path.join(tmpRoot, KB_INBOX_DIR);
    const notesDir = path.join(tmpRoot, KB_NOTES_DIR);
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.mkdir(notesDir, { recursive: true });

    // A raw-style note file (no `kind:` in frontmatter — pure v1 shape).
    const rawNoteId = 'kb_legacy_v1_raw';
    const rawNoteRaw = [
      '---',
      `id: ${rawNoteId}`,
      'title: "Legacy v1 raw"',
      'slug: legacy-raw',
      'path: inbox',
      'tags: []',
      'createdAt: 2026-01-01T00:00:00Z',
      'updatedAt: 2026-01-01T00:00:00Z',
      '---',
      '',
      'legacy body',
      '',
    ].join('\n');
    await fs.writeFile(path.join(inboxDir, 'legacy-raw.md'), rawNoteRaw, 'utf-8');

    // A v1 welcome/index file so the bootstrap's welcome check is a no-op.
    const welcomeId = 'kb_legacy_v1_welcome';
    const welcomeRaw = [
      '---',
      `id: ${welcomeId}`,
      'title: "Knowledge Base"',
      'slug: _index',
      'path: notes',
      'tags: []',
      'source: manual',
      'createdAt: 2026-01-01T00:00:00Z',
      'updatedAt: 2026-01-01T00:00:00Z',
      '---',
      '',
      '# Knowledge Base',
      '',
    ].join('\n');
    await fs.writeFile(path.join(notesDir, '_index.md'), welcomeRaw, 'utf-8');

    // Hand-write a v1 index.json: version=1, summaries WITHOUT `kind` field.
    const v1Index = {
      version: 1,
      builtAt: '2026-01-01T00:00:00Z',
      notes: {
        [rawNoteId]: {
          id: rawNoteId,
          title: 'Legacy v1 raw',
          slug: 'legacy-raw',
          path: 'inbox',
          tags: [],
          updatedAt: '2026-01-01T00:00:00Z',
        },
        [welcomeId]: {
          id: welcomeId,
          title: 'Knowledge Base',
          slug: '_index',
          path: 'notes',
          tags: [],
          source: 'manual',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    };
    await fs.writeFile(
      path.join(tmpRoot, 'index.json'),
      JSON.stringify(v1Index, null, 2),
      'utf-8',
    );

    // Act: create a fresh store pointed at this directory and call list().
    // The v2 code should reject the v1 cache and rebuild from disk, producing
    // summaries with `kind` populated.
    const freshStore = KnowledgeBaseStore.resetForTests(tmpRoot);
    const notes = await freshStore.list();

    // Assert: the returned summaries have `kind` populated (raw for inbox, index for _index).
    // Without the version bump, `kind` would be undefined here.
    const raw = notes.find((n) => n.id === rawNoteId);
    const welcome = notes.find((n) => n.id === welcomeId);
    expect(raw).toBeDefined();
    expect(raw?.kind).toBe('raw');
    expect(welcome).toBeDefined();
    expect(welcome?.kind).toBe('index');

    // Assert: the on-disk index.json now has version 2.
    const updatedIndex = JSON.parse(
      await fs.readFile(path.join(tmpRoot, 'index.json'), 'utf-8'),
    );
    expect(updatedIndex.version).toBe(2);
  });

  it('rejects an index.json with no version field (treated as pre-v1) and rebuilds', async () => {
    await fs.mkdir(path.join(tmpRoot, KB_NOTES_DIR), { recursive: true });
    // An intentionally malformed index with no version key.
    await fs.writeFile(
      path.join(tmpRoot, 'index.json'),
      JSON.stringify({ builtAt: '2026-01-01T00:00:00Z', notes: {} }),
      'utf-8',
    );

    const freshStore = KnowledgeBaseStore.resetForTests(tmpRoot);
    // list() triggers bootstrap → which writes welcome and invalidates the
    // index anyway. The v2 rebuildIndex walks disk and returns fresh summaries.
    const notes = await freshStore.list();
    const welcome = notes.find((n) => n.title === 'Knowledge Base');
    expect(welcome).toBeDefined();
    expect(welcome?.kind).toBe('index');
  });
});

// ── Promote semantics unchanged ─────────────────────────────────────────────

describe('promote() remains unchanged in v2', () => {
  it('promote only moves the note; does not set or mutate v2 fields', async () => {
    const note = await store.add({ title: 'To promote', content: 'hello' });
    const promoted = await store.promote(note.id, 'notes/promoted');
    expect(promoted.path).toBe('notes/promoted');
    // The promoted note has default kind=raw on read (unchanged semantics).
    const fresh = await store.get(note.id);
    expect(fresh?.kind).toBe('raw');
    expect(fresh?.sourceRefs).toBeUndefined();
    expect(fresh?.compiledAt).toBeUndefined();
    expect(fresh?.buildStatus).toBeUndefined();
  });
});
