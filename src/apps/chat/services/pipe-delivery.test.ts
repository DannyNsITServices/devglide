import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as delivery from './pipe-delivery.js';
import { createTestClock } from './clock.js';

const PROJECT = 'test-project';

beforeEach(() => {
  delivery._resetForTest();
});

// ── Delivery lifecycle ──────────────────────────────────────────────────────

describe('delivery state machine', () => {
  it('creates a delivery record in assigned state', () => {
    const record = delivery.createDelivery('pipe-1', 'alice', 'handoff', 'full payload', PROJECT, 1);
    expect(record.state).toBe('assigned');
    expect(record.pipeId).toBe('pipe-1');
    expect(record.assignee).toBe('alice');
    expect(record.stage).toBe(1);
    expect(record.role).toBe('handoff');
    expect(record.payload).toBe('full payload');
    expect(record.notifyAttempts).toBe(0);
    expect(record.notifiedAt).toBeNull();
    expect(record.fetchedAt).toBeNull();
    expect(record.submittedAt).toBeNull();
  });

  it('transitions assigned → notified on recordNotification', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    const ok = delivery.recordNotification('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-1', 'alice', PROJECT);
    expect(record?.state).toBe('notified');
    expect(record?.notifyAttempts).toBe(1);
    expect(record?.notifiedAt).toBeTruthy();
    expect(record?.lastNotifyAttemptAt).toBeTruthy();
  });

  it('transitions notified → fetched on recordFetch', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    const ok = delivery.recordFetch('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-1', 'alice', PROJECT);
    expect(record?.state).toBe('fetched');
    expect(record?.fetchedAt).toBeTruthy();
  });

  it('transitions fetched → submitted on recordSubmission', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    delivery.recordFetch('pipe-1', 'alice', PROJECT);
    const ok = delivery.recordSubmission('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-1', 'alice', PROJECT);
    expect(record?.state).toBe('submitted');
    expect(record?.submittedAt).toBeTruthy();
  });

  it('allows direct notified → submitted (skip fetch)', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    const ok = delivery.recordSubmission('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(true);

    const record = delivery.getDelivery('pipe-1', 'alice', PROJECT);
    expect(record?.state).toBe('submitted');
  });

  it('allows direct assigned → submitted (fire and forget)', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    const ok = delivery.recordSubmission('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(true);
  });

  it('rejects notification after submission', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    delivery.recordSubmission('pipe-1', 'alice', PROJECT);

    const ok = delivery.recordNotification('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(false);
  });

  it('rejects fetch after cancellation', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    delivery.cancelDelivery('pipe-1', 'alice', PROJECT);

    const ok = delivery.recordFetch('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(false);
  });

  it('rejects submission after expiry', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    delivery.expireDelivery('pipe-1', 'alice', PROJECT);

    const ok = delivery.recordSubmission('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(false);
  });

  it('returns false for unknown delivery', () => {
    expect(delivery.recordNotification('pipe-999', 'nobody', PROJECT)).toBe(false);
    expect(delivery.recordFetch('pipe-999', 'nobody', PROJECT)).toBe(false);
    expect(delivery.recordSubmission('pipe-999', 'nobody', PROJECT)).toBe(false);
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe('delivery cancellation', () => {
  it('cancelDelivery marks record as cancelled', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);

    const ok = delivery.cancelDelivery('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(true);
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.state).toBe('cancelled');
  });

  it('cancelDelivery does not cancel submitted deliveries', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordSubmission('pipe-1', 'alice', PROJECT);

    const ok = delivery.cancelDelivery('pipe-1', 'alice', PROJECT);
    expect(ok).toBe(false);
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.state).toBe('submitted');
  });

  it('cancelAllDeliveries cancels all non-submitted deliveries for a pipe', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.createDelivery('pipe-1', 'bob', 'handoff', 'payload', PROJECT, 2);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    delivery.recordSubmission('pipe-1', 'alice', PROJECT);
    delivery.recordNotification('pipe-1', 'bob', PROJECT);

    delivery.cancelAllDeliveries('pipe-1', PROJECT);

    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.state).toBe('submitted'); // preserved
    expect(delivery.getDelivery('pipe-1', 'bob', PROJECT)?.state).toBe('cancelled');
  });

  it('cancelDeliveriesForAssignee cancels all deliveries for a participant', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.createDelivery('pipe-2', 'alice', 'fan-out-request', 'payload', PROJECT);
    delivery.createDelivery('pipe-1', 'bob', 'handoff', 'payload', PROJECT, 2);

    delivery.cancelDeliveriesForAssignee('alice', PROJECT);

    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.state).toBe('cancelled');
    expect(delivery.getDelivery('pipe-2', 'alice', PROJECT)?.state).toBe('cancelled');
    expect(delivery.getDelivery('pipe-1', 'bob', PROJECT)?.state).toBe('assigned'); // untouched
  });
});

