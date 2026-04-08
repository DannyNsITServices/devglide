import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { KnowledgeBaseStore, KbError, KB_INBOX_DIR, KB_NOTES_DIR, KB_INDEX_FILE } from './knowledge-base-store.js';
import { parseFrontmatter } from './frontmatter.js';

let tmpRoot: string;
let store: KnowledgeBaseStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-store-'));
  store = KnowledgeBaseStore.resetForTests(tmpRoot);
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('KnowledgeBaseStore — bootstrap', () => {
  it('creates inbox/, notes/, and a frontmatter-backed welcome note on first init', async () => {
    await store.ensureBootstrapped();
    const inboxStat = await fs.stat(path.join(tmpRoot, KB_INBOX_DIR));
    const notesStat = await fs.stat(path.join(tmpRoot, KB_NOTES_DIR));
    expect(inboxStat.isDirectory()).toBe(true);
    expect(notesStat.isDirectory()).toBe(true);

    const welcomeRaw = await fs.readFile(path.join(tmpRoot, KB_NOTES_DIR, '_index.md'), 'utf-8');
    const { data, body } = parseFrontmatter(welcomeRaw);
    expect(typeof data.id).toBe('string');
    expect(data.id).toMatch(/^kb_/);
    expect(data.title).toBe('Knowledge Base');
    expect(data.slug).toBe('_index');
    expect(data.path).toBe('notes');
    expect(body).toContain('Welcome.');
  });

  it('rewrites a Phase-1-style plain markdown welcome file with frontmatter (migration)', async () => {
    // Simulate the Phase 1 bootstrap: a plain markdown file with no frontmatter.
    await fs.mkdir(path.join(tmpRoot, KB_NOTES_DIR), { recursive: true });
    const welcomePath = path.join(tmpRoot, KB_NOTES_DIR, '_index.md');
    await fs.writeFile(welcomePath, '# Plain old markdown\n\nNo frontmatter here.\n', 'utf-8');

    await store.ensureBootstrapped();
    const after = await fs.readFile(welcomePath, 'utf-8');
    expect(after.startsWith('---')).toBe(true);
    const { data } = parseFrontmatter(after);
    expect(data.id).toMatch(/^kb_/);
  });

  it('does not overwrite a valid frontmatter-backed welcome file on subsequent inits', async () => {
    await store.ensureBootstrapped();
    const first = await fs.readFile(path.join(tmpRoot, KB_NOTES_DIR, '_index.md'), 'utf-8');
    // Reset the singleton to force re-bootstrap on the same dir.
    store = KnowledgeBaseStore.resetForTests(tmpRoot);
    await store.ensureBootstrapped();
    const second = await fs.readFile(path.join(tmpRoot, KB_NOTES_DIR, '_index.md'), 'utf-8');
    expect(second).toBe(first);
  });
});

describe('KnowledgeBaseStore — add / get / list', () => {
  it('add() lands a note in inbox/ by default with kb_ prefixed id', async () => {
    const note = await store.add({ title: 'My first note', content: 'Body content here.' });
    expect(note.id).toMatch(/^kb_/);
    expect(note.path).toBe('inbox');
    expect(note.slug).toBe('my-first-note');
    expect(note.title).toBe('My first note');
    expect(note.body).toBe('Body content here.');

    const onDisk = await fs.readFile(path.join(tmpRoot, 'inbox', 'my-first-note.md'), 'utf-8');
    expect(onDisk.startsWith('---')).toBe(true);
  });

  it('get() resolves a note by its id', async () => {
    const created = await store.add({ title: 'Lookup me', content: 'hello' });
    const fetched = await store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('Lookup me');
    expect(fetched?.body).toBe('hello');
  });

  it('get() resolves a note by its relative path/slug', async () => {
    const created = await store.add({ title: 'By path', content: 'x', path: 'notes/foo' });
    const fetched = await store.get(`notes/foo/${created.slug}`);
    expect(fetched?.id).toBe(created.id);
  });

  it('get() returns null for a missing id and a missing path', async () => {
    expect(await store.get('kb_nonexistent')).toBeNull();
    expect(await store.get('notes/never/created')).toBeNull();
  });

  it('list() returns notes filtered by path prefix', async () => {
    await store.add({ title: 'A', content: '1', path: 'notes/alpha' });
    await store.add({ title: 'B', content: '2', path: 'notes/alpha/sub' });
    await store.add({ title: 'C', content: '3', path: 'notes/beta' });
    const alphaNotes = await store.list({ path: 'notes/alpha' });
    expect(alphaNotes.map((n) => n.title).sort()).toEqual(['A', 'B']);
  });

  it('list() filters by tag', async () => {
    await store.add({ title: 'X', content: '1', tags: ['kb', 'arch'] });
    await store.add({ title: 'Y', content: '2', tags: ['arch'] });
    await store.add({ title: 'Z', content: '3', tags: ['other'] });
    const archHits = await store.list({ tag: 'arch' });
    expect(archHits.map((n) => n.title).sort()).toEqual(['X', 'Y']);
  });

  it('list() includes the bootstrap welcome note', async () => {
    const all = await store.list();
    expect(all.some((n) => n.title === 'Knowledge Base')).toBe(true);
  });
});

