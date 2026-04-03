import { describe, it, expect, beforeEach } from 'vitest';
import * as materializer from './pipe-assignment-materializer.js';
import * as assignmentStore from './assignment-store.js';
import * as payloadStore from './payload-store.js';

const PROJECT = 'test-project';

beforeEach(() => {
  assignmentStore._resetForTest();
  payloadStore._resetForTest();
});

// ── materializeAssignment ───────────────────────────────────────────────────

describe('materializeAssignment', () => {
  it('creates assignment + payload for a handoff action', () => {
    const result = materializer.materializeAssignment('pipe-1', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'Analyze this code',
    }, PROJECT);

    expect(result).not.toBeNull();
    expect(result!.assignee).toBe('alice');
    expect(result!.role).toBe('stage-output');
    expect(result!.stage).toBe(1);
    expect(result!.stageId).toBe('linear:1');
    expect(result!.assignmentId).toBeTruthy();
    expect(result!.payloadId).toBeTruthy();
  });

  it('creates assignment + payload for a fan-out-request action', () => {
    const result = materializer.materializeAssignment('pipe-2', 'merge', {
      type: 'fan-out-request',
      targetAssignee: 'bob',
      body: 'Give your opinion',
    }, PROJECT);

    expect(result).not.toBeNull();
    expect(result!.assignee).toBe('bob');
    expect(result!.role).toBe('fan-out');
    expect(result!.stageId).toBe('fan-out:bob');
    expect(result!.stage).toBeUndefined();
  });

  it('creates assignment + payload for a synth-request action', () => {
    const result = materializer.materializeAssignment('pipe-3', 'merge', {
      type: 'synth-request',
      targetAssignee: 'charlie',
      body: 'Synthesize all outputs',
    }, PROJECT);

    expect(result).not.toBeNull();
    expect(result!.assignee).toBe('charlie');
    expect(result!.role).toBe('final');
    expect(result!.stageId).toBe('synth');
  });

  it('returns null when payload creation fails (e.g. too large)', () => {
    payloadStore.setMaxPayloadBytes(10); // very small limit
    const result = materializer.materializeAssignment('pipe-4', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'This body exceeds the tiny payload limit',
    }, PROJECT);

    expect(result).toBeNull();
  });
});

// ── Notification envelope ───────────────────────────────────────────────────

describe('notification envelope', () => {
  it('contains correct fields in materialized result', () => {
    const result = materializer.materializeAssignment('pipe-n', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 2,
      body: 'Stage 2 prompt',
    }, PROJECT);

    expect(result).not.toBeNull();
    const n = result!.notification;
    expect(n.assignmentId).toBe(result!.assignmentId);
    expect(n.pipeId).toBe('pipe-n');
    expect(n.stageId).toBe('linear:2');
    expect(n.role).toBe('stage-output');
    expect(n.stage).toBe(2);
    expect(n.attempt).toBe(1);
    expect(n.payloadId).toBe(result!.payloadId);
  });

  it('can retrieve notification for an existing assignment', () => {
    const result = materializer.materializeAssignment('pipe-n2', 'merge', {
      type: 'fan-out-request',
      targetAssignee: 'bob',
      body: 'Fan out prompt',
    }, PROJECT);

    const notification = materializer.getAssignmentNotification(result!.assignmentId, PROJECT);
    expect(notification).not.toBeNull();
    expect(notification!.assignmentId).toBe(result!.assignmentId);
    expect(notification!.pipeId).toBe('pipe-n2');
    expect(notification!.role).toBe('fan-out');
    expect(notification!.payloadId).toBe(result!.payloadId);
  });

  it('returns null for non-existent assignment', () => {
    const notification = materializer.getAssignmentNotification('nonexistent', PROJECT);
    expect(notification).toBeNull();
  });
});

// ── Payload integrity ───────────────────────────────────────────────────────