// ── Re-notify logic ─────────────────────────────────────────────────────────

describe('re-notify logic', () => {
  it('needsRenotify returns false before notification', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    expect(delivery.needsRenotify('pipe-1', 'alice', PROJECT)).toBe(false);
  });

  it('needsRenotify returns false immediately after notification (interval not elapsed)', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    expect(delivery.needsRenotify('pipe-1', 'alice', PROJECT)).toBe(false);
  });

  it('needsRenotify returns true after interval has elapsed', () => {
    const clock = createTestClock();
    delivery.setDeliveryClock(clock);

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      renotifyIntervalMs: 10_000,
    });
    delivery.recordNotification('pipe-1', 'alice', PROJECT);

    // Advance past the interval
    clock.advance(15_000);
    expect(delivery.needsRenotify('pipe-1', 'alice', PROJECT)).toBe(true);
  });

  it('needsRenotify returns false after fetch (acked)', () => {
    const clock = createTestClock();
    delivery.setDeliveryClock(clock);

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      renotifyIntervalMs: 10_000,
    });
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    delivery.recordFetch('pipe-1', 'alice', PROJECT);

    clock.advance(15_000);
    expect(delivery.needsRenotify('pipe-1', 'alice', PROJECT)).toBe(false);
  });

  it('needsRenotify returns false when max attempts reached', () => {
    const clock = createTestClock();
    delivery.setDeliveryClock(clock);

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      maxNotifyAttempts: 2,
      renotifyIntervalMs: 5_000,
    });

    // First notification
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    clock.advance(6_000);

    // Second notification (hits max)
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    clock.advance(6_000);

    expect(delivery.needsRenotify('pipe-1', 'alice', PROJECT)).toBe(false);
  });

  it('startRenotifyTimer fires callback after interval', async () => {
    vi.useFakeTimers();

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      renotifyIntervalMs: 5_000,
      maxNotifyAttempts: 3,
    });
    delivery.recordNotification('pipe-1', 'alice', PROJECT);

    const callback = vi.fn();
    delivery.startRenotifyTimer('pipe-1', 'alice', PROJECT, callback);

    vi.advanceTimersByTime(5_000);
    expect(callback).toHaveBeenCalledWith('pipe-1', 'alice', PROJECT);

    vi.useRealTimers();
  });

  it('startRenotifyTimer does not fire after fetch', async () => {
    vi.useFakeTimers();

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      renotifyIntervalMs: 5_000,
    });
    delivery.recordNotification('pipe-1', 'alice', PROJECT);

    const callback = vi.fn();
    delivery.startRenotifyTimer('pipe-1', 'alice', PROJECT, callback);

    // Fetch before timer fires — should cancel it
    delivery.recordFetch('pipe-1', 'alice', PROJECT);

    vi.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('expireDelivery is called when attempts exhausted in handleRenotifyTick', async () => {
    vi.useFakeTimers();

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      maxNotifyAttempts: 1,
      renotifyIntervalMs: 5_000,
    });
    delivery.recordNotification('pipe-1', 'alice', PROJECT);

    const callback = vi.fn();
    delivery.startRenotifyTimer('pipe-1', 'alice', PROJECT, callback);

    vi.advanceTimersByTime(5_000);

    // Callback should NOT have been called — attempts exhausted, delivery expired
    expect(callback).not.toHaveBeenCalled();
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.state).toBe('expired');

    vi.useRealTimers();
  });
});

// ── Payload retrieval ───────────────────────────────────────────────────────

describe('payload retrieval', () => {
  it('getDeliveryPayload returns the stored payload', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'this is the full payload', PROJECT, 1);
    expect(delivery.getDeliveryPayload('pipe-1', 'alice', PROJECT)).toBe('this is the full payload');
  });

  it('getDeliveryPayload returns undefined for unknown delivery', () => {
    expect(delivery.getDeliveryPayload('pipe-999', 'nobody', PROJECT)).toBeUndefined();
  });
});

// ── Active delivery queries ─────────────────────────────────────────────────

