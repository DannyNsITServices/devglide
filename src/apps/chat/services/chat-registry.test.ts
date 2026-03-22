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

    // First submit key after 500ms
    await vi.advanceTimersByTimeAsync(500);
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

    // Second message: first submit after 500ms
    await vi.advanceTimersByTimeAsync(500);
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

    await vi.advanceTimersByTimeAsync(500);
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

    await vi.advanceTimersByTimeAsync(500);
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

    await vi.advanceTimersByTimeAsync(500);
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
});
