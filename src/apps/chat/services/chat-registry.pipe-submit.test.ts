import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalPtys } from '../../shell/src/runtime/shell-state.js';
import { setActiveProject } from '../../../project-context.js';

const chatStoreMock = vi.hoisted(() => {
  let seq = 0;
  const messages: any[] = [];
  return {
    appendMessage: vi.fn((msg: Record<string, unknown>) => {
      const stored = {
        id: `msg-${++seq}`,
        ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        topic: null,
        ...msg,
      };
      messages.push(stored);
      return stored;
    }),
    readMessages: vi.fn(() => [...messages]),
    clearMessages: vi.fn(() => {
      messages.length = 0;
    }),
    reset: () => {
      seq = 0;
      messages.length = 0;
    },
  };
});

vi.mock('./chat-store.js', () => ({
  appendMessage: chatStoreMock.appendMessage,
  readMessages: chatStoreMock.readMessages,
  clearMessages: chatStoreMock.clearMessages,
  saveParticipants: vi.fn(),
  loadParticipants: vi.fn(() => []),
}));

const registry = await import('./chat-registry.js');

describe('chat-registry store-backed pipe submissions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    chatStoreMock.appendMessage.mockClear();
    chatStoreMock.readMessages.mockClear();
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

  it('advances merge-all from blind fan-out to final synthesis', async () => {
    globalPtys.set('pane-a', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-b', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    const alice = registry.join('alice', 'llm', 'pane-a', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'pane-b', 'bob', '\r');

    const startPromise = registry.send('user', `/merge-all-pipe @${alice.name} @${bob.name}: review this`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const started = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(started?.mode).toBe('merge-all');
    expect(started?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`).sort()).toEqual([
      `${alice.name}:fan-out`,
      `${bob.name}:fan-out`,
    ]);

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'alice analysis', 'project-chat');
    await vi.advanceTimersByTimeAsync(1_000);
    const aliceResult = await aliceSubmit;
    expect(aliceResult.ok).toBe(true);
    expect(aliceResult.message?.pipe?.role).toBe('fan-out');

    const bobFanOutSubmit = registry.submitPipeStage(pipeId!, bob.name, 'bob blind analysis', 'project-chat');
    await vi.advanceTimersByTimeAsync(2_000);
    const bobFanOutResult = await bobFanOutSubmit;
    expect(bobFanOutResult.ok).toBe(true);
    expect(bobFanOutResult.message?.pipe?.role).toBe('fan-out');

    const afterFanOut = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(afterFanOut?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`)).toEqual([
      `${bob.name}:final`,
    ]);

    const bobFinalSubmit = registry.submitPipeStage(pipeId!, bob.name, 'merged final', 'project-chat');
    await vi.advanceTimersByTimeAsync(1_000);
    const bobFinalResult = await bobFinalSubmit;
    expect(bobFinalResult.ok).toBe(true);
    expect(bobFinalResult.message?.pipe?.role).toBe('final');

    const completed = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(completed?.status).toBe('completed');

    registry.leave(alice.name);
    registry.leave(bob.name);
  });
});
