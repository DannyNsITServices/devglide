import { describe, expect, it } from 'vitest';

import { formatRecipientHeader, getMentionMatches, getPipeAssigneeMatches } from './mention-suggestions.js';

describe('mention suggestions', () => {
  it('excludes detached llms from regular mention autocomplete', () => {
    const members = [
      { name: 'user', kind: 'user', detached: false, paneId: null },
      { name: 'codex-1', kind: 'llm', detached: false, paneId: 'pane-1' },
      { name: 'claude-1', kind: 'llm', detached: true, paneId: 'pane-2' },
      { name: 'cursor-1', kind: 'llm', detached: false, paneId: null },
      { name: 'reviewer', kind: 'observer', detached: false, paneId: null },
    ];

    expect(getMentionMatches(members, '')).toEqual(['all', 'codex-1', 'reviewer']);
    expect(getMentionMatches(members, 'cl')).toEqual([]);
    expect(getMentionMatches(members, 'a')).toEqual(['all']);
    expect(getMentionMatches(members, 'co')).toEqual(['codex-1']);
  });

  it('suggests @all when the query matches even if there are no member matches', () => {
    const members = [
      { name: 'user', kind: 'user', detached: false, paneId: null },
      { name: 'codex-1', kind: 'llm', detached: false, paneId: 'pane-1' },
    ];

    expect(getMentionMatches(members, 'al')).toEqual(['all']);
  });

  it('limits pipe assignee autocomplete to live llm participants', () => {
    const members = [
      { name: 'codex-1', kind: 'llm', detached: false, paneId: 'pane-1' },
      { name: 'claude-1', kind: 'llm', detached: true, paneId: 'pane-2' },
      { name: 'cursor-1', kind: 'llm', detached: false, paneId: null },
      { name: 'reviewer', kind: 'observer', detached: false, paneId: null },
    ];

    expect(getPipeAssigneeMatches(members, '')).toEqual(['codex-1']);
    expect(getPipeAssigneeMatches(members, 'cl')).toEqual([]);
    expect(getPipeAssigneeMatches(members, 'co')).toEqual(['codex-1']);
  });
});

describe('formatRecipientHeader', () => {
  it('renders sender alone when there are no recipients', () => {
    expect(formatRecipientHeader('claude-2', null)).toBe('@claude-2');
    expect(formatRecipientHeader('claude-2', undefined)).toBe('@claude-2');
    expect(formatRecipientHeader('claude-2', '')).toBe('@claude-2');
  });

  it('renders @sender → @target for a single recipient', () => {
    expect(formatRecipientHeader('claude-2', 'codex-3')).toBe('@claude-2 \u2192 @codex-3');
  });

  it('renders @sender → @t1, @t2 for multiple recipients (comma-space)', () => {
    expect(formatRecipientHeader('claude-2', 'codex-3, pi-1')).toBe('@claude-2 \u2192 @codex-3, @pi-1');
  });

  it('also splits a legacy bare-comma list (no space)', () => {
    expect(formatRecipientHeader('claude-2', 'codex-3,pi-1')).toBe('@claude-2 \u2192 @codex-3, @pi-1');
  });

  it('renders @user → @all for a broadcast message', () => {
    expect(formatRecipientHeader('user', 'all')).toBe('@user \u2192 @all');
  });

  it('strips empty entries that may come from a malformed legacy `to` field', () => {
    expect(formatRecipientHeader('claude-2', 'codex-3,,pi-1, ')).toBe('@claude-2 \u2192 @codex-3, @pi-1');
  });

  it('does not double-prefix when sender or target already starts with @', () => {
    // Defensive: even if someone slips an `@` into the stored values,
    // the renderer should not produce `@@claude-2`.
    expect(formatRecipientHeader('@claude-2', '@codex-3')).toBe('@claude-2 \u2192 @codex-3');
  });
});