describe('payload integrity', () => {
  it('stores content with SHA-256 hash', () => {
    const body = 'Important analysis content';
    const result = materializer.materializeAssignment('pipe-hash', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body,
    }, PROJECT);

    expect(result).not.toBeNull();

    // Verify payload content and hash via payload store
    const fetchResult = payloadStore.fetchPayloadContent(result!.payloadId, PROJECT);
    expect(fetchResult.ok).toBe(true);
    if (fetchResult.ok) {
      expect(fetchResult.content).toBe(body);
      expect(fetchResult.contentHash).toBeTruthy();
      expect(fetchResult.contentHash.length).toBe(64); // SHA-256 hex is 64 chars
    }
  });

  it('stores content that matches the action body', () => {
    const body = 'Exact content to verify';
    const result = materializer.materializeAssignment('pipe-content', 'merge', {
      type: 'fan-out-request',
      targetAssignee: 'bob',
      body,
    }, PROJECT);

    const payload = payloadStore.getPayload(result!.payloadId, PROJECT);
    expect(payload).toBeDefined();
    expect(payload!.content).toBe(body);
    expect(payload!.pipeId).toBe('pipe-content');
    expect(payload!.stageId).toBe('fan-out:bob');
  });
});

// ── materializePipeAssignments (linear) ─────────────────────────────────────

describe('materializePipeAssignments — linear', () => {
  it('creates only stage 1 assignment for a linear pipe', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-lin', 'linear', ['alice', 'bob', 'charlie'], 'Analyze step by step', PROJECT,
    );

    expect(results).toHaveLength(1);
    expect(results[0].assignee).toBe('alice');
    expect(results[0].stage).toBe(1);
    expect(results[0].role).toBe('stage-output');
    expect(results[0].stageId).toBe('linear:1');
  });

  it('creates payload with the prompt as content', () => {
    const prompt = 'Linear pipe prompt';
    const results = materializer.materializePipeAssignments(
      'pipe-lin2', 'linear', ['alice', 'bob'], prompt, PROJECT,
    );

    const payload = payloadStore.getPayload(results[0].payloadId, PROJECT);
    expect(payload!.content).toBe(prompt);
  });
});

// ── materializeNextLinearAssignment ─────────────────────────────────────────

