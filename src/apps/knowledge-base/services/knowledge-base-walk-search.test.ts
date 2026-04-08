import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { KnowledgeBaseStore } from './knowledge-base-store.js';

let tmpRoot: string;
let store: KnowledgeBaseStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-walk-'));
  store = KnowledgeBaseStore.resetForTests(tmpRoot);
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Walk ────────────────────────────────────────────────────────────────────

describe('KnowledgeBaseStore.walk', () => {
  it('returns the welcome _index.md and inbox/notes folders at the root', async () => {
    await store.ensureBootstrapped();
    const result = await store.walk('');
    // The bootstrap _index.md is in notes/, not at the root, so root walk has no index.
    expect(result.index).toBeNull();
    expect(result.path).toBe('');
    expect(result.parent).toBeUndefined();
    expect(result.folders.sort()).toEqual(['inbox', 'notes']);
  });

  it('returns the _index.md welcome note when walking notes/', async () => {
    await store.ensureBootstrapped();
    const result = await store.walk('notes');
    expect(result.index).not.toBeNull();
    expect(result.index?.title).toBe('Knowledge Base');
    expect(result.index?.slug).toBe('_index');
    expect(result.path).toBe('notes');
    expect(result.parent).toBe('');
  });

  it('lists direct child notes (excluding _index.md) sorted by title', async () => {
    await store.add({ title: 'Banana', content: '1', path: 'notes/fruit' });
    await store.add({ title: 'Apple', content: '2', path: 'notes/fruit' });
    await store.add({ title: 'Cherry', content: '3', path: 'notes/fruit' });
    const result = await store.walk('notes/fruit');
    expect(result.children.map((c) => c.title)).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(result.parent).toBe('notes');
  });

  it('lists direct subfolders only (not recursive)', async () => {
    await store.add({ title: 'a', content: '1', path: 'notes/x' });
    await store.add({ title: 'b', content: '2', path: 'notes/x/y' });
    await store.add({ title: 'c', content: '3', path: 'notes/x/y/z' });
    const result = await store.walk('notes/x');
    expect(result.folders).toEqual(['y']);
    expect(result.children.map((n) => n.title)).toEqual(['a']);
  });

  it('includes both _index.md and direct child notes when both exist', async () => {
    // Create the room's _index.md and a couple of children.
    await store.add({ title: 'Architecture', content: 'overview body', path: 'notes/mempalace/architecture', slug: '_index' });
    await store.add({ title: 'Storage model', content: 'sm', path: 'notes/mempalace/architecture' });
    await store.add({ title: 'Retrieval model', content: 'rm', path: 'notes/mempalace/architecture' });

    const result = await store.walk('notes/mempalace/architecture');
    expect(result.index?.title).toBe('Architecture');
    expect(result.children.map((c) => c.title).sort()).toEqual(['Retrieval model', 'Storage model']);
    expect(result.parent).toBe('notes/mempalace');
  });

  it('returns empty children/folders for a missing folder', async () => {
    await store.ensureBootstrapped();
    const result = await store.walk('notes/does-not-exist');
    expect(result.index).toBeNull();
    expect(result.children).toEqual([]);
    expect(result.folders).toEqual([]);
    expect(result.path).toBe('notes/does-not-exist');
  });

  it('skips dotfiles in the folder listing', async () => {
    await store.ensureBootstrapped();
    await fs.writeFile(path.join(tmpRoot, 'notes', '.hidden.md'), '---\nid: kb_x\n---\nbody', 'utf-8');
    await fs.mkdir(path.join(tmpRoot, 'notes', '.cache'), { recursive: true });
    const result = await store.walk('notes');
    expect(result.children.map((c) => c.slug)).not.toContain('.hidden');
    expect(result.folders).not.toContain('.cache');
  });

  it('rejects path traversal in walk()', async () => {
    await expect(store.walk('../etc')).rejects.toBeInstanceOf(Error);
  });

  it('parent of a top-level folder is the root, parent of root is undefined', async () => {
    await store.ensureBootstrapped();
    const root = await store.walk('');
    expect(root.parent).toBeUndefined();
    const notes = await store.walk('notes');
    expect(notes.parent).toBe('');
    const sub = await store.walk('notes/sub');
    // sub doesn't exist on disk yet — but parent computation still works
    expect(sub.parent).toBe('notes');
  });
});

