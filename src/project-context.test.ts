import { describe, it, expect, beforeEach } from 'vitest';
import { getActiveProject, setActiveProject, onProjectChange } from './project-context.js';
import type { ActiveProject } from './project-context.js';

describe('project-context', () => {
  beforeEach(() => {
    setActiveProject(null);
  });

  describe('getActiveProject / setActiveProject', () => {
    it('returns null initially', () => {
      expect(getActiveProject()).toBeNull();
    });

    it('returns the project after setting it', () => {
      const project: ActiveProject = { id: 'p1', name: 'Test', path: '/tmp/test' };
      setActiveProject(project);
      expect(getActiveProject()).toEqual(project);
    });

    it('returns null after clearing', () => {
      setActiveProject({ id: 'p1', name: 'Test', path: '/tmp/test' });
      setActiveProject(null);
      expect(getActiveProject()).toBeNull();
    });
  });

  describe('onProjectChange', () => {
    it('notifies listeners on change', () => {
      const calls: (ActiveProject | null)[] = [];
      onProjectChange((p) => calls.push(p));

      const project: ActiveProject = { id: 'p1', name: 'Test', path: '/tmp/test' };
      setActiveProject(project);
      setActiveProject(null);

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(project);
      expect(calls[1]).toBeNull();
    });

    it('returns an unsubscribe function', () => {
      const calls: (ActiveProject | null)[] = [];
      const unsub = onProjectChange((p) => calls.push(p));

      setActiveProject({ id: 'p1', name: 'A', path: '/a' });
      unsub();
      setActiveProject({ id: 'p2', name: 'B', path: '/b' });

      expect(calls).toHaveLength(1);
    });

    it('does not throw if a listener throws', () => {
      onProjectChange(() => { throw new Error('boom'); });
      expect(() => setActiveProject({ id: 'x', name: 'X', path: '/x' })).not.toThrow();
    });
  });
});
