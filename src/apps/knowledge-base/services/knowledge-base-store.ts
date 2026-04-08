/**
 * KnowledgeBaseStore — file-first markdown store for the global Knowledge Base.
 *
 * Storage layout (under `KNOWLEDGE_BASE_DIR`):
 *   inbox/                — raw captured material (pipe/chat/manual ingests)
 *   notes/                — curated topic tree
 *   index.json            — rebuildable lookup cache (disk is canonical)
 *   activity.jsonl        — append-only audit log
 *
 * Phase 2: full CRUD + index rebuild + atomic writes + slug collision handling
 *          + path traversal guard + in-process locking.
 */

import fs from 'fs/promises';
import path from 'path';
import { createId } from '@paralleldrive/cuid2';
import { KNOWLEDGE_BASE_DIR, PROJECTS_DIR } from '../../../packages/paths.js';
import type {
  KbAddInput,
  KbBuildStatus,
  KbIndex,
  KbNote,
  KbNoteKind,
  KbNoteSummary,
  KbSearchHit,
  KbUpdateFields,
  KbWalkResult,
} from '../types.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { composeWikiPage, hashBody } from './kb-compose.js';

/** v2: valid values for the `kind` discriminator. */
const VALID_KINDS: readonly KbNoteKind[] = ['raw', 'wiki', 'index'];

/** v2: valid values for `buildStatus`. */
const VALID_BUILD_STATUSES: readonly KbBuildStatus[] = ['draft', 'published', 'stale'];

/**
 * v2: default `kind` for a note whose frontmatter has no `kind` field.
 *
 *   - slug === '_index' → `index` (room hub page)
 *   - otherwise          → `raw` (every v1 note is raw until the builder marks it wiki)
 *
 * The builder never writes a `kind: raw` over this default — it only writes
 * `kind: wiki` on refined pages it creates/updates. This keeps existing v1
 * files clean (no migration churn) and lets the builder opt specific pages in.
 */
export function defaultKindForSlug(slug: string): KbNoteKind {
  return slug === '_index' ? 'index' : 'raw';
}

/** Folder names inside the KB root. */
export const KB_INBOX_DIR = 'inbox';
export const KB_NOTES_DIR = 'notes';
export const KB_INDEX_FILE = 'index.json';
export const KB_ACTIVITY_FILE = 'activity.jsonl';
/**
 * On-disk index cache schema version.
 *
 * History:
 *   1 — v1 schema: id/title/slug/path/tags/source/updatedAt
 *   2 — v2 schema: adds optional `kind` and `buildStatus` to each summary,
 *       required for KB v2 wiki-builder features (getByKind, tree icons, stale
 *       badges). A v1 cache cannot express the new fields, so loading one would
 *       serve stale v1 summaries from `list()` until an unrelated write
 *       triggered a rebuild. Bumping the version forces `loadIndex()` to fall
 *       through to `rebuildIndex()` on first read, guaranteeing v2-native
 *       summaries without requiring a migration script.
 */
export const KB_INDEX_VERSION = 2;
export const KB_ID_PREFIX = 'kb_';

/** Default content of the welcome note created on first init. */
const WELCOME_INDEX = `# Knowledge Base

Welcome. This folder is your global, file-first knowledge base.

- Drop raw material into \`inbox/\`.
- Curate it into rooms under \`notes/\`.
- Promote inbox notes when they are ready.

The folder tree is the memory palace.
`;

/** Domain-specific error so callers can distinguish KB errors from generic Errors. */
export class KbError extends Error {
  constructor(message: string, public readonly code: KbErrorCode = 'invalid') {
    super(message);
    this.name = 'KbError';
  }
}

export type KbErrorCode =
  | 'invalid'
  | 'not_found'
  | 'collision'
  | 'traversal'
  | 'cascade_required'
  | 'manual_edits_present';

/** Minimal shape of a chat pipe message line, parsed out of `pipes/{id}.jsonl`. */
interface KbPipeMessage {
  ts?: string;
  from?: string;
  body?: string;
  [k: string]: unknown;
}

export class KnowledgeBaseStore {
  private static instance: KnowledgeBaseStore | null = null;

  protected readonly rootDir: string;
  /** Where to look for `chat/pipes/{pipeId}.jsonl` when resolving pipe imports. */
  protected projectsDir: string = PROJECTS_DIR;
  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;
  private writeLocks = new Map<string, Promise<void>>();
  private indexCache: KbIndex | null = null;

  protected constructor(rootDir: string = KNOWLEDGE_BASE_DIR) {
    this.rootDir = rootDir;
  }

  static getInstance(): KnowledgeBaseStore {
    if (!KnowledgeBaseStore.instance) {
      KnowledgeBaseStore.instance = new KnowledgeBaseStore();
    }
    return KnowledgeBaseStore.instance;
  }

  /** Reset the singleton — used by tests that point to a temp dir. */
  static resetForTests(rootDir?: string, projectsDir?: string): KnowledgeBaseStore {
    const instance = new KnowledgeBaseStore(rootDir);
    if (projectsDir !== undefined) instance.projectsDir = projectsDir;
    KnowledgeBaseStore.instance = instance;
    return instance;
  }

