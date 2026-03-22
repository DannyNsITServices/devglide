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
