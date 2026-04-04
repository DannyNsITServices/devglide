import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalPtys } from '../../shell/src/runtime/shell-state.js';
import { setActiveProject } from '../../../project-context.js';

vi.mock('./chat-store.js', () => ({
  appendMessage: vi.fn((msg: Record<string, unknown>) => ({
    id: 'msg-1',
    ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    topic: null,
    ...msg,
  })),
  appendPipeEvent: vi.fn((event: Record<string, unknown>) => ({
    id: 'pipe-event-1',
    ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...event,
  })),
  clearMessages: vi.fn(),
  readMessages: vi.fn(() => []),
  saveParticipants: vi.fn(),
  loadParticipants: vi.fn(() => []),
  discoverPersistedPipeIds: vi.fn(() => []),
  readAllPipeEvents: vi.fn(() => []),
  removePipeFiles: vi.fn(),
}));

const registry = await import('./chat-registry.js');

// Helper: generate a unique project ID to avoid cross-test pollution
let projectCounter = 0;
function uniqueProject(): string {
  return `test-proj-roles-${Date.now()}-${++projectCounter}`;
}

// Helper: join an LLM participant into the registry for the given project
let paneCounter = 0;
function joinLlm(name: string, pid: string) {
  const paneId = `pane-role-test-${++paneCounter}`;
  setActiveProject({ id: pid, name: 'Test', path: '/tmp/test' });
  globalPtys.set(paneId, { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
  return registry.join(name, 'llm', paneId, name, '\r', pid);
}

describe('role assignment helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalPtys.clear();
    // Clear all participants to avoid interference between test suites
    for (const participant of registry.listParticipants()) {
      registry.leave(participant.name);
    }
    setActiveProject({ id: 'project-roles-test', name: 'Roles Test', path: '/tmp/roles-test' });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalPtys.clear();
    for (const participant of registry.listParticipants()) {
      registry.leave(participant.name);
    }
    setActiveProject(null);
  });

  // ── assignRole ─────────────────────────────────────────────────

  describe('assignRole', () => {
    it('assigns a role to a connected LLM participant', () => {
      const pid = uniqueProject();
      const p = joinLlm('claude-1', pid);

      registry.assignRole(pid, p.name, 'implementer');

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[p.name]).toBe('implementer');
    });

    it('replaces the participant\'s existing role when reassigned to a different role', () => {
      const pid = uniqueProject();
      const p = joinLlm('claude-1', pid);

      registry.assignRole(pid, p.name, 'implementer');
      registry.assignRole(pid, p.name, 'reviewer');

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[p.name]).toBe('reviewer');
      expect(Object.values(assignments).filter((r) => r === 'implementer')).toHaveLength(0);
    });

    it('for exclusive role: evicts the previous holder when a different participant takes it', () => {
      const pid = uniqueProject();
      const p1 = joinLlm('claude-1', pid);
      const p2 = joinLlm('codex-1', pid);

      // tech-lead is exclusive
      registry.assignRole(pid, p1.name, 'tech-lead');
      registry.assignRole(pid, p2.name, 'tech-lead');

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[p2.name]).toBe('tech-lead');
      // p1 should have been evicted
      expect(assignments[p1.name]).toBeUndefined();
    });

    it('for multi role (implementer): allows two participants to hold the same role simultaneously', () => {
      const pid = uniqueProject();
      const p1 = joinLlm('claude-1', pid);
      const p2 = joinLlm('codex-1', pid);

      // implementer has cardinality 'multi'
      registry.assignRole(pid, p1.name, 'implementer');
      registry.assignRole(pid, p2.name, 'implementer');

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[p1.name]).toBe('implementer');
      expect(assignments[p2.name]).toBe('implementer');
    });

    it('always clears the old role from the same participant (1 role per participant)', () => {
      const pid = uniqueProject();
      const p = joinLlm('claude-1', pid);

      registry.assignRole(pid, p.name, 'tester');
      registry.assignRole(pid, p.name, 'kanban');

      const assignments = registry.listProjectRoleAssignments(pid);
      const entries = Object.entries(assignments).filter(([name]) => name === p.name);
      expect(entries).toHaveLength(1);
      expect(entries[0][1]).toBe('kanban');
    });

    it('throws an error for an invalid role slug', () => {
      const pid = uniqueProject();
      expect(() => {
        registry.assignRole(pid, 'anyone', 'nonexistent-role');
      }).toThrow('"nonexistent-role" is not a valid role slug.');
    });

    it('throws when the participant is not connected to the project', () => {
      const pid = uniqueProject();
      expect(() => {
        registry.assignRole(pid, 'ghost-participant', 'implementer');
      }).toThrow('not connected');
    });
  });

  // ── unassignRole ───────────────────────────────────────────────

  describe('unassignRole', () => {
    it('removes the role assignment from a participant', () => {
      const pid = uniqueProject();
      const p = joinLlm('claude-1', pid);

      registry.assignRole(pid, p.name, 'reviewer');
      registry.unassignRole(pid, p.name);

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[p.name]).toBeUndefined();
    });

    it('is a no-op if the participant had no role', () => {
      const pid = uniqueProject();
      // Should not throw
      expect(() => {
        registry.unassignRole(pid, 'ghost-participant');
      }).not.toThrow();

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments['ghost-participant']).toBeUndefined();
    });
  });

  // ── listProjectRoleAssignments ─────────────────────────────────

  describe('listProjectRoleAssignments', () => {
    it('returns an empty object when no roles assigned', () => {
      const pid = uniqueProject();
      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments).toEqual({});
    });

    it('returns current assignments as a flat participantName -> roleSlug map', () => {
      const pid = uniqueProject();
      const p1 = joinLlm('claude-1', pid);
      const p2 = joinLlm('codex-1', pid);
      const p3 = joinLlm('cursor-1', pid);

      registry.assignRole(pid, p1.name, 'tech-lead');
      registry.assignRole(pid, p2.name, 'implementer');
      registry.assignRole(pid, p3.name, 'tester');

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[p1.name]).toBe('tech-lead');
      expect(assignments[p2.name]).toBe('implementer');
      expect(assignments[p3.name]).toBe('tester');
    });
  });

  // ── leave cleanup (integration) ────────────────────────────────

  describe('leave cleanup', () => {
    it('calling leave() removes the participant\'s role assignment', () => {
      const pid = uniqueProject();

      // Set up a pane so join() works
      globalPtys.set('pane-roles-leave', {
        ptyProcess: { write: vi.fn() } as never,
        chunks: [],
        totalLen: 0,
      });

      // Join a participant in the active project (project-roles-test)
      setActiveProject({ id: pid, name: 'Roles Leave Test', path: '/tmp/roles-leave' });
      const participant = registry.join('claude', 'llm', 'pane-roles-leave', 'claude', '\r', pid);

      // Assign a role
      registry.assignRole(pid, participant.name, 'reviewer');
      expect(registry.listProjectRoleAssignments(pid)[participant.name]).toBe('reviewer');

      // Leave — should clear the role
      registry.leave(participant.name, pid);

      const assignments = registry.listProjectRoleAssignments(pid);
      expect(assignments[participant.name]).toBeUndefined();
    });
  });
});
