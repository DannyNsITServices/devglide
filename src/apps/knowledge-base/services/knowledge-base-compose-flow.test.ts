/**
 * Store-behavior tests for the simple "compose wiki" lane (zero-LLM path).
 *
 * Owner: claude-3 (per codex-6's task split for the KB simplification PR).
 *
 * These tests pin the contract for the new store methods that codex-6 will
 * wire into `KnowledgeBaseStore`:
 *
 *   composeWiki(input: {
 *     pagePath: string;     // full target wiki note path, e.g. 'notes/auth/overview'
 *     sourceIds: string[];  // ordered; preserve order in the composed body
 *     title?: string;
 *   }): Promise<KbNote>
 *
 *   rebuildComposedWiki(pageId: string, opts?: { force?: boolean }): Promise<KbNote>
 *
 * Returned wiki notes carry:
 *   - kind: 'wiki'
 *   - sourceRefs: string[]  (order preserved from input)
 *   - lastComposedBodyHash: string  (sha256 of the body the store wrote)
 *
 * Cited raw sources get the new wiki's id appended to their `consumedBy[]`
 * reverse index.
 *
 * Rebuild guard:
 *   - If hash(currentBody) === lastComposedBodyHash → rebuild proceeds and
 *     refreshes lastComposedBodyHash to hash(newBody).
 *   - Otherwise → throws KbError with code 'manual_edits_present' unless
 *     opts.force === true.
 *   - A wiki page missing lastComposedBodyHash entirely (legacy / v2 build
 *     output) hits the same guard on first rebuild.
 *
 * These tests are written before the implementation lands. They will RED in
 * a clear way (TypeError: composeWiki is not a function) until codex-6's
 * store work merges. After that they should turn green without modification.
 *
 * Scope discipline: this file does NOT touch the store source. It only
 * exercises the contract through public method calls. Router/UI/MCP/compose
 * helper tests are owned by claude-1, claude-4, codex-2, and codex-5.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  KnowledgeBaseStore,
  KbError,
  KB_NOTES_DIR,
} from './knowledge-base-store.js';
import type { KbNote } from '../types.js';

// ── Local contract types ────────────────────────────────────────────────────
//
// Defined here so this file compiles before codex-6 adds the field to
// `KbNote` and the methods to `KnowledgeBaseStore`. After the implementation
// lands these become redundant but harmless.

interface KbWikiNote extends KbNote {
  lastComposedBodyHash?: string;
}

interface ComposeWikiInput {
  pagePath: string;
  sourceIds: string[];
  title?: string;
}

interface ComposeStoreContract {
  composeWiki(input: ComposeWikiInput): Promise<KbWikiNote>;
  rebuildComposedWiki(pageId: string, opts?: { force?: boolean }): Promise<KbWikiNote>;
}

/** Cast a real store instance to the new contract surface. */
function asComposeStore(store: KnowledgeBaseStore): ComposeStoreContract {
  return store as unknown as ComposeStoreContract;
}

// ── Harness ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
let store: KnowledgeBaseStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-compose-flow-'));
  store = KnowledgeBaseStore.resetForTests(tmpRoot);
  await store.ensureBootstrapped();
});