describe('materializeNextLinearAssignment', () => {
  it('creates stage 2 assignment after stage 1 completes', () => {
    // Materialize stage 1
    const stage1 = materializer.materializePipeAssignments(
      'pipe-next', 'linear', ['alice', 'bob', 'charlie'], 'Initial prompt', PROJECT,
    );
    expect(stage1).toHaveLength(1);

    // Complete stage 1 (transition through lifecycle)
    materializer.transitionAssignmentStatus(stage1[0].assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(stage1[0].assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(stage1[0].assignmentId, 'payload_fetched', PROJECT);
    materializer.completeAssignment(stage1[0].assignmentId, PROJECT);

    // Materialize stage 2
    const stage2 = materializer.materializeNextLinearAssignment(
      'pipe-next', 1, ['alice', 'bob', 'charlie'], 'Stage 1 output', PROJECT,
    );

    expect(stage2).not.toBeNull();
    expect(stage2!.assignee).toBe('bob');
    expect(stage2!.stage).toBe(2);
    expect(stage2!.stageId).toBe('linear:2');
    expect(stage2!.role).toBe('stage-output');
  });

  it('creates stage 3 assignment after stage 2 completes', () => {
    // Set up stage 1 and complete it
    materializer.materializePipeAssignments(
      'pipe-s3', 'linear', ['a', 'b', 'c'], 'prompt', PROJECT,
    );
    const assignments = assignmentStore.getAssignmentsByPipe('pipe-s3', PROJECT);
    const s1 = assignments[0];
    assignmentStore.transitionAssignment(s1.assignmentId, 'notified', PROJECT);
    assignmentStore.transitionAssignment(s1.assignmentId, 'acknowledged', PROJECT);
    assignmentStore.transitionAssignment(s1.assignmentId, 'payload_fetched', PROJECT);
    assignmentStore.transitionAssignment(s1.assignmentId, 'submitted', PROJECT);

    // Materialize and complete stage 2
    const s2 = materializer.materializeNextLinearAssignment(
      'pipe-s3', 1, ['a', 'b', 'c'], 'output-1', PROJECT,
    );
    assignmentStore.transitionAssignment(s2!.assignmentId, 'notified', PROJECT);
    assignmentStore.transitionAssignment(s2!.assignmentId, 'acknowledged', PROJECT);
    assignmentStore.transitionAssignment(s2!.assignmentId, 'payload_fetched', PROJECT);
    assignmentStore.transitionAssignment(s2!.assignmentId, 'submitted', PROJECT);

    // Materialize stage 3
    const s3 = materializer.materializeNextLinearAssignment(
      'pipe-s3', 2, ['a', 'b', 'c'], 'output-2', PROJECT,
    );
    expect(s3).not.toBeNull();
    expect(s3!.assignee).toBe('c');
    expect(s3!.stage).toBe(3);
  });

  it('returns null when all stages are complete', () => {
    materializer.materializePipeAssignments(
      'pipe-done', 'linear', ['alice', 'bob'], 'prompt', PROJECT,
    );
    // Complete stage 1
    const assignments = assignmentStore.getAssignmentsByPipe('pipe-done', PROJECT);
    assignmentStore.transitionAssignment(assignments[0].assignmentId, 'notified', PROJECT);
    assignmentStore.transitionAssignment(assignments[0].assignmentId, 'acknowledged', PROJECT);
    assignmentStore.transitionAssignment(assignments[0].assignmentId, 'payload_fetched', PROJECT);
    assignmentStore.transitionAssignment(assignments[0].assignmentId, 'submitted', PROJECT);

    // Complete stage 2
    const s2 = materializer.materializeNextLinearAssignment(
      'pipe-done', 1, ['alice', 'bob'], 'output-1', PROJECT,
    );
    assignmentStore.transitionAssignment(s2!.assignmentId, 'notified', PROJECT);
    assignmentStore.transitionAssignment(s2!.assignmentId, 'acknowledged', PROJECT);
    assignmentStore.transitionAssignment(s2!.assignmentId, 'payload_fetched', PROJECT);
    assignmentStore.transitionAssignment(s2!.assignmentId, 'submitted', PROJECT);

    // No stage 3 — should return null
    const s3 = materializer.materializeNextLinearAssignment(
      'pipe-done', 2, ['alice', 'bob'], 'output-2', PROJECT,
    );
    expect(s3).toBeNull();
  });
});

// ── materializePipeAssignments (merge) ──────────────────────────────────────

describe('materializePipeAssignments — merge', () => {
  it('creates fan-out assignments for all assignees except synthesizer', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-merge', 'merge', ['alice', 'bob', 'charlie'], 'Compare approaches', PROJECT,
    );

    // merge: last assignee is synthesizer, rest are fan-out
    expect(results).toHaveLength(2);
    expect(results[0].assignee).toBe('alice');
    expect(results[0].role).toBe('fan-out');
    expect(results[0].stageId).toBe('fan-out:alice');
    expect(results[1].assignee).toBe('bob');
    expect(results[1].role).toBe('fan-out');
    expect(results[1].stageId).toBe('fan-out:bob');
  });

  it('does not create synthesizer assignment during initial materialization', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-merge2', 'merge', ['alice', 'bob', 'charlie'], 'prompt', PROJECT,
    );

    // No assignment for charlie (synthesizer)
    const assigneeNames = results.map(r => r.assignee);
    expect(assigneeNames).not.toContain('charlie');
  });
});

// ── materializePipeAssignments (merge-all) ──────────────────────────────────