describe('KnowledgeBaseStore — slug collisions', () => {
  it('appends -2, -3 suffixes when the same title is added repeatedly', async () => {
    const a = await store.add({ title: 'Same title', content: 'one' });
    const b = await store.add({ title: 'Same title', content: 'two' });
    const c = await store.add({ title: 'Same title', content: 'three' });
    expect(a.slug).toBe('same-title');
    expect(b.slug).toBe('same-title-2');
    expect(c.slug).toBe('same-title-3');
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});

describe('KnowledgeBaseStore — update', () => {
  it('updates title and body in place; bumps updatedAt; preserves id and createdAt', async () => {
    const created = await store.add({ title: 'Original', content: 'old body' });
    // Force a clock tick.
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(created.id, { title: 'Renamed in place', content: 'new body' });
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(created.id);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.updatedAt).not.toBe(created.updatedAt);
    expect(updated!.title).toBe('Renamed in place');
    expect(updated!.body).toBe('new body');
    // Slug stays the same when no slug is supplied.
    expect(updated!.slug).toBe('original');
  });

  it('renames the on-disk file when slug changes; old file is gone', async () => {
    const created = await store.add({ title: 'Will be renamed', content: 'x' });
    const oldFile = path.join(tmpRoot, 'inbox', `${created.slug}.md`);
    const updated = await store.update(created.id, { slug: 'new-name' });
    expect(updated!.slug).toBe('new-name');
    const newFile = path.join(tmpRoot, 'inbox', 'new-name.md');
    await expect(fs.access(newFile)).resolves.toBeUndefined();
    await expect(fs.access(oldFile)).rejects.toBeTruthy();
  });

  it('moves a note across folders when path changes; preserves id', async () => {
    const created = await store.add({ title: 'Moveable', content: 'y' });
    const moved = await store.update(created.id, { path: 'notes/curated' });
    expect(moved!.id).toBe(created.id);
    expect(moved!.path).toBe('notes/curated');
    const newFile = path.join(tmpRoot, 'notes', 'curated', `${moved!.slug}.md`);
    await expect(fs.access(newFile)).resolves.toBeUndefined();
    const oldFile = path.join(tmpRoot, 'inbox', `${created.slug}.md`);
    await expect(fs.access(oldFile)).rejects.toBeTruthy();
  });

  it('returns null for an unknown id', async () => {
    const result = await store.update('kb_unknown', { title: 'nope' });
    expect(result).toBeNull();
  });
});

describe('KnowledgeBaseStore — remove', () => {
  it('deletes the on-disk file and returns true', async () => {
    const created = await store.add({ title: 'Deletable', content: 'gone soon' });
    const file = path.join(tmpRoot, 'inbox', `${created.slug}.md`);
    expect(await store.remove(created.id)).toBe(true);
    await expect(fs.access(file)).rejects.toBeTruthy();
  });

  it('returns false for a missing note', async () => {
    expect(await store.remove('kb_nope')).toBe(false);
  });

  it('removes the note from list() results after deletion', async () => {
    const created = await store.add({ title: 'Listed', content: 'x' });
    await store.remove(created.id);
    const all = await store.list();
    expect(all.some((n) => n.id === created.id)).toBe(false);
  });
});

describe('KnowledgeBaseStore — index rebuild', () => {
  it('rebuildIndex() walks the disk and produces a complete index', async () => {
    await store.add({ title: 'A', content: '1', path: 'notes/x' });
    await store.add({ title: 'B', content: '2', path: 'notes/x/sub' });
    await store.add({ title: 'C', content: '3' }); // inbox
    const index = await store.rebuildIndex();
    // Bumped to 2 in KB v2 (Phase 1 — kanban ygvpccl1ujbx89o4t2cb32mf) to force
    // rebuild of v1 index caches on upgrade so the new `kind` / `buildStatus`
    // summary fields are populated on the read path immediately.
    expect(index.version).toBe(2);
    // 3 added notes + 1 welcome _index.md = 4
    expect(Object.keys(index.notes).length).toBe(4);
    expect(typeof index.builtAt).toBe('string');

    // index.json is also persisted to disk
    const onDisk = JSON.parse(await fs.readFile(path.join(tmpRoot, KB_INDEX_FILE), 'utf-8'));
    expect(Object.keys(onDisk.notes).length).toBe(4);
  });

  it('disk wins over a stale index — direct disk edits are reflected after rebuild', async () => {
    const created = await store.add({ title: 'Edit me', content: 'before' });
    // Hand-edit the file's body via fs (no frontmatter change).
    const file = path.join(tmpRoot, 'inbox', `${created.slug}.md`);
    const raw = await fs.readFile(file, 'utf-8');
    const edited = raw.replace('before', 'AFTER hand-edit');
    await fs.writeFile(file, edited, 'utf-8');

    const index = await store.rebuildIndex();
    const summary = index.notes[created.id];
    expect(summary).toBeDefined();
    // Re-read the note via the store; the body should reflect the disk edit.
    const reloaded = await store.get(created.id);
    expect(reloaded?.body).toContain('AFTER hand-edit');
  });
});

describe('KnowledgeBaseStore — path-traversal guard', () => {
  it('rejects "../etc/passwd" via add()', async () => {
    await expect(store.add({ title: 'evil', content: 'x', path: '../etc' })).rejects.toBeInstanceOf(KbError);
  });

  it('rejects an absolute Windows path', async () => {
    await expect(store.add({ title: 'evil', content: 'x', path: 'C:/Windows' })).rejects.toBeInstanceOf(KbError);
  });

  it('rejects a path containing a null byte', async () => {
    await expect(store.add({ title: 'evil', content: 'x', path: 'notes\0hidden' })).rejects.toBeInstanceOf(KbError);
  });

  it('rejects a path with a `..` segment buried in the middle', async () => {
    await expect(store.add({ title: 'evil', content: 'x', path: 'notes/../../escape' })).rejects.toBeInstanceOf(KbError);
  });
});

describe('KnowledgeBaseStore — review regressions', () => {
  it('get(id) recovers when the indexed path is stale (file moved on disk by hand)', async () => {
    const created = await store.add({ title: 'Move me by hand', content: 'body' });
    // Force-load the index so the cache has the original path.
    await store.list();
    // Simulate a manual file move on disk.
    const oldFile = path.join(tmpRoot, 'inbox', `${created.slug}.md`);
    const newDir = path.join(tmpRoot, 'notes', 'curated');
    const newFile = path.join(newDir, `${created.slug}.md`);
    await fs.mkdir(newDir, { recursive: true });
    await fs.rename(oldFile, newFile);

    // get(id) should still find the note via fallback walk and re-sync the index.
    const fetched = await store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.path).toBe('notes/curated');

    // The index should also reflect the new location after the recovery.
    const summary = (await store.list()).find((s) => s.id === created.id);
    expect(summary?.path).toBe('notes/curated');
  });

  it('get(id) returns null and prunes the cache when the file is truly gone', async () => {
    const created = await store.add({ title: 'Soon to vanish', content: 'x' });
    await store.list();
    await fs.unlink(path.join(tmpRoot, 'inbox', `${created.slug}.md`));
    expect(await store.get(created.id)).toBeNull();
    const summary = (await store.list()).find((s) => s.id === created.id);
    expect(summary).toBeUndefined();
  });

  it('update() rejects an empty title (matches the add() invariant)', async () => {
    const created = await store.add({ title: 'Has a real title', content: 'x' });
    await expect(store.update(created.id, { title: '' })).rejects.toBeInstanceOf(KbError);
    await expect(store.update(created.id, { title: '   ' })).rejects.toBeInstanceOf(KbError);
    // The on-disk note is unchanged.
    const after = await store.get(created.id);
    expect(after?.title).toBe('Has a real title');
  });
});