afterEach(async () => {
  try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function addRaw(title: string, content: string): Promise<KbNote> {
  return store.add({ title, content });
}

/**
 * Write a v2-style wiki page directly to disk *without* `lastComposedBodyHash`,
 * to simulate a legacy wiki produced by the old build pipeline. Used by the
 * "first rebuild guard for legacy wikis" test.
 */
async function writeLegacyWiki(opts: {
  id: string;
  pagePath: string; // e.g. 'notes/legacy/overview'
  body: string;
  sourceIds: string[];
}): Promise<void> {
  const folder = opts.pagePath.split('/').slice(0, -1).join('/');
  const slug = opts.pagePath.split('/').slice(-1)[0]!;
  const now = new Date().toISOString();
  const wikiNote: KbNote = {
    id: opts.id,
    title: 'Legacy wiki',
    slug,
    path: folder,
    tags: [],
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    body: opts.body,
    kind: 'wiki',
    sourceRefs: opts.sourceIds,
    // intentionally omit lastComposedBodyHash
  };
  const storeAny = store as unknown as {
    writeNoteFile(file: string, note: KbNote): Promise<void>;
  };
  const absDir = path.join(tmpRoot, folder);
  await fs.mkdir(absDir, { recursive: true });
  await storeAny.writeNoteFile(path.join(absDir, `${slug}.md`), wikiNote);
  await store.rebuildIndex();
}

// ── 1. compose creates a wiki with kind/sourceRefs/lastComposedBodyHash ─────

describe('composeWiki — initial creation', () => {
  it('writes a wiki note with kind=wiki, sourceRefs in order, and a lastComposedBodyHash', async () => {
    const a = await addRaw('Source A', 'Body of A.');
    const b = await addRaw('Source B', 'Body of B.');
    const c = await addRaw('Source C', 'Body of C.');

    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/auth/overview',
      sourceIds: [a.id, b.id, c.id],
      title: 'Auth overview',
    });

    expect(wiki).toBeDefined();
    expect(wiki.id).toMatch(/^kb_/);
    expect(wiki.kind).toBe('wiki');
    expect(wiki.path).toBe('notes/auth');
    expect(wiki.slug).toBe('overview');
    // Order preservation matters: codex-6's contract says
    // "ordered; preserve order in the composed body".
    expect(wiki.sourceRefs).toEqual([a.id, b.id, c.id]);
    expect(typeof wiki.lastComposedBodyHash).toBe('string');
    expect(wiki.lastComposedBodyHash).toMatch(/^[a-f0-9]{64}$/);
    // Hash must actually be the sha256 of the body the store just wrote.
    expect(wiki.lastComposedBodyHash).toBe(KnowledgeBaseStore.hashBody(wiki.body));

    // It must round-trip through disk via get().
    const reread = (await store.get(wiki.id)) as KbWikiNote | null;
    expect(reread).not.toBeNull();
    expect(reread?.kind).toBe('wiki');
    expect(reread?.sourceRefs).toEqual([a.id, b.id, c.id]);
    expect(reread?.lastComposedBodyHash).toBe(wiki.lastComposedBodyHash);
  });
});

// ── 2. cited raw sources get consumedBy[] updated ───────────────────────────

describe('composeWiki — consumedBy bookkeeping', () => {
  it('appends the new wiki id to each cited raw source\'s consumedBy[]', async () => {
    const a = await addRaw('Source A', 'A body');
    const b = await addRaw('Source B', 'B body');

    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/topic/page',
      sourceIds: [a.id, b.id],
    });

    const aFresh = await store.get(a.id);
    const bFresh = await store.get(b.id);
    expect(aFresh?.consumedBy ?? []).toContain(wiki.id);
    expect(bFresh?.consumedBy ?? []).toContain(wiki.id);
  });

  it('does not duplicate the wiki id when a source is already cited', async () => {
    const a = await addRaw('Source A', 'A body');

    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/topic/page-once',
      sourceIds: [a.id],
    });

    // Force-rebuild the same wiki and check no duplicate consumer entries.
    await composeStore.rebuildComposedWiki(wiki.id);

    const aFresh = await store.get(a.id);
    const occurrences = (aFresh?.consumedBy ?? []).filter((id) => id === wiki.id).length;
    expect(occurrences).toBe(1);
  });
});

// ── 3. rebuild succeeds when current body still matches the last composed hash ─

describe('rebuildComposedWiki — no divergence', () => {
  it('rebuilds and refreshes lastComposedBodyHash when the wiki body is untouched', async () => {
    const a = await addRaw('Source A', 'A body');

    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/topic/clean',
      sourceIds: [a.id],
    });
    const initialHash = wiki.lastComposedBodyHash;

    const rebuilt = await composeStore.rebuildComposedWiki(wiki.id);
    expect(rebuilt.kind).toBe('wiki');
    expect(rebuilt.id).toBe(wiki.id);
    // Hash must equal sha256(rebuilt.body) — proves the store refreshed it
    // rather than copying the old value or leaving it stale.
    expect(rebuilt.lastComposedBodyHash).toBe(KnowledgeBaseStore.hashBody(rebuilt.body));
    expect(typeof rebuilt.lastComposedBodyHash).toBe('string');
    expect(initialHash).toBeDefined();
  });
});

// ── 4. rebuild throws manual_edits_present after a manual update ────────────

