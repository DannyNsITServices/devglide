import { describe, it, expect } from 'vitest';
import { composeWikiPage, hashBody } from './kb-compose.js';
import type { KbNote } from '../types.js';

/**
 * Tests for the pure deterministic wiki composer.
 *
 * Contract (per chat assignment from codex-6):
 *  - Pure function. No I/O.
 *  - Input source order is preserved in body and in `sourceRefs`.
 *  - Output is plain markdown plus a body hash helper.
 *  - Intentionally dumb: title, short source sections, sources list.
 *  - No LLM, no clustering, no proposal logic.
 *  - Body is fully deterministic from inputs (no timestamps in body)
 *    so that an unedited rebuild on unchanged sources is a no-op.
 */

function makeSource(overrides: Partial<KbNote> & { id: string; title: string; body: string }): KbNote {
  return {
    id: overrides.id,
    title: overrides.title,
    slug: overrides.slug ?? overrides.title.toLowerCase().replace(/\s+/g, '-'),
    path: overrides.path ?? 'inbox',
    tags: overrides.tags ?? [],
    source: overrides.source ?? 'manual',
    createdAt: overrides.createdAt ?? '2026-04-08T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-08T10:00:00.000Z',
    body: overrides.body,
  };
}

describe('composeWikiPage — input validation', () => {
  it('throws when sources array is empty', () => {
    expect(() => composeWikiPage({ title: 'Whatever', sources: [] })).toThrow(
      /at least one source/i,
    );
  });
});

describe('composeWikiPage — single source', () => {
  it('produces a body containing the title heading and a source section', () => {
    const out = composeWikiPage({
      title: 'Architecture Notes',
      sources: [
        makeSource({
          id: 'kb_aaa',
          title: 'Storage Model',
          body: 'The store uses atomic rename for safe writes.',
        }),
      ],
    });

    expect(out.body).toContain('# Architecture Notes');
    expect(out.body).toContain('## Storage Model');
    expect(out.body).toContain('The store uses atomic rename for safe writes.');
  });

  it('returns a single-element sourceRefs in input order', () => {
    const out = composeWikiPage({
      title: 'X',
      sources: [makeSource({ id: 'kb_only', title: 'T', body: 'B' })],
    });
    expect(out.sourceRefs).toEqual(['kb_only']);
  });

  it('exposes a Sources reference list at the bottom of the body', () => {
    const out = composeWikiPage({
      title: 'X',
      sources: [makeSource({ id: 'kb_zzz', title: 'My Source', body: 'B' })],
    });
    // The Sources section follows the source content, near the end.
    const sourcesIdx = out.body.indexOf('## Sources');
    const refIdx = out.body.indexOf('kb_zzz');
    expect(sourcesIdx).toBeGreaterThan(0);
    expect(refIdx).toBeGreaterThan(sourcesIdx);
  });
});

describe('composeWikiPage — multiple sources', () => {
  it('preserves input order in section ordering and in sourceRefs', () => {
    const out = composeWikiPage({
      title: 'Combined',
      sources: [
        makeSource({ id: 'kb_b', title: 'Beta', body: 'beta body' }),
        makeSource({ id: 'kb_a', title: 'Alpha', body: 'alpha body' }),
        makeSource({ id: 'kb_c', title: 'Gamma', body: 'gamma body' }),
      ],
    });

    expect(out.sourceRefs).toEqual(['kb_b', 'kb_a', 'kb_c']);

    // Section order in body must match input order.
    const idxBeta = out.body.indexOf('## Beta');
    const idxAlpha = out.body.indexOf('## Alpha');
    const idxGamma = out.body.indexOf('## Gamma');
    expect(idxBeta).toBeGreaterThan(-1);
    expect(idxAlpha).toBeGreaterThan(idxBeta);
    expect(idxGamma).toBeGreaterThan(idxAlpha);
  });

  it('includes every source id in the bottom Sources reference list', () => {
    const out = composeWikiPage({
      title: 'All',
      sources: [
        makeSource({ id: 'kb_one', title: 'One', body: 'one' }),
        makeSource({ id: 'kb_two', title: 'Two', body: 'two' }),
        makeSource({ id: 'kb_three', title: 'Three', body: 'three' }),
      ],
    });
    const sourcesSection = out.body.slice(out.body.indexOf('## Sources'));
    expect(sourcesSection).toContain('kb_one');
    expect(sourcesSection).toContain('kb_two');
    expect(sourcesSection).toContain('kb_three');
  });
});