// ── Search ──────────────────────────────────────────────────────────────────

describe('KnowledgeBaseStore.search', () => {
  it('returns an empty array for an empty query', async () => {
    await store.add({ title: 'Has body', content: 'something' });
    const hits = await store.search('');
    expect(hits).toEqual([]);
  });

  it('scores title matches higher than body matches', async () => {
    await store.add({ title: 'PKCE flow', content: 'unrelated body', path: 'notes/auth' });
    await store.add({ title: 'OAuth basics', content: 'this mentions PKCE in the body', path: 'notes/auth' });

    const hits = await store.search('pkce');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.note.title).toBe('PKCE flow');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('counts up to 5 body occurrences (cap)', async () => {
    const body = 'foo '.repeat(20); // 20 occurrences of "foo"
    await store.add({ title: 'irrelevant', content: body });
    const hits = await store.search('foo');
    expect(hits.length).toBe(1);
    // 0 (title) + 0 (tag) + 0 (path) + 5 (body capped) = 5
    expect(hits[0]?.score).toBe(5);
  });

  it('adds the tag-match weight (+3) when a tag matches', async () => {
    await store.add({ title: 'irrelevant', content: 'no body match', tags: ['mempalace'] });
    const hits = await store.search('mempalace');
    expect(hits.length).toBe(1);
    expect(hits[0]?.score).toBe(3);
  });

  it('adds the path-match weight (+2) when the path contains the query', async () => {
    await store.add({ title: 'irrelevant', content: 'no body match', path: 'notes/architecture' });
    const hits = await store.search('architecture');
    expect(hits.length).toBe(1);
    expect(hits[0]?.score).toBe(2);
  });

  it('combines title + path + tag + body weights correctly', async () => {
    await store.add({
      title: 'Cache layer',
      content: 'cache miss handling and cache fill semantics',
      path: 'notes/cache',
      tags: ['cache', 'perf'],
    });
    // title +5, tag +3, path +2, body has 2 "cache" occurrences = +2 → 12
    const hits = await store.search('cache');
    expect(hits[0]?.score).toBe(12);
  });

  it('respects the path filter to scope the search to a folder', async () => {
    await store.add({ title: 'Match A', content: 'shared term', path: 'notes/alpha' });
    await store.add({ title: 'Match B', content: 'shared term', path: 'notes/beta' });
    const hits = await store.search('shared term', { path: 'notes/alpha' });
    expect(hits.length).toBe(1);
    expect(hits[0]?.note.path).toBe('notes/alpha');
  });

  it('builds a snippet around the first body match', async () => {
    await store.add({
      title: 'Snippet test',
      content: 'lorem ipsum dolor sit amet, the SECRET phrase, then more text after it',
    });
    const hits = await store.search('secret');
    expect(hits[0]?.snippet.toLowerCase()).toContain('secret');
  });

  it('breaks ties by updatedAt desc', async () => {
    const first = await store.add({ title: 'Tie A', content: 'one match' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.add({ title: 'Tie B', content: 'one match' });
    // Both have score 1 (single body match). The newer one should be first.
    const hits = await store.search('match');
    expect(hits[0]?.note.id).toBe(second.id);
    expect(hits[1]?.note.id).toBe(first.id);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await store.add({ title: `Item ${i}`, content: 'token here' });
    }
    const hits = await store.search('token', { limit: 2 });
    expect(hits.length).toBe(2);
  });

  it('omits notes that have a zero score', async () => {
    await store.add({ title: 'visible', content: 'has the term needle inside' });
    await store.add({ title: 'hidden', content: 'no match' });
    const hits = await store.search('needle');
    expect(hits.length).toBe(1);
    expect(hits[0]?.note.title).toBe('visible');
  });
});
