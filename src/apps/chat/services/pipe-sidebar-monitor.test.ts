import { describe, it, expect, beforeEach } from 'vitest';
import * as pipeStore from './pipe-store.js';
import * as provenanceStore from './pipe-provenance.js';

/**
 * Focused verification for the pipe monitoring sidebar.
 *
 * Tests the data layer patterns that the sidebar UI relies on:
 * - Initial load (listAllPipes + getRuntimeLeaseStatuses + getDeadLetterEntries)
 * - Drilldown (getPipeStatus + getPipeTimingSummary)
 * - Cancel action (cancelPipe + status transition)
 * - Representative render states (running, completed, failed, cancelled, dead-lettered)
 */

const projectId = 'sidebar-test';

beforeEach(() => {
  pipeStore._resetForTest();
  provenanceStore._resetForTest();
});

// ── Initial Load ─────────────────────────────────────────────────────────────

describe('Sidebar initial load', () => {
  it('returns all pipes with slot summaries for the pipe list', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'prompt1', projectId);
    pipeStore.createPipe('p2', 'merge', ['alice', 'bob', 'carol'], 'prompt2', projectId);

    const all = pipeStore.listAllPipes(projectId);
    expect(all).toHaveLength(2);

    const p1 = all.find(p => p.pipeId === 'p1')!;
    expect(p1.mode).toBe('linear');
    expect(p1.status).toBe('running');
    expect(p1.slotSummary).toBeDefined();
    expect(p1.slotSummary.total).toBe(2);
    expect(p1.slotSummary.pending).toBe(2);
    expect(p1.slotSummary.submitted).toBe(0);

    const p2 = all.find(p => p.pipeId === 'p2')!;
    expect(p2.mode).toBe('merge');
    expect(p2.slotSummary.total).toBe(3);
  });

  it('returns lease statuses for countdown badges', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId, {
      stageTimeoutMs: 60000,
    });
    pipeStore.grantLease('p1', 'alice', projectId);

    const leases = pipeStore.getRuntimeLeaseStatuses(projectId);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      pipeId: 'p1',
      assignee: 'alice',
      isOverdue: false,
    });
    expect(leases[0].deadline).toBeDefined();
    expect(leases[0].remainingMs).toBeGreaterThan(0);
    expect(leases[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty dead-letters for healthy pipes', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId, {
      stageTimeoutMs: 300000,
    });
    pipeStore.grantLease('p1', 'alice', projectId);
    expect(pipeStore.getDeadLetterEntries(projectId)).toHaveLength(0);
  });

  it('isolates pipe data by project', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId);
    pipeStore.createPipe('p2', 'linear', ['bob'], 'test', 'other-project');

    expect(pipeStore.listAllPipes(projectId)).toHaveLength(1);
    expect(pipeStore.listAllPipes('other-project')).toHaveLength(1);
  });
});

// ── Drilldown ────────────────────────────────────────────────────────────────

describe('Sidebar drilldown', () => {
  it('returns detailed pipe status with slots and prompt', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'my prompt', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);

    const status = pipeStore.getPipeStatus('p1', projectId);
    expect(status).toBeDefined();
    expect(status!.prompt).toBe('my prompt');
    expect(status!.slots).toHaveLength(2);
    expect(status!.assignees).toEqual(['alice', 'bob']);

    const aliceSlot = status!.slots.find(s => s.assignee === 'alice');
    expect(aliceSlot?.role).toBe('stage-output');
    expect(aliceSlot?.status).toBe('leased');

    const bobSlot = status!.slots.find(s => s.assignee === 'bob');
    expect(bobSlot?.status).toBe('pending');
  });

  it('returns timing summary for completed pipes', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);
    pipeStore.submitStage('p1', 'alice', 'output-a', projectId, true);
    pipeStore.grantLease('p1', 'bob', projectId);
    pipeStore.submitStage('p1', 'bob', 'output-b', projectId, true);
    pipeStore.markPipeStatus('p1', 'completed', projectId);

    const timing = pipeStore.getPipeTimingSummary('p1', projectId);
    expect(timing).toBeDefined();
    expect(timing!.status).toBe('completed');
    expect(timing!.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(timing!.stages).toHaveLength(2);
    expect(timing!.stages.every(s => s.submittedAt !== null)).toBe(true);
    expect(timing!.stages.every(s => s.durationMs === null || typeof s.durationMs === 'number')).toBe(true);
  });

  it('returns undefined for non-existent pipe', () => {
    expect(pipeStore.getPipeStatus('no-such-pipe', projectId)).toBeUndefined();
    expect(pipeStore.getPipeTimingSummary('no-such-pipe', projectId)).toBeUndefined();
  });
});

// ── Cancel Action ────────────────────────────────────────────────────────────

describe('Sidebar cancel action', () => {
  it('transitions pipe from running to cancelled', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);

    pipeStore.markPipeStatus('p1', 'cancelled', projectId);

    const all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('cancelled');

    // Leases should be cleared after cancellation
    const leases = pipeStore.getRuntimeLeaseStatuses(projectId);
    expect(leases).toHaveLength(0);
  });

  it('cancel is idempotent for already-terminal pipes', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId);
    pipeStore.markPipeStatus('p1', 'completed', projectId);

    // Re-marking as cancelled on an already-completed pipe should not crash
    pipeStore.markPipeStatus('p1', 'cancelled', projectId);
    const all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('cancelled');
  });
});