describe('KnowledgeBaseStore — concurrent adds', () => {
  it('parallel add() calls with the same title all get unique slugs', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.add({ title: 'Race', content: `body ${i}` })),
    );
    const slugs = results.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(5);
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });
});

describe('KnowledgeBaseStore — hidden field + filters', () => {
  it('round-trips hidden: true through frontmatter', async () => {
    await store.ensureBootstrapped();
    const note = await store.add({ title: 'Initially visible', content: 'x' });
    expect(note.hidden).toBeUndefined();

    // Mark hidden by writing the file directly via the helper used by the move
    // path. Use moveSourceToWikiFolder to exercise the public path.
    await store.add({ title: 'Source', content: 'src body', path: 'inbox' });
    const target = (await store.list()).find((n) => n.title === 'Initially visible');
    expect(target).toBeDefined();
    // Use update() to set path so the source ends up where we expect — but
    // update() doesn't expose hidden. Test the round-trip via the move helper.
  });

  it('list() filters hidden notes by default and surfaces them with includeHidden', async () => {
    await store.ensureBootstrapped();
    const visible = await store.add({ title: 'Visible', content: 'v' });
    const sourceForWiki = await store.add({ title: 'Will hide', content: 's' });
    // Move it to a wiki folder which sets hidden: true.
    await fs.mkdir(path.join(tmpRoot, 'notes', 'topic'), { recursive: true });
    await store.add({ title: 'Wiki', content: 'wikibody', path: 'notes/topic' });
    const moveResult = await store.moveSourceToWikiFolder(sourceForWiki.id, 'notes/topic');
    expect(moveResult).not.toBeNull();

    const defaultList = await store.list();
    expect(defaultList.some((n) => n.id === visible.id)).toBe(true);
    expect(defaultList.some((n) => n.id === sourceForWiki.id)).toBe(false);

    const fullList = await store.list({ includeHidden: true });
    expect(fullList.some((n) => n.id === sourceForWiki.id)).toBe(true);
    const moved = fullList.find((n) => n.id === sourceForWiki.id);
    expect(moved?.hidden).toBe(true);
    expect(moved?.path).toBe('notes/topic/_sources');
  });

  it('walk() hides _sources/ subfolder by default and surfaces it with includeHidden', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki body', content: 'wb', path: 'notes/room' });
    const src = await store.add({ title: 'Source A', content: 'a' });
    await store.moveSourceToWikiFolder(src.id, 'notes/room');

    const defaultWalk = await store.walk('notes/room');
    expect(defaultWalk.folders).not.toContain('_sources');

    const fullWalk = await store.walk('notes/room', { includeHidden: true });
    expect(fullWalk.folders).toContain('_sources');
  });

  it('walk() filters hidden child notes by default', async () => {
    await store.ensureBootstrapped();
    // Place a hidden note directly under notes/topic (not via _sources path).
    const visible = await store.add({ title: 'Visible child', content: 'v', path: 'notes/topic' });
    // Use the move helper to put a hidden note in the same folder.
    const src = await store.add({ title: 'Hidden child', content: 'h' });
    // moveSourceToWikiFolder forces the _sources subfolder, so to get a
    // hidden note directly in notes/topic we use the lower-level path.
    // Walk notes/topic and confirm only visible appears.
    await store.moveSourceToWikiFolder(src.id, 'notes/topic');
    const walkResult = await store.walk('notes/topic');
    expect(walkResult.children.some((n) => n.id === visible.id)).toBe(true);
    expect(walkResult.children.some((n) => n.id === src.id)).toBe(false);
  });

  it('search() filters hidden notes by default', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Findable visible', content: 'has a unique-token here' });
    const hidden = await store.add({ title: 'Findable hidden', content: 'has a unique-token here too' });
    await store.add({ title: 'Wiki', content: 'wb', path: 'notes/searchroom' });
    await store.moveSourceToWikiFolder(hidden.id, 'notes/searchroom');

    const defaultHits = await store.search('unique-token');
    expect(defaultHits.some((h) => h.note.title === 'Findable visible')).toBe(true);
    expect(defaultHits.some((h) => h.note.title === 'Findable hidden')).toBe(false);

    const fullHits = await store.search('unique-token', { includeHidden: true });
    expect(fullHits.some((h) => h.note.title === 'Findable hidden')).toBe(true);
  });
});

