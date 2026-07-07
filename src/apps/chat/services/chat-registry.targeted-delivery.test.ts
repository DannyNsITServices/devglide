import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalPtys } from '../../shell/src/runtime/shell-state.js';
import { setActiveProject } from '../../../project-context.js';

const chatStoreMock = vi.hoisted(() => {
  let seq = 0;
  return {
    appendMessage: vi.fn((msg: { from: string; to: string | null; body: string; type: string }) => ({
      id: `msg-${++seq}`,
      ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      topic: null,
      ...msg,
    })),
    appendPipeEvent: vi.fn((event: Record<string, unknown>) => ({
      id: `pipe-event-${++seq}`,
      ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ...event,
    })),
    clearMessages: vi.fn(),
    readMessages: vi.fn(() => []),
    reset: () => { seq = 0; },
  };
});

vi.mock('./chat-store.js', () => ({
  appendMessage: chatStoreMock.appendMessage,
  appendPipeEvent: chatStoreMock.appendPipeEvent,
  clearMessages: chatStoreMock.clearMessages,
  readMessages: chatStoreMock.readMessages,
  saveParticipants: vi.fn(),
  loadParticipants: vi.fn(() => []),
}));

const registry = await import('./chat-registry.js');

function pty(from: string, body: string): string {
  return `[DevGlide Chat] @${from}: ${body}`;
}

