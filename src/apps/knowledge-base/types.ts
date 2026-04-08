/**
 * Knowledge Base note types.
 *
 * Each note is a markdown file with YAML frontmatter on disk.
 * The KbNote interface mirrors the parsed shape: frontmatter fields plus body.
 *
 * v2 additions (all optional for v1 back-compat):
 *   - `kind` discriminator (raw | wiki | index)
 *   - wiki provenance fields (sourceRefs, compiledAt, compiledBy, promptVersion,
 *     buildStatus, lastSourceHashes, manualEditsAfter, lastComposedBodyHash)
 *   - raw reverse index (consumedBy)
 */

/** Discriminator for the three v2 note kinds. */
export type KbNoteKind = 'raw' | 'wiki' | 'index';

/** Lifecycle status for wiki pages. */
export type KbBuildStatus = 'draft' | 'published' | 'stale';

export interface KbNote {
  /** Stable, immutable identifier (cuid2, prefixed `kb_`). */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Filename stem (mutable on rename). Matches the on-disk filename without `.md`. */
  slug: string;
  /** Parent folder relative to the KB root, e.g. `notes/mempalace/architecture`. */
  path: string;
  /** Free-form labels. */
  tags: string[];
  /** Provenance: `pipe:<id>`, `chat:<msgId>`, `manual`, or `import`. */
  source?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
  /** Markdown body (everything after the frontmatter block). */
  body: string;

  // ── v2 additions (optional; v1 notes parse unchanged) ─────────────────────

  /** Discriminator. Defaults at read time: `_index` slug → `index`, else → `raw`. */
  kind?: KbNoteKind;
  /** Wiki only: raw note ids cited by this page. */
  sourceRefs?: string[];
  /** Raw only: wiki page ids that cite this source (reverse index). */
  consumedBy?: string[];
  /** Wiki only: ISO timestamp of last build run that wrote this page. */
  compiledAt?: string;
  /** Wiki only: builder identity + version, e.g. `kb-builder-v1`. */
  compiledBy?: string;
  /** Wiki only: pinned prompt version for replay / drift detection. */
  promptVersion?: string;
  /** Wiki only: lifecycle state. */
  buildStatus?: KbBuildStatus;
  /** Wiki only: map of sourceId → sha256(source.body) at build time. */
  lastSourceHashes?: Record<string, string>;
  /** Wiki only: ISO timestamp of last human edit after the last builder commit. */
  manualEditsAfter?: string;
  /** Wiki only: sha256(body) captured by the simple compose/rebuild lane. */
  lastComposedBodyHash?: string;
  /**
   * Tree-visibility hint. When `true`, the note is filtered out of the
   * default list/walk results — used by the wiki builder to tuck cited
   * source notes into `<wikiPath>/_sources/` without cluttering the room
   * view. Pass `includeHidden: true` on list/walk to surface hidden notes.
   * Frontmatter is the source of truth: editing the note and clearing
   * `hidden: true` un-hides it without moving the file.
   */
  hidden?: boolean;
}

/** Lightweight projection used by `list` / index cache. */
export interface KbNoteSummary {
  id: string;
  title: string;
  slug: string;
  path: string;
  tags: string[];
  source?: string;
  updatedAt: string;
  /** v2: discriminator (raw | wiki | index). */
  kind?: KbNoteKind;
  /** v2: lifecycle state (wiki pages only). */
  buildStatus?: KbBuildStatus;
  /** v2: tree-visibility hint. See `KbNote.hidden`. */
  hidden?: boolean;
}

/** Inputs to `add`. */
export interface KbAddInput {
  title: string;
  content: string;
  /** Defaults to `inbox`. Must be a relative path under the KB root. */
  path?: string;
  tags?: string[];
  source?: string;
  /** Optional explicit slug; auto-derived from title if omitted. */
  slug?: string;
}

/** Inputs to `update`. Undefined fields are left untouched. */
export interface KbUpdateFields {
  title?: string;
  content?: string;
  tags?: string[];
  path?: string;
  slug?: string;
}

/** A single search hit. */
export interface KbSearchHit {
  note: KbNoteSummary;
  /** Short surrounding excerpt. */
  snippet: string;
  score: number;
}

/** Result of `walk(path)` — the canonical "memory palace navigation" primitive. */
export interface KbWalkResult {
  /** The folder's `_index.md` note, if present. */
  index: KbNote | null;
  /** Notes directly in the folder (excluding `_index.md`). */
  children: KbNoteSummary[];
  /** Subfolder names directly under the folder. */
  folders: string[];
  /** Parent folder path, or undefined at the root. */
  parent?: string;
  /** The walked path itself, normalized. */
  path: string;
}

/** On-disk index cache schema. */
export interface KbIndex {
  version: number;
  builtAt: string;
  notes: Record<string, KbNoteSummary>;
}