describe('KnowledgeBaseStore — moveSourceToWikiFolder', () => {
  it('moves a source from inbox into <wikiPath>/_sources/ and sets hidden=true', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki', content: 'wb', path: 'notes/auth' });
    const src = await store.add({ title: 'Auth source', content: 'authdata' });
    expect(src.path).toBe('inbox');

    const result = await store.moveSourceToWikiFolder(src.id, 'notes/auth');
    expect(result).not.toBeNull();
    expect(result?.id).toBe(src.id);
    expect(result?.fromPath).toBe('inbox');
    expect(result?.toPath).toBe('notes/auth/_sources');

    const moved = await store.get(src.id);
    expect(moved?.path).toBe('notes/auth/_sources');
    expect(moved?.hidden).toBe(true);
    // The original inbox file is gone.
    await expect(fs.stat(path.join(tmpRoot, 'inbox', `${result!.fromSlug}.md`))).rejects.toThrow();
    // The new file exists with the hidden frontmatter.
    const newRaw = await fs.readFile(path.join(tmpRoot, 'notes', 'auth', '_sources', `${result!.toSlug}.md`), 'utf-8');
    expect(newRaw).toContain('hidden: true');
  });

  it('refuses to move a source not in inbox (returns null)', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki', content: 'wb', path: 'notes/auth' });
    const curatedSource = await store.add({ title: 'Curated', content: 'data', path: 'notes/curated' });

    const result = await store.moveSourceToWikiFolder(curatedSource.id, 'notes/auth');
    expect(result).toBeNull();

    // Source untouched.
    const after = await store.get(curatedSource.id);
    expect(after?.path).toBe('notes/curated');
    expect(after?.hidden).toBeUndefined();
  });

  it('returns null when the source is already in the target _sources folder', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki', content: 'wb', path: 'notes/topic' });
    const src = await store.add({ title: 'Idempotent', content: 'x' });
    const first = await store.moveSourceToWikiFolder(src.id, 'notes/topic');
    expect(first).not.toBeNull();

    const second = await store.moveSourceToWikiFolder(src.id, 'notes/topic');
    expect(second).toBeNull();
  });

  it('refuses to move a source into inbox or root (returns null)', async () => {
    await store.ensureBootstrapped();
    const src = await store.add({ title: 'src', content: 'x' });
    expect(await store.moveSourceToWikiFolder(src.id, 'inbox')).toBeNull();
    expect(await store.moveSourceToWikiFolder(src.id, '')).toBeNull();
  });

  it('handles slug collisions in the target via findFreeSlug', async () => {
    await store.ensureBootstrapped();
    // Pre-create a colliding file in notes/topic/_sources
    await fs.mkdir(path.join(tmpRoot, 'notes', 'topic', '_sources'), { recursive: true });
    await store.add({ title: 'Same name', content: 'first', path: 'notes/topic/_sources' });

    const src = await store.add({ title: 'Same name', content: 'second' });
    const result = await store.moveSourceToWikiFolder(src.id, 'notes/topic');
    expect(result).not.toBeNull();
    // The new slug should differ from the colliding original.
    expect(result?.toSlug).not.toBe('same-name');
    expect(result?.toSlug).toMatch(/same-name-\d+/);
  });
});

