import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalPtys } from '../../shell/src/runtime/shell-state.js';
import { setActiveProject } from '../../../project-context.js';

const chatStoreMock = vi.hoisted(() => {
  let seq = 0;
  const messages: any[] = [];
  const pipeEvents: any[] = [];
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
    appendPipeEvent: vi.fn((event: Record<string, unknown>) => {
      const stored = {
        id: `pipe-event-${++seq}`,
        ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        ...event,
      };
      pipeEvents.push(stored);
      return stored;
    }),
    readMessages: vi.fn(() => [...messages]),
    clearMessages: vi.fn(() => {
      messages.length = 0;
      pipeEvents.length = 0;
    }),
    reset: () => {
      seq = 0;
      messages.length = 0;
      pipeEvents.length = 0;
    },
  };
});

vi.mock('./chat-store.js', () => ({
  appendMessage: chatStoreMock.appendMessage,
  appendPipeEvent: chatStoreMock.appendPipeEvent,
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
    chatStoreMock.appendPipeEvent.mockClear();
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

    const startPromise = registry.send('user', `/merge-all-pipe @${alice.name} @${bob.name} review this`);
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
    // Alice has no more slots — her work is complete
    expect(aliceResult.myWorkComplete).toBe(true);
    expect(aliceResult.pendingStages).toBe(0);

    const bobFanOutSubmit = registry.submitPipeStage(pipeId!, bob.name, 'bob blind analysis', 'project-chat');
    await vi.advanceTimersByTimeAsync(2_000);
    const bobFanOutResult = await bobFanOutSubmit;
    expect(bobFanOutResult.ok).toBe(true);
    expect(bobFanOutResult.message?.pipe?.role).toBe('fan-out');
    // Bob is the synthesizer (last assignee) — he still has the final slot pending
    expect(bobFanOutResult.myWorkComplete).toBe(false);
    expect(bobFanOutResult.pendingStages).toBe(1);

    const afterFanOut = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(afterFanOut?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`)).toEqual([
      `${bob.name}:final`,
    ]);

    const bobFinalSubmit = registry.submitPipeStage(pipeId!, bob.name, 'merged final', 'project-chat');
    // Final submit now broadcasts the result to all PTYs via the completion handler,
    // which requires extra timer advancement (1000ms per participant for PTY delivery)
    await vi.advanceTimersByTimeAsync(5_000);
    const bobFinalResult = await bobFinalSubmit;
    expect(bobFinalResult.ok).toBe(true);
    expect(bobFinalResult.message?.pipe?.role).toBe('final');
    // Bob's final submission — all work complete
    expect(bobFinalResult.myWorkComplete).toBe(true);
    expect(bobFinalResult.pendingStages).toBe(0);

    const completed = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(completed?.status).toBe('completed');

    registry.leave(alice.name);
    registry.leave(bob.name);
  });

  it('defaults /explain to active attached LLMs and completes merge-all style orchestration', async () => {
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
    globalPtys.set('pane-c', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    const alice = registry.join('alice', 'llm', 'pane-a', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'pane-b', 'bob', '\r');
    const detached = registry.join('carol', 'llm', 'pane-c', 'carol', '\r');
    registry.join('user-self', 'user', null, null, '\r');
    registry.detach(detached.name);

    const startPromise = registry.send('user', '/explain explain this failure');
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const started = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(started?.mode).toBe('explain');
    expect(started?.assignees).toEqual([alice.name, bob.name]);
    expect(started?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`).sort()).toEqual([
      `${alice.name}:fan-out`,
      `${bob.name}:fan-out`,
    ]);

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'alice explanation', 'project-chat');
    await vi.advanceTimersByTimeAsync(1_000);
    const aliceResult = await aliceSubmit;
    expect(aliceResult.ok).toBe(true);
    // Alice (non-synthesizer) has no more work after fan-out
    expect(aliceResult.myWorkComplete).toBe(true);
    expect(aliceResult.pendingStages).toBe(0);

    const bobFanOutSubmit = registry.submitPipeStage(pipeId!, bob.name, 'bob explanation', 'project-chat');
    await vi.advanceTimersByTimeAsync(2_000);
    const bobFanOutResult = await bobFanOutSubmit;
    expect(bobFanOutResult.ok).toBe(true);
    // Bob (synthesizer) still has the final slot pending
    expect(bobFanOutResult.myWorkComplete).toBe(false);
    expect(bobFanOutResult.pendingStages).toBe(1);

    const afterFanOut = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(afterFanOut?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`)).toEqual([
      `${bob.name}:final`,
    ]);

    const bobFinalSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final explanation', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    const bobFinalResult = await bobFinalSubmit;
    expect(bobFinalResult.ok).toBe(true);
    expect(bobFinalResult.message?.pipe?.role).toBe('final');
    // Bob's final submission — all work complete
    expect(bobFinalResult.myWorkComplete).toBe(true);
    expect(bobFinalResult.pendingStages).toBe(0);

    const completed = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(completed?.status).toBe('completed');

    registry.leave(alice.name);
    registry.leave(bob.name);
    registry.leave(detached.name);
    registry.leave('user-self');
  });

  it('defaults /summarize to active attached LLMs and completes merge-all style orchestration', async () => {
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
    globalPtys.set('pane-c', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    const alice = registry.join('alice', 'llm', 'pane-a', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'pane-b', 'bob', '\r');
    const detached = registry.join('carol', 'llm', 'pane-c', 'carol', '\r');
    registry.join('user-self', 'user', null, null, '\r');
    registry.detach(detached.name);

    const startPromise = registry.send('user', '/summarize summarize this long topic');
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const started = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(started?.mode).toBe('summarize');
    expect(started?.assignees).toEqual([alice.name, bob.name]);
    expect(started?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`).sort()).toEqual([
      `${alice.name}:fan-out`,
      `${bob.name}:fan-out`,
    ]);

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'alice summary', 'project-chat');
    await vi.advanceTimersByTimeAsync(1_000);
    const aliceResult = await aliceSubmit;
    expect(aliceResult.ok).toBe(true);
    expect(aliceResult.myWorkComplete).toBe(true);
    expect(aliceResult.pendingStages).toBe(0);

    const bobFanOutSubmit = registry.submitPipeStage(pipeId!, bob.name, 'bob summary', 'project-chat');
    await vi.advanceTimersByTimeAsync(2_000);
    const bobFanOutResult = await bobFanOutSubmit;
    expect(bobFanOutResult.ok).toBe(true);
    expect(bobFanOutResult.myWorkComplete).toBe(false);
    expect(bobFanOutResult.pendingStages).toBe(1);

    const afterFanOut = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(afterFanOut?.leases.map(lease => `${lease.assignee}:${lease.slotRole}`)).toEqual([
      `${bob.name}:final`,
    ]);

    const bobFinalSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final summary', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    const bobFinalResult = await bobFinalSubmit;
    expect(bobFinalResult.ok).toBe(true);
    expect(bobFinalResult.message?.pipe?.role).toBe('final');
    expect(bobFinalResult.myWorkComplete).toBe(true);
    expect(bobFinalResult.pendingStages).toBe(0);

    const completed = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(completed?.status).toBe('completed');

    registry.leave(alice.name);
    registry.leave(bob.name);
    registry.leave(detached.name);
    registry.leave('user-self');
  });

  it('returns myWorkComplete for linear pipe stages', async () => {
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

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} analyze this`);
    await vi.advanceTimersByTimeAsync(3_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const started = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(started?.mode).toBe('linear');

    // Alice is stage 1 — she has exactly one slot, so after submission she's done
    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    const aliceResult = await aliceSubmit;
    expect(aliceResult.ok).toBe(true);
    expect(aliceResult.myWorkComplete).toBe(true);
    expect(aliceResult.pendingStages).toBe(0);

    // Bob is stage 2 (final) — he also has exactly one slot
    const bobSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    const bobResult = await bobSubmit;
    expect(bobResult.ok).toBe(true);
    expect(bobResult.message?.pipe?.role).toBe('final');
    expect(bobResult.myWorkComplete).toBe(true);
    expect(bobResult.pendingStages).toBe(0);

    const completed = registry.getPipeStoreStatus(pipeId!, 'project-chat');
    expect(completed?.status).toBe('completed');

    registry.leave(alice.name);
    registry.leave(bob.name);
  });

  it('does not emit a private pipe-step event for the final stage submission', async () => {
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

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} analyze this`);
    await vi.advanceTimersByTimeAsync(3_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    await aliceSubmit;

    chatStoreMock.appendPipeEvent.mockClear();

    const finalSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    await finalSubmit;

    const stageOutputCalls = chatStoreMock.appendPipeEvent.mock.calls
      .map(([event]) => event)
      .filter((event: any) => event.type === 'stage-output');
    expect(stageOutputCalls).toEqual([]);

    registry.leave(alice.name);
    registry.leave(bob.name);
  });

  it('preserves the pipe anchor on the public final chat message', async () => {
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

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} analyze this`);
    await vi.advanceTimersByTimeAsync(3_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    await aliceSubmit;

    chatStoreMock.appendMessage.mockClear();

    const finalSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    await finalSubmit;

    const finalMessage = chatStoreMock.appendMessage.mock.calls
      .map(([message]) => message)
      .find((message: any) => message?.pipe?.role === 'final');

    expect(finalMessage).toBeDefined();
    expect(finalMessage!.body).toBe(`#pipe-${pipeId} final output`);

    registry.leave(alice.name);
    registry.leave(bob.name);
  });

  it('final output is NOT PTY-delivered to LLM participants (user-only delivery)', async () => {
    const writesA: string[] = [];
    const writesB: string[] = [];
    globalPtys.set('pane-a', {
      ptyProcess: { write: vi.fn((c: string) => { writesA.push(c); }) } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-b', {
      ptyProcess: { write: vi.fn((c: string) => { writesB.push(c); }) } as never,
      chunks: [],
      totalLen: 0,
    });
    const alice = registry.join('alice', 'llm', 'pane-a', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'pane-b', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do work`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Clear writes from pipe setup (handoff notifications)
    writesA.length = 0;
    writesB.length = 0;

    // Alice submits stage 1
    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    await aliceSubmit;

    // Clear writes from stage 1 handoff to bob
    writesA.length = 0;
    writesB.length = 0;

    // Bob submits final stage
    const bobSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output content', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    await bobSubmit;

    // Neither LLM should have received the final output via PTY
    const allWrites = [...writesA, ...writesB];
    const finalDeliveries = allWrites.filter(w => w.includes('final output content'));
    expect(finalDeliveries).toEqual([]);

    registry.leave(alice.name);
    registry.leave(bob.name);
  });

  it('final output message is persisted with to="user" (not broadcast)', async () => {
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

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do work`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    await aliceSubmit;

    chatStoreMock.appendMessage.mockClear();

    const bobSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    await bobSubmit;

    const finalMessage = chatStoreMock.appendMessage.mock.calls
      .map(([message]) => message)
      .find((message: any) => message?.pipe?.role === 'final');

    expect(finalMessage).toBeDefined();
    expect(finalMessage!.to).toBe('user');

    registry.leave(alice.name);
    registry.leave(bob.name);
  });
});