describe('materializePipeAssignments — merge-all', () => {
  it('creates fan-out assignments for ALL assignees including synthesizer', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-mall', 'merge-all', ['alice', 'bob', 'charlie'], 'Everyone weighs in', PROJECT,
    );

    expect(results).toHaveLength(3);
    expect(results[0].assignee).toBe('alice');
    expect(results[1].assignee).toBe('bob');
    expect(results[2].assignee).toBe('charlie');
    results.forEach(r => {
      expect(r.role).toBe('fan-out');
    });
  });
});

// ── materializePipeAssignments (explain / summarize) ────────────────────────

describe('materializePipeAssignments — explain', () => {
  it('creates fan-out assignments for all assignees (explain is merge-all style)', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-exp', 'explain', ['alice', 'bob'], 'Explain closures', PROJECT,
    );

    expect(results).toHaveLength(2);
    expect(results[0].assignee).toBe('alice');
    expect(results[1].assignee).toBe('bob');
  });
});

describe('materializePipeAssignments — summarize', () => {
  it('creates fan-out assignments for all assignees (summarize is merge-all style)', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-sum', 'summarize', ['alice', 'bob', 'charlie'], 'Summarize findings', PROJECT,
    );

    expect(results).toHaveLength(3);
  });
});

// ── materializeSynthAssignment ──────────────────────────────────────────────

describe('materializeSynthAssignment', () => {
  it('creates a synth assignment with final role', () => {
    const result = materializer.materializeSynthAssignment(
      'pipe-synth', 'merge', 'charlie', 'Synthesize: alice said X, bob said Y', PROJECT,
    );

    expect(result).not.toBeNull();
    expect(result!.assignee).toBe('charlie');
    expect(result!.role).toBe('final');
    expect(result!.stageId).toBe('synth');
    expect(result!.stage).toBeUndefined();
  });

  it('stores the synthesis prompt as payload content', () => {
    const synthBody = 'Combine outputs from alice and bob';
    const result = materializer.materializeSynthAssignment(
      'pipe-synth2', 'merge', 'charlie', synthBody, PROJECT,
    );

    const payload = payloadStore.getPayload(result!.payloadId, PROJECT);
    expect(payload!.content).toBe(synthBody);
  });
});

// ── completeAssignment ──────────────────────────────────────────────────────

describe('completeAssignment', () => {
  it('transitions assignment to submitted', () => {
    const result = materializer.materializeAssignment('pipe-comp', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'Do something',
    }, PROJECT);

    // Walk through lifecycle
    materializer.transitionAssignmentStatus(result!.assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'payload_fetched', PROJECT);

    const ok = materializer.completeAssignment(result!.assignmentId, PROJECT);
    expect(ok).toBe(true);

    // Verify assignment is in submitted status
    const assignment = assignmentStore.getAssignment(result!.assignmentId, PROJECT);
    expect(assignment!.status).toBe('submitted');
  });

  it('fast-forwards from assigned to submitted (supports submit-without-fetch)', () => {
    const result = materializer.materializeAssignment('pipe-comp2', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'Work',
    }, PROJECT);

    // completeAssignment fast-forwards through all intermediate states
    // This supports the observed LLM pattern of submitting without calling pipe_read_output
    const ok = materializer.completeAssignment(result!.assignmentId, PROJECT);
    expect(ok).toBe(true);

    const assignment = assignmentStore.getAssignment(result!.assignmentId, PROJECT);
    expect(assignment!.status).toBe('submitted');
  });
});

// ── transitionAssignmentStatus ──────────────────────────────────────────────