describe('active delivery queries', () => {
  it('getActiveDeliveries returns non-terminal records', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'p1', PROJECT, 1);
    delivery.createDelivery('pipe-1', 'bob', 'handoff', 'p2', PROJECT, 2);
    delivery.createDelivery('pipe-1', 'carol', 'handoff', 'p3', PROJECT, 3);

    // Submit alice, cancel carol
    delivery.recordSubmission('pipe-1', 'alice', PROJECT);
    delivery.cancelDelivery('pipe-1', 'carol', PROJECT);

    const active = delivery.getActiveDeliveries('pipe-1', PROJECT);
    expect(active).toHaveLength(1);
    expect(active[0].assignee).toBe('bob');
  });
});

// ── Compact notification formatting ─────────────────────────────────────────

describe('compact notification formatting', () => {
  it('formats a linear handoff notification', () => {
    const notification = delivery.formatCompactNotification(
      'abc123', 'linear', 'handoff', 'alice', 3, 2,
    );
    expect(notification.body).toContain('#pipe-abc123');
    expect(notification.body).toContain('[linear | stage 2/3 | @alice]');
    expect(notification.body).toContain('Inspect assignment: pipe_get_assignment(pipeId="abc123")');
    expect(notification.body).toContain('Read stage input: pipe_read_output(pipeId="abc123")');
    expect(notification.body).toContain('pipe_submit(pipeId="abc123"');
    expect(notification.body).toContain('Your output passes to the next stage.');
    // Should NOT contain the full prompt text
    expect(notification.pipe.pipeId).toBe('abc123');
    expect(notification.pipe.role).toBe('handoff');
    expect(notification.pipe.stage).toBe(2);
  });

  it('formats a final stage notification', () => {
    const notification = delivery.formatCompactNotification(
      'abc123', 'linear', 'handoff', 'carol', 3, 3,
    );
    expect(notification.body).toContain('Final stage');
    expect(notification.body).toContain('stage 3/3');
  });

  it('formats a fan-out-request notification', () => {
    const notification = delivery.formatCompactNotification(
      'abc123', 'merge-all', 'fan-out-request', 'bob', 3,
    );
    expect(notification.body).toContain('[merge-all | fan-out | @bob]');
    expect(notification.body).toContain('independent analysis');
    expect(notification.body).toContain('Inspect assignment: pipe_get_assignment(pipeId="abc123")');
    expect(notification.body).toContain('Read stage input: pipe_read_output(pipeId="abc123")');
  });

  it('formats a synth-request notification', () => {
    const notification = delivery.formatCompactNotification(
      'abc123', 'merge', 'synth-request', 'synth', 3,
    );
    expect(notification.body).toContain('[merge | synthesizer | @synth]');
    expect(notification.body).toContain('Synthesize');
    expect(notification.body).toContain('Inspect assignment: pipe_get_assignment(pipeId="abc123")');
    expect(notification.body).toContain('Read stage input: pipe_read_output(pipeId="abc123")');
  });

});

// ── Clock injection ─────────────────────────────────────────────────────────

describe('injectable clock', () => {
  it('uses injected clock for timestamps', () => {
    const clock = createTestClock(1700000000000); // fixed time
    delivery.setDeliveryClock(clock);

    const record = delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);
    expect(record.assignedAt).toBe(new Date(1700000000000).toISOString());

    clock.advance(5000);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    const updated = delivery.getDelivery('pipe-1', 'alice', PROJECT);
    expect(updated?.notifiedAt).toBe(new Date(1700000005000).toISOString());
  });
});

// ── Multiple re-notification increments ─────────────────────────────────────

describe('re-notification counting', () => {
  it('increments notifyAttempts on each recordNotification call', () => {
    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1, {
      maxNotifyAttempts: 5,
    });

    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.notifyAttempts).toBe(1);

    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.notifyAttempts).toBe(2);

    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.notifyAttempts).toBe(3);
  });

  it('preserves first notifiedAt on subsequent notifications', () => {
    const clock = createTestClock();
    delivery.setDeliveryClock(clock);

    delivery.createDelivery('pipe-1', 'alice', 'handoff', 'payload', PROJECT, 1);

    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    const firstNotifiedAt = delivery.getDelivery('pipe-1', 'alice', PROJECT)?.notifiedAt;

    clock.advance(10_000);
    delivery.recordNotification('pipe-1', 'alice', PROJECT);
    const secondNotifiedAt = delivery.getDelivery('pipe-1', 'alice', PROJECT)?.notifiedAt;

    // First notifiedAt is preserved — only lastNotifyAttemptAt changes
    expect(secondNotifiedAt).toBe(firstNotifiedAt);
    expect(delivery.getDelivery('pipe-1', 'alice', PROJECT)?.lastNotifyAttemptAt).not.toBe(firstNotifiedAt);
  });
});
