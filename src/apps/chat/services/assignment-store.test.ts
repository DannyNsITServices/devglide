import { describe, it, expect, beforeEach } from 'vitest';
import * as assignmentStore from './assignment-store.js';
import { createTestClock } from './clock.js';

beforeEach(() => {
  assignmentStore._resetForTest();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestAssignment(overrides?: {
  pipeId?: string;
  stageId?: string;
  payloadId?: string;
  assignee?: string;
  role?: 'stage-output' | 'fan-out' | 'final';
  stage?: number;
}) {
  return assignmentStore.createAssignment(
    overrides?.pipeId ?? 'pipe-1',
    overrides?.stageId ?? 'linear:1',
    overrides?.payloadId ?? 'payload-1',
    overrides?.assignee ?? 'alice',
    overrides?.role ?? 'stage-output',
    'proj-1',
    { stage: overrides?.stage ?? 1 },
  );
}

/** Transition through the full happy path to 'submitted'. */
function submitAssignment(assignmentId: string) {
  assignmentStore.transitionAssignment(assignmentId, 'notified', 'proj-1');
  assignmentStore.transitionAssignment(assignmentId, 'acknowledged', 'proj-1');
  assignmentStore.transitionAssignment(assignmentId, 'payload_fetched', 'proj-1');
  assignmentStore.transitionAssignment(assignmentId, 'submitted', 'proj-1');
}

// ── deriveStageId ────────────────────────────────────────────────────────────

describe('deriveStageId', () => {
  it('derives linear stage ID', () => {
    expect(assignmentStore.deriveStageId('linear', 'stage-output', { stage: 3 })).toBe('linear:3');
  });

  it('derives fan-out stage ID', () => {
    expect(assignmentStore.deriveStageId('merge', 'fan-out', { assignee: 'bob' })).toBe('fan-out:bob');
  });

  it('derives synth stage ID', () => {
    expect(assignmentStore.deriveStageId('merge-all', 'final')).toBe('synth');
  });
});

// ── createAssignment ─────────────────────────────────────────────────────────

describe('createAssignment', () => {
  it('creates an assignment with correct initial state', () => {
    const result = createTestAssignment();
    expect(result.ok).toBe(true);
    expect(result.assignment).toBeDefined();

    const a = result.assignment!;
    expect(a.pipeId).toBe('pipe-1');
    expect(a.stageId).toBe('linear:1');
    expect(a.payloadId).toBe('payload-1');
    expect(a.assignee).toBe('alice');
    expect(a.role).toBe('stage-output');
    expect(a.stage).toBe(1);
    expect(a.status).toBe('assigned');
    expect(a.attempt).toBe(1);
    expect(a.version).toBe(1);
    expect(a.supersededBy).toBeNull();
    expect(a.supersedes).toBeNull();
  });

  it('sets all timestamps to null except createdAt', () => {
    const result = createTestAssignment();
    const a = result.assignment!;
    expect(a.createdAt).toBeTruthy();
    expect(a.notifiedAt).toBeNull();
    expect(a.acknowledgedAt).toBeNull();
    expect(a.fetchedAt).toBeNull();
    expect(a.submittedAt).toBeNull();
    expect(a.expiredAt).toBeNull();
    expect(a.reassignedAt).toBeNull();
    expect(a.cancelledAt).toBeNull();
  });

  it('rejects duplicate active assignment for same pipe+stageId', () => {
    createTestAssignment();
    const result = createTestAssignment({ assignee: 'bob' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('DUPLICATE_ACTIVE');
  });

  it('allows new assignment after previous one reaches terminal state', () => {
    const first = createTestAssignment();
    assignmentStore.transitionAssignment(first.assignment!.assignmentId, 'expired', 'proj-1');

    const second = createTestAssignment({ assignee: 'bob' });
    expect(second.ok).toBe(true);
    expect(second.assignment!.assignee).toBe('bob');
  });

  it('increments attempt when superseding', () => {
    const first = createTestAssignment();
    assignmentStore.transitionAssignment(first.assignment!.assignmentId, 'expired', 'proj-1');

    const second = assignmentStore.createAssignment(
      'pipe-1', 'linear:1', 'payload-1', 'bob', 'stage-output', 'proj-1',
      { stage: 1, supersedes: first.assignment!.assignmentId },
    );
    expect(second.ok).toBe(true);
    expect(second.assignment!.attempt).toBe(2);
    expect(second.assignment!.supersedes).toBe(first.assignment!.assignmentId);
  });
});

// ── transitionAssignment ─────────────────────────────────────────────────────

describe('transitionAssignment', () => {
  it('transitions through the happy path', () => {
    const { assignment } = createTestAssignment();
    const id = assignment!.assignmentId;

    const r1 = assignmentStore.transitionAssignment(id, 'notified', 'proj-1');
    expect(r1.ok).toBe(true);
    expect(r1.assignment!.status).toBe('notified');
    expect(r1.assignment!.notifiedAt).toBeTruthy();
    expect(r1.assignment!.version).toBe(2);

    const r2 = assignmentStore.transitionAssignment(id, 'acknowledged', 'proj-1');
    expect(r2.ok).toBe(true);
    expect(r2.assignment!.acknowledgedAt).toBeTruthy();

    const r3 = assignmentStore.transitionAssignment(id, 'payload_fetched', 'proj-1');
    expect(r3.ok).toBe(true);
    expect(r3.assignment!.fetchedAt).toBeTruthy();

    const r4 = assignmentStore.transitionAssignment(id, 'submitted', 'proj-1');
    expect(r4.ok).toBe(true);
    expect(r4.assignment!.submittedAt).toBeTruthy();
    expect(r4.assignment!.version).toBe(5);
  });

  it('rejects invalid transition', () => {
    const { assignment } = createTestAssignment();
    const result = assignmentStore.transitionAssignment(
      assignment!.assignmentId, 'submitted', 'proj-1',
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TRANSITION');
  });

  it('rejects transition on terminal assignment', () => {
    const { assignment } = createTestAssignment();
    const id = assignment!.assignmentId;
    assignmentStore.transitionAssignment(id, 'expired', 'proj-1');

    const result = assignmentStore.transitionAssignment(id, 'notified', 'proj-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ASSIGNMENT_TERMINAL');
  });

  it('returns error for unknown assignment', () => {
    const result = assignmentStore.transitionAssignment('nonexistent', 'notified', 'proj-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ASSIGNMENT_NOT_FOUND');
  });

  it('checks optimistic concurrency version', () => {
    const { assignment } = createTestAssignment();
    const id = assignment!.assignmentId;

    const result = assignmentStore.transitionAssignment(id, 'notified', 'proj-1', { expectedVersion: 99 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VERSION_CONFLICT');

    const ok = assignmentStore.transitionAssignment(id, 'notified', 'proj-1', { expectedVersion: 1 });
    expect(ok.ok).toBe(true);
  });

  it('allows direct transition to expired from any non-terminal state', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'notified', 'proj-1');

    const result = assignmentStore.transitionAssignment(assignment!.assignmentId, 'expired', 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.assignment!.expiredAt).toBeTruthy();
  });

  it('allows direct transition to cancelled from any non-terminal state', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'notified', 'proj-1');
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'acknowledged', 'proj-1');

    const result = assignmentStore.transitionAssignment(assignment!.assignmentId, 'cancelled', 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.assignment!.cancelledAt).toBeTruthy();
  });

  it('removes from active index on terminal transition', () => {
    const { assignment } = createTestAssignment();
    const id = assignment!.assignmentId;

    expect(assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1')).toBeDefined();

    submitAssignment(id);

    expect(assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1')).toBeUndefined();
  });
});

// ── reassignAssignment ───────────────────────────────────────────────────────

describe('reassignAssignment', () => {
  it('reassigns to a new participant', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'notified', 'proj-1');

    const result = assignmentStore.reassignAssignment(
      assignment!.assignmentId, 'bob', 'proj-1', 'participant left',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Old assignment is reassigned
    expect(result.old.status).toBe('reassigned');
    expect(result.old.reassignedAt).toBeTruthy();
    expect(result.old.reassignReason).toBe('participant left');
    expect(result.old.supersededBy).toBe(result.new.assignmentId);

    // New assignment is created
    expect(result.new.assignee).toBe('bob');
    expect(result.new.status).toBe('assigned');
    expect(result.new.attempt).toBe(2);
    expect(result.new.supersedes).toBe(result.old.assignmentId);
    expect(result.new.pipeId).toBe('pipe-1');
    expect(result.new.stageId).toBe('linear:1');
  });

  it('rejects reassignment of terminal assignment', () => {
    const { assignment } = createTestAssignment();
    submitAssignment(assignment!.assignmentId);

    const result = assignmentStore.reassignAssignment(
      assignment!.assignmentId, 'bob', 'proj-1', 'test',
    );
    expect(result.ok).toBe(false);
  });

  it('new assignment becomes the active one', () => {
    const { assignment } = createTestAssignment();
    const result = assignmentStore.reassignAssignment(
      assignment!.assignmentId, 'bob', 'proj-1', 'test',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const active = assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1');
    expect(active).toBeDefined();
    expect(active!.assignee).toBe('bob');
  });
});

// ── cancelPipeAssignments ────────────────────────────────────────────────────

describe('cancelPipeAssignments', () => {
  it('cancels all non-terminal assignments for a pipe', () => {
    createTestAssignment({ stageId: 'linear:1', assignee: 'alice', stage: 1 });
    // Submit the first so it's terminal
    const first = assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1');
    submitAssignment(first!.assignmentId);

    // Create a second that will be cancelled
    createTestAssignment({ stageId: 'linear:2', assignee: 'bob', stage: 2 });

    const cancelled = assignmentStore.cancelPipeAssignments('pipe-1', 'proj-1');
    expect(cancelled).toHaveLength(1);

    // The submitted one should not be affected
    const submitted = assignmentStore.getAssignment(first!.assignmentId, 'proj-1');
    expect(submitted!.status).toBe('submitted');

    // The pending one should be cancelled
    const bobAssignment = assignmentStore.getAssignmentsByPipe('pipe-1', 'proj-1')
      .find(a => a.assignee === 'bob');
    expect(bobAssignment!.status).toBe('cancelled');
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe('queries', () => {
  it('getAssignment returns assignment by ID', () => {
    const { assignment } = createTestAssignment();
    const found = assignmentStore.getAssignment(assignment!.assignmentId, 'proj-1');
    expect(found).toBeDefined();
    expect(found!.assignmentId).toBe(assignment!.assignmentId);
  });

  it('getActiveAssignment returns the non-terminal assignment for a stage', () => {
    createTestAssignment();
    const active = assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1');
    expect(active).toBeDefined();
    expect(active!.status).toBe('assigned');
  });

  it('getActiveAssignment returns undefined for terminal assignments', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'expired', 'proj-1');
    expect(assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1')).toBeUndefined();
  });

  it('getAssignmentsByPipe returns all assignments including terminal', () => {
    createTestAssignment({ stageId: 'linear:1', assignee: 'alice', stage: 1 });
    const first = assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1');
    assignmentStore.transitionAssignment(first!.assignmentId, 'expired', 'proj-1');

    createTestAssignment({ stageId: 'linear:2', assignee: 'bob', stage: 2 });

    const all = assignmentStore.getAssignmentsByPipe('pipe-1', 'proj-1');
    expect(all).toHaveLength(2);
  });

  it('getActiveAssignmentsForParticipant lists pending work', () => {
    createTestAssignment({ pipeId: 'pipe-1', stageId: 'linear:1', assignee: 'alice', stage: 1 });
    createTestAssignment({ pipeId: 'pipe-2', stageId: 'linear:1', assignee: 'alice', stage: 1 });

    const active = assignmentStore.getActiveAssignmentsForParticipant('alice', 'proj-1');
    expect(active).toHaveLength(2);
  });

  it('getActiveAssignmentsForParticipant excludes terminal assignments', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'expired', 'proj-1');

    const active = assignmentStore.getActiveAssignmentsForParticipant('alice', 'proj-1');
    expect(active).toHaveLength(0);
  });
});

// ── Assignment chain ─────────────────────────────────────────────────────────

describe('getAssignmentChain', () => {
  it('returns single assignment when no chain', () => {
    const { assignment } = createTestAssignment();
    const chain = assignmentStore.getAssignmentChain(assignment!.assignmentId, 'proj-1');
    expect(chain).toHaveLength(1);
    expect(chain[0].assignmentId).toBe(assignment!.assignmentId);
  });

  it('returns full chain across reassignments', () => {
    const { assignment: a1 } = createTestAssignment();
    const r1 = assignmentStore.reassignAssignment(a1!.assignmentId, 'bob', 'proj-1', 'test');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = assignmentStore.reassignAssignment(r1.new.assignmentId, 'carol', 'proj-1', 'test2');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Query from any point in the chain
    const chain = assignmentStore.getAssignmentChain(r1.new.assignmentId, 'proj-1');
    expect(chain).toHaveLength(3);
    expect(chain[0].assignee).toBe('alice');
    expect(chain[1].assignee).toBe('bob');
    expect(chain[2].assignee).toBe('carol');
  });
});

// ── Stale access ─────────────────────────────────────────────────────────────

describe('stale access', () => {
  it('isStale returns true for reassigned assignments', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.reassignAssignment(assignment!.assignmentId, 'bob', 'proj-1', 'test');
    expect(assignmentStore.isStale(assignment!.assignmentId, 'proj-1')).toBe(true);
  });

  it('isStale returns false for active assignments', () => {
    const { assignment } = createTestAssignment();
    expect(assignmentStore.isStale(assignment!.assignmentId, 'proj-1')).toBe(false);
  });

  it('staleAccessPolicy returns accept-silent for reassigned', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.reassignAssignment(assignment!.assignmentId, 'bob', 'proj-1', 'test');
    expect(assignmentStore.staleAccessPolicy(assignment!.assignmentId, 'proj-1')).toBe('accept-silent');
  });

  it('staleAccessPolicy returns reject for expired', () => {
    const { assignment } = createTestAssignment();
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'expired', 'proj-1');
    expect(assignmentStore.staleAccessPolicy(assignment!.assignmentId, 'proj-1')).toBe('reject');
  });

  it('staleAccessPolicy returns ok for active', () => {
    const { assignment } = createTestAssignment();
    expect(assignmentStore.staleAccessPolicy(assignment!.assignmentId, 'proj-1')).toBe('ok');
  });
});

// ── toNotification ───────────────────────────────────────────────────────────

describe('toNotification', () => {
  it('produces a compact notification envelope', () => {
    const { assignment } = createTestAssignment();
    const notification = assignmentStore.toNotification(assignment!);

    expect(notification.assignmentId).toBe(assignment!.assignmentId);
    expect(notification.pipeId).toBe('pipe-1');
    expect(notification.stageId).toBe('linear:1');
    expect(notification.role).toBe('stage-output');
    expect(notification.stage).toBe(1);
    expect(notification.attempt).toBe(1);
    expect(notification.payloadId).toBe('payload-1');
    // Should NOT contain content, timestamps, or chain info
    expect(notification).not.toHaveProperty('content');
    expect(notification).not.toHaveProperty('createdAt');
    expect(notification).not.toHaveProperty('supersededBy');
  });
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

describe('cleanupTerminalAssignments', () => {
  it('removes terminal assignments older than TTL', () => {
    const clock = createTestClock();
    assignmentStore.setClock(clock);

    createTestAssignment();
    const active = assignmentStore.getActiveAssignment('pipe-1', 'linear:1', 'proj-1');
    assignmentStore.transitionAssignment(active!.assignmentId, 'expired', 'proj-1');

    // Not enough time has passed
    clock.advance(1000);
    expect(assignmentStore.cleanupTerminalAssignments('proj-1', 5000)).toBe(0);

    // Now enough time has passed
    clock.advance(5000);
    expect(assignmentStore.cleanupTerminalAssignments('proj-1', 5000)).toBe(1);
  });

  it('does not remove active assignments', () => {
    const clock = createTestClock();
    assignmentStore.setClock(clock);

    createTestAssignment();
    clock.advance(100_000);
    expect(assignmentStore.cleanupTerminalAssignments('proj-1', 1000)).toBe(0);
  });
});

// ── Recovery ─────────────────────────────────────────────────────────────────

describe('rehydrateFromEvents', () => {
  it('recreates assignment from creation event', () => {
    const events: assignmentStore.AssignmentRecoveryEvent[] = [
      {
        type: 'assignment-created',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        payloadId: 'payload-1',
        assignee: 'alice',
        role: 'stage-output',
        stage: 1,
      },
    ];

    const active = assignmentStore.rehydrateFromEvents(events, 'proj-1');
    expect(active).toContain('a-001');

    const assignment = assignmentStore.getAssignment('a-001', 'proj-1');
    expect(assignment).toBeDefined();
    expect(assignment!.assignee).toBe('alice');
    expect(assignment!.status).toBe('assigned');
  });

  it('replays transitions', () => {
    const events: assignmentStore.AssignmentRecoveryEvent[] = [
      {
        type: 'assignment-created',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        payloadId: 'payload-1',
        assignee: 'alice',
        role: 'stage-output',
        stage: 1,
      },
      {
        type: 'assignment-transitioned',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        status: 'notified',
      },
      {
        type: 'assignment-transitioned',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        status: 'acknowledged',
      },
    ];

    const active = assignmentStore.rehydrateFromEvents(events, 'proj-1');
    expect(active).toContain('a-001');

    const assignment = assignmentStore.getAssignment('a-001', 'proj-1');
    expect(assignment!.status).toBe('acknowledged');
  });

  it('marks terminal assignments as not active', () => {
    const events: assignmentStore.AssignmentRecoveryEvent[] = [
      {
        type: 'assignment-created',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        payloadId: 'payload-1',
        assignee: 'alice',
        role: 'stage-output',
        stage: 1,
      },
      {
        type: 'assignment-transitioned',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        status: 'notified',
      },
      {
        type: 'assignment-transitioned',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        status: 'acknowledged',
      },
      {
        type: 'assignment-transitioned',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        status: 'payload_fetched',
      },
      {
        type: 'assignment-transitioned',
        assignmentId: 'a-001',
        pipeId: 'pipe-1',
        stageId: 'linear:1',
        status: 'submitted',
      },
    ];

    const active = assignmentStore.rehydrateFromEvents(events, 'proj-1');
    expect(active).not.toContain('a-001');
  });
});

// ── Clock injection ──────────────────────────────────────────────────────────

describe('clock injection', () => {
  it('uses injected clock for timestamps', () => {
    const clock = createTestClock(1700000000000); // 2023-11-14T22:13:20Z
    assignmentStore.setClock(clock);

    const { assignment } = createTestAssignment();
    expect(assignment!.createdAt).toBe('2023-11-14T22:13:20.000Z');

    clock.advance(5000);
    assignmentStore.transitionAssignment(assignment!.assignmentId, 'notified', 'proj-1');

    const updated = assignmentStore.getAssignment(assignment!.assignmentId, 'proj-1');
    expect(updated!.notifiedAt).toBe('2023-11-14T22:13:25.000Z');
  });
});
