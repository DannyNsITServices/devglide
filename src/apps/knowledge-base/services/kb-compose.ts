/**
 * Pure deterministic wiki composer.
 *
 * The Knowledge Base "compose" lane turns one or more raw notes into a
 * cited wiki page. This module is the pure-function core: it takes a
 * title and an ordered list of source notes and returns the composed
 * markdown body plus the metadata the store needs to write the page
 * (sourceRefs, lastComposedBodyHash).
 *
 * Design rules:
 *  - No I/O. No store reference. No clock. No randomness.
 *  - Body is a deterministic function of (title, sources). Composing the
 *    same input twice produces a byte-identical body, so an unedited
 *    rebuild on unchanged sources is a hash-stable no-op.
 *  - Source order is preserved in both the body sections and `sourceRefs`.
 *  - Intentionally dumb format: title heading, one section per source
 *    with the source's first paragraph, then a Sources reference list.
 *  - No LLM. No clustering. No proposal logic. No timestamps in the body.
 *
 * Layered above this, `KnowledgeBaseStore.composeWiki(...)` resolves
 * source ids to KbNote objects, calls `composeWikiPage`, writes the
 * resulting note via `add()`, and patches the wiki frontmatter with
 * `kind: 'wiki'`, `sourceRefs`, and `lastComposedBodyHash`.
 */

import { createHash } from 'node:crypto';
import type { KbNote } from '../types.js';

/** Inputs for the deterministic composer. */
export interface ComposeWikiPageInput {
  /** Display title rendered as the H1 heading. */
  title: string;
  /**
   * Pre-resolved source notes in the order they should appear in the
   * composed body. Order is preserved in `sourceRefs` as well.
   */
  sources: KbNote[];
}

/** Output of the deterministic composer. */
export interface ComposeWikiPageOutput {
  /** Echoes the input title for caller convenience. */
  title: string;
  /** Composed markdown body, deterministic from inputs. */
  body: string;
  /** Source ids in the same order as `input.sources`. */
  sourceRefs: string[];
  /**
   * sha256 hex digest of `body`. The store writes this to wiki
   * frontmatter so `rebuildComposedWiki` can detect manual edits by
   * comparing `hashBody(currentBody)` against the stored value.
   * Equal to `hashBody(body)`.
   */
  lastComposedBodyHash: string;
}

/**
 * Compose a wiki page deterministically from one or more source notes.
 *
 * Throws if `sources` is empty — composing nothing is a caller bug.
 */
export function composeWikiPage(input: ComposeWikiPageInput): ComposeWikiPageOutput {
  if (input.sources.length === 0) {
    throw new Error('composeWikiPage requires at least one source');
  }

  const lines: string[] = [];

  // H1 — page title.
  lines.push(`# ${input.title}`);
  lines.push('');

  // One section per source, in input order.
  for (const src of input.sources) {
    lines.push(`## ${src.title}`);
    lines.push('');
    const para = firstParagraph(src.body);
    if (para.length > 0) {
      lines.push(para);
      lines.push('');
    }
  }

  // Bottom Sources reference list — explicit, machine-and-human readable.
  lines.push('## Sources');
  lines.push('');
  for (const src of input.sources) {
    lines.push(`- \`${src.id}\` — ${src.title}`);
  }
  lines.push('');

  const body = lines.join('\n');

  return {
    title: input.title,
    body,
    sourceRefs: input.sources.map((s) => s.id),
    lastComposedBodyHash: hashBody(body),
  };
}

/**
 * Stable sha256 hex digest of an arbitrary body string.
 *
 * Exposed as a separate export so callers (notably the store's
 * `rebuildComposedWiki`) can compare the hash of an existing wiki
 * page's body against its stored `lastComposedBodyHash` without
 * re-running the full composer.
 */
export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Extract the first paragraph of a source body.
 *
 * "First paragraph" = everything before the first blank line (a line
 * containing only whitespace), with leading/trailing whitespace
 * stripped. If the body has no blank-line break, the whole body is
 * returned. An empty or whitespace-only body returns an empty string.
 */
function firstParagraph(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  const match = /^([\s\S]*?)(?:\r?\n[ \t]*\r?\n|$)/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}
