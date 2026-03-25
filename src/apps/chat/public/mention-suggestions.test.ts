import { describe, expect, it } from 'vitest';

import { getMentionMatches, getPipeAssigneeMatches } from './mention-suggestions.js';

describe('mention suggestions', () => {
  it('excludes detached llms from regular mention autocomplete', () => {
    const members = [
      { name: 'user', kind: 'user', detached: false, paneId: null },
      { name: 'codex-1', kind: 'llm', detached: false, paneId: 'pane-1' },
      { name: 'claude-1', kind: 'llm', detached: true, paneId: 'pane-2' },
      { name: 'cursor-1', kind: 'llm', detached: false, paneId: null },
      { name: 'reviewer', kind: 'observer', detached: false, paneId: null },
    ];

    expect(getMentionMatches(members, '')).toEqual(['codex-1', 'reviewer']);
    expect(getMentionMatches(members, 'cl')).toEqual([]);
    expect(getMentionMatches(members, 'co')).toEqual(['codex-1']);
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