async function flushDeliveryQueue(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ═══════════════════════════════════════════════════════════════════
// UNIT TESTS — parseTargetTokens (pure function, no state)
// ═══════════════════════════════════════════════════════════════════

describe('parseTargetTokens', () => {
  it('extracts a single @mention', () => {
    expect(registry.parseTargetTokens('@claude-7 do X')).toEqual(['claude-7']);
  });

  it('extracts @all', () => {
    expect(registry.parseTargetTokens('@all heads up')).toEqual(['all']);
  });

  it('extracts multiple @mentions', () => {
    expect(registry.parseTargetTokens('@claude-7 @codex-14 review this')).toEqual(['claude-7', 'codex-14']);
  });

  it('returns empty for no mentions', () => {
    expect(registry.parseTargetTokens('no mentions here')).toEqual([]);
  });

  it('extracts @user as a token', () => {
    expect(registry.parseTargetTokens('@user done')).toEqual(['user']);
  });

  it('extracts @team-prefixed tokens', () => {
    expect(registry.parseTargetTokens('@team-ui-squad go')).toEqual(['team-ui-squad']);
  });

  it('strips trailing punctuation from tokens', () => {
    expect(registry.parseTargetTokens('@claude-7, @codex-14: check')).toEqual(['claude-7', 'codex-14']);
  });

  it('deduplicates repeated mentions', () => {
    expect(registry.parseTargetTokens('@claude-7 and @claude-7 again')).toEqual(['claude-7']);
  });

  it('ignores mid-word @ (emails must not become mentions)', () => {
    expect(registry.parseTargetTokens('ping admin@example.com about the outage')).toEqual([]);
    expect(registry.parseTargetTokens('contact a@b and c@d please')).toEqual([]);
  });

  it('still extracts a mention at start or after brackets', () => {
    expect(registry.parseTargetTokens('(@claude-7) take this')).toEqual(['claude-7']);
  });

  it('merges explicit to param for user senders', () => {
    expect(registry.parseTargetTokens('@codex-14 review', 'claude-7', 'user')).toEqual(['claude-7', 'codex-14']);
  });

  it('merges explicit to param for LLM senders (issue 2 fix)', () => {
    expect(registry.parseTargetTokens('@codex-14 review', 'claude-7', 'llm')).toEqual(['claude-7', 'codex-14']);
  });

  it('deduplicates to param when also in body', () => {
    expect(registry.parseTargetTokens('@claude-7 check', 'claude-7', 'user')).toEqual(['claude-7']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// UNIT TESTS — expandToRecipients (state-dependent)
// ═══════════════════════════════════════════════════════════════════

describe('expandToRecipients', () => {
  let p1: { name: string };
  let p2: { name: string };
  let p3: { name: string };

  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    globalPtys.clear();
    setActiveProject({ id: 'project-test', name: 'Test', path: '/tmp/test' });
    for (const p of registry.listParticipants()) registry.leave(p.name);

    globalPtys.set('pane-7', { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    globalPtys.set('pane-14', { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    globalPtys.set('pane-15', { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    p1 = registry.join('claude', 'llm', 'pane-7', 'claude', '\r');
    p2 = registry.join('codex', 'llm', 'pane-14', 'codex', '\r');
    p3 = registry.join('cursor', 'llm', 'pane-15', 'cursor', '\r');
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalPtys.clear();
    for (const p of registry.listParticipants()) registry.leave(p.name);
    setActiveProject(null);
  });

  it('expands @all to all participants except sender', () => {
    const result = registry.expandToRecipients(['all'], p1.name, 'project-test');
    expect(result.recipients.sort()).toEqual([p2.name, p3.name].sort());
    expect(result.concreteAssignees).toEqual([]);
  });

  it('resolves a known participant', () => {
    const result = registry.expandToRecipients([p2.name], p1.name, 'project-test');
    expect(result.recipients).toEqual([p2.name]);
    expect(result.concreteAssignees).toEqual([p2.name]);
  });

  it('returns empty for unknown participant', () => {
    const result = registry.expandToRecipients(['nonexistent'], p1.name, 'project-test');
    expect(result.recipients).toEqual([]);
    expect(result.concreteAssignees).toEqual([]);
  });

  it('returns empty recipients for semantic-only targets (user, system)', () => {
    const result = registry.expandToRecipients(['user'], p1.name, 'project-test');
    expect(result.recipients).toEqual([]);
    expect(result.concreteAssignees).toEqual([]);
  });

  it('deduplicates @all + individual mention', () => {
    const result = registry.expandToRecipients(['all', p2.name], p1.name, 'project-test');
    expect(result.recipients.sort()).toEqual([p2.name, p3.name].sort());
    expect(result.concreteAssignees).toEqual([p2.name]);
  });

  it('excludes detached participants from recipients but keeps in concreteAssignees', () => {
    registry.detach(p2.name);
    const result = registry.expandToRecipients([p2.name], p1.name, 'project-test');
    expect(result.recipients).toEqual([]);
    expect(result.concreteAssignees).toEqual([p2.name]);
  });

  it('excludes self from recipients', () => {
    const result = registry.expandToRecipients([p1.name], p1.name, 'project-test');
    expect(result.recipients).toEqual([]);
    expect(result.concreteAssignees).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// UNIT TESTS — buildDeliveryPlan
// ═══════════════════════════════════════════════════════════════════

describe('buildDeliveryPlan', () => {
  let agent1: { name: string };
  let agent2: { name: string };

  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    globalPtys.clear();
    setActiveProject({ id: 'project-test', name: 'Test', path: '/tmp/test' });
    for (const p of registry.listParticipants()) registry.leave(p.name);

    globalPtys.set('pane-7', { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    globalPtys.set('pane-14', { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    agent1 = registry.join('claude', 'llm', 'pane-7', 'claude', '\r');
    agent2 = registry.join('codex', 'llm', 'pane-14', 'codex', '\r');
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalPtys.clear();
    for (const p of registry.listParticipants()) registry.leave(p.name);
    setActiveProject(null);
  });

  it('user with no mentions: fallbackBroadcast=true', () => {
    const plan = registry.buildDeliveryPlan('user', 'hello everyone', undefined, 'user', 'project-test');
    expect(plan.targetLabels).toEqual([]);
    expect(plan.recipients).toEqual([]);
    expect(plan.fallbackBroadcast).toBe(true);
  });

  it('user with @specific: targeted, no fallback', () => {
    const plan = registry.buildDeliveryPlan('user', `@${agent1.name} implement this`, undefined, 'user', 'project-test');
    expect(plan.targetLabels).toEqual([agent1.name]);
    expect(plan.recipients).toEqual([agent1.name]);
    expect(plan.concreteAssignees).toEqual([agent1.name]);
    expect(plan.fallbackBroadcast).toBe(false);
  });

  it('LLM with no mentions: no fallback, no recipients', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, 'thinking out loud', undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual([]);
    expect(plan.recipients).toEqual([]);
    expect(plan.fallbackBroadcast).toBe(false);
  });

  it('LLM with @specific: targeted delivery', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, `@${agent2.name} review this`, undefined, 'llm', 'project-test');
    expect(plan.recipients).toEqual([agent2.name]);
    expect(plan.concreteAssignees).toEqual([agent2.name]);
    expect(plan.fallbackBroadcast).toBe(false);
  });

  it('user with @unknown: no fallback (issue 1 fix — had target intent)', () => {
    const plan = registry.buildDeliveryPlan('user', '@nonexistent check this', undefined, 'user', 'project-test');
    expect(plan.targetLabels).toEqual(['nonexistent']);
    expect(plan.recipients).toEqual([]);
    expect(plan.fallbackBroadcast).toBe(false);
  });

  it('user with @user only: no fallback (semantic-only target = had intent)', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, '@user done!', undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual([]);
    expect(plan.recipients).toEqual([]);
    expect(plan.fallbackBroadcast).toBe(false);
  });

  it('@all sets fallbackBroadcast=false (explicit broadcast resolved)', () => {
    const plan = registry.buildDeliveryPlan('user', '@all check status', undefined, 'user', 'project-test');
    expect(plan.targetLabels).toEqual(['all']);
    expect(plan.recipients.sort()).toEqual([agent1.name, agent2.name].sort());
    expect(plan.concreteAssignees).toEqual([]);
    expect(plan.fallbackBroadcast).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — send() targeted delivery behavior
// ═══════════════════════════════════════════════════════════════════

describe('send() targeted PTY delivery', () => {
  let writes1: string[];
  let writes2: string[];
  let writes3: string[];
  let a1: { name: string };
  let a2: { name: string };
  let a3: { name: string };

  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    chatStoreMock.appendMessage.mockClear();
    globalPtys.clear();
    setActiveProject({ id: 'project-test', name: 'Test', path: '/tmp/test' });
    for (const p of registry.listParticipants()) registry.leave(p.name);

    writes1 = [];
    writes2 = [];
    writes3 = [];
    globalPtys.set('pane-7', { ptyProcess: { write: vi.fn((c: string) => { writes1.push(c); }) } as never, chunks: [], totalLen: 0 });
    globalPtys.set('pane-14', { ptyProcess: { write: vi.fn((c: string) => { writes2.push(c); }) } as never, chunks: [], totalLen: 0 });
    globalPtys.set('pane-15', { ptyProcess: { write: vi.fn((c: string) => { writes3.push(c); }) } as never, chunks: [], totalLen: 0 });
    a1 = registry.join('claude', 'llm', 'pane-7', 'claude', '\r');
    a2 = registry.join('codex', 'llm', 'pane-14', 'codex', '\r');
    a3 = registry.join('cursor', 'llm', 'pane-15', 'cursor', '\r');
    // Clear mocks AFTER joins — join messages don't pollute send() assertions
    chatStoreMock.appendMessage.mockClear();
    writes1.length = 0;
    writes2.length = 0;
    writes3.length = 0;
  });

  /** Advance timers enough for N sequential PTY deliveries to complete */
  async function drainDeliveries(count: number): Promise<void> {
    for (let i = 0; i < count + 1; i++) {
      await flushDeliveryQueue();
      await vi.advanceTimersByTimeAsync(1100);
      await flushDeliveryQueue();
    }
  }

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalPtys.clear();
    for (const p of registry.listParticipants()) registry.leave(p.name);
    setActiveProject(null);
  });

  it('LLM @mention delivers to target only', async () => {
    const p = registry.send(a1.name, `@${a2.name} review this`);
    await drainDeliveries(1);
    await p;

    expect(writes2[0]).toBe(pty(a1.name, `@${a2.name} review this`));
    expect(writes1).toEqual([]); // sender excluded
    expect(writes3).toEqual([]); // a3 not mentioned
  });

  it('LLM with no @mention delivers to nobody', async () => {
    const p = registry.send(a1.name, 'thinking out loud');
    await flushDeliveryQueue();
    await p;

    expect(writes1).toEqual([]);
    expect(writes2).toEqual([]);
    expect(writes3).toEqual([]);
  });

  it('LLM @all delivers to all except sender', async () => {
    const p = registry.send(a1.name, '@all heads up everyone');
    await drainDeliveries(2);
    await p;

    expect(writes2[0]).toBe(pty(a1.name, '@all heads up everyone'));
    expect(writes3[0]).toBe(pty(a1.name, '@all heads up everyone'));
    expect(writes1).toEqual([]); // sender excluded
  });

  it('user with no @mention broadcasts to all (Option B)', async () => {
    const p = registry.send('user', 'hello everyone');
    await drainDeliveries(3);
    await p;

    expect(writes1[0]).toBe(pty('user', 'hello everyone'));
    expect(writes2[0]).toBe(pty('user', 'hello everyone'));
    expect(writes3[0]).toBe(pty('user', 'hello everyone'));
  });

  it('user @specific delivers to target only', async () => {
    const p = registry.send('user', `@${a1.name} implement this`);
    await drainDeliveries(1);
    await p;

    expect(writes1[0]).toBe(pty('user', `@${a1.name} implement this`));
    expect(writes2).toEqual([]); // not mentioned
    expect(writes3).toEqual([]); // not mentioned
  });

  it('message is always persisted regardless of delivery', async () => {
    const p = registry.send(a1.name, 'no mentions');
    await flushDeliveryQueue();
    await p;
    expect(chatStoreMock.appendMessage).toHaveBeenCalledTimes(1);
  });

  it('deliveredTo is included in persisted message for targeted delivery', async () => {
    const p = registry.send('user', `@${a1.name} do X`);
    await drainDeliveries(1);
    await p;

    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.deliveredTo).toBe(1);
  });

  it('deliveredTo is absent when LLM has no mentions', async () => {
    const p = registry.send(a1.name, 'no delivery');
    await flushDeliveryQueue();
    await p;

    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.deliveredTo).toBeUndefined();
  });

  it('msg.to stores "all" for @all messages', async () => {
    const p = registry.send(a1.name, '@all broadcast');
    await drainDeliveries(2);
    await p;

    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0];
    expect(sendCall.to).toBe('all');
  });

  // ── `to` param delivery tests (issue 2 coverage) ───────────────────

  it('LLM with no body mention but to=target delivers to target only', async () => {
    const p = registry.send(a1.name, 'review this please', a2.name);
    await drainDeliveries(1);
    await p;

    expect(writes2[0]).toBe(pty(a1.name, 'review this please'));
    expect(writes1).toEqual([]); // sender
    expect(writes3).toEqual([]); // not targeted
  });

  it('user with no body mention but to=target delivers to target only (no Option B)', async () => {
    const p = registry.send('user', 'implement this', a1.name);
    await drainDeliveries(1);
    await p;

    expect(writes1[0]).toBe(pty('user', 'implement this'));
    expect(writes2).toEqual([]); // not targeted
    expect(writes3).toEqual([]); // not targeted
  });

  it('union: to=targetA and body @targetB delivers to both', async () => {
    const p = registry.send(a1.name, `@${a3.name} check this too`, a2.name);
    await drainDeliveries(2);
    await p;

    expect(writes2[0]).toBe(pty(a1.name, `@${a3.name} check this too`));
    expect(writes3[0]).toBe(pty(a1.name, `@${a3.name} check this too`));
    expect(writes1).toEqual([]); // sender
  });

  it('@all does NOT set participant status to working (concreteAssignees safety)', async () => {
    const before = registry.listParticipants().map(p => ({ name: p.name, status: p.status }));

    const p = registry.send('user', '@all check status');
    await drainDeliveries(3);
    await p;

    const after = registry.listParticipants().map(p => ({ name: p.name, status: p.status }));
    expect(after).toEqual(before);
  });
});