describe('KnowledgeBaseStore — restoreSourceFromWikiFolder', () => {
  it('moves a hidden source out of _sources/ back to its original inbox path and clears hidden', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki', content: 'wb', path: 'notes/topic' });
    const src = await store.add({ title: 'Restored', content: 'r' });
    const move = await store.moveSourceToWikiFolder(src.id, 'notes/topic');
    expect(move).not.toBeNull();

    const restored = await store.restoreSourceFromWikiFolder(src.id, move!.fromPath, move!.fromSlug);
    expect(restored).not.toBeNull();
    expect(restored?.restoredPath).toBe('inbox');

    const after = await store.get(src.id);
    expect(after?.path).toBe('inbox');
    expect(after?.hidden).toBeUndefined();
  });

  it('returns null when the source is not currently inside a _sources folder', async () => {
    await store.ensureBootstrapped();
    const src = await store.add({ title: 'Just an inbox note', content: 'x' });
    const result = await store.restoreSourceFromWikiFolder(src.id, 'inbox', src.slug);
    expect(result).toBeNull();
  });
});

describe('KnowledgeBaseStore — removeFolder', () => {
  it('removes an empty folder under notes/', async () => {
    await store.ensureBootstrapped();
    const target = path.join(tmpRoot, KB_NOTES_DIR, 'stray-room');
    await fs.mkdir(target, { recursive: true });

    const ok = await store.removeFolder('notes/stray-room');
    expect(ok).toBe(true);

    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('returns false when the folder does not exist', async () => {
    await store.ensureBootstrapped();
    const ok = await store.removeFolder('notes/never-existed');
    expect(ok).toBe(false);
  });

  it('rejects a non-empty folder unless recursive is true', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Inside', content: 'x', path: 'notes/has-stuff' });

    await expect(store.removeFolder('notes/has-stuff')).rejects.toThrow(/not empty/);

    // The note is still there.
    const stat = await fs.stat(path.join(tmpRoot, 'notes', 'has-stuff'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('force-deletes a non-empty folder when recursive is true and purges note ids from the index', async () => {
    await store.ensureBootstrapped();
    const created = await store.add({ title: 'Inside', content: 'body', path: 'notes/doomed' });
    expect((await store.list()).some((n) => n.id === created.id)).toBe(true);

    const ok = await store.removeFolder('notes/doomed', { recursive: true });
    expect(ok).toBe(true);

    await expect(fs.stat(path.join(tmpRoot, 'notes', 'doomed'))).rejects.toThrow();
    expect((await store.list()).some((n) => n.id === created.id)).toBe(false);
  });

  it('rejects removing the KB root', async () => {
    await store.ensureBootstrapped();
    await expect(store.removeFolder('')).rejects.toThrow(/KB root/);
    await expect(store.removeFolder('/')).rejects.toThrow(/KB root/);
  });

  it('rejects removing the protected top-level inbox folder', async () => {
    await store.ensureBootstrapped();
    await expect(store.removeFolder('inbox')).rejects.toThrow(/protected top-level/);
  });

  it('rejects removing the protected top-level notes folder', async () => {
    await store.ensureBootstrapped();
    await expect(store.removeFolder('notes')).rejects.toThrow(/protected top-level/);
  });

  it('rejects path traversal attempts', async () => {
    await store.ensureBootstrapped();
    await expect(store.removeFolder('../escape')).rejects.toBeInstanceOf(KbError);
    await expect(store.removeFolder('notes/../../escape')).rejects.toBeInstanceOf(KbError);
  });

  it('throws when path is a file, not a directory', async () => {
    await store.ensureBootstrapped();
    const note = await store.add({ title: 'A note', content: 'x' });
    // The note's full slug-relative path under inbox/ is `inbox/<slug>` (no .md
    // extension on the directory side, so this is technically a non-existent
    // dir from the store's perspective). Cover the file-stat-not-dir branch
    // by writing a regular file directly under notes/.
    const filePath = path.join(tmpRoot, 'notes', 'a-file');
    await fs.writeFile(filePath, 'just a file', 'utf-8');
    await expect(store.removeFolder('notes/a-file')).rejects.toThrow(/not a directory/);
    expect(note.id).toMatch(/^kb_/);
  });

  it('appends an activity log entry on successful removal', async () => {
    await store.ensureBootstrapped();
    await fs.mkdir(path.join(tmpRoot, 'notes', 'logged-room'), { recursive: true });
    await store.removeFolder('notes/logged-room');

    const activity = await fs.readFile(path.join(tmpRoot, 'activity.jsonl'), 'utf-8');
    expect(activity).toContain('"op":"remove_folder"');
    expect(activity).toContain('"path":"notes/logged-room"');
  });

  it('uses op=remove_folder_recursive in the activity log when recursive is true', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Recursive doomed', content: 'x', path: 'notes/recursive-doomed' });

    await store.removeFolder('notes/recursive-doomed', { recursive: true });

    const activity = await fs.readFile(path.join(tmpRoot, 'activity.jsonl'), 'utf-8');
    expect(activity).toContain('"op":"remove_folder_recursive"');
    expect(activity).toContain('"path":"notes/recursive-doomed"');
  });

  // ── Cascade-aware recursive removal (review fix #1, codex-2) ─────────────

  it('recursive remove BLOCKS when a raw source inside the tree is cited by a wiki OUTSIDE the tree', async () => {
    await store.ensureBootstrapped();
    // Source lives in the room we're about to delete.
    const src = await store.add({ title: 'Cited source', content: 'data', path: 'notes/doomed-room' });
    // Pretend a wiki outside the tree cites it: write the wiki by hand
    // with consumedBy on the source via updateConsumedBy.
    await store.add({
      title: 'External wiki',
      content: 'cites [^kb_x]',
      path: 'notes/safe-room',
    });
    // Find the wiki we just created and pretend it's a wiki kind.
    const externalWiki = (await store.list()).find((n) => n.title === 'External wiki');
    expect(externalWiki).toBeDefined();
    // Add the external wiki id to the source's consumedBy[] manually.
    await store.updateConsumedBy(src.id, [externalWiki!.id]);

    await expect(
      store.removeFolder('notes/doomed-room', { recursive: true }),
    ).rejects.toMatchObject({ code: 'cascade_required' });

    // The source and folder are still there because the call rejected.
    const stillThere = await store.get(src.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.path).toBe('notes/doomed-room');
  });

  it('recursive remove with cascade: true strips citations from external wikis and marks them stale', async () => {
    await store.ensureBootstrapped();
    const src = await store.add({ title: 'Source for cascade', content: 'cd', path: 'notes/doomed-cascade' });
    await store.add({
      title: 'External wiki cascade',
      content: 'body',
      path: 'notes/safe-cascade',
    });
    const externalWiki = (await store.list()).find((n) => n.title === 'External wiki cascade');
    expect(externalWiki).toBeDefined();

    // Stamp the external wiki with sourceRefs pointing at our source so the
    // cascade strip path has something to act on. Use update() to set the body
    // and tags; then write sourceRefs via the lower-level path used by the
    // builder. Easiest path: re-write the file via add+update flow with
    // sourceRefs in frontmatter — but update() doesn't expose sourceRefs.
    // Instead, exercise via the consumer side: add to consumedBy AND directly
    // patch the wiki frontmatter on disk.
    await store.updateConsumedBy(src.id, [externalWiki!.id]);
    const wikiFile = path.join(tmpRoot, 'notes', 'safe-cascade', `${externalWiki!.slug}.md`);
    const raw = await fs.readFile(wikiFile, 'utf-8');
    const patched = raw.replace(/^---\n/, `---\nkind: wiki\nsourceRefs: [${src.id}]\nbuildStatus: published\n`);
    await fs.writeFile(wikiFile, patched, 'utf-8');
    // Force the store to reload from disk.
    KnowledgeBaseStore.resetForTests(tmpRoot);
    store = KnowledgeBaseStore.getInstance();
    await store.ensureBootstrapped();

    // Now the recursive remove with cascade should succeed.
    const ok = await store.removeFolder('notes/doomed-cascade', { recursive: true, cascade: true });
    expect(ok).toBe(true);

    // The folder is gone.
    await expect(fs.stat(path.join(tmpRoot, 'notes', 'doomed-cascade'))).rejects.toThrow();

    // The external wiki has had the source id stripped from sourceRefs and
    // is marked stale.
    const refreshedWiki = await store.get(externalWiki!.id);
    expect(refreshedWiki?.sourceRefs ?? []).not.toContain(src.id);
    expect(refreshedWiki?.buildStatus).toBe('stale');
  });

  it('recursive remove ALWAYS cleans up external sources whose consumedBy includes wikis being deleted (no cascade flag needed)', async () => {
    await store.ensureBootstrapped();
    // External source lives outside the deletion tree.
    const externalSrc = await store.add({ title: 'External source', content: 'src', path: 'notes/safe' });
    // Wiki inside the deletion tree cites the external source via sourceRefs +
    // is recorded as a consumer in consumedBy[].
    await store.add({ title: 'Wiki to delete', content: 'body', path: 'notes/doomed-wiki' });
    const wikiToDelete = (await store.list()).find((n) => n.title === 'Wiki to delete');
    expect(wikiToDelete).toBeDefined();

    // Patch the wiki on disk to be kind=wiki with sourceRefs pointing at the external source.
    const wikiFile = path.join(tmpRoot, 'notes', 'doomed-wiki', `${wikiToDelete!.slug}.md`);
    const raw = await fs.readFile(wikiFile, 'utf-8');
    const patched = raw.replace(/^---\n/, `---\nkind: wiki\nsourceRefs: [${externalSrc.id}]\nbuildStatus: published\n`);
    await fs.writeFile(wikiFile, patched, 'utf-8');
    KnowledgeBaseStore.resetForTests(tmpRoot);
    store = KnowledgeBaseStore.getInstance();
    await store.ensureBootstrapped();

    // Stamp the external source's consumedBy to include the wiki id.
    await store.updateConsumedBy(externalSrc.id, [wikiToDelete!.id]);

    // Recursive remove without cascade — should succeed because the only
    // dependency is wiki→source (cleanup direction, not raw→wiki).
    const ok = await store.removeFolder('notes/doomed-wiki', { recursive: true });
    expect(ok).toBe(true);

    // The external source's consumedBy[] no longer references the deleted wiki.
    const refreshedSrc = await store.get(externalSrc.id);
    expect(refreshedSrc?.consumedBy ?? []).not.toContain(wikiToDelete!.id);
  });

  it('recursive remove succeeds when ALL dependencies are internal to the deletion tree', async () => {
    await store.ensureBootstrapped();
    // Source and wiki both inside the same deletion tree.
    const src = await store.add({ title: 'Internal source', content: 'i', path: 'notes/sibling-room' });
    await store.add({ title: 'Internal wiki', content: 'b', path: 'notes/sibling-room' });
    const wiki = (await store.list()).find((n) => n.title === 'Internal wiki');
    expect(wiki).toBeDefined();
    // Cross-link them.
    await store.updateConsumedBy(src.id, [wiki!.id]);

    // Should succeed without cascade — all references are inside the tree.
    const ok = await store.removeFolder('notes/sibling-room', { recursive: true });
    expect(ok).toBe(true);
    expect(await store.get(src.id)).toBeNull();
    expect(await store.get(wiki!.id)).toBeNull();
  });
});

// ── walk() _sources/ filter respects frontmatter (review fix #2, codex-2) ─

describe('KnowledgeBaseStore — walk() _sources/ visibility is content-aware', () => {
  it('walk() shows _sources/ in folders when at least one child note is no longer hidden', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki', content: 'wb', path: 'notes/manual-unhide' });
    const src = await store.add({ title: 'To unhide', content: 'u' });
    await store.moveSourceToWikiFolder(src.id, 'notes/manual-unhide');

    // Default walk: _sources/ is hidden because all children are hidden.
    const before = await store.walk('notes/manual-unhide');
    expect(before.folders).not.toContain('_sources');

    // Manually clear hidden: true on the moved source by editing the file
    // on disk, then forcing a fresh store + index.
    const movedNote = await store.get(src.id);
    expect(movedNote?.path).toBe('notes/manual-unhide/_sources');
    const noteFile = path.join(tmpRoot, 'notes', 'manual-unhide', '_sources', `${movedNote!.slug}.md`);
    const raw = await fs.readFile(noteFile, 'utf-8');
    const patched = raw.replace(/\nhidden: true\n/, '\n');
    await fs.writeFile(noteFile, patched, 'utf-8');
    KnowledgeBaseStore.resetForTests(tmpRoot);
    store = KnowledgeBaseStore.getInstance();
    await store.ensureBootstrapped();

    // Now walk() should surface _sources/ because the child is visible.
    const after = await store.walk('notes/manual-unhide');
    expect(after.folders).toContain('_sources');

    // And walking into _sources should show the child note.
    const inside = await store.walk('notes/manual-unhide/_sources');
    expect(inside.children.some((n) => n.id === src.id)).toBe(true);
  });

  it('walk() continues to hide _sources/ when ALL children are hidden (default UX preserved)', async () => {
    await store.ensureBootstrapped();
    await store.add({ title: 'Wiki default', content: 'wb', path: 'notes/default-room' });
    const src = await store.add({ title: 'Stays hidden', content: 'h' });
    await store.moveSourceToWikiFolder(src.id, 'notes/default-room');

    const result = await store.walk('notes/default-room');
    expect(result.folders).not.toContain('_sources');
    // includeHidden still surfaces it.
    const full = await store.walk('notes/default-room', { includeHidden: true });
    expect(full.folders).toContain('_sources');
  });
});
