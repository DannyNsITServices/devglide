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
    clearMessages: vi.fn(),
    reset: () => {
      seq = 0;
    },
  };
});

vi.mock('./chat-store.js', () => ({
  appendMessage: chatStoreMock.appendMessage,
  clearMessages: chatStoreMock.clearMessages,
}));

const registry = await import('./chat-registry.js');

async function flushDeliveryQueue(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('chat-registry PTY delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    chatStoreMock.appendMessage.mockClear();
    chatStoreMock.clearMessages.mockClear();
    globalPtys.clear();
    setActiveProject({ id: 'project-chat', name: 'Chat', path: '/tmp/chat' });

    for (const participant of registry.listParticipants()) {
      registry.leave(participant.name);
    }
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

  it('serializes back-to-back deliveries to the same pane', async () => {
    const writes: string[] = [];
    globalPtys.set('pane-1', {
      ptyProcess: { write: vi.fn((chunk: string) => { writes.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('codex', 'llm', 'pane-1', 'codex', '\r');

    registry.send('user', 'first');
    registry.send('user', 'second');
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: first',
    ]);

    // Adaptive submit delay: 500ms base + 1ms per char (29 chars → 529ms)
    await vi.advanceTimersByTimeAsync(529);
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: first',
      '\r',
    ]);

    // Retry submit after additional 1000ms, then second message starts
    await vi.advanceTimersByTimeAsync(1000);
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: first',
      '\r',
      '\r',
      '[DevGlide Chat] @user: second',
    ]);

    // Second message: adaptive submit (30 chars → 530ms)
    await vi.advanceTimersByTimeAsync(530);
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: first',
      '\r',
      '\r',
      '[DevGlide Chat] @user: second',
      '\r',
    ]);

    // Second message: retry submit after additional 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: first',
      '\r',
      '\r',
      '[DevGlide Chat] @user: second',
      '\r',
      '\r',
    ]);

    registry.leave(participant.name);
  });

  it('chunks long messages and uses adaptive submit delay', async () => {
    const writes: string[] = [];
    globalPtys.set('pane-5', {
      ptyProcess: { write: vi.fn((chunk: string) => { writes.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('codex-long', 'llm', 'pane-5', 'codex', '\r');

    // Send a message that exceeds 1024 bytes when formatted
    const longBody = 'x'.repeat(1500);
    registry.send('user', longBody);
    await flushDeliveryQueue();

    // First chunk written immediately (1024 chars)
    const formatted = `[DevGlide Chat] @user: ${longBody}`;
    expect(writes.length).toBe(1);
    expect(writes[0]).toBe(formatted.slice(0, 1024));

    // After 50ms chunk gap, second chunk is written
    await vi.advanceTimersByTimeAsync(50);
    await flushDeliveryQueue();
    expect(writes.length).toBe(2);
    expect(writes[0] + writes[1]).toBe(formatted);

    // Adaptive submit delay: 500 + formatted.length chars, capped at 5000ms
    const expectedDelay = Math.min(500 + formatted.length, 5000);
    await vi.advanceTimersByTimeAsync(expectedDelay);
    await flushDeliveryQueue();
    expect(writes[2]).toBe('\r');

    // Retry submit after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    await flushDeliveryQueue();
    expect(writes[3]).toBe('\r');

    registry.leave(participant.name);
  });

  it('stops chunked delivery when participant detaches mid-burst', async () => {
    const writes: string[] = [];
    globalPtys.set('pane-6', {
      ptyProcess: { write: vi.fn((chunk: string) => { writes.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('codex-detach', 'llm', 'pane-6', 'codex', '\r');

    // Send a long message that will require multiple chunks
    const longBody = 'y'.repeat(2500);
    registry.send('user', longBody);
    await flushDeliveryQueue();

    // First chunk written
    expect(writes.length).toBe(1);

    // Detach participant before second chunk arrives
    registry.detach(participant.name);

    // Advance past chunk delay — second chunk should NOT be written
    await vi.advanceTimersByTimeAsync(50);
    await flushDeliveryQueue();

    // Only the first chunk was written, delivery stopped
    expect(writes.length).toBe(1);

    // No submit key either
    await vi.advanceTimersByTimeAsync(10000);
    await flushDeliveryQueue();
    expect(writes.length).toBe(1);

    registry.leave(participant.name);
  });

  it('skips the delayed submit when the participant detaches before it fires', async () => {
    const writes: string[] = [];
    globalPtys.set('pane-2', {
      ptyProcess: { write: vi.fn((chunk: string) => { writes.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('claude', 'llm', 'pane-2', 'claude', '\r');

    registry.send('user', 'hello');
    await flushDeliveryQueue();
    registry.detach(participant.name);

    // Adaptive delay: 500 + 29 chars = 529ms
    await vi.advanceTimersByTimeAsync(529);
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: hello',
    ]);

    registry.leave(participant.name);
  });

  it('skips the delayed submit after same-pane detach and reclaim', async () => {
    const writes: string[] = [];
    globalPtys.set('pane-4', {
      ptyProcess: { write: vi.fn((chunk: string) => { writes.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('codex', 'llm', 'pane-4', 'codex', '\r');

    registry.send('user', 'reclaim-race');
    await flushDeliveryQueue();
    registry.detach(participant.name);
    const reclaimed = registry.join('codex', 'llm', 'pane-4', 'codex', '\r');

    // Adaptive delay: 500 + 36 chars = 536ms
    await vi.advanceTimersByTimeAsync(536);
    await flushDeliveryQueue();

    expect(reclaimed.name).toBe(participant.name);
    expect(writes).toEqual([
      '[DevGlide Chat] @user: reclaim-race',
    ]);

    registry.leave(participant.name);
  });

  it('skips the delayed submit when the pane closes before it fires', async () => {
    const writes: string[] = [];
    globalPtys.set('pane-3', {
      ptyProcess: { write: vi.fn((chunk: string) => { writes.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('cursor', 'llm', 'pane-3', 'cursor', '\r');

    registry.send('user', 'close-soon');
    await flushDeliveryQueue();
    globalPtys.delete('pane-3');

    // Adaptive delay: 500 + 34 chars = 534ms
    await vi.advanceTimersByTimeAsync(534);
    await flushDeliveryQueue();

    expect(writes).toEqual([
      '[DevGlide Chat] @user: close-soon',
    ]);
    expect(registry.getParticipant(participant.name)?.paneId).toBeNull();

    registry.leave(participant.name);
  });

  it('broadcasts mentioned messages to every same-project participant except the sender', async () => {
    const writesA: string[] = [];
    const writesB: string[] = [];
    const writesSender: string[] = [];

    globalPtys.set('pane-a', {
      ptyProcess: { write: vi.fn((chunk: string) => { writesSender.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-b', {
      ptyProcess: { write: vi.fn((chunk: string) => { writesA.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-c', {
      ptyProcess: { write: vi.fn((chunk: string) => { writesB.push(chunk); }) } as never,
      chunks: [],
      totalLen: 0,
    });

    const sender = registry.join('sender', 'llm', 'pane-a', 'codex', '\r');
    const target = registry.join('target', 'llm', 'pane-b', 'claude', '\r');
    const observer = registry.join('observer', 'llm', 'pane-c', 'cursor', '\r');

    registry.send(sender.name, `@${target.name} please handle this`);
    await flushDeliveryQueue();

    expect(writesSender).toEqual([]);
    expect(writesA).toEqual([`[DevGlide Chat] @${sender.name}: @${target.name} please handle this`]);
    expect(writesB).toEqual([`[DevGlide Chat] @${sender.name}: @${target.name} please handle this`]);

    registry.leave(sender.name);
    registry.leave(target.name);
    registry.leave(observer.name);
  });

  it('can still enumerate a joined project after the global active project changes', () => {
    globalPtys.set('pane-5', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    const participant = registry.join('claude', 'llm', 'pane-5', 'claude', '\r');
    setActiveProject({ id: 'project-other', name: 'Other', path: '/tmp/other' });

    expect(registry.listParticipants()).toEqual([]);
    expect(registry.listParticipants('project-chat').map((p) => p.name)).toEqual([participant.name]);

    registry.leave(participant.name, 'project-chat');
  });

  it('same display name in two projects does not collide', () => {
    globalPtys.set('pane-p1', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-p2', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    // Join project-chat (active) as claude
    const p1 = registry.join('claude', 'llm', 'pane-p1', 'claude', '\r');

    // Switch to project-other and join as claude with same pane num
    setActiveProject({ id: 'project-other', name: 'Other', path: '/tmp/other' });
    const p2 = registry.join('claude', 'llm', 'pane-p2', 'claude', '\r', 'project-other');

    // Both should coexist — same display name, different projects
    expect(p1.name).toMatch(/^claude/);
    expect(p2.name).toMatch(/^claude/);
    expect(p1.projectId).toBe('project-chat');
    expect(p2.projectId).toBe('project-other');

    // Each project sees only its own participant
    expect(registry.listParticipants('project-chat').map(p => p.name)).toEqual([p1.name]);
    expect(registry.listParticipants('project-other').map(p => p.name)).toEqual([p2.name]);

    // Leaving one does not affect the other
    registry.leave(p2.name, 'project-other');
    expect(registry.listParticipants('project-chat').map(p => p.name)).toEqual([p1.name]);

    registry.leave(p1.name, 'project-chat');
  });
});