  /** Absolute path to the KB root. */
  getRootDir(): string {
    return this.rootDir;
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────

  /**
   * Ensure the root directory and required subfolders exist. Idempotent and
   * concurrency-safe — parallel calls share a single bootstrap promise so the
   * welcome-file write doesn't race with itself.
   */
  async ensureBootstrapped(): Promise<void> {
    if (this.bootstrapped) return;
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = this.doBootstrap().finally(() => {
      this.bootstrapPromise = null;
    });
    return this.bootstrapPromise;
  }

  private async doBootstrap(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.mkdir(path.join(this.rootDir, KB_INBOX_DIR), { recursive: true });
    await fs.mkdir(path.join(this.rootDir, KB_NOTES_DIR), { recursive: true });

    const welcomePath = path.join(this.rootDir, KB_NOTES_DIR, '_index.md');
    let existing: string | null = null;
    try {
      existing = await fs.readFile(welcomePath, 'utf-8');
    } catch {
      existing = null;
    }
    // Write the welcome note if it is missing OR if it was left behind by the
    // Phase 1 skeleton without a frontmatter block (first non-blank line not `---`).
    const needsWelcome =
      existing === null ||
      !existing.replace(/^\uFEFF/, '').trimStart().startsWith('---');
    if (needsWelcome) {
      const now = new Date().toISOString();
      const welcomeNote: KbNote = {
        id: this.generateId(),
        title: 'Knowledge Base',
        slug: '_index',
        path: KB_NOTES_DIR,
        tags: [],
        source: 'manual',
        createdAt: now,
        updatedAt: now,
        body: WELCOME_INDEX,
      };
      await this.writeNoteFile(welcomePath, welcomeNote);
      // Invalidate any cached index so the next ensureIndex() rebuilds from
      // disk and picks up the newly-written welcome note. Without this, a
      // stale on-disk index.json (e.g. from a hand-edited or partially-reset
      // state) would hide the welcome note from list() responses.
      this.indexCache = null;
      const indexPath = path.join(this.rootDir, KB_INDEX_FILE);
      try { await fs.unlink(indexPath); } catch { /* ok if absent */ }
    }
    this.bootstrapped = true;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async add(input: KbAddInput): Promise<KbNote> {
    await this.ensureBootstrapped();
    if (!input.title || input.title.trim() === '') {
      throw new KbError('title is required');
    }
    if (input.content === undefined || input.content === null) {
      throw new KbError('content is required');
    }

    const targetPath = this.normalizeRelDir(input.path ?? KB_INBOX_DIR);
    const baseSlug = this.slugify(input.slug ?? input.title);

    return this.withLock(`add:${targetPath}`, async () => {
      const absDir = this.resolveSafe(targetPath);
      await fs.mkdir(absDir, { recursive: true });
      const slug = await this.findFreeSlug(absDir, baseSlug);

      const now = new Date().toISOString();
      const note: KbNote = {
        id: this.generateId(),
        title: input.title.trim(),
        slug,
        path: targetPath,
        tags: input.tags ?? [],
        source: input.source,
        createdAt: now,
        updatedAt: now,
        body: input.content,
      };
      const file = path.join(absDir, `${slug}.md`);
      await this.writeNoteFile(file, note);
      this.upsertIndex(note);
      await this.appendActivity({ ts: now, op: 'add', id: note.id, path: note.path, source: note.source });
      return note;
    });
  }

  async get(idOrPath: string): Promise<KbNote | null> {
    await this.ensureBootstrapped();
    if (this.looksLikeId(idOrPath)) {
      return this.getById(idOrPath);
    }
    return this.getByPath(idOrPath);
  }

  async list(filter?: { path?: string; tag?: string; q?: string; limit?: number; includeHidden?: boolean }): Promise<KbNoteSummary[]> {
    await this.ensureBootstrapped();
    const index = await this.ensureIndex();
    const all = Object.values(index.notes);

    let filtered = all;
    if (filter?.path) {
      const prefix = this.normalizeRelDir(filter.path);
      filtered = filtered.filter((s) =>
        s.path === prefix || s.path.startsWith(prefix + '/')
      );
    }
    if (filter?.tag) {
      filtered = filtered.filter((s) => s.tags.includes(filter.tag!));
    }
    if (filter?.q) {
      const q = filter.q.toLowerCase();
      filtered = filtered.filter((s) => s.title.toLowerCase().includes(q));
    }
    // Default: hide notes flagged `hidden: true` (sources tucked under
    // `<wikiPath>/_sources/` by the wiki builder). Pass `includeHidden: true`
    // to surface them — used by trace_sources, the dashboard "show hidden"
    // toggle, and any debug listing.
    if (!filter?.includeHidden) {
      filtered = filtered.filter((s) => s.hidden !== true);
    }

    filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (filter?.limit && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }
    return filtered;
  }

  async update(idOrPath: string, fields: KbUpdateFields): Promise<KbNote | null> {
    await this.ensureBootstrapped();
    const existing = await this.get(idOrPath);
    if (!existing) return null;

    return this.withLock(`note:${existing.id}`, async () => {
      // Re-fetch under lock to avoid clobbering concurrent updates.
      const fresh = await this.getById(existing.id);
      if (!fresh) return null;

      const merged: KbNote = { ...fresh };
      if (fields.title !== undefined) {
        const trimmed = fields.title.trim();
        if (trimmed === '') {
          throw new KbError('title cannot be empty');
        }
        merged.title = trimmed;
      }
      if (fields.content !== undefined) merged.body = fields.content;
      if (fields.tags !== undefined) merged.tags = fields.tags;

      // Determine target location after rename/move.
      let targetPath = fresh.path;
      let targetSlug = fresh.slug;
      let needsMove = false;
      if (fields.path !== undefined) {
        const norm = this.normalizeRelDir(fields.path);
        if (norm !== fresh.path) {
          targetPath = norm;
          needsMove = true;
        }
      }
      if (fields.slug !== undefined) {
        const newSlug = this.slugify(fields.slug);
        if (newSlug !== fresh.slug) {
          targetSlug = newSlug;
          needsMove = true;
        }
      }

      merged.updatedAt = new Date().toISOString();
      const oldFile = path.join(this.resolveSafe(fresh.path), `${fresh.slug}.md`);

      if (needsMove) {
        const targetDir = this.resolveSafe(targetPath);
        await fs.mkdir(targetDir, { recursive: true });
        const finalSlug = await this.findFreeSlug(targetDir, targetSlug, fresh.id);
        merged.path = targetPath;
        merged.slug = finalSlug;
        const newFile = path.join(targetDir, `${finalSlug}.md`);

        await this.writeNoteFile(newFile, merged);
        if (path.resolve(newFile) !== path.resolve(oldFile)) {
          try { await fs.unlink(oldFile); } catch { /* ignore */ }
        }
      } else {
        await this.writeNoteFile(oldFile, merged);
      }

      this.upsertIndex(merged);
      await this.appendActivity({ ts: merged.updatedAt, op: 'update', id: merged.id, path: merged.path, source: merged.source });
      return merged;
    });
  }

  // ── Ingest + import + promote ───────────────────────────────────────────

  /**
   * The brainstorm-input shortcut: drop a blob of text into `inbox/` with a
   * date-stamped, source-tagged filename. Title is derived from the first
   * non-empty line if not supplied; source defaults to `manual`.
   */
  async ingest(content: string, opts?: { title?: string; source?: string }): Promise<KbNote> {
    await this.ensureBootstrapped();
    if (content === undefined || content === null || content.trim() === '') {
      throw new KbError('content is required');
    }
    const source = opts?.source ?? 'manual';
    const title = (opts?.title?.trim() || this.deriveTitleFromContent(content)).slice(0, 200);
    const datePrefix = new Date().toISOString().slice(0, 10);
    const sourcePart = source
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'manual';
    const titleSlug = this.slugify(title);
    const slug = `${datePrefix}-${sourcePart}-${titleSlug}`.slice(0, 80).replace(/-+$/, '');

    const note = await this.add({
      title,
      content,
      path: KB_INBOX_DIR,
      source,
      slug,
    });
    await this.appendActivity({
      ts: note.createdAt,
      op: 'ingest',
      id: note.id,
      path: note.path,
      source: note.source,
    });
    return note;
  }

  /**
   * Simple compose lane: create one wiki page directly from a selected,
   * ordered set of raw sources. Unlike the v2 builder path this is
   * synchronous, deterministic, and requires no runtime LLM.
   */
  async composeWiki(input: {
    pagePath: string;
    sourceIds: string[];
    title?: string;
  }): Promise<KbNote> {
    await this.ensureBootstrapped();
    const target = this.parseComposeTarget(input.pagePath);
    if (target.path !== KB_NOTES_DIR && !target.path.startsWith(`${KB_NOTES_DIR}/`)) {
      throw new KbError(`Composed wiki pages must live under "${KB_NOTES_DIR}/"`, 'invalid');
    }

    const sourceIds = [...new Set(
      input.sourceIds
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    )];
    if (sourceIds.length === 0) {
      throw new KbError('sourceIds must contain at least one note id', 'invalid');
    }

    const sources = await this.resolveComposeSources(sourceIds);
    const title = input.title?.trim() || this.titleFromSlug(target.slug);
    const baseSlug = this.slugify(target.slug);

    return this.withLock(`compose:${target.path}`, async () => {
      const absDir = this.resolveSafe(target.path);
      await fs.mkdir(absDir, { recursive: true });
      const slug = await this.findFreeSlug(absDir, baseSlug);
      const now = new Date().toISOString();
      const composed = composeWikiPage({ title, sources });
      const body = this.normalizeStoredBody(composed.body);
      const note: KbNote = {
        id: this.generateId(),
        title,
        slug,
        path: target.path,
        tags: [],
        createdAt: now,
        updatedAt: now,
        body,
        kind: 'wiki',
        sourceRefs: composed.sourceRefs,
        lastComposedBodyHash: hashBody(body),
      };

      const file = path.join(absDir, `${slug}.md`);
      await this.writeNoteFile(file, note);
      this.upsertIndex(note);
      await this.appendActivity({ ts: now, op: 'compose', id: note.id, path: note.path, source: note.source });

      for (const source of sources) {
        await this.updateConsumedBy(source.id, [...(source.consumedBy ?? []), note.id]);
      }

      return note;
    });
  }

  /**
   * Recompose an existing wiki page from its current `sourceRefs[]`.
   * Refuses to overwrite manual body edits unless `force: true`.
   */
  async rebuildComposedWiki(pageId: string, opts?: { force?: boolean }): Promise<KbNote> {
    await this.ensureBootstrapped();
    return this.withLock(`note:${pageId}`, async () => {
      const fresh = await this.getById(pageId);
      if (!fresh) {
        throw new KbError(`Note "${pageId}" not found`, 'not_found');
      }
      if ((fresh.kind ?? defaultKindForSlug(fresh.slug)) !== 'wiki') {
        throw new KbError(`Note "${pageId}" is not a wiki page`, 'invalid');
      }
      const sourceIds = fresh.sourceRefs ?? [];
      if (sourceIds.length === 0) {
        throw new KbError(`Wiki page "${pageId}" has no sourceRefs to rebuild from`, 'invalid');
      }

      const currentHash = KnowledgeBaseStore.hashBody(fresh.body);
      if (
        fresh.lastComposedBodyHash === undefined ||
        fresh.lastComposedBodyHash === '' ||
        currentHash !== fresh.lastComposedBodyHash
      ) {
        if (opts?.force !== true) {
          throw new KbError(
            `Wiki page "${pageId}" has manual edits; re-invoke with force: true to overwrite them.`,
            'manual_edits_present',
          );
        }
      }

      const sources = await this.resolveComposeSources(sourceIds);
      const composed = composeWikiPage({ title: fresh.title, sources });
      const body = this.normalizeStoredBody(composed.body);
      const rebuilt: KbNote = {
        ...fresh,
        body,
        sourceRefs: composed.sourceRefs,
        lastComposedBodyHash: hashBody(body),
        updatedAt: new Date().toISOString(),
      };

      const file = path.join(this.resolveSafe(rebuilt.path), `${rebuilt.slug}.md`);
      await this.writeNoteFile(file, rebuilt);
      this.upsertIndex(rebuilt);
      await this.appendActivity({ ts: rebuilt.updatedAt, op: 'rebuild', id: rebuilt.id, path: rebuilt.path, source: rebuilt.source });
      return rebuilt;
    });
  }

  /**
   * Pull a chat pipe transcript off disk and ingest it as an inbox note.
   *
   * Reads the per-pipe JSONL written by the chat app. Scans every project
   * under `projectsDir` until it finds a `chat/pipes/{pipeId}.jsonl` matching
   * the requested pipe id. The pipe id may be passed as `#pipe-abc`,
   * `pipe-abc`, or just `abc`.
   *
   * If `opts.path` is provided, the note lands directly in that folder
   * (skipping the inbox); otherwise it goes through `ingest()`.
   */
  async importPipe(pipeId: string, opts?: { title?: string; path?: string }): Promise<KbNote> {
    await this.ensureBootstrapped();
    const cleanId = pipeId.trim().replace(/^#?pipe-?/i, '');
    if (cleanId === '') {
      throw new KbError('pipeId is required');
    }
    const messages = await this.findPipeMessages(cleanId);
    if (!messages) {
      throw new KbError(`Pipe not found: ${pipeId}`, 'not_found');
    }
    const title = opts?.title?.trim() || `Pipe ${cleanId} import`;
    const source = `pipe:${cleanId}`;
    const content = this.formatPipeAsMarkdown(cleanId, messages);

    if (opts?.path) {
      const created = await this.add({
        title,
        content,
        path: opts.path,
        source,
      });
      await this.appendActivity({
        ts: created.createdAt,
        op: 'import_pipe',
        id: created.id,
        path: created.path,
        source: created.source,
      });
      return created;
    }
    const ingested = await this.ingest(content, { title, source });
    await this.appendActivity({
      ts: ingested.updatedAt,
      op: 'import_pipe',
      id: ingested.id,
      path: ingested.path,
      source: ingested.source,
    });
    return ingested;
  }

  /**
   * Move a note out of `inbox/` into the curated tree (or rename in place).
   * Conceptually distinct from `update(path=...)` because the inbox→notes
   * transition is the explicit "this is ready to keep" verb.
   */
  async promote(idOrPath: string, targetPath: string, opts?: { newSlug?: string }): Promise<KbNote> {
    await this.ensureBootstrapped();
    if (!targetPath || targetPath.trim() === '') {
      throw new KbError('targetPath is required');
    }
    const fields: KbUpdateFields = { path: targetPath };
    if (opts?.newSlug) fields.slug = opts.newSlug;
    const updated = await this.update(idOrPath, fields);
    if (!updated) {
      throw new KbError(`Note not found: ${idOrPath}`, 'not_found');
    }
    await this.appendActivity({
      ts: updated.updatedAt,
      op: 'promote',
      id: updated.id,
      path: updated.path,
      source: updated.source,
    });
    return updated;
  }

  // ── Pipe helpers ────────────────────────────────────────────────────────

  /** Walk every project under `projectsDir` and return the first matching pipe transcript. */
  private async findPipeMessages(pipeId: string): Promise<KbPipeMessage[] | null> {
    let projectIds: string[];
    try {
      projectIds = await fs.readdir(this.projectsDir);
    } catch {
      return null;
    }
    for (const projId of projectIds) {
      const file = path.join(this.projectsDir, projId, 'chat', 'pipes', `${pipeId}.jsonl`);
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const messages: KbPipeMessage[] = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          try {
            messages.push(JSON.parse(trimmed) as KbPipeMessage);
          } catch { /* skip malformed line */ }
        }
        return messages;
      } catch { /* try next project */ }
    }
    return null;
  }

  /** Render a pipe transcript as a readable markdown digest. */
  private formatPipeAsMarkdown(pipeId: string, messages: KbPipeMessage[]): string {
    const lines: string[] = [`# Pipe ${pipeId}`, ''];
    if (messages.length === 0) {
      lines.push('_No messages._');
      return lines.join('\n');
    }
    for (const msg of messages) {
      const from = (typeof msg.from === 'string' && msg.from) || 'unknown';
      const ts = (typeof msg.ts === 'string' && msg.ts) || '';
      const body = (typeof msg.body === 'string' && msg.body) || '';
      lines.push(`## ${from}${ts ? ` — ${ts}` : ''}`, '', body, '');
    }
    return lines.join('\n').replace(/\n+$/, '\n');
  }

  /** Derive a usable title from a markdown blob: first non-empty line, header marks stripped. */
  private deriveTitleFromContent(content: string): string {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      const stripped = line.replace(/^#+\s*/, '').trim();
      if (stripped !== '') return stripped.slice(0, 200);
    }
    return 'Untitled';
  }

  /** Convert a slug-like filename stem into a readable title. */
  private titleFromSlug(slug: string): string {
    const trimmed = slug.trim().replace(/[-_]+/g, ' ');
    if (trimmed === '') return 'Untitled';
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  /**
   * Canonical body form for bytes we persist and later hash-check.
   * The frontmatter reader does not preserve a trailing newline at EOF, so
   * compose/rebuild must hash the newline-stripped form to avoid false
   * `manual_edits_present` positives on untouched pages.
   */
  private normalizeStoredBody(body: string): string {
    return body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  }

  /** Parse a target wiki note path like `notes/auth/overview` into path + slug. */
  private parseComposeTarget(pagePath: string): { path: string; slug: string } {
    let cleaned = pagePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (cleaned.endsWith('.md')) cleaned = cleaned.slice(0, -3);
    const norm = this.normalizeRelDir(cleaned);
    const idx = norm.lastIndexOf('/');
    if (idx <= 0 || idx === norm.length - 1) {
      throw new KbError(
        `pagePath must look like "${KB_NOTES_DIR}/room/page" (received "${pagePath}")`,
        'invalid',
      );
    }
    return {
      path: norm.slice(0, idx),
      slug: norm.slice(idx + 1),
    };
  }

  /** Resolve ordered compose sources, requiring every id to exist and be raw. */
  private async resolveComposeSources(sourceIds: string[]): Promise<KbNote[]> {
    const sources: KbNote[] = [];
    for (const sourceId of sourceIds) {
      const source = await this.getById(sourceId);
      if (!source) {
        throw new KbError(`Source "${sourceId}" not found`, 'not_found');
      }
      const effectiveKind = source.kind ?? defaultKindForSlug(source.slug);
      if (effectiveKind !== 'raw') {
        throw new KbError(`Source "${sourceId}" is not a raw note`, 'invalid');
      }
      sources.push(source);
    }
    return sources;
  }

  // ── Walk ────────────────────────────────────────────────────────────────

  /**
   * Memory-palace navigation primitive: list a folder's `_index.md`,
   * its direct child notes, and its direct subfolders.
   *
   * `path` is relative to the KB root. Use `''` (or `'/'`) for the root.
   * Throws KbError on path traversal; returns an empty result for a missing
   * folder.
   */
  async walk(relPath: string, opts?: { includeHidden?: boolean }): Promise<KbWalkResult> {
    await this.ensureBootstrapped();
    const norm = this.normalizeRelDir(relPath);
    const absDir = norm === '' ? path.resolve(this.rootDir) : this.resolveSafe(norm);

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return { index: null, children: [], folders: [], path: norm, parent: this.parentOf(norm) };
    }

    let indexNote: KbNote | null = null;
    const childNotes: KbNote[] = [];
    const folders: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        // The `_sources/` subfolder convention pairs raw sources with the
        // wiki page that cites them. By default the room view should not
        // show it — but only when ALL of its child notes are still flagged
        // hidden. The frontmatter is the source of truth: if the user has
        // manually cleared `hidden: true` on any note inside, the folder
        // should appear so they can navigate to it. `includeHidden: true`
        // always surfaces the folder regardless.
        if (entry.name === '_sources' && !opts?.includeHidden) {
          const hasVisibleChild = await this.folderHasVisibleNote(path.join(absDir, entry.name));
          if (!hasVisibleChild) continue;
        }
        folders.push(entry.name);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const slug = entry.name.slice(0, -3);
      try {
        const raw = await fs.readFile(path.join(absDir, entry.name), 'utf-8');
        const note = this.parseNoteFile(raw, norm, slug);
        if (!note) continue;
        if (slug === '_index') {
          indexNote = note;
        } else {
          childNotes.push(note);
        }
      } catch { /* skip unreadable */ }
    }

    // Default: filter out child notes flagged hidden. The frontmatter is the
    // source of truth — the `_sources/` folder convention is just navigation
    // sugar. A user who manually marks a non-`_sources` note hidden gets the
    // same filtering, and a user who clears `hidden: true` on a note inside
    // `_sources/` will see it again next walk.
    const visibleChildren = opts?.includeHidden
      ? childNotes
      : childNotes.filter((n) => n.hidden !== true);

    // Stable order: title asc, then slug asc.
    visibleChildren.sort((a, b) => {
      const t = a.title.localeCompare(b.title);
      return t !== 0 ? t : a.slug.localeCompare(b.slug);
    });
    folders.sort((a, b) => a.localeCompare(b));

    return {
      index: indexNote,
      children: visibleChildren.map((n) => this.toSummary(n)),
      folders,
      path: norm,
      parent: this.parentOf(norm),
    };
  }

