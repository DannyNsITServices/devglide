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

  it('merges explicit to param for user senders', () => {
    expect(registry.parseTargetTokens('@codex-14 review', 'claude-7', 'user')).toEqual(['claude-7', 'codex-14']);
  });

  it('merges explicit to param for LLM senders (issue 2 fix)', () => {
    expect(registry.parseTargetTokens('@codex-14 review', 'claude-7', 'llm')).toEqual(['claude-7', 'codex-14']);
  });

  it('deduplicates to param when also in body', () => {
    expect(registry.parseTargetTokens('@claude-7 check', 'claude-7', 'user')).toEqual(['claude-7']);
  });

  // ── Code-aware mention extraction (self-loop bug fix) ─────────────
  // Mentions inside inline code spans (`...`) and fenced code blocks (```...```)
  // are example syntax, not actual addressees. The parser must skip them.

  it('ignores @mention inside inline code span', () => {
    expect(registry.parseTargetTokens('use `@claude-7 fix` to assign')).toEqual([]);
  });

  it('ignores @mention inside fenced code block', () => {
    const body = 'example:\n```\n@claude-7 do this\n```\nplease';
    expect(registry.parseTargetTokens(body)).toEqual([]);
  });

  it('ignores @mention inside fenced code block with language tag', () => {
    const body = '```ts\nconst x = "@claude-7";\n```';
    expect(registry.parseTargetTokens(body)).toEqual([]);
  });

  it('still captures real prose mentions when code blocks exist', () => {
    const body = '@codex-14 see example: `@claude-7 fix` — got it?';
    expect(registry.parseTargetTokens(body)).toEqual(['codex-14']);
  });

  it('does not capture regex literal characters as a mention token', () => {
    // Real-world: claude-3 explained the bug using `/@(\\S+)/g` in a code block
    // and the parser captured "(\S+)/g" as a recipient.
    const body = 'the parser uses `/@(\\S+)/g` to scan';
    expect(registry.parseTargetTokens(body)).toEqual([]);
  });

  it('handles mentions split across prose and code without leaking', () => {
    const body = '@codex-14 here is the bug:\n```\n@self-loop here\n```\nfix it';
    expect(registry.parseTargetTokens(body)).toEqual(['codex-14']);
  });

  // ── Markdown-immune mention parsing (recipient-garbage bug) ─────────
  // Real-world: a chat message containing markdown bold around a mention
  // like `**Coordination, @codex-3:**` previously captured `codex-3:**`
  // as a token because /@(\S+)/g is too greedy and the trailing-punct
  // strip only handled `[,.:;!?]+`.

  it('does not capture trailing markdown-bold marker as part of mention', () => {
    expect(registry.parseTargetTokens('**Coordination, @codex-3:**')).toEqual(['codex-3']);
  });

  it('does not capture leading markdown bold as part of mention', () => {
    expect(registry.parseTargetTokens('**@user @codex-3** review')).toEqual(['user', 'codex-3']);
  });

  it('does not capture trailing underscore emphasis as part of mention', () => {
    expect(registry.parseTargetTokens('emphasised _@claude-7_ here')).toEqual(['claude-7']);
  });

  it('does not capture trailing parenthesis as part of mention', () => {
    expect(registry.parseTargetTokens('(see @codex-14) for context')).toEqual(['codex-14']);
  });

  it('does not capture trailing tilde or asterisk decoration', () => {
    expect(registry.parseTargetTokens('~@claude-7~ *@codex-14*')).toEqual(['claude-7', 'codex-14']);
  });

  // ── Comma-separated `to` param (parser stored it as one literal) ────
  // Real-world: an MCP caller passed `to: "codex-3,pi-1"` and the parser
  // stored that whole string as a single token, which then leaked into
  // both the unresolved targets AND the displayed `msg.to` header.

  it('splits comma-separated to param into separate tokens', () => {
    expect(registry.parseTargetTokens('hello', 'codex-7,pi-1', 'llm')).toEqual(['codex-7', 'pi-1']);
  });

  it('splits comma+space-separated to param', () => {
    expect(registry.parseTargetTokens('hello', 'codex-7, pi-1', 'llm')).toEqual(['codex-7', 'pi-1']);
  });

  it('dedupes comma-separated to param against body @mentions', () => {
    expect(registry.parseTargetTokens('@codex-7 review', 'codex-7,pi-1', 'llm'))
      .toEqual(['codex-7', 'pi-1']);
  });

  it('drops empty entries from comma-separated to param', () => {
    expect(registry.parseTargetTokens('hi', 'codex-7,,pi-1,', 'llm')).toEqual(['codex-7', 'pi-1']);
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
    // `targetLabels` now contains only validated display targets — unresolved
    // garbage is excluded so the dashboard never renders it as a "to" header.
    // The "had target intent" semantics live in `fallbackBroadcast=false` and
    // the unresolved name is reported separately via `unresolvedTargets`.
    expect(plan.targetLabels).toEqual([]);
    expect(plan.unresolvedTargets).toEqual(['nonexistent']);
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

  // ── Self-loop guard (rendered as "claude-2 → claude-2") ─────────────
  // Even if a sender's own alias somehow ends up in the token list (e.g.
  // legacy data, bug, or an explicit `to` param), the displayed
  // targetLabels should never include the sender — there is no such thing
  // as sending a message to yourself.

  it('strips sender alias from targetLabels when echoed in body prose', () => {
    // Simulates an LLM that types its own alias in prose for whatever reason.
    const body = `@${agent2.name} and @${agent1.name} both — heads up`;
    const plan = registry.buildDeliveryPlan(agent1.name, body, undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual([agent2.name]);
    expect(plan.targetLabels).not.toContain(agent1.name);
  });

  it('strips sender alias from targetLabels when passed via to param', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, 'hello', agent1.name, 'llm', 'project-test');
    expect(plan.targetLabels).not.toContain(agent1.name);
  });

  it('LLM with only own alias in code example: targetLabels empty (real-world bug)', () => {
    // The exact shape of the message that produced "claude-2 → claude-2"
    // in the chat history: code-fence example containing the sender's own
    // alias. After the parser fix this should not even tokenize, and after
    // the sender-strip defense it cannot leak even if it did.
    const body = 'try one of:\n```\n@claude fix\n@claude implement\n```';
    const plan = registry.buildDeliveryPlan(agent1.name, body, undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual([]);
    expect(plan.recipients).toEqual([]);
  });

  // ── targetLabels must contain only validated targets (display sanity) ──
  // Real-world bug: targetLabels was built from raw `tokens`, so any
  // garbage the parser captured (markdown leftovers, unknown names, the
  // literal comma-string from a comma-separated `to` param) leaked into
  // the persisted `msg.to` and the dashboard renderer showed it as the
  // "to" line — e.g. `claude-2 → mention,codex-3:**`.

  it('targetLabels excludes @mention to nonexistent participant', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, '@nobody-here please', undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual([]);
  });

  it('targetLabels still keeps @all literally (it is a valid display target)', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, '@all heads up', undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual(['all']);
  });

  it('targetLabels excludes @mention captured as raw token (defense in depth)', () => {
    // Even if the parser regressed and produced a garbage token, the
    // display layer must not surface it. Verified by mixing a real and a
    // fake mention: only the real one should appear in targetLabels.
    const body = `@${agent2.name} and @ghost-rider please`;
    const plan = registry.buildDeliveryPlan(agent1.name, body, undefined, 'llm', 'project-test');
    expect(plan.targetLabels).toEqual([agent2.name]);
  });

  it('targetLabels handles comma-split to param targeting two real recipients', () => {
    const plan = registry.buildDeliveryPlan(agent1.name, 'multi target', `${agent2.name},${agent2.name}`, 'llm', 'project-test');
    // Same name twice is deduped → exactly one entry
    expect(plan.targetLabels).toEqual([agent2.name]);
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

  // ── msg.to display format (recipient-garbage bug) ────────────────────
  // The persisted `msg.to` field is what the dashboard renderer reads to
  // build the `@sender → @t1, @t2` header. It must contain ONLY validated
  // names (or 'all' for broadcast), separated by ", " for multi-target,
  // never the literal comma-string from a comma-separated `to` param.

  it('msg.to is single name for one targeted recipient', async () => {
    const p = registry.send(a1.name, `@${a2.name} review this`);
    await drainDeliveries(1);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBe(a2.name);
  });

  it('msg.to is comma-space separated for multiple targeted recipients', async () => {
    const p = registry.send(a1.name, `@${a2.name} @${a3.name} review`);
    await drainDeliveries(2);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBe(`${a2.name}, ${a3.name}`);
  });

  it('msg.to omits markdown-leaked garbage even with bold-wrapped mention', async () => {
    const p = registry.send(a1.name, `**Coordination, @${a2.name}:** stand down`);
    await drainDeliveries(1);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    // No `:**`, no `mention`, no garbage — just the validated participant.
    expect(sendCall.to).toBe(a2.name);
  });

  it('msg.to omits unresolved garbage when body has fake mention', async () => {
    // Even if a peer LLM produces an @mention to a nonexistent name,
    // msg.to must only contain validated participants.
    const p = registry.send(a1.name, `@${a2.name} @ghost-here please`);
    await drainDeliveries(1);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBe(a2.name);
    // The unresolved one is reported separately, not in `to`.
    expect(sendCall.unresolvedTargets).toContain('ghost-here');
  });

  it('msg.to handles comma-split to param targeting two real recipients', async () => {
    // Caller passed `to: "a2,a3"` — server must split, not store as one token.
    const p = registry.send(a1.name, 'multi target', `${a2.name},${a3.name}`);
    await drainDeliveries(2);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBe(`${a2.name}, ${a3.name}`);
  });

  // ── Implicit broadcast header (codex review feedback) ──────────────
  // The user's example header `@user → @all` should appear for ALL user
  // broadcasts, including unaddressed ones (Option B fallback). Without
  // this, the dashboard renders no header for the user's typical pattern
  // of plain unaddressed messages, which leaves the addressing intent
  // invisible.

  it('msg.to is "all" for implicit user broadcast (no @mention, fallback)', async () => {
    const p = registry.send('user', 'hello everyone');
    await drainDeliveries(3);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBe('all');
  });

  it('msg.to is "all" for unaddressed system message (system also fallbacks)', async () => {
    const p = registry.send('system', 'server restarted');
    await drainDeliveries(3);
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBe('all');
  });

  it('msg.to stays null for LLM with no @mention (LLMs do not fallback)', async () => {
    const p = registry.send(a1.name, 'thinking out loud');
    await flushDeliveryQueue();
    await p;
    const sendCall = chatStoreMock.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(sendCall.to).toBeNull();
  });
});