describe('readPipeOutput entitlement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    chatStoreMock.appendMessage.mockClear();
    chatStoreMock.appendPipeEvent.mockClear();
    globalPtys.clear();
    setActiveProject({ id: 'project-read', name: 'Read', path: '/tmp/read' });
    for (const p of registry.listParticipants()) registry.leave(p.name);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalPtys.clear();
    for (const p of registry.listParticipants()) registry.leave(p.name);
    setActiveProject(null);
  });

  function addPanes(...ids: string[]) {
    for (const id of ids) {
      globalPtys.set(id, { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    }
  }

  it('returns 404 for unknown pipe', () => {
    const result = registry.readPipeOutput('nonexistent', 'alice', 'project-read');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('returns 403 for non-assignee', async () => {
    addPanes('p1', 'p2', 'p3');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');
    registry.join('carol', 'llm', 'p3', 'carol', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do something`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const result = registry.readPipeOutput(pipeId!, 'carol', 'project-read');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('returns prompt payload for stage-1 caller', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do something`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const result = registry.readPipeOutput(pipeId!, alice.name, 'project-read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stagePayload).toContain('Prompt: do something');
      expect(result.data.previousOutput).toBeNull();
    }
  });

  it('returns previous stage output for linear downstream assignee', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do something`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Bob can't read yet — handoff for stage 2 not emitted
    const premature = registry.readPipeOutput(pipeId!, bob.name, 'project-read');
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.status).toBe(409);

    // Alice submits stage 1 → triggers handoff to bob (stage 2)
    const submitPromise = registry.submitPipeStage(pipeId!, alice.name, 'alice output', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await submitPromise;

    // Now bob can read alice's output
    const result = registry.readPipeOutput(pipeId!, bob.name, 'project-read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.previousOutput?.stage).toBe(1);
      expect(result.data.previousOutput?.from).toBe(alice.name);
      expect(result.data.previousOutput?.content).toBe('alice output');
    }
  });

  it('returns 409 for completed pipe', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do something`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Submit both stages to complete the pipe
    const s1 = registry.submitPipeStage(pipeId!, alice.name, 'alice output', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;

    const s2 = registry.submitPipeStage(pipeId!, bob.name, 'bob output', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;

    // Pipe is now completed — reads should fail with 409
    const result = registry.readPipeOutput(pipeId!, bob.name, 'project-read');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it('returns fan-out outputs for synthesizer in merge mode', async () => {
    addPanes('p1', 'p2', 'p3');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');
    const carol = registry.join('carol', 'llm', 'p3', 'carol', '\r');

    const startPromise = registry.send('user', `/merge-pipe @${alice.name} @${bob.name} @${carol.name} review this`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Carol (synthesizer) can't read yet — synth not requested
    const premature = registry.readPipeOutput(pipeId!, carol.name, 'project-read');
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.status).toBe(409);

    // Alice (fan-out) can read her stage payload before submitting
    const fanOutPrompt = registry.readPipeOutput(pipeId!, alice.name, 'project-read');
    expect(fanOutPrompt.ok).toBe(true);
    if (fanOutPrompt.ok) {
      expect(fanOutPrompt.data.stagePayload).toContain('review this');
      expect(fanOutPrompt.data.fanOutOutputs).toBeUndefined();
    }

    // Submit fan-out outputs
    const s1 = registry.submitPipeStage(pipeId!, alice.name, 'alice analysis', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;

    const s2 = registry.submitPipeStage(pipeId!, bob.name, 'bob analysis', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;

    // Now carol can read fan-out outputs
    const result = registry.readPipeOutput(pipeId!, carol.name, 'project-read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fanOutOutputs).toHaveLength(2);
      const fromNames = result.data.fanOutOutputs!.map(o => o.from).sort();
      expect(fromNames).toEqual([alice.name, bob.name]);
    }
  });

  it('returns fan-out prompt payload for non-synth participant in merge mode', async () => {
    addPanes('p1', 'p2', 'p3');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');
    const carol = registry.join('carol', 'llm', 'p3', 'carol', '\r');

    const startPromise = registry.send('user', `/merge-pipe @${alice.name} @${bob.name} @${carol.name} review this`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const result = registry.readPipeOutput(pipeId!, alice.name, 'project-read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stagePayload).toContain('review this');
      expect(result.data.previousOutput).toBeNull();
      expect(result.data.fanOutOutputs).toBeUndefined();
    }
  });

  it('returns prompt payload for merge-all synthesizer during fan-out phase', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const startPromise = registry.send('user', `/explain @${alice.name} @${bob.name} explain this failure`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    const result = registry.readPipeOutput(pipeId!, bob.name, 'project-read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stagePayload).toContain('explain this failure');
      expect(result.data.previousOutput).toBeNull();
      expect(result.data.fanOutOutputs).toBeUndefined();
    }
  });

  it('cross-stage isolation: stage-3 cannot read stage-1 output (only stage-2)', async () => {
    addPanes('p1', 'p2', 'p3');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');
    const carol = registry.join('carol', 'llm', 'p3', 'carol', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} @${carol.name} chain work`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Alice submits stage 1
    const s1 = registry.submitPipeStage(pipeId!, alice.name, 'stage-1 output', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;

    // Bob can read stage 1 (previous to stage 2)
    const bobRead = registry.readPipeOutput(pipeId!, bob.name, 'project-read');
    expect(bobRead.ok).toBe(true);
    if (bobRead.ok) {
      expect(bobRead.data.previousOutput?.stage).toBe(1);
      expect(bobRead.data.previousOutput?.content).toBe('stage-1 output');
    }

    // Carol cannot read yet — handoff for stage 3 not emitted
    const carolPremature = registry.readPipeOutput(pipeId!, carol.name, 'project-read');
    expect(carolPremature.ok).toBe(false);
    if (!carolPremature.ok) expect(carolPremature.status).toBe(409);

    // Bob submits stage 2
    const s2 = registry.submitPipeStage(pipeId!, bob.name, 'stage-2 output', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;

    // Now carol can read stage 2 (not stage 1)
    const carolRead = registry.readPipeOutput(pipeId!, carol.name, 'project-read');
    expect(carolRead.ok).toBe(true);
    if (carolRead.ok) {
      expect(carolRead.data.previousOutput?.stage).toBe(2);
      expect(carolRead.data.previousOutput?.content).toBe('stage-2 output');
    }
  });

  it('handoff prompt does not contain inline output markers', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do something`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-read')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Alice submits stage 1 → triggers handoff to bob
    const submitPromise = registry.submitPipeStage(pipeId!, alice.name, 'big output here', 'project-read');
    await vi.advanceTimersByTimeAsync(2_000);
    await submitPromise;

    // Handoff is delivered via PTY to bob's pane (p2)
    const bobPty = globalPtys.get('p2') as { ptyProcess: { write: ReturnType<typeof vi.fn> } } | undefined;
    expect(bobPty).toBeDefined();
    const writeCall = bobPty!.ptyProcess.write.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes(`#pipe-${pipeId}`) && args[0].includes('stage 2'),
    );
    expect(writeCall).toBeDefined();
    const handoffText = writeCall![0] as string;
    // Must NOT contain inline output
    expect(handoffText).not.toContain('--- Previous stage output ---');
    expect(handoffText).not.toContain('big output here');
    // Must contain pipe_read_output instruction
    expect(handoffText).toContain('pipe_read_output(pipeId=');
  });
});

const brainstormStore = await import('./brainstorm-store.js');

describe('brainstorm command handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    chatStoreMock.appendMessage.mockClear();
    brainstormStore._resetForTest();
    globalPtys.clear();
    setActiveProject({ id: 'project-bs', name: 'BS', path: '/tmp/bs' });
    for (const p of registry.listParticipants()) registry.leave(p.name);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalPtys.clear();
    for (const p of registry.listParticipants()) registry.leave(p.name);
    setActiveProject(null);
  });

  function addPanes(...ids: string[]) {
    for (const id of ids) {
      globalPtys.set(id, { ptyProcess: { write: vi.fn() } as never, chunks: [], totalLen: 0 });
    }
  }

  it('creates a brainstorm record and launches child pipe', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a caching layer`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const brainstorms = registry.getActiveBrainstorms('project-bs');
    expect(brainstorms).toHaveLength(1);
    expect(brainstorms[0].prompt).toBe('design a caching layer');
    expect(brainstorms[0].assignees).toEqual([alice.name, bob.name]);
    expect(brainstorms[0].phase).toBe('ideas');
    expect(brainstorms[0].activeChildPipeId).toBeDefined();
    expect(brainstorms[0].ideaIterations).toBe(1);
  });

  it('defaults to all active LLMs when no assignees specified', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm design a caching layer`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const brainstorms = registry.getActiveBrainstorms('project-bs');
    expect(brainstorms).toHaveLength(1);
    expect(brainstorms[0].assignees.sort()).toEqual([alice.name, bob.name].sort());
  });

  it('emits a start message with brainstorm anchor', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const brainstorms = registry.getActiveBrainstorms('project-bs');
    const startMsg = chatStoreMock.appendMessage.mock.calls
      .map(([m]: [any]) => m)
      .find((m: any) => typeof m?.body === 'string' && m.body.includes('#brainstorm-'));
    expect(startMsg).toBeDefined();
    expect(startMsg.body).toContain(`#brainstorm-${brainstorms[0].id}`);
    expect(startMsg.body).toContain('Phase: Ideas');
  });

  it('rejects with error when fewer than 2 LLMs available', async () => {
    addPanes('p1');
    registry.join('alice', 'llm', 'p1', 'alice', '\r');

    await registry.send('user', `/brainstorm design a cache`);

    const errorMsg = chatStoreMock.appendMessage.mock.calls
      .map(([m]: [any]) => m)
      .find((m: any) => typeof m?.body === 'string' && m.body.includes('Brainstorm error'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg.body).toContain('at least 2');
  });

  it('rejects when first leading @name is unknown', async () => {
    addPanes('p1', 'p2');
    registry.join('alice', 'llm', 'p1', 'alice', '\r');
    registry.join('bob', 'llm', 'p2', 'bob', '\r');

    await registry.send('user', `/brainstorm @ghost design a cache`);

    const errorMsg = chatStoreMock.appendMessage.mock.calls
      .map(([m]: [any]) => m)
      .find((m: any) => typeof m?.body === 'string' && m.body.includes('Brainstorm error'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg.body).toContain('@ghost');
  });

  it('transitions to ideas_review with candidateIdea when child pipe completes', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    const childPipeId = bs.activeChildPipeId!;
    expect(childPipeId).toBeDefined();

    // Submit fan-out outputs from both LLMs, then bob submits final synthesis
    const s1 = registry.submitPipeStage(childPipeId, alice.name, 'alice idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;

    const s2 = registry.submitPipeStage(childPipeId, bob.name, 'bob idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;

    // Bob is the synthesizer in merge-all — submits the final output
    const s3 = registry.submitPipeStage(childPipeId, bob.name, 'synthesized idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s3;

    // Brainstorm should now be in ideas_review with candidateIdea set
    const updated = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(updated?.phase).toBe('ideas_review');
    expect(updated?.candidateIdea).toBeTruthy();
    expect(updated?.acceptedIdea).toBeNull();
    expect(updated?.activeChildPipeId).toBeNull();
  });

  it('retry re-launches a new child pipe with user note', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    const firstChildId = bs.activeChildPipeId!;

    // Complete the first idea round (fan-out + synthesis)
    const s1 = registry.submitPipeStage(firstChildId, alice.name, 'alice idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;
    const s2 = registry.submitPipeStage(firstChildId, bob.name, 'bob idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;
    const s3 = registry.submitPipeStage(firstChildId, bob.name, 'synthesized idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s3;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('ideas_review');

    // Retry with a note
    const retryPromise = registry.brainstormRetryIdeas(bs.id, 'focus on Redis', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    const retried = await retryPromise;
    expect(retried).toBe(true);

    const afterRetry = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(afterRetry?.phase).toBe('ideas');
    expect(afterRetry?.activeChildPipeId).not.toBe(firstChildId);
    expect(afterRetry?.activeChildPipeId).toBeTruthy();
    expect(afterRetry?.ideaIterations).toBe(2);
    expect(afterRetry?.latestUserNote).toBe('focus on Redis');
  });

  it('accept promotes candidateIdea to acceptedIdea and advances to details', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    const childPipeId = bs.activeChildPipeId!;

    // Complete the idea round (fan-out + synthesis)
    const s1 = registry.submitPipeStage(childPipeId, alice.name, 'alice idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;
    const s2 = registry.submitPipeStage(childPipeId, bob.name, 'bob idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;
    const s3 = registry.submitPipeStage(childPipeId, bob.name, 'synthesized idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s3;

    const preAccept = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(preAccept?.phase).toBe('ideas_review');
    expect(preAccept?.candidateIdea).toBeTruthy();
    const candidateBeforeAccept = preAccept!.candidateIdea;

    // Accept the idea (launches detail pipe)
    const acceptPromise = registry.brainstormAcceptIdea(bs.id, 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    const accepted = await acceptPromise;
    expect(accepted).toBe(true);

    const afterAccept = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(afterAccept?.phase).toBe('details');
    expect(afterAccept?.acceptedIdea).toBe(candidateBeforeAccept);
    expect(afterAccept?.candidateIdea).toBeNull();
  });

  it('reject retry when not in ideas_review phase', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    // Still in 'ideas' phase (pipe running), retry should fail
    const retried = await registry.brainstormRetryIdeas(bs.id, null, 'project-bs');
    expect(retried).toBe(false);
  });

  /** Helper: run a brainstorm through idea acceptance, returning the record. */
  async function runThroughIdeaAcceptance(alice: any, bob: any) {
    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    const childId = bs.activeChildPipeId!;

    // Complete merge-all idea round (fan-out + synthesis)
    const s1 = registry.submitPipeStage(childId, alice.name, 'alice idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;
    const s2 = registry.submitPipeStage(childId, bob.name, 'bob idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;
    const s3 = registry.submitPipeStage(childId, bob.name, 'synthesized idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s3;

    // Accept the idea → launches detail pipe
    const acceptPromise = registry.brainstormAcceptIdea(bs.id, 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await acceptPromise;

    return bs;
  }

  it('accept idea launches linear detail pipe', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const bs = await runThroughIdeaAcceptance(alice, bob);
    const record = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(record?.phase).toBe('details');
    expect(record?.acceptedIdea).toBeTruthy();
    expect(record?.activeChildPipeId).toBeTruthy();
    expect(record?.detailIterations).toBe(1);
  });

  it('detail pipe completion transitions to details_review with candidateDraft', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const bs = await runThroughIdeaAcceptance(alice, bob);
    const detailPipeId = registry.getBrainstormRecord(bs.id, 'project-bs')!.activeChildPipeId!;

    // Complete the linear detail pipe (alice stage 1 → bob stage 2 final)
    const d1 = registry.submitPipeStage(detailPipeId, alice.name, 'alice details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d1;
    const d2 = registry.submitPipeStage(detailPipeId, bob.name, 'bob final details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d2;

    const record = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(record?.phase).toBe('details_review');
    expect(record?.candidateDraft).toBeTruthy();
    expect(record?.activeChildPipeId).toBeNull();
  });

  it('finalize accepts draft and launches final pass, then completes brainstorm', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const bs = await runThroughIdeaAcceptance(alice, bob);
    const detailPipeId = registry.getBrainstormRecord(bs.id, 'project-bs')!.activeChildPipeId!;

    // Complete detail pipe
    const d1 = registry.submitPipeStage(detailPipeId, alice.name, 'alice details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d1;
    const d2 = registry.submitPipeStage(detailPipeId, bob.name, 'bob final details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d2;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('details_review');

    // Finalize → launches final pass
    const finalizePromise = registry.brainstormFinalize(bs.id, 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await finalizePromise;

    const afterFinalize = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(afterFinalize?.phase).toBe('finalizing');
    expect(afterFinalize?.acceptedDraft).toBeTruthy();

    // Complete the final pass (single assignee: alice)
    const finalPipeId = afterFinalize!.activeChildPipeId!;
    const f1 = registry.submitPipeStage(finalPipeId, alice.name, 'final comprehensive document', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await f1;

    const completed = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(completed?.phase).toBe('complete');
  });

  it('back to ideas returns to ideas_review from details_review', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const bs = await runThroughIdeaAcceptance(alice, bob);
    const detailPipeId = registry.getBrainstormRecord(bs.id, 'project-bs')!.activeChildPipeId!;

    // Complete detail pipe
    const d1 = registry.submitPipeStage(detailPipeId, alice.name, 'alice details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d1;
    const d2 = registry.submitPipeStage(detailPipeId, bob.name, 'bob final details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d2;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('details_review');

    const backed = await registry.brainstormBackToIdeas(bs.id, 'project-bs');
    expect(backed).toBe(true);
    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('ideas_review');
  });

  it('adjust relaunches detail pass with user note', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const bs = await runThroughIdeaAcceptance(alice, bob);
    const firstDetailId = registry.getBrainstormRecord(bs.id, 'project-bs')!.activeChildPipeId!;

    // Complete detail pipe
    const d1 = registry.submitPipeStage(firstDetailId, alice.name, 'alice details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d1;
    const d2 = registry.submitPipeStage(firstDetailId, bob.name, 'bob final details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await d2;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('details_review');

    // Adjust with a note
    const adjustPromise = registry.brainstormAdjustDetails(bs.id, 'add error handling section', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    const adjusted = await adjustPromise;
    expect(adjusted).toBe(true);

    const afterAdjust = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(afterAdjust?.phase).toBe('details');
    expect(afterAdjust?.activeChildPipeId).not.toBe(firstDetailId);
    expect(afterAdjust?.activeChildPipeId).toBeTruthy();
    expect(afterAdjust?.detailIterations).toBe(2);
    expect(afterAdjust?.latestUserNote).toBe('add error handling section');
  });

  it('idea acceptance clears latestUserNote so it does not leak into detail phase', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    // Start brainstorm and complete idea round
    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    const childId = bs.activeChildPipeId!;

    const s1 = registry.submitPipeStage(childId, alice.name, 'alice idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s1;
    const s2 = registry.submitPipeStage(childId, bob.name, 'bob idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s2;
    const s3 = registry.submitPipeStage(childId, bob.name, 'synthesized idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await s3;

    // Retry with a note
    const retryPromise = registry.brainstormRetryIdeas(bs.id, 'focus on Redis', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await retryPromise;

    // Complete second idea round
    const childId2 = registry.getBrainstormRecord(bs.id, 'project-bs')!.activeChildPipeId!;
    const r1 = registry.submitPipeStage(childId2, alice.name, 'alice redis idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await r1;
    const r2 = registry.submitPipeStage(childId2, bob.name, 'bob redis idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await r2;
    const r3 = registry.submitPipeStage(childId2, bob.name, 'synthesized redis idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await r3;

    // Note should still be set before acceptance
    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.latestUserNote).toBe('focus on Redis');

    // Accept idea → should clear the note
    const acceptPromise = registry.brainstormAcceptIdea(bs.id, 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await acceptPromise;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.latestUserNote).toBeNull();
  });

  it('brainstorm does not add a new PipeMode — child pipes use existing modes', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    const sendPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await sendPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    // The child pipe should be a standard merge-all pipe, not a new "brainstorm" mode
    const childPipeStatus = registry.getPipeStoreStatus(bs.activeChildPipeId!, 'project-bs');
    expect(childPipeStatus?.mode).toBe('merge-all');
  });

  it('full end-to-end brainstorm flow: start → ideas → accept → details → finalize → complete', async () => {
    addPanes('p1', 'p2');
    const alice = registry.join('alice', 'llm', 'p1', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'p2', 'bob', '\r');

    // Phase 1: Start brainstorm → merge-all idea round
    const startPromise = registry.send('user', `/brainstorm @${alice.name} @${bob.name} : design a cache`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const bs = registry.getActiveBrainstorms('project-bs')[0];
    expect(bs.phase).toBe('ideas');

    // Complete merge-all: fan-out + synthesis
    const ideaPipeId = bs.activeChildPipeId!;
    let sub = registry.submitPipeStage(ideaPipeId, alice.name, 'alice idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000); await sub;
    sub = registry.submitPipeStage(ideaPipeId, bob.name, 'bob idea', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000); await sub;
    sub = registry.submitPipeStage(ideaPipeId, bob.name, 'merged idea summary', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000); await sub;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('ideas_review');
    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.candidateIdea).toBeTruthy();

    // Phase 2: Accept idea → linear detail round
    const acceptPromise = registry.brainstormAcceptIdea(bs.id, 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await acceptPromise;

    const afterAccept = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(afterAccept?.phase).toBe('details');
    expect(afterAccept?.acceptedIdea).toBeTruthy();
    const detailPipeId = afterAccept!.activeChildPipeId!;

    // Verify child pipe is a standard linear mode
    expect(registry.getPipeStoreStatus(detailPipeId, 'project-bs')?.mode).toBe('linear');

    // Complete linear: alice stage 1 → bob stage 2 (final)
    sub = registry.submitPipeStage(detailPipeId, alice.name, 'alice details', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000); await sub;
    sub = registry.submitPipeStage(detailPipeId, bob.name, 'detailed draft', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000); await sub;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('details_review');
    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.candidateDraft).toBeTruthy();

    // Phase 3: Finalize → single assignee final pass
    const finalizePromise = registry.brainstormFinalize(bs.id, 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000);
    await finalizePromise;

    const afterFinalize = registry.getBrainstormRecord(bs.id, 'project-bs');
    expect(afterFinalize?.phase).toBe('finalizing');
    expect(afterFinalize?.acceptedDraft).toBeTruthy();
    const finalPipeId = afterFinalize!.activeChildPipeId!;

    // Complete final pass
    sub = registry.submitPipeStage(finalPipeId, alice.name, 'final comprehensive document', 'project-bs');
    await vi.advanceTimersByTimeAsync(2_000); await sub;

    expect(registry.getBrainstormRecord(bs.id, 'project-bs')?.phase).toBe('complete');
    // Brainstorm should no longer appear in active list
    expect(registry.getActiveBrainstorms('project-bs')).toHaveLength(0);
  });
});