  private parentOf(relPath: string): string | undefined {
    if (relPath === '') return undefined;
    const idx = relPath.lastIndexOf('/');
    if (idx === -1) return '';
    return relPath.slice(0, idx);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /**
   * Naive scored substring search.
   * Weights: title +5, tag +3, path +2, body +1 per occurrence (cap 5).
   * Tie-breaker: updatedAt desc.
   *
   * Hidden notes (`hidden: true` frontmatter — typically wiki source provenance
   * tucked under `<wikiPath>/_sources/`) are filtered out by default. Pass
   * `includeHidden: true` to surface them in the result set.
   */
  async search(query: string, opts?: { path?: string; limit?: number; includeHidden?: boolean }): Promise<KbSearchHit[]> {
    await this.ensureBootstrapped();
    const q = query.trim().toLowerCase();
    if (q === '') return [];

    const pathFilter = opts?.path ? this.normalizeRelDir(opts.path) : null;
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 25;
    const includeHidden = opts?.includeHidden === true;

    // For body matches we need the full notes, not just summaries — walk the disk.
    const all = await this.walkAllNotes(this.rootDir, '');
    const hits: KbSearchHit[] = [];

    for (const note of all) {
      if (pathFilter !== null) {
        if (note.path !== pathFilter && !note.path.startsWith(pathFilter + '/')) continue;
      }
      if (!includeHidden && note.hidden === true) continue;
      const score = this.scoreNote(note, q);
      if (score <= 0) continue;
      hits.push({
        note: this.toSummary(note),
        snippet: this.buildSnippet(note.body, q),
        score,
      });
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.note.updatedAt !== b.note.updatedAt) {
        return a.note.updatedAt < b.note.updatedAt ? 1 : -1;
      }
      // Final deterministic tie-breaker so search ranking does not depend on
      // walk order when score and updatedAt are both equal.
      return a.note.id.localeCompare(b.note.id);
    });
    return hits.slice(0, limit);
  }

  /** Compute the v1 search score for a note against a lowercased query. */
  private scoreNote(note: KbNote, q: string): number {
    let score = 0;
    if (note.title.toLowerCase().includes(q)) score += 5;
    if (note.tags.some((t) => t.toLowerCase().includes(q))) score += 3;
    if (note.path.toLowerCase().includes(q)) score += 2;

    // Body substring matches: +1 per occurrence, capped at 5.
    const body = note.body.toLowerCase();
    let count = 0;
    let from = 0;
    while (count < 5) {
      const idx = body.indexOf(q, from);
      if (idx === -1) break;
      count++;
      from = idx + q.length;
    }
    score += count;
    return score;
  }

  /** Build a short snippet around the first body match (or fall back to head). */
  private buildSnippet(body: string, q: string): string {
    const lower = body.toLowerCase();
    const idx = lower.indexOf(q);
    const WINDOW = 80;
    if (idx === -1) {
      return body.slice(0, WINDOW * 2).replace(/\s+/g, ' ').trim();
    }
    const start = Math.max(0, idx - WINDOW);
    const end = Math.min(body.length, idx + q.length + WINDOW);
    let snippet = body.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < body.length) snippet = snippet + '…';
    return snippet;
  }

  /**
   * Remove a note by id or path. Guarded for raw sources with non-empty
   * `consumedBy[]` — callers must pass `{ cascade: true }` to opt into removing
   * a raw source that wiki pages still cite. With cascade, the dependent wiki
   * pages have the removed source id stripped from their `sourceRefs[]` and
   * are marked `buildStatus: stale` so the next build run regenerates them.
   *
   * Without cascade, trying to remove a raw source with consumers throws a
   * `KbError('cascade_required', ...)` which the router maps to a 409 so the
   * caller can re-issue with the flag.
   */
  async remove(idOrPath: string, opts?: { cascade?: boolean }): Promise<boolean> {
    await this.ensureBootstrapped();
    const existing = await this.get(idOrPath);
    if (!existing) return false;

    // Delete-cascade guard for raw sources with wiki consumers.
    const effectiveKind = existing.kind ?? defaultKindForSlug(existing.slug);
    if (effectiveKind === 'raw' && existing.consumedBy && existing.consumedBy.length > 0) {
      if (!opts?.cascade) {
        throw new KbError(
          `Cannot delete raw source ${existing.id}: ${existing.consumedBy.length} wiki page(s) still cite it. ` +
            `Re-invoke with cascade: true to strip the citations and mark dependent wikis stale.`,
          'cascade_required',
        );
      }
      // Cascade: for each dependent wiki, strip the removed id from
      // sourceRefs and mark buildStatus: 'stale'.
      for (const wikiId of existing.consumedBy) {
        const wiki = await this.getById(wikiId);
        if (!wiki) continue;
        const nextRefs = (wiki.sourceRefs ?? []).filter((id) => id !== existing.id);
        await this.withLock(`note:${wiki.id}`, async () => {
          const fresh = await this.getById(wiki.id);
          if (!fresh) return;
          const merged: KbNote = {
            ...fresh,
            sourceRefs: nextRefs,
            buildStatus: 'stale',
            updatedAt: new Date().toISOString(),
          };
          const file = path.join(this.resolveSafe(fresh.path), `${fresh.slug}.md`);
          await this.writeNoteFile(file, merged);
          this.upsertIndex(merged);
        });
      }
    }

    return this.withLock(`note:${existing.id}`, async () => {
      const file = path.join(this.resolveSafe(existing.path), `${existing.slug}.md`);
      try {
        await fs.unlink(file);
      } catch {
        return false;
      }
      this.removeFromIndex(existing.id);
      await this.appendActivity({ ts: new Date().toISOString(), op: 'remove', id: existing.id, path: existing.path, source: existing.source });
      return true;
    });
  }

  /**
   * Unconditional remove — bypasses the delete-cascade guard. Used by the
   * builder's revert path to delete wiki files that were created by a build
   * run being reverted (wikis have no `consumedBy` check to worry about).
   */
  async removeRaw(idOrPath: string): Promise<boolean> {
    await this.ensureBootstrapped();
    const existing = await this.get(idOrPath);
    if (!existing) return false;
    return this.withLock(`note:${existing.id}`, async () => {
      const file = path.join(this.resolveSafe(existing.path), `${existing.slug}.md`);
      try {
        await fs.unlink(file);
      } catch {
        return false;
      }
      this.removeFromIndex(existing.id);
      await this.appendActivity({ ts: new Date().toISOString(), op: 'remove', id: existing.id, path: existing.path, source: existing.source });
      return true;
    });
  }

  /**
   * Delete a folder under the KB root.
   *
   * Default behavior is empty-only: if the folder contains any files or
   * subfolders, the call rejects with `KbError('not empty', 'invalid')`. This
   * matches the user-facing UX of "remove this stray empty room" without
   * accidentally nuking content.
   *
   * Pass `{ recursive: true }` to force-delete a populated folder. The
   * recursive path is **cascade-aware**:
   *
   *   - Any raw source in the deletion tree whose `consumedBy[]` points at a
   *     wiki **outside** the tree is treated as a cascade dependency. The
   *     call rejects with `KbError('cascade_required')` (mapped to HTTP 409)
   *     unless `cascade: true` is also passed.
   *   - With `cascade: true`, the implementation strips the deleted source
   *     ids from each external wiki's `sourceRefs` and marks those wikis
   *     `buildStatus: 'stale'` (mirroring the existing single-note `remove`
   *     cascade logic).
   *   - For wikis being deleted, the implementation **always** strips the
   *     deleted wiki id from each cited external source's `consumedBy[]` —
   *     no cascade flag needed because the action is purely cleanup of
   *     reverse references and never destroys content the caller hasn't
   *     already approved deletion for.
   *
   * Protected paths that always reject:
   *   - the KB root itself (empty path)
   *   - top-level `inbox` and `notes` (would destroy the KB structure)
   *
   * Returns `true` if the folder existed and was removed, `false` if the
   * path did not resolve to an existing directory.
   */
  async removeFolder(relPath: string, opts?: { recursive?: boolean; cascade?: boolean }): Promise<boolean> {
    await this.ensureBootstrapped();
    const norm = this.normalizeRelDir(relPath);
    if (norm === '') {
      throw new KbError('Cannot remove the KB root', 'invalid');
    }
    if (norm === KB_INBOX_DIR || norm === KB_NOTES_DIR) {
      throw new KbError(`Cannot remove protected top-level folder "${norm}"`, 'invalid');
    }
    const absDir = this.resolveSafe(norm);

    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(absDir);
    } catch {
      return false;
    }
    if (!stat.isDirectory()) {
      throw new KbError(`Path "${relPath}" is not a directory`, 'invalid');
    }

    return this.withLock(`folder:${norm}`, async () => {
      const entries = await fs.readdir(absDir);
      // Hidden dotfiles (e.g. .DS_Store) do not count toward "non-empty" —
      // they would block the empty check on macOS for no good reason. Filter
      // them out the same way `walk()` does.
      const visibleEntries = entries.filter((name) => !name.startsWith('.'));
      if (visibleEntries.length > 0 && !opts?.recursive) {
        throw new KbError(
          `Folder "${norm}" is not empty (${visibleEntries.length} entr${visibleEntries.length === 1 ? 'y' : 'ies'}). Re-invoke with recursive: true to force-delete the folder and all its contents.`,
          'invalid',
        );
      }

      if (!opts?.recursive) {
        // Empty-only fast path: just rmdir and we're done.
        try {
          await fs.rmdir(absDir);
        } catch (err) {
          throw new KbError(
            `Failed to remove folder "${norm}": ${err instanceof Error ? err.message : String(err)}`,
            'invalid',
          );
        }
        await this.appendActivity({
          ts: new Date().toISOString(),
          op: 'remove_folder',
          path: norm,
        });
        return true;
      }

      // ── Cascade-aware recursive path ───────────────────────────────────
      //
      // Phase 1: walk the tree and collect every note inside, with full
      // frontmatter parsed so we can inspect `consumedBy[]` and `sourceRefs[]`.
      const treeNotes: KbNote[] = [];
      await this.collectNotes(absDir, treeNotes);
      const treeIds = new Set(treeNotes.map((n) => n.id));

      // Phase 2: classify reverse-index dependencies.
      //   - rawSourceExternalConsumers: raw sources in the tree whose
      //     consumers (wikis citing them) live OUTSIDE the tree. These are
      //     the cascade-gated dependencies; without `cascade: true` we
      //     refuse the delete.
      //   - wikiExternalSources: wikis in the tree whose cited sources live
      //     OUTSIDE the tree. These external sources need their `consumedBy[]`
      //     cleaned up after the wiki is deleted; this is non-gated cleanup.
      const rawSourceExternalConsumers: Array<{ source: KbNote; externalWikiIds: string[] }> = [];
      const wikiExternalSources: Array<{ wiki: KbNote; externalSourceIds: string[] }> = [];
      for (const note of treeNotes) {
        const effectiveKind = note.kind ?? defaultKindForSlug(note.slug);
        if (effectiveKind === 'raw' && note.consumedBy && note.consumedBy.length > 0) {
          const externalWikiIds = note.consumedBy.filter((wikiId) => !treeIds.has(wikiId));
          if (externalWikiIds.length > 0) {
            rawSourceExternalConsumers.push({ source: note, externalWikiIds });
          }
        }
        if (effectiveKind === 'wiki' && note.sourceRefs && note.sourceRefs.length > 0) {
          const externalSourceIds = note.sourceRefs.filter((srcId) => !treeIds.has(srcId));
          if (externalSourceIds.length > 0) {
            wikiExternalSources.push({ wiki: note, externalSourceIds });
          }
        }
      }

      // Phase 3: cascade gate for raw sources with external consumers.
      if (rawSourceExternalConsumers.length > 0 && opts?.cascade !== true) {
        const summary = rawSourceExternalConsumers
          .map((entry) => `${entry.source.id} (cited by ${entry.externalWikiIds.length} external wiki${entry.externalWikiIds.length === 1 ? '' : 's'})`)
          .join('; ');
        throw new KbError(
          `Cannot recursive-remove folder "${norm}": ${rawSourceExternalConsumers.length} raw source${rawSourceExternalConsumers.length === 1 ? '' : 's'} inside the tree are cited by wiki page(s) outside the tree: ${summary}. ` +
            `Re-invoke with cascade: true to strip the citations and mark the dependent wikis stale.`,
          'cascade_required',
        );
      }

      // Phase 4: apply cascade to external wikis whose sourceRefs[] include
      // raw sources from inside the tree. Strip the deleted source ids and
      // mark the wikis stale. This is the cascade-gated path; we only reach
      // it when `cascade: true` was passed.
      if (rawSourceExternalConsumers.length > 0) {
        // Build a map externalWikiId → set of source ids to strip.
        const stripFromWiki = new Map<string, Set<string>>();
        for (const entry of rawSourceExternalConsumers) {
          for (const wikiId of entry.externalWikiIds) {
            const set = stripFromWiki.get(wikiId) ?? new Set<string>();
            set.add(entry.source.id);
            stripFromWiki.set(wikiId, set);
          }
        }
        for (const [wikiId, srcsToStrip] of stripFromWiki) {
          const wiki = await this.getById(wikiId);
          if (!wiki) continue;
          const nextRefs = (wiki.sourceRefs ?? []).filter((id) => !srcsToStrip.has(id));
          await this.withLock(`note:${wiki.id}`, async () => {
            const fresh = await this.getById(wiki.id);
            if (!fresh) return;
            const merged: KbNote = {
              ...fresh,
              sourceRefs: nextRefs,
              buildStatus: 'stale',
              updatedAt: new Date().toISOString(),
            };
            const file = path.join(this.resolveSafe(fresh.path), `${fresh.slug}.md`);
            await this.writeNoteFile(file, merged);
            this.upsertIndex(merged);
          });
        }
      }

      // Phase 5: clean up external sources whose consumedBy[] includes
      // wikis from inside the tree. Always runs (no cascade gate) — this
      // is just removing dangling references to about-to-be-deleted wikis.
      if (wikiExternalSources.length > 0) {
        // Build a map externalSourceId → set of wiki ids to strip from consumedBy.
        const stripFromSource = new Map<string, Set<string>>();
        for (const entry of wikiExternalSources) {
          for (const srcId of entry.externalSourceIds) {
            const set = stripFromSource.get(srcId) ?? new Set<string>();
            set.add(entry.wiki.id);
            stripFromSource.set(srcId, set);
          }
        }
        for (const [srcId, wikisToStrip] of stripFromSource) {
          const src = await this.getById(srcId);
          if (!src || !src.consumedBy) continue;
          const nextConsumers = src.consumedBy.filter((id) => !wikisToStrip.has(id));
          if (nextConsumers.length !== src.consumedBy.length) {
            await this.updateConsumedBy(srcId, nextConsumers);
          }
        }
      }

      // Phase 6: rm the tree.
      try {
        await fs.rm(absDir, { recursive: true, force: true });
      } catch (err) {
        throw new KbError(
          `Failed to remove folder "${norm}": ${err instanceof Error ? err.message : String(err)}`,
          'invalid',
        );
      }

      // Phase 7: purge ids from the in-memory index.
      for (const note of treeNotes) {
        this.removeFromIndex(note.id);
      }

      await this.appendActivity({
        ts: new Date().toISOString(),
        op: 'remove_folder_recursive',
        path: norm,
      });
      return true;
    });
  }

  /**
   * Recursively scan a directory for any parseable markdown note whose
   * frontmatter does NOT have `hidden: true`. Used by `walk()` to decide
   * whether the `_sources/` subfolder convention should be hidden from the
   * default tree listing: if ANY note inside is currently visible (because
   * the user has manually cleared `hidden`), the folder is shown so the
   * note is reachable via the tree. Bounded depth in practice — `_sources/`
   * is normally one level deep with a small flat list of source files.
   */
  private async folderHasVisibleNote(absDir: string): Promise<boolean> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (await this.folderHasVisibleNote(childAbs)) return true;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const raw = await fs.readFile(childAbs, 'utf-8');
        const { data } = parseFrontmatter(raw);
        // hidden field is serialized as the literal string 'true'; absence
        // means visible. Anything other than 'true' is treated as visible.
        if (data.hidden !== 'true') return true;
      } catch { /* skip unreadable, treat as not-visible */ }
    }
    return false;
  }

  /**
   * Walk a directory tree under the KB root collecting every parseable
   * markdown note inside. Used by `removeFolder({ recursive: true })` for
   * the cascade-aware reverse-index analysis. Returns full `KbNote` objects
   * (not just ids) so the caller can inspect `consumedBy[]` and `sourceRefs[]`.
   * Best-effort: malformed files are skipped without throwing.
   */
  private async collectNotes(absDir: string, out: KbNote[]): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const relDir = this.relPathFromRoot(absDir);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.collectNotes(childAbs, out);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const raw = await fs.readFile(childAbs, 'utf-8');
        const slug = entry.name.slice(0, -3);
        const note = this.parseNoteFile(raw, relDir, slug);
        if (note && note.id.startsWith(KB_ID_PREFIX)) {
          out.push(note);
        }
      } catch { /* skip unreadable */ }
    }
  }

  /**
   * Move a raw source note from `inbox/` to a `_sources/` subfolder under
   * the wiki page that cites it, and mark it `hidden: true`. Used by the v2
   * wiki builder's commit path so each refined wiki page travels with its
   * provenance instead of leaving inbox cluttered.
   *
   * Guards:
   *   - The source must currently live under `inbox/` — manually-curated
   *     sources in `notes/foo/` are NOT moved (the user already chose where
   *     they belong).
   *   - The target wiki path must NOT itself be `inbox/...`.
   *   - If the source is already at the target `_sources/` location, the
   *     call is a no-op (returns null) — same source cited by a re-run of
   *     the same wiki shouldn't double-move.
   *
   * Atomicity: writes the new file with updated frontmatter (`hidden: true`,
   * new path, new slug), then unlinks the old file. If the unlink fails the
   * source exists in two places — the next index rebuild will find both and
   * the duplicate id is harmless because both files have the same id (the
   * caller's reverse-index walk will reconcile via `getById`).
   *
   * Returns the from/to record so the caller can persist it for `revert`,
   * or `null` if the move was skipped (not an inbox source / no-op).
   */
  async moveSourceToWikiFolder(
    sourceId: string,
    wikiPath: string,
  ): Promise<{ id: string; fromPath: string; fromSlug: string; toPath: string; toSlug: string } | null> {
    await this.ensureBootstrapped();
    const fresh = await this.getById(sourceId);
    if (!fresh) return null;

    // Only relocate inbox-resident sources. Manually-curated raw notes in
    // `notes/<room>/` stay where they are.
    const isInInbox = fresh.path === KB_INBOX_DIR || fresh.path.startsWith(`${KB_INBOX_DIR}/`);
    if (!isInInbox) return null;

    const targetWiki = this.normalizeRelDir(wikiPath);
    if (targetWiki === '' || targetWiki === KB_INBOX_DIR || targetWiki.startsWith(`${KB_INBOX_DIR}/`)) {
      // Refuse to move sources into inbox or the root.
      return null;
    }
    const targetSourcesPath = `${targetWiki}/_sources`;

    // No-op if the source already lives in the target _sources/ folder.
    if (fresh.path === targetSourcesPath) return null;

    return this.withLock(`note:${fresh.id}`, async () => {
      // Re-fetch under lock to avoid clobbering concurrent updates.
      const current = await this.getById(fresh.id);
      if (!current) return null;

      const stillInInbox = current.path === KB_INBOX_DIR || current.path.startsWith(`${KB_INBOX_DIR}/`);
      if (!stillInInbox) return null;

      const targetDirAbs = this.resolveSafe(targetSourcesPath);
      await fs.mkdir(targetDirAbs, { recursive: true });
      const finalSlug = await this.findFreeSlug(targetDirAbs, current.slug, current.id);
      const newFile = path.join(targetDirAbs, `${finalSlug}.md`);
      const oldFile = path.join(this.resolveSafe(current.path), `${current.slug}.md`);

      const merged: KbNote = {
        ...current,
        path: targetSourcesPath,
        slug: finalSlug,
        hidden: true,
        updatedAt: new Date().toISOString(),
      };

      await this.writeNoteFile(newFile, merged);
      if (path.resolve(newFile) !== path.resolve(oldFile)) {
        try { await fs.unlink(oldFile); } catch { /* tolerate stale handles */ }
      }

      this.upsertIndex(merged);
      await this.appendActivity({
        ts: merged.updatedAt,
        op: 'move_source_to_wiki',
        id: merged.id,
        path: merged.path,
        source: merged.source,
      });

      return {
        id: current.id,
        fromPath: current.path,
        fromSlug: current.slug,
        toPath: targetSourcesPath,
        toSlug: finalSlug,
      };
    });
  }

  /**
   * Reverse `moveSourceToWikiFolder`: move a source note from a wiki's
   * `_sources/` folder back to its original inbox path, and clear the
   * `hidden` flag. Used by `build_revert` so reverted runs unwind cleanly.
   *
   * Guards:
   *   - The source must currently live under the recorded `fromPath` parent
   *     wiki's `_sources/` folder. If it has been moved elsewhere by hand,
   *     we leave it alone and return null.
   *   - If the target inbox path no longer exists, mkdir -p before writing.
   */
  async restoreSourceFromWikiFolder(
    sourceId: string,
    fromPath: string,
    fromSlug: string,
  ): Promise<{ id: string; restoredPath: string; restoredSlug: string } | null> {
    await this.ensureBootstrapped();
    const fresh = await this.getById(sourceId);
    if (!fresh) return null;

    // Only restore notes that currently live in some `_sources/` folder.
    const isInSourcesFolder = fresh.path === '_sources' || fresh.path.endsWith('/_sources');
    if (!isInSourcesFolder) return null;

    const targetPath = this.normalizeRelDir(fromPath);
    return this.withLock(`note:${fresh.id}`, async () => {
      const current = await this.getById(fresh.id);
      if (!current) return null;

      const stillInSources = current.path === '_sources' || current.path.endsWith('/_sources');
      if (!stillInSources) return null;

      const targetDirAbs = this.resolveSafe(targetPath);
      await fs.mkdir(targetDirAbs, { recursive: true });
      const finalSlug = await this.findFreeSlug(targetDirAbs, fromSlug, current.id);
      const newFile = path.join(targetDirAbs, `${finalSlug}.md`);
      const oldFile = path.join(this.resolveSafe(current.path), `${current.slug}.md`);

      const merged: KbNote = {
        ...current,
        path: targetPath,
        slug: finalSlug,
        hidden: false,
        updatedAt: new Date().toISOString(),
      };
      // Strip the hidden flag from the merged record so writeNoteFile drops
      // the field entirely (rather than emitting `hidden: false`).
      delete merged.hidden;

      await this.writeNoteFile(newFile, merged);
      if (path.resolve(newFile) !== path.resolve(oldFile)) {
        try { await fs.unlink(oldFile); } catch { /* tolerate stale handles */ }
      }

      this.upsertIndex(merged);
      await this.appendActivity({
        ts: merged.updatedAt,
        op: 'restore_source_from_wiki',
        id: merged.id,
        path: merged.path,
        source: merged.source,
      });

      return { id: current.id, restoredPath: targetPath, restoredSlug: finalSlug };
    });
  }

  // ── KB v2 builder helpers ──────────────────────────────────────────────

  /**
   * v2: update a raw note's `consumedBy[]` reverse index in place. Used by
   * the builder's commit stage to record which wiki pages cite each source,
   * and by revert to strip those entries back out.
   */
  async updateConsumedBy(sourceId: string, consumedBy: string[]): Promise<void> {
    await this.ensureBootstrapped();
    return this.withLock(`note:${sourceId}`, async () => {
      const fresh = await this.getById(sourceId);
      if (!fresh) return;
      const merged: KbNote = { ...fresh, consumedBy: [...new Set(consumedBy)], updatedAt: new Date().toISOString() };
      const file = path.join(this.resolveSafe(fresh.path), `${fresh.slug}.md`);
      await this.writeNoteFile(file, merged);
      this.upsertIndex(merged);
    });
  }

  /**
   * v2: write a prepared KbNote to a specific staging file path. Used by the
   * builder's commit stage to materialize proposals before the atomic move
   * into `notes/`. Does NOT update the index — the final move does that.
   */
  async writeStagedNote(filePath: string, note: KbNote): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await this.writeNoteFile(filePath, note);
  }

  /**
   * v2: write a wiki note directly to its final path (used by revert to
   * restore a previous-body snapshot). Updates the index cache so subsequent
   * reads see the restored state.
   */
  async writeWikiDirect(note: KbNote): Promise<void> {
    await this.ensureBootstrapped();
    const targetDir = path.join(this.resolveSafe(note.path));
    await fs.mkdir(targetDir, { recursive: true });
    const file = path.join(targetDir, `${note.slug}.md`);
    await this.writeNoteFile(file, note);
    this.upsertIndex(note);
  }

  /**
   * v2: re-read a note from disk and upsert the index entry. Used by the
   * builder's commit stage after the atomic move from staging so `get(id)`
   * immediately reflects the committed file.
   */
  async syncNoteFromDisk(id: string, relPath: string, slug: string): Promise<void> {
    const fresh = await this.readNoteAt(relPath, slug);
    if (fresh && fresh.id === id) {
      this.upsertIndex(fresh);
    } else {
      // The id in frontmatter might differ if the slug collided — re-scan.
      this.indexCache = null;
    }
  }

  /**
   * v2: append a builder-specific activity entry with the new Phase 3 op
   * vocabulary. Separate from the v1 `appendActivity` helper because the
   * payload shape is richer (runId, wikiId, sourceRefs, etc.).
   */
  async appendBuilderActivity(entry: {
    ts: string;
    op: 'build_plan' | 'build_commit' | 'build_revert' | 'rebuild' | 'stale';
    runId: string;
    wikiId?: string;
    sourceRefs?: string[];
    isCreate?: boolean;
    reverted?: string[];
  }): Promise<void> {
    const file = path.join(this.rootDir, KB_ACTIVITY_FILE);
    try {
      await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* non-fatal */ }
  }

  // ── Index lifecycle ─────────────────────────────────────────────────────

  /** Walk the entire KB tree and rebuild the in-memory + on-disk index. */
  async rebuildIndex(): Promise<KbIndex> {
    await this.ensureBootstrapped();
    const notes: Record<string, KbNoteSummary> = {};
    const all = await this.walkAllNotes(this.rootDir, '');
    for (const note of all) {
      notes[note.id] = this.toSummary(note);
    }
    const index: KbIndex = {
      version: KB_INDEX_VERSION,
      builtAt: new Date().toISOString(),
      notes,
    };
    this.indexCache = index;
    await this.flushIndex(index);
    return index;
  }

  /** Load index from disk if present, otherwise rebuild from disk. */
  async loadIndex(): Promise<KbIndex> {
    await this.ensureBootstrapped();
    if (this.indexCache) return this.indexCache;
    const indexPath = path.join(this.rootDir, KB_INDEX_FILE);
    try {
      const raw = await fs.readFile(indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as KbIndex;
      if (parsed && parsed.version === KB_INDEX_VERSION && parsed.notes) {
        this.indexCache = parsed;
        return parsed;
      }
    } catch {
      // fall through to rebuild
    }
    return this.rebuildIndex();
  }

  private async ensureIndex(): Promise<KbIndex> {
    if (this.indexCache) return this.indexCache;
    return this.loadIndex();
  }

  private upsertIndex(note: KbNote): void {
    if (!this.indexCache) return;
    this.indexCache.notes[note.id] = this.toSummary(note);
    this.indexCache.builtAt = new Date().toISOString();
    void this.flushIndex(this.indexCache);
  }

  private removeFromIndex(id: string): void {
    if (!this.indexCache) return;
    delete this.indexCache.notes[id];
    this.indexCache.builtAt = new Date().toISOString();
    void this.flushIndex(this.indexCache);
  }

  private async flushIndex(index: KbIndex): Promise<void> {
    const indexPath = path.join(this.rootDir, KB_INDEX_FILE);
    try {
      await this.writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
    } catch {
      // Index is a cache; failures here are non-fatal.
    }
  }

  // ── Internal lookups ────────────────────────────────────────────────────

  private async getById(id: string): Promise<KbNote | null> {
    const index = await this.ensureIndex();
    const summary = index.notes[id];
    if (summary) {
      const direct = await this.readNoteAt(summary.path, summary.slug);
      if (direct) return direct;
      // The indexed path was stale (file moved/renamed on disk by hand). The
      // index is a cache and disk wins, so fall through to a full walk and
      // re-sync the index from whatever we find.
    }
    const all = await this.walkAllNotes(this.rootDir, '');
    const found = all.find((n) => n.id === id);
    if (!found) {
      // Note has truly been removed from disk — drop it from the cache too.
      if (summary) this.removeFromIndex(id);
      return null;
    }
    // Re-sync the index entry to whatever the disk currently says.
    this.upsertIndex(found);
    return found;
  }

  private async getByPath(rel: string): Promise<KbNote | null> {
    // Normalize: strip leading/trailing slashes and `.md` extension.
    let cleaned = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (cleaned.endsWith('.md')) cleaned = cleaned.slice(0, -3);
    const lastSlash = cleaned.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : cleaned.slice(0, lastSlash);
    const slug = lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
    if (!slug) return null;
    return this.readNoteAt(dir, slug);
  }

  private async readNoteAt(relDir: string, slug: string): Promise<KbNote | null> {
    const dir = relDir === '' ? this.rootDir : this.resolveSafe(relDir);
    const file = path.join(dir, `${slug}.md`);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      return this.parseNoteFile(raw, this.relPathFromRoot(dir), slug);
    } catch {
      return null;
    }
  }

  // ── Walking + parsing ───────────────────────────────────────────────────

  private async walkAllNotes(dir: string, relDir: string): Promise<KbNote[]> {
    const results: KbNote[] = [];
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // v2: never descend into the builder's audit/staging directory. It
      // lives inside the KB root but its files are NOT content notes —
      // picking them up would make `store.get(wikiId)` return staging-bound
      // proposals and break the commit path's "is this a new wiki?" check.
      if (relDir === '' && entry.name === 'build-runs') continue;
      const full = path.join(dir, entry.name);
      const relSub = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...(await this.walkAllNotes(full, relSub)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const raw = await fs.readFile(full, 'utf-8');
          const slug = entry.name.slice(0, -3);
          const note = this.parseNoteFile(raw, relDir, slug);
          if (note) results.push(note);
        } catch { /* skip unreadable */ }
      }
    }
    return results;
  }

  /**
   * Parse a markdown file's frontmatter into a KbNote.
   * Disk wins: the on-disk path/slug always overrides any frontmatter values
   * for `path` and `slug`, so renames don't desync the index.
   *
   * v2 additions (all optional; v1 notes parse unchanged):
   *   - `kind` (defaults via defaultKindForSlug)
   *   - `sourceRefs`, `consumedBy` (string arrays)
   *   - `compiledAt`, `compiledBy`, `promptVersion`, `buildStatus`, `manualEditsAfter`, `lastComposedBodyHash` (scalars)
   *   - `lastSourceHashes` (JSON-encoded object string)
   */
  private parseNoteFile(raw: string, relDir: string, slug: string): KbNote | null {
    const { data, body } = parseFrontmatter(raw);
    const id = typeof data.id === 'string' ? data.id : null;
    const title = typeof data.title === 'string' ? data.title : slug;
    const v2 = this.extractV2Fields(data, slug);
    if (!id) {
      // A markdown file without an id is treated as a rogue/manual file —
      // surface it with a synthetic id so it still appears in listings.
      return {
        id: `${KB_ID_PREFIX}orphan_${this.hashPath(`${relDir}/${slug}`)}`,
        title,
        slug,
        path: relDir,
        tags: this.coerceTags(data.tags),
        source: typeof data.source === 'string' ? data.source : 'manual',
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date(0).toISOString(),
        body,
        ...v2,
      };
    }
    return {
      id,
      title,
      slug,
      path: relDir,
      tags: this.coerceTags(data.tags),
      source: typeof data.source === 'string' ? data.source : undefined,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
      body,
      ...v2,
    };
  }

  /**
   * v2: extract KB v2 frontmatter fields from a parsed frontmatter record.
   * Applies the `kind` default (`_index` → `index`, else `raw`) and tolerates
   * missing/invalid values by omitting the field rather than throwing.
   */
  private extractV2Fields(
    data: Record<string, string | string[]>,
    slug: string,
  ): Partial<KbNote> {
    const out: Partial<KbNote> = {};
    // kind: accept only valid values; fall back to the slug-driven default.
    const rawKind = typeof data.kind === 'string' ? data.kind : undefined;
    out.kind = (VALID_KINDS as readonly string[]).includes(rawKind ?? '')
      ? (rawKind as KbNoteKind)
      : defaultKindForSlug(slug);

    if (Array.isArray(data.sourceRefs)) out.sourceRefs = [...data.sourceRefs];
    else if (typeof data.sourceRefs === 'string' && data.sourceRefs !== '') {
      out.sourceRefs = [data.sourceRefs];
    }
    if (Array.isArray(data.consumedBy)) out.consumedBy = [...data.consumedBy];
    else if (typeof data.consumedBy === 'string' && data.consumedBy !== '') {
      out.consumedBy = [data.consumedBy];
    }

    if (typeof data.compiledAt === 'string' && data.compiledAt !== '') out.compiledAt = data.compiledAt;
    if (typeof data.compiledBy === 'string' && data.compiledBy !== '') out.compiledBy = data.compiledBy;
    if (typeof data.promptVersion === 'string' && data.promptVersion !== '') out.promptVersion = data.promptVersion;
    if (typeof data.manualEditsAfter === 'string' && data.manualEditsAfter !== '') {
      out.manualEditsAfter = data.manualEditsAfter;
    }
    if (typeof data.lastComposedBodyHash === 'string' && data.lastComposedBodyHash !== '') {
      out.lastComposedBodyHash = data.lastComposedBodyHash;
    }

    const rawStatus = typeof data.buildStatus === 'string' ? data.buildStatus : undefined;
    if ((VALID_BUILD_STATUSES as readonly string[]).includes(rawStatus ?? '')) {
      out.buildStatus = rawStatus as KbBuildStatus;
    }

    // hidden: tree-visibility hint. The frontmatter parser returns scalars
    // as strings; we accept the literal `'true'` (and only that) so absent /
    // misspelled values silently default to "visible". The writer only ever
    // emits this field when explicitly set, keeping non-hidden notes clean.
    if (typeof data.hidden === 'string' && data.hidden === 'true') {
      out.hidden = true;
    }

    // lastSourceHashes is serialized as a JSON-encoded object string so the
    // existing flat scalar frontmatter parser can round-trip it. Tolerate both
    // a JSON string and a malformed entry (drop it).
    if (typeof data.lastSourceHashes === 'string' && data.lastSourceHashes !== '') {
      try {
        const parsed = JSON.parse(data.lastSourceHashes) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string') clean[k] = v;
          }
          if (Object.keys(clean).length > 0) out.lastSourceHashes = clean;
        }
      } catch {
        // Malformed JSON — drop the field, treating the wiki as having no
        // recorded hashes. `isWikiStale` will flag it for rebuild.
      }
    }

    return out;
  }

  private coerceTags(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value !== '') return [value];
    return [];
  }

  // ── File I/O ────────────────────────────────────────────────────────────

  private async writeNoteFile(file: string, note: KbNote): Promise<void> {
    const data: Record<string, string | string[] | undefined> = {
      id: note.id,
      title: note.title,
      slug: note.slug,
      path: note.path,
      tags: note.tags,
      source: note.source,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };

    // v2: only persist fields that are explicitly set to keep v1 notes clean
    // and make the v1 → v2 lazy upgrade path a no-op for raw notes.
    if (note.kind !== undefined) data.kind = note.kind;
    if (note.sourceRefs !== undefined && note.sourceRefs.length > 0) data.sourceRefs = note.sourceRefs;
    if (note.consumedBy !== undefined && note.consumedBy.length > 0) data.consumedBy = note.consumedBy;
    if (note.compiledAt !== undefined) data.compiledAt = note.compiledAt;
    if (note.compiledBy !== undefined) data.compiledBy = note.compiledBy;
    if (note.promptVersion !== undefined) data.promptVersion = note.promptVersion;
    if (note.buildStatus !== undefined) data.buildStatus = note.buildStatus;
    if (note.manualEditsAfter !== undefined) data.manualEditsAfter = note.manualEditsAfter;
    if (note.lastComposedBodyHash !== undefined && note.lastComposedBodyHash !== '') {
      data.lastComposedBodyHash = note.lastComposedBodyHash;
    }
    if (note.lastSourceHashes !== undefined && Object.keys(note.lastSourceHashes).length > 0) {
      // Serialize as a JSON-encoded string so the flat frontmatter parser can
      // round-trip it. The parser's `formatScalar` quotes any value starting
      // with `{`, so `JSON.stringify` + the parser's auto-quoting gives us a
      // reversible round trip.
      data.lastSourceHashes = JSON.stringify(note.lastSourceHashes);
    }
    // hidden: only emit when explicitly true so non-hidden notes don't gain
    // a noisy frontmatter line. The reader treats absent === false.
    if (note.hidden === true) {
      data.hidden = 'true';
    }

    const content = serializeFrontmatter(data, note.body);
    await this.writeFileAtomic(file, content);
  }

  private async writeFileAtomic(file: string, content: string): Promise<void> {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, file);
  }

  private async appendActivity(entry: { ts: string; op: string; id?: string; path: string; source?: string }): Promise<void> {
    const file = path.join(this.rootDir, KB_ACTIVITY_FILE);
    try {
      await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* non-fatal */ }
  }

  // ── Path safety ─────────────────────────────────────────────────────────

  /** Normalize a relative directory path: forward slashes, no trailing slash, no leading slash. */
  private normalizeRelDir(rel: string): string {
    const cleaned = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (cleaned === '' || cleaned === '.') return '';
    if (cleaned.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
      throw new KbError(`Invalid path: ${rel}`, 'traversal');
    }
    if (/[\0]/.test(cleaned)) {
      throw new KbError('Path contains null byte', 'traversal');
    }
    return cleaned;
  }

  /** Resolve a relative directory under the KB root with a traversal guard. */
  private resolveSafe(relDir: string): string {
    const norm = this.normalizeRelDir(relDir);
    const root = path.resolve(this.rootDir);
    const full = path.resolve(root, norm);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new KbError(`Path escapes KB root: ${relDir}`, 'traversal');
    }
    return full;
  }

  private relPathFromRoot(absDir: string): string {
    const root = path.resolve(this.rootDir);
    const abs = path.resolve(absDir);
    if (abs === root) return '';
    const rel = path.relative(root, abs);
    return rel.split(path.sep).join('/');
  }

  // ── Naming + IDs ────────────────────────────────────────────────────────

  private looksLikeId(s: string): boolean {
    return s.startsWith(KB_ID_PREFIX);
  }

  private generateId(): string {
    return `${KB_ID_PREFIX}${createId()}`;
  }

  /**
   * Convert a title to a filesystem-safe slug.
   * - lowercase
   * - keep `[a-z0-9_]`; collapse other runs to `-`
   * - trim leading/trailing hyphens (underscores are preserved so the
   *   `_index` convention for folder readmes survives explicit slugs)
   * - fall back to `note` if the result is empty
   */
  private slugify(value: string): string {
    const base = value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base === '' ? 'note' : base.slice(0, 80);
  }

  /**
   * Find a slug that doesn't collide in `dir`. If `<base>.md` exists, try
   * `<base>-2.md`, `<base>-3.md`, ... up to 999. `excludeId` skips collisions
   * against a note with that id (used by update so a note can keep its slug).
   */
  private async findFreeSlug(dir: string, base: string, excludeId?: string): Promise<string> {
    for (let n = 1; n <= 999; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const file = path.join(dir, `${candidate}.md`);
      if (!(await this.fileExists(file))) return candidate;
      if (excludeId) {
        try {
          const raw = await fs.readFile(file, 'utf-8');
          const { data } = parseFrontmatter(raw);
          if (typeof data.id === 'string' && data.id === excludeId) {
            return candidate; // same note keeping its slug — not a collision
          }
        } catch { /* fall through */ }
      }
    }
    throw new KbError(`Slug collision unresolvable for "${base}"`, 'collision');
  }

  private async fileExists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  /** Cheap deterministic hash for orphan IDs. */
  private hashPath(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
  }

  // ── Locking ─────────────────────────────────────────────────────────────

  private async withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.writeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.writeLocks.set(key, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  // ── Summaries ───────────────────────────────────────────────────────────

  private toSummary(note: KbNote): KbNoteSummary {
    const s: KbNoteSummary = {
      id: note.id,
      title: note.title,
      slug: note.slug,
      path: note.path,
      tags: note.tags,
      source: note.source,
      updatedAt: note.updatedAt,
    };
    if (note.kind !== undefined) s.kind = note.kind;
    if (note.buildStatus !== undefined) s.buildStatus = note.buildStatus;
    if (note.hidden === true) s.hidden = true;
    return s;
  }

  // ── v2: kind + provenance query helpers ─────────────────────────────────

  /**
   * v2: list notes filtered by `kind` (raw | wiki | index).
   *
   * Uses the index cache for speed; the index stores `kind` so this is a
   * simple filter over the cached summaries. Notes without an explicit
   * `kind` in frontmatter get the slug-driven default on read.
   */
  async getByKind(kind: KbNoteKind): Promise<KbNoteSummary[]> {
    await this.ensureBootstrapped();
    const index = await this.ensureIndex();
    const all = Object.values(index.notes);
    return all
      .filter((s) => (s.kind ?? defaultKindForSlug(s.slug)) === kind)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * v2: resolve a wiki page's cited raw sources. Reads the wiki, then walks
   * its `sourceRefs[]` and fetches each by id. Missing sources are silently
   * dropped — callers can detect drops via `isWikiStale()`, which also
   * flags them.
   */
  async traceSources(wikiId: string): Promise<KbNote[]> {
    await this.ensureBootstrapped();
    const wiki = await this.getById(wikiId);
    if (!wiki || !wiki.sourceRefs || wiki.sourceRefs.length === 0) return [];
    const out: KbNote[] = [];
    for (const srcId of wiki.sourceRefs) {
      const src = await this.getById(srcId);
      if (src) out.push(src);
    }
    return out;
  }

  /**
   * v2: reverse lookup. Given a raw source id, return the wiki pages that
   * cite it. Uses the raw note's `consumedBy[]` reverse index (maintained
   * by the builder's commit step); falls back to a walk + filter if the
   * index is missing.
   */
  async traceDerivatives(sourceId: string): Promise<KbNote[]> {
    await this.ensureBootstrapped();
    const source = await this.getById(sourceId);
    if (!source) return [];
    if (source.consumedBy && source.consumedBy.length > 0) {
      const out: KbNote[] = [];
      for (const wikiId of source.consumedBy) {
        const wiki = await this.getById(wikiId);
        if (wiki) out.push(wiki);
      }
      return out;
    }
    // Fallback: walk all wiki notes and filter by sourceRefs membership.
    const all = await this.walkAllNotes(this.rootDir, '');
    return all.filter(
      (n) => (n.kind ?? defaultKindForSlug(n.slug)) === 'wiki' &&
             !!n.sourceRefs &&
             n.sourceRefs.includes(sourceId),
    );
  }

  /**
   * v2: compute the sha256 hash of a string body. Exposed for tests and for
   * the builder's commit stage to snapshot source bodies into `lastSourceHashes`.
   */
  static hashBody(body: string): string {
    return hashBody(body);
  }
}

/**
 * v2: pure predicate — is this wiki page out of date relative to its sources?
 *
 * Returns `true` when:
 *   - the note is not actually a wiki (defensive no-op → false)
 *   - it has no `lastSourceHashes` or `sourceRefs` recorded (malformed)
 *   - any cited source has been deleted
 *   - any cited source's body hash differs from the snapshot
 *
 * The `getSource` lookup is passed in so callers can supply an in-memory cache
 * or the live store. This keeps the function pure and trivially unit-testable.
 */
export function isWikiStale(
  wiki: KbNote,
  getSource: (id: string) => KbNote | null | undefined,
): boolean {
  if ((wiki.kind ?? defaultKindForSlug(wiki.slug)) !== 'wiki') return false;
  if (!wiki.sourceRefs || wiki.sourceRefs.length === 0) return true;
  if (!wiki.lastSourceHashes) return true;
  for (const srcId of wiki.sourceRefs) {
    const src = getSource(srcId);
    if (!src) return true; // source deleted → stale
    const current = KnowledgeBaseStore.hashBody(src.body);
    if (current !== wiki.lastSourceHashes[srcId]) return true; // edited → stale
  }
  return false;
}
