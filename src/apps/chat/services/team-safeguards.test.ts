import { describe, expect, it } from 'vitest';
import {
  checkRunIndependence,
  checkDetachedAssignees,
  checkMissingAssignees,
  validateRunSafeguards,
  getDisbandWarning,
  stripNonBlockingUnassignedStages,
} from './team-safeguards.js';
import type { TeamRunStage } from './team-run-store.js';
import type { ChatParticipant } from '../types.js';
import type { ActiveTeam } from './team-store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function stage(index: number, roleSlug: string, assignee: string | null): TeamRunStage {
  return { index, roleSlug, assignee, description: 'desc', pipeId: null, status: 'pending' };
}

function liveParticipant(name: string): ChatParticipant {
  return {
    name, kind: 'llm', model: null, paneId: 'pane-1', paneNum: 1,
    projectId: 'proj', submitKey: '\r', joinedAt: '', lastSeen: '',
    detached: false,
  };
}

function detachedParticipant(name: string): ChatParticipant {
  return { ...liveParticipant(name), detached: true };
}

function makeParticipantMap(...ps: ChatParticipant[]): Map<string, ChatParticipant> {
  return new Map(ps.map(p => [p.name, p]));
}

// ── checkRunIndependence ───────────────────────────────────────────────────

describe('checkRunIndependence', () => {
  it('returns null when all roles have distinct participants', () => {
    const stages = [
      stage(0, 'tech-lead', 'alice'),
      stage(1, 'implementer', 'bob'),
      stage(2, 'reviewer', 'carol'),
    ];
    expect(checkRunIndependence(stages)).toBeNull();
  });

  it('returns error when same participant is implementer and reviewer', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'reviewer', 'bob'),
    ];
    const err = checkRunIndependence(stages);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('SELF_REVIEW_VIOLATION');
    expect(err?.message).toContain('@bob');
  });

  it('returns error when same participant is implementer and tester', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'tester', 'bob'),
    ];
    const err = checkRunIndependence(stages);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('SELF_REVIEW_VIOLATION');
  });

  it('returns error when tech-lead is also reviewer', () => {
    const stages = [
      stage(0, 'tech-lead', 'alice'),
      stage(1, 'reviewer', 'alice'),
    ];
    expect(checkRunIndependence(stages)).not.toBeNull();
  });

  it('ignores null-assignee stages', () => {
    const stages = [
      stage(0, 'implementer', null),
      stage(1, 'reviewer', null),
    ];
    expect(checkRunIndependence(stages)).toBeNull();
  });
});

// ── checkDetachedAssignees ─────────────────────────────────────────────────

describe('checkDetachedAssignees', () => {
  it('returns null when all assignees are live', () => {
    const stages = [stage(0, 'implementer', 'bob'), stage(1, 'reviewer', 'carol')];
    const map = makeParticipantMap(liveParticipant('bob'), liveParticipant('carol'));
    expect(checkDetachedAssignees(stages, map)).toBeNull();
  });

  it('returns error when an assignee is detached', () => {
    const stages = [stage(0, 'implementer', 'bob')];
    const map = makeParticipantMap(detachedParticipant('bob'));
    const err = checkDetachedAssignees(stages, map);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('DETACHED_ASSIGNEES');
    expect(err?.message).toContain('@bob');
  });

  it('returns null when assignee is not in participant map (unknown / offline)', () => {
    // Only detached participants block — unknown ones are checked by missing-assignee guard
    const stages = [stage(0, 'implementer', 'unknown')];
    const map = makeParticipantMap(liveParticipant('carol'));
    expect(checkDetachedAssignees(stages, map)).toBeNull();
  });
});

// ── checkMissingAssignees ─────────────────────────────────────────────────

describe('checkMissingAssignees', () => {
  it('returns null when all blocking roles have assignees', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'reviewer', 'carol'),
      stage(2, 'kanban', null), // optional
    ];
    expect(checkMissingAssignees(stages)).toBeNull();
  });

  it('returns error when a blocking role lacks an assignee', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'reviewer', null),
    ];
    const err = checkMissingAssignees(stages);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('MISSING_ASSIGNEES');
    expect(err?.message).toContain('reviewer');
  });

  it('allows kanban to be null (non-blocking)', () => {
    const stages = [stage(0, 'kanban', null)];
    expect(checkMissingAssignees(stages)).toBeNull();
  });
});

// ── validateRunSafeguards ─────────────────────────────────────────────────

describe('validateRunSafeguards', () => {
  it('returns null when all checks pass', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'reviewer', 'carol'),
    ];
    const map = makeParticipantMap(liveParticipant('bob'), liveParticipant('carol'));
    expect(validateRunSafeguards(stages, map)).toBeNull();
  });

  it('returns missing-assignee error first', () => {
    const stages = [stage(0, 'implementer', null)];
    const map = new Map<string, ChatParticipant>();
    const err = validateRunSafeguards(stages, map);
    expect(err?.code).toBe('MISSING_ASSIGNEES');
  });

  it('returns independence error after missing check passes', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'reviewer', 'bob'),
    ];
    const map = makeParticipantMap(liveParticipant('bob'));
    const err = validateRunSafeguards(stages, map);
    expect(err?.code).toBe('SELF_REVIEW_VIOLATION');
  });
});

// ── getDisbandWarning ─────────────────────────────────────────────────────

describe('getDisbandWarning', () => {
  const team: ActiveTeam = {
    id: 'team-1', name: 'Alpha', projectId: 'proj',
    members: [], status: 'active',
    createdAt: '', updatedAt: '',
  };

  it('returns null when no active run', () => {
    expect(getDisbandWarning(team, null)).toBeNull();
  });

  it('returns a warning message when an active run exists', () => {
    const warning = getDisbandWarning(team, 'run-123');
    expect(warning).not.toBeNull();
    expect(warning).toContain('Alpha');
  });
});

// ── stripNonBlockingUnassignedStages ─────────────────────────────────────

describe('stripNonBlockingUnassignedStages', () => {
  it('removes unassigned kanban stages', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'kanban', null),
    ];
    const stripped = stripNonBlockingUnassignedStages(stages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].roleSlug).toBe('implementer');
  });

  it('keeps assigned kanban stages', () => {
    const stages = [
      stage(0, 'implementer', 'bob'),
      stage(1, 'kanban', 'alice'),
    ];
    const stripped = stripNonBlockingUnassignedStages(stages);
    expect(stripped).toHaveLength(2);
  });

  it('keeps unassigned blocking roles (they will fail safeguard checks)', () => {
    const stages = [
      stage(0, 'implementer', null),
      stage(1, 'reviewer', 'carol'),
    ];
    const stripped = stripNonBlockingUnassignedStages(stages);
    expect(stripped).toHaveLength(2);
  });
});