describe('transitionAssignmentStatus', () => {
  it('transitions through the full lifecycle', () => {
    const result = materializer.materializeAssignment('pipe-trans', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'Task',
    }, PROJECT);

    const id = result!.assignmentId;

    const a1 = materializer.transitionAssignmentStatus(id, 'notified', PROJECT);
    expect(a1).not.toBeNull();
    expect(a1!.status).toBe('notified');

    const a2 = materializer.transitionAssignmentStatus(id, 'acknowledged', PROJECT);
    expect(a2!.status).toBe('acknowledged');

    const a3 = materializer.transitionAssignmentStatus(id, 'payload_fetched', PROJECT);
    expect(a3!.status).toBe('payload_fetched');

    const a4 = materializer.transitionAssignmentStatus(id, 'submitted', PROJECT);
    expect(a4!.status).toBe('submitted');
  });

  it('returns null for invalid transition', () => {
    const result = materializer.materializeAssignment('pipe-invalid', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'Task',
    }, PROJECT);

    // Can't go directly to payload_fetched from assigned
    const a = materializer.transitionAssignmentStatus(result!.assignmentId, 'payload_fetched', PROJECT);
    expect(a).toBeNull();
  });

  it('returns null for non-existent assignment', () => {
    const a = materializer.transitionAssignmentStatus('nonexistent', 'notified', PROJECT);
    expect(a).toBeNull();
  });
});

// ── cancelPipeAssignments ───────────────────────────────────────────────────

describe('cancelPipeAssignments', () => {
  it('cancels all active assignments for a pipe', () => {
    // Create fan-out assignments
    materializer.materializePipeAssignments(
      'pipe-cancel', 'merge', ['alice', 'bob', 'charlie'], 'prompt', PROJECT,
    );

    const cancelled = materializer.cancelPipeAssignments('pipe-cancel', PROJECT);
    expect(cancelled).toHaveLength(2); // alice and bob fan-outs

    // Verify all are cancelled
    const assignments = assignmentStore.getAssignmentsByPipe('pipe-cancel', PROJECT);
    for (const a of assignments) {
      expect(a.status).toBe('cancelled');
    }
  });

  it('returns empty array when no active assignments exist', () => {
    const cancelled = materializer.cancelPipeAssignments('nonexistent-pipe', PROJECT);
    expect(cancelled).toHaveLength(0);
  });

  it('does not cancel already terminal assignments', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-partial-cancel', 'merge', ['alice', 'bob', 'charlie'], 'prompt', PROJECT,
    );

    // Complete alice's assignment
    const aliceId = results[0].assignmentId;
    assignmentStore.transitionAssignment(aliceId, 'notified', PROJECT);
    assignmentStore.transitionAssignment(aliceId, 'acknowledged', PROJECT);
    assignmentStore.transitionAssignment(aliceId, 'payload_fetched', PROJECT);
    assignmentStore.transitionAssignment(aliceId, 'submitted', PROJECT);

    // Cancel remaining — should only cancel bob's
    const cancelled = materializer.cancelPipeAssignments('pipe-partial-cancel', PROJECT);
    expect(cancelled).toHaveLength(1);

    // Alice should still be submitted
    const alice = assignmentStore.getAssignment(aliceId, PROJECT);
    expect(alice!.status).toBe('submitted');
  });
});

// ── Role derivation ─────────────────────────────────────────────────────────

describe('role derivation', () => {
  it('handoff action maps to stage-output role', () => {
    const result = materializer.materializeAssignment('pipe-role1', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'prompt',
    }, PROJECT);

    expect(result!.role).toBe('stage-output');
  });

  it('fan-out-request action maps to fan-out role', () => {
    const result = materializer.materializeAssignment('pipe-role2', 'merge', {
      type: 'fan-out-request',
      targetAssignee: 'bob',
      body: 'prompt',
    }, PROJECT);

    expect(result!.role).toBe('fan-out');
  });

  it('synth-request action maps to final role', () => {
    const result = materializer.materializeAssignment('pipe-role3', 'merge', {
      type: 'synth-request',
      targetAssignee: 'charlie',
      body: 'synthesize',
    }, PROJECT);

    expect(result!.role).toBe('final');
  });
});