// ── Representative Render States ─────────────────────────────────────────────

describe('Sidebar render states', () => {
  it('running pipe: has leases, pending slots, no timing', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId, {
      stageTimeoutMs: 60000,
    });
    pipeStore.grantLease('p1', 'alice', projectId);

    const all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('running');
    expect(all[0].slotSummary.leased).toBe(1);
    expect(all[0].slotSummary.pending).toBe(1);

    const leases = pipeStore.getRuntimeLeaseStatuses(projectId);
    expect(leases.length).toBeGreaterThan(0);

    // Timing not yet available (pipe still running)
    const timing = pipeStore.getPipeTimingSummary('p1', projectId);
    expect(timing!.completedAt).toBeNull();
    expect(timing!.totalDurationMs).toBeNull();
  });

  it('completed pipe: all slots submitted, timing available', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);
    pipeStore.submitStage('p1', 'alice', 'done', projectId, true);
    pipeStore.markPipeStatus('p1', 'completed', projectId);

    const all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('completed');
    expect(all[0].slotSummary.submitted).toBe(1);

    const timing = pipeStore.getPipeTimingSummary('p1', projectId);
    expect(timing!.completedAt).toBeDefined();
    expect(timing!.totalDurationMs).toBeGreaterThanOrEqual(0);

    // No active leases
    expect(pipeStore.getRuntimeLeaseStatuses(projectId)).toHaveLength(0);
  });

  it('failed pipe: status transitions, timing captures partial work', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);
    pipeStore.submitStage('p1', 'alice', 'partial', projectId, true);
    pipeStore.markPipeStatus('p1', 'failed', projectId);

    const all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('failed');

    const timing = pipeStore.getPipeTimingSummary('p1', projectId);
    expect(timing!.status).toBe('failed');

    // Alice submitted, bob never did
    const aliceStage = timing!.stages.find(s => s.assignee === 'alice');
    const bobStage = timing!.stages.find(s => s.assignee === 'bob');
    expect(aliceStage?.submittedAt).not.toBeNull();
    expect(bobStage?.submittedAt).toBeNull();
  });

  it('cancelled pipe: visible in pipe list with cancelled status', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId);
    pipeStore.markPipeStatus('p1', 'cancelled', projectId);

    const all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('cancelled');
  });

  it('merge pipe with partial fan-out: slot summary reflects progress', () => {
    pipeStore.createPipe('p1', 'merge', ['alice', 'bob', 'carol'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);
    pipeStore.grantLease('p1', 'bob', projectId);
    pipeStore.submitStage('p1', 'alice', 'alice-out', projectId, true);

    const all = pipeStore.listAllPipes(projectId);
    const p = all[0];
    expect(p.slotSummary.submitted).toBe(1);
    expect(p.slotSummary.leased).toBeGreaterThanOrEqual(1);
    expect(p.slotSummary.total).toBe(3); // alice(fan-out) + bob(fan-out) + carol(final)
  });
});

// ── Event-Driven Refresh ─────────────────────────────────────────────────────

describe('Sidebar refresh on state changes', () => {
  it('slot summary updates after submission', () => {
    pipeStore.createPipe('p1', 'linear', ['alice', 'bob'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);

    let before = pipeStore.listAllPipes(projectId)[0];
    expect(before.slotSummary.submitted).toBe(0);

    pipeStore.submitStage('p1', 'alice', 'output', projectId, true);

    let after = pipeStore.listAllPipes(projectId)[0];
    expect(after.slotSummary.submitted).toBe(1);
  });

  it('pipe status reflects completion in list', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId);
    pipeStore.grantLease('p1', 'alice', projectId);
    pipeStore.submitStage('p1', 'alice', 'done', projectId, true);

    let all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('running');

    pipeStore.markPipeStatus('p1', 'completed', projectId);

    all = pipeStore.listAllPipes(projectId);
    expect(all[0].status).toBe('completed');
  });

  it('leases disappear after submission', () => {
    pipeStore.createPipe('p1', 'linear', ['alice'], 'test', projectId, {
      stageTimeoutMs: 60000,
    });
    pipeStore.grantLease('p1', 'alice', projectId);
    expect(pipeStore.getRuntimeLeaseStatuses(projectId)).toHaveLength(1);

    pipeStore.submitStage('p1', 'alice', 'done', projectId, true);
    expect(pipeStore.getRuntimeLeaseStatuses(projectId)).toHaveLength(0);
  });
});

// ── Provenance (optional for MVP — verify basic availability) ────────────────

describe('Sidebar provenance', () => {
  it('provenance records are queryable per pipe', () => {
    provenanceStore.recordProvenance(projectId, {
      pipeId: 'p1', event: 'created', actor: 'user', actorKind: 'user',
    });
    provenanceStore.recordProvenance(projectId, {
      pipeId: 'p1', event: 'stage-granted', actor: 'system', actorKind: 'system',
      stage: 1, metadata: { assignee: 'alice' },
    });

    const records = provenanceStore.getProvenanceForPipe('p1', projectId);
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe('created');
    expect(records[1].event).toBe('stage-granted');
  });
});
