import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as pipeStore from './pipe-store.js';

describe('Reconnect recovery — assignment queries', () => {
  beforeEach(() => {
    pipeStore._resetForTest();
  });

  it('getAssignmentsForParticipant returns pending slots for running pipes', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test prompt', null);
    const assignments = pipeStore.getAssignmentsForParticipant('alice', null);
    expect(assignments.length).toBe(1);
    expect(assignments[0].pipeId).toBe('pipe-1');
    expect(assignments[0].slotStatus).toBe('pending');
  });

  it('getAssignmentsForParticipant excludes submitted slots', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', null);
    pipeStore.grantLease('pipe-1', 'alice', null);
    pipeStore.submitStage('pipe-1', 'alice', 'output', null);
    const assignments = pipeStore.getAssignmentsForParticipant('alice', null);
    expect(assignments.length).toBe(0);
  });

  it('getAssignmentsForParticipant shows leased slot with active lease status', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', null);
    pipeStore.grantLease('pipe-1', 'alice', null);
    const assignments = pipeStore.getAssignmentsForParticipant('alice', null);
    expect(assignments.length).toBe(1);
    expect(assignments[0].slotStatus).toBe('leased');
    expect(assignments[0].leaseStatus).toBe('active');
  });

  it('getAssignmentsForParticipant returns empty for non-running pipes', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', null);
    pipeStore.markPipeStatus('pipe-1', 'failed', null);
    // markPipeStatus removes from activePipeIndex
    const assignments = pipeStore.getAssignmentsForParticipant('alice', null);
    expect(assignments.length).toBe(0);
  });

  it('getAssignmentsForParticipant returns assignments across multiple pipes', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'prompt 1', null);
    pipeStore.createPipe('pipe-2', 'linear', ['alice', 'carol'], 'prompt 2', null);
    const assignments = pipeStore.getAssignmentsForParticipant('alice', null);
    expect(assignments.length).toBe(2);
    expect(assignments.map(a => a.pipeId)).toContain('pipe-1');
    expect(assignments.map(a => a.pipeId)).toContain('pipe-2');
  });

  it('expired lease is detected in assignment listing', () => {
    vi.useFakeTimers();
    try {
      pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', null, {
        stageTimeoutMs: 5000,
      });
      pipeStore.grantLease('pipe-1', 'alice', null);
      vi.advanceTimersByTime(6000);
      const assignments = pipeStore.getAssignmentsForParticipant('alice', null);
      expect(assignments.length).toBe(1);
      expect(assignments[0].leaseStatus).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('isLeaseExpired returns false for lease without deadline', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', null, {
      stageTimeoutMs: 0,
    });
    const result = pipeStore.grantLease('pipe-1', 'alice', null);
    expect(result.ok).toBe(true);
    expect(result.lease!.deadline).toBeNull();
    expect(pipeStore.isLeaseExpired(result.lease!)).toBe(false);
  });

  it('isLeaseExpired returns true for expired lease', () => {
    vi.useFakeTimers();
    try {
      pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', null, {
        stageTimeoutMs: 5000,
      });
      const result = pipeStore.grantLease('pipe-1', 'alice', null);
      expect(result.ok).toBe(true);
      vi.advanceTimersByTime(6000);
      expect(pipeStore.isLeaseExpired(result.lease!)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getAssignmentsForParticipant scopes by projectId', () => {
    pipeStore.createPipe('pipe-1', 'linear', ['alice', 'bob'], 'test', 'proj-a');
    pipeStore.createPipe('pipe-2', 'linear', ['alice', 'carol'], 'test', 'proj-b');
    const assignmentsA = pipeStore.getAssignmentsForParticipant('alice', 'proj-a');
    const assignmentsB = pipeStore.getAssignmentsForParticipant('alice', 'proj-b');
    expect(assignmentsA.length).toBe(1);
    expect(assignmentsA[0].pipeId).toBe('pipe-1');
    expect(assignmentsB.length).toBe(1);
    expect(assignmentsB[0].pipeId).toBe('pipe-2');
  });

  it('merge-all pipe shows both fan-out and final slots for last assignee', () => {
    pipeStore.createPipe('pipe-1', 'merge-all', ['alice', 'bob'], 'test', null);
    // bob (last) should have both fan-out and final slots
    const assignments = pipeStore.getAssignmentsForParticipant('bob', null);
    expect(assignments.length).toBe(2);
    expect(assignments.map(a => a.role)).toContain('fan-out');
    expect(assignments.map(a => a.role)).toContain('final');
  });

  it('rehydrated pipe preserves assignments for reconnecting participants', () => {
    // Simulate: pipe created, stage 1 submitted, then server restart
    const events: pipeStore.PipeRecoveryEvent[] = [
      { type: 'start', pipeId: 'pipe-r', mode: 'linear', assignees: ['alice', 'bob', 'carol'], prompt: 'test' },
      { type: 'stage-output', pipeId: 'pipe-r', from: 'alice', content: 'alice output' },
    ];
    const running = pipeStore.rehydrateFromEvents(events, null);
    expect(running).toContain('pipe-r');

    // bob should have a pending assignment (stage 2)
    const bobAssignments = pipeStore.getAssignmentsForParticipant('bob', null);
    expect(bobAssignments.length).toBe(1);
    expect(bobAssignments[0].pipeId).toBe('pipe-r');
    expect(bobAssignments[0].slotStatus).toBe('pending');

    // alice should have no pending assignments (already submitted)
    const aliceAssignments = pipeStore.getAssignmentsForParticipant('alice', null);
    expect(aliceAssignments.length).toBe(0);

    // carol should have a pending assignment (stage 3, not yet reached)
    const carolAssignments = pipeStore.getAssignmentsForParticipant('carol', null);
    expect(carolAssignments.length).toBe(1);
    expect(carolAssignments[0].slotStatus).toBe('pending');
  });
});
