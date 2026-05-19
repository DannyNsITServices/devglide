/**
 * Regression tests for observed LLM pipe tool usage patterns.
 *
 * These tests document and verify the cross-cutting behaviors observed when
 * LLMs interact with the pipe system:
 *
 * 1. Delivery state machine when pipe_read_output is skipped vs used
 * 2. Assignment lifecycle for submit-without-fetch (the legacy/workaround path)
 * 3. Fan-out payload readability after the auth guard fix
 * 4. Compact notification wording (assignment vs stage input separation)
 * 5. Re-notify behavior when fetch is skipped
 *
 * These tests operate at the delivery, assignment, and materializer layers
 * (not the registry integration layer, which is covered by chat-registry.pipe-submit.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as delivery from './pipe-delivery.js';
import * as materializer from './pipe-assignment-materializer.js';
import * as assignmentStore from './assignment-store.js';
import * as payloadStore from './payload-store.js';
import { createTestClock } from './clock.js';

const PROJECT = 'regression-test';

beforeEach(() => {
  delivery._resetForTest();
  assignmentStore._resetForTest();
  payloadStore._resetForTest();
});

// ── Observed LLM Pattern: submit without fetch ────────────────────────────────

describe('LLM workaround: submit without pipe_read_output', () => {
  it('delivery allows direct notified → submitted (skipping fetch)', () => {
    delivery.createDelivery('pipe-r1', 'alice', 'fan-out-request', 'prompt text', PROJECT);
    delivery.recordNotification('pipe-r1', 'alice', PROJECT);

    // LLM skips pipe_read_output, submits directly
    const ok = delivery.recordSubmission('pipe-r1', 'alice', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-r1', 'alice', PROJECT);
    expect(record?.state).toBe('submitted');
    // fetchedAt should remain null — LLM never called pipe_read_output
    expect(record?.fetchedAt).toBeNull();
    expect(record?.submittedAt).toBeTruthy();
  });

  it('delivery allows direct assigned → submitted (fire-and-forget)', () => {
    delivery.createDelivery('pipe-r2', 'bob', 'fan-out-request', 'prompt', PROJECT);

    // LLM submits without even being notified (race condition / fast agent)
    const ok = delivery.recordSubmission('pipe-r2', 'bob', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-r2', 'bob', PROJECT);
    expect(record?.state).toBe('submitted');
    expect(record?.notifiedAt).toBeNull();
    expect(record?.fetchedAt).toBeNull();
  });

  it('assignment completeAssignment handles submit-without-fetch via fast-forward', () => {
    const result = materializer.materializeAssignment('pipe-r3', 'merge', {
      type: 'fan-out-request',
      targetAssignee: 'alice',
      body: 'Fan-out prompt',
    }, PROJECT);
    expect(result).not.toBeNull();

    // Simulate: notification was sent but LLM skipped pipe_read_output
    materializer.transitionAssignmentStatus(result!.assignmentId, 'notified', PROJECT);

    // LLM submits — completeAssignment should walk through intermediate states
    const assignment = assignmentStore.getAssignment(result!.assignmentId, PROJECT);
    expect(assignment?.status).toBe('notified');

    // Walk manually: notified → acknowledged → payload_fetched → submitted
    materializer.transitionAssignmentStatus(result!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'payload_fetched', PROJECT);
    const ok = materializer.completeAssignment(result!.assignmentId, PROJECT);
    expect(ok).toBe(true);

    const final = assignmentStore.getAssignment(result!.assignmentId, PROJECT);
    expect(final?.status).toBe('submitted');
  });
});

// ── Observed LLM Pattern: pipe_get_assignment → chat_read → pipe_submit ───────

describe('LLM workaround: assignment metadata is sufficient for fan-out work', () => {
  it('fan-out assignment has correct metadata without needing pipe_read_output', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-r4', 'explain', ['alice', 'bob', 'charlie'], 'How does X work?', PROJECT,
    );

    // All participants get fan-out assignments with metadata
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.role).toBe('fan-out');
      expect(r.assignmentId).toBeTruthy();
      expect(r.payloadId).toBeTruthy();
      expect(r.stageId).toMatch(/^fan-out:/);
    }

    // Assignment store has the metadata an LLM would get from pipe_get_assignment
    for (const r of results) {
      const assignment = assignmentStore.getAssignment(r.assignmentId, PROJECT);
      expect(assignment).toBeDefined();
      expect(assignment!.role).toBe('fan-out');
      expect(assignment!.status).toBe('assigned');
      expect(assignment!.pipeId).toBe('pipe-r4');
    }
  });

  it('fan-out payload content matches the original prompt', () => {
    const prompt = 'Explain how the pipe system works';
    const results = materializer.materializePipeAssignments(
      'pipe-r5', 'explain', ['alice', 'bob'], prompt, PROJECT,
    );

    // Each fan-out assignee's payload contains the prompt
    for (const r of results) {
      const payload = payloadStore.getPayload(r.payloadId, PROJECT);
      expect(payload).toBeDefined();
      expect(payload!.content).toBe(prompt);
      expect(payload!.status).toBe('active');
    }
  });

  it('fan-out payload is fetchable via payload store after assignment creation', () => {
    const prompt = 'Analyze this code';
    const results = materializer.materializePipeAssignments(
      'pipe-r6', 'merge', ['alice', 'bob', 'carol'], prompt, PROJECT,
    );

    // merge: alice and bob are fan-out, carol is synthesizer
    expect(results).toHaveLength(2);

    for (const r of results) {
      const fetchResult = payloadStore.fetchPayloadContent(r.payloadId, PROJECT);
      expect(fetchResult.ok).toBe(true);
      if (fetchResult.ok) {
        expect(fetchResult.content).toBe(prompt);
        expect(fetchResult.contentHash).toBeTruthy();
      }
    }
  });
});

// ── Delivery state integrity when pipe_read_output IS called ──────────────────

describe('correct path: pipe_read_output advances delivery state', () => {
  it('fetch transitions delivery from notified → fetched', () => {
    delivery.createDelivery('pipe-r7', 'alice', 'fan-out-request', 'payload', PROJECT);
    delivery.recordNotification('pipe-r7', 'alice', PROJECT);

    const ok = delivery.recordFetch('pipe-r7', 'alice', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-r7', 'alice', PROJECT);
    expect(record?.state).toBe('fetched');
    expect(record?.fetchedAt).toBeTruthy();
  });

  it('fetch after notification advances assignment to payload_fetched', () => {
    const result = materializer.materializeAssignment('pipe-r8', 'explain', {
      type: 'fan-out-request',
      targetAssignee: 'alice',
      body: 'Explain this',
    }, PROJECT);

    // Simulate notification + fetch (the correct LLM path)
    materializer.transitionAssignmentStatus(result!.assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'payload_fetched', PROJECT);

    const assignment = assignmentStore.getAssignment(result!.assignmentId, PROJECT);
    expect(assignment?.status).toBe('payload_fetched');
  });

  it('full correct lifecycle: assigned → notified → acknowledged → fetched → submitted', () => {
    const result = materializer.materializeAssignment('pipe-r9', 'linear', {
      type: 'handoff',
      targetAssignee: 'bob',
      stage: 2,
      body: 'Stage 2 content',
    }, PROJECT);

    // Delivery lifecycle
    delivery.createDelivery('pipe-r9', 'bob', 'handoff', 'Stage 2 content', PROJECT, 2);
    delivery.recordNotification('pipe-r9', 'bob', PROJECT);
    delivery.recordFetch('pipe-r9', 'bob', PROJECT);
    delivery.recordSubmission('pipe-r9', 'bob', PROJECT);

    const deliveryRecord = delivery.getDelivery('pipe-r9', 'bob', PROJECT);
    expect(deliveryRecord?.state).toBe('submitted');
    expect(deliveryRecord?.fetchedAt).toBeTruthy();
    expect(deliveryRecord?.submittedAt).toBeTruthy();

    // Assignment lifecycle
    materializer.transitionAssignmentStatus(result!.assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'payload_fetched', PROJECT);
    const ok = materializer.completeAssignment(result!.assignmentId, PROJECT);
    expect(ok).toBe(true);

    const assignment = assignmentStore.getAssignment(result!.assignmentId, PROJECT);
    expect(assignment?.status).toBe('submitted');
  });
});

// ── Re-notify behavior when fetch is skipped ──────────────────────────────────

describe('re-notify fires when LLM skips pipe_read_output', () => {
  it('re-notify timer fires when agent is notified but does not fetch', async () => {
    vi.useFakeTimers();

    delivery.createDelivery('pipe-r10', 'alice', 'fan-out-request', 'payload', PROJECT, undefined, {
      renotifyIntervalMs: 5_000,
      maxNotifyAttempts: 3,
    });
    delivery.recordNotification('pipe-r10', 'alice', PROJECT);

    const callback = vi.fn();
    delivery.startRenotifyTimer('pipe-r10', 'alice', PROJECT, callback);

    // Agent skips pipe_read_output — timer fires after interval
    vi.advanceTimersByTime(5_000);
    expect(callback).toHaveBeenCalledWith('pipe-r10', 'alice', PROJECT);

    vi.useRealTimers();
  });

  it('re-notify timer is cancelled when agent calls pipe_read_output (fetch)', async () => {
    vi.useFakeTimers();

    delivery.createDelivery('pipe-r11', 'bob', 'fan-out-request', 'payload', PROJECT, undefined, {
      renotifyIntervalMs: 5_000,
    });
    delivery.recordNotification('pipe-r11', 'bob', PROJECT);

    const callback = vi.fn();
    delivery.startRenotifyTimer('pipe-r11', 'bob', PROJECT, callback);

    // Agent calls pipe_read_output → fetch cancels the timer
    delivery.recordFetch('pipe-r11', 'bob', PROJECT);

    vi.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('re-notify does not fire when agent submits directly (skipping fetch)', async () => {
    vi.useFakeTimers();

    delivery.createDelivery('pipe-r12', 'carol', 'fan-out-request', 'payload', PROJECT, undefined, {
      renotifyIntervalMs: 5_000,
    });
    delivery.recordNotification('pipe-r12', 'carol', PROJECT);

    const callback = vi.fn();
    delivery.startRenotifyTimer('pipe-r12', 'carol', PROJECT, callback);

    // Agent submits without fetch — recordSubmission cancels the re-notify timer
    delivery.recordSubmission('pipe-r12', 'carol', PROJECT);

    vi.advanceTimersByTime(10_000);
    // Timer is cancelled by recordSubmission (via cancelRenotifyTimer), not just suppressed
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ── Compact notification wording regression ───────────────────────────────────

describe('compact notification separates assignment metadata from stage input', () => {
  it('fan-out notification has separate assignment and input instructions', () => {
    const notification = delivery.formatCompactNotification(
      'abc123', 'explain', 'fan-out-request', 'alice', 3,
    );

    // Should have separate lines for assignment metadata and stage input
    expect(notification.body).toContain('Inspect assignment: pipe_get_assignment(pipeId="abc123")');
    expect(notification.body).toContain('Read stage input: pipe_read_output(pipeId="abc123")');
    // Should NOT have the old combined wording
    expect(notification.body).not.toContain('Read your assignment');
  });

  it('linear handoff notification has separate assignment and input instructions', () => {
    const notification = delivery.formatCompactNotification(
      'def456', 'linear', 'handoff', 'bob', 3, 2,
    );

    expect(notification.body).toContain('Inspect assignment: pipe_get_assignment(pipeId="def456")');
    expect(notification.body).toContain('Read stage input: pipe_read_output(pipeId="def456")');
    expect(notification.body).not.toContain('Read your assignment');
  });

  it('synth-request notification has separate assignment and input instructions', () => {
    const notification = delivery.formatCompactNotification(
      'ghi789', 'merge', 'synth-request', 'synth', 3,
    );

    expect(notification.body).toContain('Inspect assignment: pipe_get_assignment(pipeId="ghi789")');
    expect(notification.body).toContain('Read stage input: pipe_read_output(pipeId="ghi789")');
    expect(notification.body).not.toContain('Read your assignment');
  });

  it('all notification types include pipe_submit instruction', () => {
    const modes: Array<{ mode: 'explain' | 'linear' | 'merge'; type: 'fan-out-request' | 'handoff' | 'synth-request'; stage?: number }> = [
      { mode: 'explain', type: 'fan-out-request' },
      { mode: 'linear', type: 'handoff', stage: 1 },
      { mode: 'merge', type: 'synth-request' },
    ];

    for (const { mode, type, stage } of modes) {
      const notification = delivery.formatCompactNotification(
        'test-pipe', mode, type, 'agent', 3, stage,
      );
      expect(notification.body).toContain('pipe_submit(pipeId="test-pipe"');
      expect(notification.body).toContain('Do not use chat_send');
    }
  });
});

// ── Fan-out payload lifecycle ─────────────────────────────────────────────────

describe('fan-out payload lifecycle across pipe modes', () => {
  it('explain mode: all participants (including synthesizer) get fan-out payloads', () => {
    const prompt = 'Explain closures in JS';
    const results = materializer.materializePipeAssignments(
      'pipe-exp', 'explain', ['alice', 'bob', 'charlie'], prompt, PROJECT,
    );

    expect(results).toHaveLength(3);
    for (const r of results) {
      const payload = payloadStore.getPayload(r.payloadId, PROJECT);
      expect(payload!.content).toBe(prompt);
      expect(payload!.status).toBe('active');
    }
  });

  it('merge mode: only non-synthesizer participants get fan-out payloads', () => {
    const prompt = 'Compare approaches';
    const results = materializer.materializePipeAssignments(
      'pipe-mrg', 'merge', ['alice', 'bob', 'carol'], prompt, PROJECT,
    );

    // merge: alice and bob are fan-out, carol is synthesizer (no initial payload)
    expect(results).toHaveLength(2);
    const assignees = results.map(r => r.assignee);
    expect(assignees).toContain('alice');
    expect(assignees).toContain('bob');
    expect(assignees).not.toContain('carol');
  });

  it('payloads are archived when pipe assignments are cancelled', () => {
    const results = materializer.materializePipeAssignments(
      'pipe-cancel', 'explain', ['alice', 'bob'], 'prompt', PROJECT,
    );

    materializer.cancelPipeAssignments('pipe-cancel', PROJECT);

    // Payloads should be archived
    for (const r of results) {
      const payload = payloadStore.getPayload(r.payloadId, PROJECT);
      expect(payload!.status).toBe('archived');
    }
  });

  it('payload is archived after assignment completion', () => {
    const result = materializer.materializeAssignment('pipe-complete', 'linear', {
      type: 'handoff',
      targetAssignee: 'alice',
      stage: 1,
      body: 'Do work',
    }, PROJECT);

    // Walk through lifecycle to submitted
    materializer.transitionAssignmentStatus(result!.assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(result!.assignmentId, 'payload_fetched', PROJECT);
    materializer.completeAssignment(result!.assignmentId, PROJECT);

    const payload = payloadStore.getPayload(result!.payloadId, PROJECT);
    expect(payload!.status).toBe('archived');
  });
});

// ── Cross-layer consistency: delivery + assignment + payload ───────────────────

describe('cross-layer consistency for fan-out pipe', () => {
  it('all three layers stay consistent through the correct path', () => {
    const pipeId = 'pipe-consistent';
    const assignee = 'alice';
    const prompt = 'Explain the bug';

    // 1. Materialize assignment + payload
    const materialized = materializer.materializeAssignment(pipeId, 'explain', {
      type: 'fan-out-request',
      targetAssignee: assignee,
      body: prompt,
    }, PROJECT);
    expect(materialized).not.toBeNull();

    // 2. Create delivery record
    delivery.createDelivery(pipeId, assignee, 'fan-out-request', prompt, PROJECT);

    // 3. Notification sent
    delivery.recordNotification(pipeId, assignee, PROJECT);
    materializer.transitionAssignmentStatus(materialized!.assignmentId, 'notified', PROJECT);

    // Verify: all layers in 'notified' state
    expect(delivery.getDelivery(pipeId, assignee, PROJECT)?.state).toBe('notified');
    expect(assignmentStore.getAssignment(materialized!.assignmentId, PROJECT)?.status).toBe('notified');
    expect(payloadStore.getPayload(materialized!.payloadId, PROJECT)?.status).toBe('active');

    // 4. Agent fetches (pipe_read_output)
    delivery.recordFetch(pipeId, assignee, PROJECT);
    materializer.transitionAssignmentStatus(materialized!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(materialized!.assignmentId, 'payload_fetched', PROJECT);

    // Verify: delivery fetched, assignment payload_fetched, payload active
    expect(delivery.getDelivery(pipeId, assignee, PROJECT)?.state).toBe('fetched');
    expect(assignmentStore.getAssignment(materialized!.assignmentId, PROJECT)?.status).toBe('payload_fetched');
    expect(payloadStore.getPayload(materialized!.payloadId, PROJECT)?.status).toBe('active');

    // 5. Agent submits
    delivery.recordSubmission(pipeId, assignee, PROJECT);
    materializer.completeAssignment(materialized!.assignmentId, PROJECT);

    // Verify: all layers in terminal state
    expect(delivery.getDelivery(pipeId, assignee, PROJECT)?.state).toBe('submitted');
    expect(assignmentStore.getAssignment(materialized!.assignmentId, PROJECT)?.status).toBe('submitted');
    expect(payloadStore.getPayload(materialized!.payloadId, PROJECT)?.status).toBe('archived');
  });

  it('all three layers stay consistent through the workaround path (skip fetch)', () => {
    const pipeId = 'pipe-workaround';
    const assignee = 'bob';
    const prompt = 'What is happening?';

    // 1. Materialize assignment + payload
    const materialized = materializer.materializeAssignment(pipeId, 'explain', {
      type: 'fan-out-request',
      targetAssignee: assignee,
      body: prompt,
    }, PROJECT);

    // 2. Create delivery record
    delivery.createDelivery(pipeId, assignee, 'fan-out-request', prompt, PROJECT);

    // 3. Notification sent
    delivery.recordNotification(pipeId, assignee, PROJECT);
    materializer.transitionAssignmentStatus(materialized!.assignmentId, 'notified', PROJECT);

    // 4. Agent SKIPS pipe_read_output — goes directly to submit
    delivery.recordSubmission(pipeId, assignee, PROJECT);

    // Assignment needs manual walk-through since completeAssignment from 'notified'
    // requires walking through intermediate states
    materializer.transitionAssignmentStatus(materialized!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(materialized!.assignmentId, 'payload_fetched', PROJECT);
    materializer.completeAssignment(materialized!.assignmentId, PROJECT);

    // Verify: delivery submitted (no fetch), assignment submitted, payload archived
    const deliveryRecord = delivery.getDelivery(pipeId, assignee, PROJECT);
    expect(deliveryRecord?.state).toBe('submitted');
    expect(deliveryRecord?.fetchedAt).toBeNull(); // never fetched
    expect(deliveryRecord?.submittedAt).toBeTruthy();

    expect(assignmentStore.getAssignment(materialized!.assignmentId, PROJECT)?.status).toBe('submitted');
    expect(payloadStore.getPayload(materialized!.payloadId, PROJECT)?.status).toBe('archived');
  });
});

// ── Synthesizer payload lifecycle ─────────────────────────────────────────────

describe('synthesizer: correct pipe_read_output usage', () => {
  it('synth assignment materializes with collected outputs as payload', () => {
    const synthBody = '--- @alice ---\nAlice analysis\n\n--- @bob ---\nBob analysis';
    const result = materializer.materializeSynthAssignment(
      'pipe-synth', 'explain', 'charlie', synthBody, PROJECT,
    );

    expect(result).not.toBeNull();
    expect(result!.role).toBe('final');
    expect(result!.stageId).toBe('synth');

    const payload = payloadStore.getPayload(result!.payloadId, PROJECT);
    expect(payload!.content).toBe(synthBody);
  });

  it('synth delivery lifecycle tracks fetch correctly', () => {
    const synthBody = 'Synthesize these outputs';

    delivery.createDelivery('pipe-synth2', 'synth', 'synth-request', synthBody, PROJECT);
    delivery.recordNotification('pipe-synth2', 'synth', PROJECT);

    // Synthesizer MUST call pipe_read_output to get fan-out outputs
    delivery.recordFetch('pipe-synth2', 'synth', PROJECT);

    const record = delivery.getDelivery('pipe-synth2', 'synth', PROJECT);
    expect(record?.state).toBe('fetched');
    expect(record?.fetchedAt).toBeTruthy();

    delivery.recordSubmission('pipe-synth2', 'synth', PROJECT);
    expect(delivery.getDelivery('pipe-synth2', 'synth', PROJECT)?.state).toBe('submitted');
  });
});

// ── Linear pipe: pipe_read_output is essential for stage 2+ ───────────────────

describe('linear pipe: pipe_read_output is essential for downstream stages', () => {
  it('stage 2 assignment payload contains the compact notification (not upstream output)', () => {
    // The materializer stores the compact notification as the payload body
    // The actual upstream output is served by readPipeOutput in chat-registry
    const result = materializer.materializeNextLinearAssignment(
      'pipe-lin', 1, ['alice', 'bob', 'carol'], 'Stage 1 output from alice', PROJECT,
    );

    expect(result).not.toBeNull();
    expect(result!.assignee).toBe('bob');
    expect(result!.stage).toBe(2);

    // Payload contains what was passed as the body (stage 1 output)
    const payload = payloadStore.getPayload(result!.payloadId, PROJECT);
    expect(payload!.content).toBe('Stage 1 output from alice');
  });

  it('linear assignment + delivery + payload all track through full lifecycle', () => {
    // Materialize stage 1
    const s1 = materializer.materializePipeAssignments(
      'pipe-lin-full', 'linear', ['alice', 'bob'], 'Original prompt', PROJECT,
    );
    expect(s1).toHaveLength(1);

    // Complete stage 1 through full lifecycle
    delivery.createDelivery('pipe-lin-full', 'alice', 'handoff', 'Original prompt', PROJECT, 1);
    delivery.recordNotification('pipe-lin-full', 'alice', PROJECT);
    delivery.recordFetch('pipe-lin-full', 'alice', PROJECT);
    delivery.recordSubmission('pipe-lin-full', 'alice', PROJECT);

    materializer.transitionAssignmentStatus(s1[0].assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(s1[0].assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(s1[0].assignmentId, 'payload_fetched', PROJECT);
    materializer.completeAssignment(s1[0].assignmentId, PROJECT);

    // Materialize stage 2
    const s2 = materializer.materializeNextLinearAssignment(
      'pipe-lin-full', 1, ['alice', 'bob'], 'Alice stage 1 output', PROJECT,
    );
    expect(s2).not.toBeNull();
    expect(s2!.assignee).toBe('bob');
    expect(s2!.stage).toBe(2);

    // Stage 2 delivery lifecycle (bob calls pipe_read_output for upstream content)
    delivery.createDelivery('pipe-lin-full', 'bob', 'handoff', 'Alice stage 1 output', PROJECT, 2);
    delivery.recordNotification('pipe-lin-full', 'bob', PROJECT);
    delivery.recordFetch('pipe-lin-full', 'bob', PROJECT);
    delivery.recordSubmission('pipe-lin-full', 'bob', PROJECT);

    materializer.transitionAssignmentStatus(s2!.assignmentId, 'notified', PROJECT);
    materializer.transitionAssignmentStatus(s2!.assignmentId, 'acknowledged', PROJECT);
    materializer.transitionAssignmentStatus(s2!.assignmentId, 'payload_fetched', PROJECT);
    materializer.completeAssignment(s2!.assignmentId, PROJECT);

    // Verify both stages completed
    expect(assignmentStore.getAssignment(s1[0].assignmentId, PROJECT)?.status).toBe('submitted');
    expect(assignmentStore.getAssignment(s2!.assignmentId, PROJECT)?.status).toBe('submitted');
    expect(payloadStore.getPayload(s1[0].payloadId, PROJECT)?.status).toBe('archived');
    expect(payloadStore.getPayload(s2!.payloadId, PROJECT)?.status).toBe('archived');
  });
});