describe('composeWikiPage — first-paragraph extraction', () => {
  it('uses only the first paragraph of a multi-paragraph source body', () => {
    const out = composeWikiPage({
      title: 'X',
      sources: [
        makeSource({
          id: 'kb_p',
          title: 'Long Note',
          body: 'First para line one.\nFirst para line two.\n\nSecond paragraph should be omitted.',
        }),
      ],
    });
    expect(out.body).toContain('First para line one.');
    expect(out.body).toContain('First para line two.');
    expect(out.body).not.toContain('Second paragraph should be omitted.');
  });

  it('falls back to the whole body when there is no blank-line separator', () => {
    const out = composeWikiPage({
      title: 'X',
      sources: [
        makeSource({
          id: 'kb_short',
          title: 'Short',
          body: 'A single line with no blank line after it.',
        }),
      ],
    });
    expect(out.body).toContain('A single line with no blank line after it.');
  });

  it('handles an empty source body without throwing', () => {
    expect(() =>
      composeWikiPage({
        title: 'X',
        sources: [makeSource({ id: 'kb_e', title: 'Empty', body: '' })],
      }),
    ).not.toThrow();
  });
});

describe('composeWikiPage — determinism', () => {
  it('produces byte-identical output for the same input twice', () => {
    const sources = [
      makeSource({ id: 'kb_a', title: 'A', body: 'alpha' }),
      makeSource({ id: 'kb_b', title: 'B', body: 'beta' }),
    ];
    const first = composeWikiPage({ title: 'Det', sources });
    const second = composeWikiPage({ title: 'Det', sources });
    expect(second.body).toBe(first.body);
    expect(second.lastComposedBodyHash).toBe(first.lastComposedBodyHash);
  });

  it('does not embed any timestamp in the body', () => {
    // Determinism requires no system time bleeding into the body, otherwise
    // a no-op rebuild on unchanged sources would always change the hash.
    const out = composeWikiPage({
      title: 'No clock',
      sources: [makeSource({ id: 'kb_t', title: 'T', body: 'body' })],
    });
    // ISO date pattern (YYYY-MM-DD) and full ISO timestamp must be absent.
    expect(out.body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(out.body).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });
});

describe('composeWikiPage — output shape', () => {
  it('returns title, body, sourceRefs, and lastComposedBodyHash', () => {
    const out = composeWikiPage({
      title: 'Shape',
      sources: [makeSource({ id: 'kb_s', title: 'S', body: 'b' })],
    });
    expect(out.title).toBe('Shape');
    expect(typeof out.body).toBe('string');
    expect(out.sourceRefs).toEqual(['kb_s']);
    expect(typeof out.lastComposedBodyHash).toBe('string');
    expect(out.lastComposedBodyHash.length).toBeGreaterThan(0);
    // hash must equal hashBody(body) so callers can re-derive without re-composing.
    expect(out.lastComposedBodyHash).toBe(hashBody(out.body));
  });
});

describe('hashBody', () => {
  it('returns a stable hex digest for the same input', () => {
    const a = hashBody('hello world');
    const b = hashBody('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it('returns a different digest for different inputs', () => {
    expect(hashBody('a')).not.toBe(hashBody('b'));
  });

  it('returns the same length digest for any input (sha256 = 64 hex chars)', () => {
    expect(hashBody('').length).toBe(64);
    expect(hashBody('x').length).toBe(64);
    expect(hashBody('a much longer body string here').length).toBe(64);
  });
});
