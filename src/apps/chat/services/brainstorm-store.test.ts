import { describe, expect, it, beforeEach } from 'vitest';
import {
  createBrainstorm,
  getBrainstorm,
  updateBrainstorm,
  listActiveBrainstorms,
  linkChildPipe,
  findBrainstormByChildPipe,
  _resetForTest,
} from './brainstorm-store.js';

describe('brainstorm-store', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('creates and retrieves a brainstorm record', () => {
    const record = createBrainstorm('bs1', ['alice', 'bob'], 'design a cache', 'proj1');
    expect(record.id).toBe('bs1');
    expect(record.phase).toBe('ideas');
    expect(record.assignees).toEqual(['alice', 'bob']);
    expect(record.prompt).toBe('design a cache');
    expect(record.candidateIdea).toBeNull();
    expect(record.acceptedIdea).toBeNull();
    expect(record.candidateDraft).toBeNull();
    expect(record.acceptedDraft).toBeNull();

    const retrieved = getBrainstorm('bs1', 'proj1');
    expect(retrieved).toBe(record); // same reference
  });

  it('returns undefined for unknown brainstorm', () => {
    expect(getBrainstorm('nonexistent', 'proj1')).toBeUndefined();
  });

  it('updates a brainstorm record', () => {
    createBrainstorm('bs1', ['alice', 'bob'], 'design a cache', 'proj1');
    const updated = updateBrainstorm('bs1', 'proj1', { phase: 'ideas_review', candidateIdea: 'great idea' });
    expect(updated?.phase).toBe('ideas_review');
    expect(updated?.candidateIdea).toBe('great idea');
  });

  it('lists only active (non-complete) brainstorms', () => {
    createBrainstorm('bs1', ['a', 'b'], 'topic1', 'proj1');
    createBrainstorm('bs2', ['a', 'b'], 'topic2', 'proj1');
    updateBrainstorm('bs1', 'proj1', { phase: 'complete' });

    const active = listActiveBrainstorms('proj1');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('bs2');
  });

  it('scopes brainstorms by project', () => {
    createBrainstorm('bs1', ['a', 'b'], 'topic1', 'proj1');
    createBrainstorm('bs2', ['a', 'b'], 'topic2', 'proj2');

    expect(getBrainstorm('bs1', 'proj1')).toBeDefined();
    expect(getBrainstorm('bs1', 'proj2')).toBeUndefined();
    expect(listActiveBrainstorms('proj1')).toHaveLength(1);
    expect(listActiveBrainstorms('proj2')).toHaveLength(1);
  });

  it('links and finds child pipes', () => {
    createBrainstorm('bs1', ['a', 'b'], 'topic', 'proj1');
    linkChildPipe('bs1', 'pipe-123', 'proj1');

    const found = findBrainstormByChildPipe('pipe-123', 'proj1');
    expect(found).toBeDefined();
    expect(found?.id).toBe('bs1');
  });

  it('returns undefined for unlinked child pipe', () => {
    expect(findBrainstormByChildPipe('pipe-unknown', 'proj1')).toBeUndefined();
  });

  it('child pipe lookup is project-scoped', () => {
    createBrainstorm('bs1', ['a', 'b'], 'topic', 'proj1');
    linkChildPipe('bs1', 'pipe-123', 'proj1');

    expect(findBrainstormByChildPipe('pipe-123', 'proj1')).toBeDefined();
    expect(findBrainstormByChildPipe('pipe-123', 'proj2')).toBeUndefined();
  });

  it('_resetForTest clears all state including child pipe map', () => {
    createBrainstorm('bs1', ['a', 'b'], 'topic', 'proj1');
    linkChildPipe('bs1', 'pipe-123', 'proj1');
    _resetForTest();

    expect(getBrainstorm('bs1', 'proj1')).toBeUndefined();
    expect(findBrainstormByChildPipe('pipe-123', 'proj1')).toBeUndefined();
  });
});