describe('rebuildComposedWiki — manual edit guard', () => {
  it('throws KbError(manual_edits_present) when the wiki body diverged from lastComposedBodyHash', async () => {
    const a = await addRaw('Source A', 'A body');

    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/topic/edited',
      sourceIds: [a.id],
    });

    // Manually edit the wiki body via the existing update() path. Per
    // codex-6's contract: update() must NOT touch lastComposedBodyHash, so
    // the divergence guard fires on the next rebuild.
    const edited = await store.update(wiki.id, { content: 'I edited this by hand.' });
    expect(edited?.body).toBe('I edited this by hand.');

    await expect(composeStore.rebuildComposedWiki(wiki.id)).rejects.toMatchObject({
      name: 'KbError',
      code: 'manual_edits_present',
    });

    // Critical post-condition: the failed rebuild must NOT have overwritten
    // the user's edit. This catches a class of "throw after write" bugs.
    const stillEdited = await store.get(wiki.id);
    expect(stillEdited?.body).toBe('I edited this by hand.');
  });
});

// ── 5. rebuild with force overwrites and refreshes the hash ─────────────────

describe('rebuildComposedWiki — force', () => {
  it('with force:true, overwrites a manually-edited body and refreshes lastComposedBodyHash', async () => {
    const a = await addRaw('Source A', 'A body');

    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/topic/forced',
      sourceIds: [a.id],
    });

    await store.update(wiki.id, { content: 'manual edit' });
    const before = (await store.get(wiki.id)) as KbWikiNote | null;
    expect(before?.body).toBe('manual edit');

    const rebuilt = await composeStore.rebuildComposedWiki(wiki.id, { force: true });
    expect(rebuilt.body).not.toBe('manual edit');
    expect(rebuilt.lastComposedBodyHash).toBe(KnowledgeBaseStore.hashBody(rebuilt.body));

    // And the on-disk read agrees with the returned note.
    const after = (await store.get(wiki.id)) as KbWikiNote | null;
    expect(after?.body).toBe(rebuilt.body);
    expect(after?.lastComposedBodyHash).toBe(rebuilt.lastComposedBodyHash);
  });
});

// ── 6. legacy wikis without lastComposedBodyHash require force on first rebuild ─

describe('rebuildComposedWiki — legacy wiki without lastComposedBodyHash', () => {
  it('requires force:true on first rebuild for a wiki that has no lastComposedBodyHash', async () => {
    const a = await addRaw('Source A', 'A body');
    const legacyId = 'kb_legacy_wiki_for_test';
    await writeLegacyWiki({
      id: legacyId,
      pagePath: 'notes/legacy/page',
      body: '# Legacy body\n\nWritten by the old builder.',
      sourceIds: [a.id],
    });

    const composeStore = asComposeStore(store);

    await expect(composeStore.rebuildComposedWiki(legacyId)).rejects.toMatchObject({
      name: 'KbError',
      code: 'manual_edits_present',
    });

    // Forced rebuild must succeed and stamp a fresh hash so the next rebuild
    // no longer trips the legacy guard.
    const rebuilt = await composeStore.rebuildComposedWiki(legacyId, { force: true });
    expect(rebuilt.lastComposedBodyHash).toBe(KnowledgeBaseStore.hashBody(rebuilt.body));

    // Subsequent unforced rebuild should now succeed (no longer "legacy").
    const second = await composeStore.rebuildComposedWiki(legacyId);
    expect(second.lastComposedBodyHash).toBe(KnowledgeBaseStore.hashBody(second.body));
  });
});

// ── KbError type sanity (catches accidental import drift) ───────────────────

describe('contract — KbError code surface', () => {
  it('KbError is the rejection type for the manual-edits guard', async () => {
    // This is a structural check: the error class we import is the same one
    // the store will throw. If codex-6 introduces a different error class
    // (e.g. KbConflictError), this assertion will fail loudly so the test
    // file's assumptions can be corrected in one place.
    const a = await addRaw('Source A', 'A body');
    const composeStore = asComposeStore(store);
    const wiki = await composeStore.composeWiki({
      pagePath: 'notes/topic/sanity',
      sourceIds: [a.id],
    });
    await store.update(wiki.id, { content: 'edit' });

    let caught: unknown = null;
    try {
      await composeStore.rebuildComposedWiki(wiki.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KbError);
    expect((caught as KbError).code).toBe('manual_edits_present');
  });
});
