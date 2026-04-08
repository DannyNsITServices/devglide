import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { KnowledgeBaseStore, KbError, KB_INBOX_DIR, KB_NOTES_DIR, KB_ACTIVITY_FILE } from './knowledge-base-store.js';
import { parseFrontmatter } from './frontmatter.js';

let tmpRoot: string;
let tmpProjects: string;
let store: KnowledgeBaseStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-'));
  tmpProjects = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-projects-'));
  store = KnowledgeBaseStore.resetForTests(tmpRoot, tmpProjects);
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await fs.rm(tmpProjects, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── ingest ─────────────────────────────────────────────────────────────────

describe('KnowledgeBaseStore.ingest', () => {
  it('drops a date-prefixed, source-tagged file into inbox/', async () => {
    const note = await store.ingest('# My Title\n\nbody content', { source: 'pipe:abc123' });
    expect(note.path).toBe(KB_INBOX_DIR);
    expect(note.source).toBe('pipe:abc123');
    expect(note.title).toBe('My Title');
    // Slug pattern: YYYY-MM-DD-pipe-abc123-my-title (the colon is normalized to a hyphen)
    expect(note.slug).toMatch(/^\d{4}-\d{2}-\d{2}-pipe-abc123-my-title$/);
    // The file actually lands at the expected location.
    const file = path.join(tmpRoot, KB_INBOX_DIR, `${note.slug}.md`);
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it('defaults source to "manual" when not supplied', async () => {
    const note = await store.ingest('quick capture');
    expect(note.source).toBe('manual');
    expect(note.slug).toMatch(/^\d{4}-\d{2}-\d{2}-manual-/);
  });

  it('derives a title from the first non-empty line when no title is given', async () => {
    const note = await store.ingest('   \n\n# Heading One\n\nrest of body');
    expect(note.title).toBe('Heading One');
  });

  it('falls back to "Untitled" when content has no usable first line', async () => {
    const note = await store.ingest('   \n\n#\n\n');
    expect(note.title).toBe('Untitled');
  });

  it('rejects empty content', async () => {
    await expect(store.ingest('')).rejects.toBeInstanceOf(KbError);
    await expect(store.ingest('   \n\n')).rejects.toBeInstanceOf(KbError);
  });

  it('appends an `ingest` row to activity.jsonl', async () => {
    const note = await store.ingest('one', { source: 'manual' });
    const activity = await fs.readFile(path.join(tmpRoot, KB_ACTIVITY_FILE), 'utf-8');
    const lines = activity.trim().split('\n').map((l) => JSON.parse(l));
    const ingestRow = lines.find((l) => l.op === 'ingest' && l.id === note.id);
    expect(ingestRow).toBeDefined();
    expect(ingestRow.path).toBe(KB_INBOX_DIR);
    expect(ingestRow.source).toBe('manual');
  });

  it('persists provenance via the source frontmatter field', async () => {
    const note = await store.ingest('content', { source: 'chat:msg-42' });
    const raw = await fs.readFile(path.join(tmpRoot, KB_INBOX_DIR, `${note.slug}.md`), 'utf-8');
    const { data } = parseFrontmatter(raw);
    expect(data.source).toBe('chat:msg-42');
  });
});

// ── importPipe ─────────────────────────────────────────────────────────────

describe('KnowledgeBaseStore.importPipe', () => {
  /** Plant a fake pipe transcript on disk under the test projects dir. */
  async function seedPipe(projectId: string, pipeId: string, messages: object[]): Promise<void> {
    const dir = path.join(tmpProjects, projectId, 'chat', 'pipes');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${pipeId}.jsonl`);
    await fs.writeFile(file, messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  }

  it('imports a pipe transcript into inbox/ as a markdown digest', async () => {
    await seedPipe('proj-1', 'abc123', [
      { ts: '2026-04-07T20:00:00Z', from: 'claude-1', body: 'Hello from claude' },
      { ts: '2026-04-07T20:01:00Z', from: 'codex-2', body: 'Hi back from codex' },
    ]);
    const note = await store.importPipe('abc123');
    expect(note.path).toBe(KB_INBOX_DIR);
    expect(note.source).toBe('pipe:abc123');
    expect(note.title).toBe('Pipe abc123 import');
    expect(note.body).toContain('# Pipe abc123');
    expect(note.body).toContain('## claude-1');
    expect(note.body).toContain('Hello from claude');
    expect(note.body).toContain('## codex-2');
    expect(note.body).toContain('Hi back from codex');
  });

  it('accepts pipe IDs in `#pipe-`, `pipe-`, and bare forms', async () => {
    await seedPipe('proj-1', 'xyz', [{ ts: 'now', from: 'a', body: 'b' }]);
    const a = await store.importPipe('#pipe-xyz');
    const b = await store.importPipe('pipe-xyz');
    const c = await store.importPipe('xyz');
    for (const note of [a, b, c]) {
      expect(note.source).toBe('pipe:xyz');
    }
  });

  it('throws KbError("not_found") when no project has the pipe', async () => {
    await expect(store.importPipe('ghost')).rejects.toBeInstanceOf(KbError);
  });

  it('throws KbError when pipeId is empty', async () => {
    await expect(store.importPipe('')).rejects.toBeInstanceOf(KbError);
    await expect(store.importPipe('#pipe-')).rejects.toBeInstanceOf(KbError);
  });

  it('skips malformed JSONL lines without crashing', async () => {
    const dir = path.join(tmpProjects, 'proj-1', 'chat', 'pipes');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'mixed.jsonl');
    await fs.writeFile(
      file,
      [
        JSON.stringify({ ts: '2026-04-07', from: 'a', body: 'good line' }),
        '{ this is not json',
        '',
        JSON.stringify({ ts: '2026-04-07', from: 'b', body: 'another good line' }),
      ].join('\n'),
      'utf-8',
    );
    const note = await store.importPipe('mixed');
    expect(note.body).toContain('good line');
    expect(note.body).toContain('another good line');
  });

  it('finds the pipe across multiple projects', async () => {
    await seedPipe('proj-1', 'one', [{ from: 'a', body: 'first' }]);
    await seedPipe('proj-2', 'two', [{ from: 'b', body: 'second' }]);
    const a = await store.importPipe('one');
    const b = await store.importPipe('two');
    expect(a.body).toContain('first');
    expect(b.body).toContain('second');
  });

  it('lands the note at opts.path when supplied (skipping inbox)', async () => {
    await seedPipe('proj-1', 'direct', [{ from: 'a', body: 'x' }]);
    const note = await store.importPipe('direct', { path: 'notes/imports', title: 'Custom title' });
    expect(note.path).toBe('notes/imports');
    expect(note.title).toBe('Custom title');
    expect(note.source).toBe('pipe:direct');
  });

  it('appends an `import_pipe` activity row', async () => {
    await seedPipe('proj-1', 'logme', [{ from: 'a', body: 'x' }]);
    const note = await store.importPipe('logme');
    const activity = await fs.readFile(path.join(tmpRoot, KB_ACTIVITY_FILE), 'utf-8');
    const lines = activity.trim().split('\n').map((l) => JSON.parse(l));
    const importRow = lines.find((l) => l.op === 'import_pipe' && l.id === note.id);
    expect(importRow).toBeDefined();
    expect(importRow.source).toBe('pipe:logme');
  });
});

// ── promote ────────────────────────────────────────────────────────────────

describe('KnowledgeBaseStore.promote', () => {
  it('moves an inbox note into the curated tree, preserving id', async () => {
    const created = await store.ingest('# Worth keeping\n\nbody');
    const oldFile = path.join(tmpRoot, KB_INBOX_DIR, `${created.slug}.md`);
    const promoted = await store.promote(created.id, 'notes/curated');
    expect(promoted.id).toBe(created.id);
    expect(promoted.path).toBe('notes/curated');
    // The old inbox file is gone; the new one exists.
    await expect(fs.access(oldFile)).rejects.toBeTruthy();
    const newFile = path.join(tmpRoot, KB_NOTES_DIR, 'curated', `${promoted.slug}.md`);
    await expect(fs.access(newFile)).resolves.toBeUndefined();
  });

  it('renames the slug when newSlug is given', async () => {
    const created = await store.add({ title: 'Long ugly inbox slug', content: 'x' });
    const promoted = await store.promote(created.id, 'notes/short', { newSlug: 'cleaner-name' });
    expect(promoted.slug).toBe('cleaner-name');
    expect(promoted.path).toBe('notes/short');
  });

  it('preserves the slug when newSlug is omitted', async () => {
    const created = await store.add({ title: 'Keep the slug', content: 'x' });
    const promoted = await store.promote(created.id, 'notes/keep');
    expect(promoted.slug).toBe(created.slug);
  });

  it('throws KbError when targetPath is empty', async () => {
    const created = await store.add({ title: 'x', content: 'x' });
    await expect(store.promote(created.id, '')).rejects.toBeInstanceOf(KbError);
    await expect(store.promote(created.id, '   ')).rejects.toBeInstanceOf(KbError);
  });

  it('throws KbError("not_found") when the source note is missing', async () => {
    await expect(store.promote('kb_nonexistent', 'notes/x')).rejects.toBeInstanceOf(KbError);
  });

  it('appends a `promote` activity row distinct from the underlying update row', async () => {
    const created = await store.add({ title: 'Promote me', content: 'x' });
    await store.promote(created.id, 'notes/here');
    const activity = await fs.readFile(path.join(tmpRoot, KB_ACTIVITY_FILE), 'utf-8');
    const ops = activity.trim().split('\n').map((l) => JSON.parse(l).op);
    expect(ops).toContain('promote');
    expect(ops).toContain('update');
  });

  it('round-trip: ingest → promote → list shows the note in the new path', async () => {
    const ingested = await store.ingest('content for promotion', { source: 'manual' });
    await store.promote(ingested.id, 'notes/final');
    const inFinal = await store.list({ path: 'notes/final' });
    expect(inFinal.some((s) => s.id === ingested.id)).toBe(true);
    const inInbox = await store.list({ path: KB_INBOX_DIR });
    expect(inInbox.some((s) => s.id === ingested.id)).toBe(false);
  });
});
