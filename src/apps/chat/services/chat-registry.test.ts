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
  updateMessageDelivery: vi.fn(),
  saveParticipants: vi.fn(),
  loadParticipants: vi.fn(() => []),
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

  it('marks assigned participants as working and returns them to idle after inactivity', async () => {
    globalPtys.set('pane-status-working', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    const worker = registry.join('codex', 'llm', 'pane-status-working', 'codex', '\r');

    registry.send('user', `@${worker.name} fix the rendering bug`);
    expect(registry.getParticipant(worker.name)?.status).toBe('working');

    await vi.advanceTimersByTimeAsync(30_000);
    await flushDeliveryQueue();

    expect(registry.getParticipant(worker.name)?.status).toBe('idle');

    registry.leave(worker.name);
  });

  it('marks explicit review assignments as working', () => {
    globalPtys.set('pane-status-review', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });

    const reviewer = registry.join('claude', 'llm', 'pane-status-review', 'claude', '\r');

    registry.send('user', `@${reviewer.name} verify the fix`);

    expect(registry.getParticipant(reviewer.name)?.status).toBe('working');

    registry.leave(reviewer.name);
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

describe('chat-registry PTY status detection (idle/working)', () => {
  let dataListeners: Array<(data: string) => void>;

  function createPtyWithOnData(paneId: string) {
    dataListeners = [];
    const mockEntry = {
      ptyProcess: {
        write: vi.fn(),
        onData: vi.fn((listener: (data: string) => void) => {
          dataListeners.push(listener);
          return {
            dispose: vi.fn(() => {
              const idx = dataListeners.indexOf(listener);
              if (idx >= 0) dataListeners.splice(idx, 1);
            }),
          };
        }),
      } as never,
      chunks: [] as string[],
      totalLen: 0,
    };
    globalPtys.set(paneId, mockEntry);
    return mockEntry;
  }

  function emitPtyData(paneId: string, data: string) {
    const entry = globalPtys.get(paneId) as { chunks: string[]; totalLen: number };
    if (entry) {
      entry.chunks.push(data);
      entry.totalLen += data.length;
    }
    for (const listener of [...dataListeners]) {
      listener(data);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    chatStoreMock.reset();
    chatStoreMock.appendMessage.mockClear();
    chatStoreMock.clearMessages.mockClear();
    globalPtys.clear();
    dataListeners = [];
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

  // ── PTY-driven working status ──────────────────────────────────

  it('sets working on nontrivial PTY output', async () => {
    createPtyWithOnData('pane-pty-w1');
    const participant = registry.join('claude', 'llm', 'pane-pty-w1', 'claude', '\r');
    expect(registry.getParticipant(participant.name)?.status).toBe('idle');

    emitPtyData('pane-pty-w1', 'Compiling src/main.ts...');

    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  it('returns to idle after PTY inactivity timeout (8s)', async () => {
    createPtyWithOnData('pane-pty-w2');
    const participant = registry.join('claude', 'llm', 'pane-pty-w2', 'claude', '\r');

    emitPtyData('pane-pty-w2', 'Building...');
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // After 8s of silence → idle
    await vi.advanceTimersByTimeAsync(8000);

    expect(registry.getParticipant(participant.name)?.status).toBe('idle');

    registry.leave(participant.name);
  });

  it('does not set working on ANSI-only / whitespace-only output', async () => {
    createPtyWithOnData('pane-pty-w3');
    const participant = registry.join('claude', 'llm', 'pane-pty-w3', 'claude', '\r');

    // Pure ANSI escape (cursor move) — no printable content
    emitPtyData('pane-pty-w3', '\x1b[2J\x1b[H');

    expect(registry.getParticipant(participant.name)?.status).toBe('idle');

    registry.leave(participant.name);
  });

  it('keeps working status during PTY activity after review assignment', async () => {
    createPtyWithOnData('pane-pty-w4');
    const participant = registry.join('claude', 'llm', 'pane-pty-w4', 'claude', '\r');

    registry.send('user', `@${participant.name} verify the fix`);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // PTY output should keep the participant in working
    emitPtyData('pane-pty-w4', 'Reading file...');

    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  // ── Prompt detection holds working ──────────────────────────────

  it('holds working when PTY output matches a prompt pattern (prevents idle)', async () => {
    createPtyWithOnData('pane-prompt-1');
    const participant = registry.join('claude', 'llm', 'pane-prompt-1', 'claude', '\r');

    emitPtyData('pane-prompt-1', 'Allow Edit /src/file.ts');

    // Nontrivial output → working immediately
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // After quiescence (2000ms), prompt detected → idle timer cancelled, stays working
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // Even after the normal 8s idle timeout, still working (prompt holds it)
    await vi.advanceTimersByTimeAsync(8000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  it('detects MCP tool permission prompts with double underscores', async () => {
    createPtyWithOnData('pane-prompt-mcp');
    const participant = registry.join('claude', 'llm', 'pane-prompt-mcp', 'claude', '\r');

    emitPtyData('pane-prompt-mcp', 'Allow mcp__devglide-chat__chat_send({"message":"hello"})');
    await vi.advanceTimersByTimeAsync(2000);

    // Prompt holds working indefinitely
    await vi.advanceTimersByTimeAsync(8000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  it('detects generic yes/no prompts and holds working', async () => {
    createPtyWithOnData('pane-prompt-yn');
    const participant = registry.join('codex', 'llm', 'pane-prompt-yn', 'codex', '\r');

    emitPtyData('pane-prompt-yn', 'Do you want to overwrite? (y/n)');
    await vi.advanceTimersByTimeAsync(2000);

    // Prompt holds working
    await vi.advanceTimersByTimeAsync(8000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  it('releases working→idle after prompt is answered (new nontrivial output)', async () => {
    createPtyWithOnData('pane-prompt-answered');
    const participant = registry.join('claude', 'llm', 'pane-prompt-answered', 'claude', '\r');

    // Trigger prompt hold
    emitPtyData('pane-prompt-answered', 'Allow Bash npm test');
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // User responds — nontrivial output arrives, prompt flag clears after quiescence
    emitPtyData('pane-prompt-answered', 'Running tests...');
    await vi.advanceTimersByTimeAsync(2000);

    // Still working but now the idle timer is active
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // After 8s of inactivity → idle (prompt no longer holding)
    await vi.advanceTimersByTimeAsync(8000);
    expect(registry.getParticipant(participant.name)?.status).toBe('idle');

    registry.leave(participant.name);
  });

  it('does not re-trigger prompt hold from stale text after user responds', async () => {
    createPtyWithOnData('pane-prompt-retrigger');
    const participant = registry.join('claude', 'llm', 'pane-prompt-retrigger', 'claude', '\r');

    // First: prompt appears → held working
    emitPtyData('pane-prompt-retrigger', 'Allow Edit /src/file.ts');
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // User responds → new output clears prompt flag
    emitPtyData('pane-prompt-retrigger', 'File saved successfully');
    await vi.advanceTimersByTimeAsync(2000);

    // Delta buffer was cleared so old "Allow Edit" should NOT re-trigger hold
    // After 8s → should go idle
    await vi.advanceTimersByTimeAsync(8000);
    expect(registry.getParticipant(participant.name)?.status).toBe('idle');

    registry.leave(participant.name);
  });

  it('chat-injected PTY text does not clear prompt hold', async () => {
    createPtyWithOnData('pane-prompt-chat-injected');
    const participant = registry.join('claude', 'llm', 'pane-prompt-chat-injected', 'claude', '\r');

    // Prompt detected → held working
    emitPtyData('pane-prompt-chat-injected', 'Allow WebFetch https://example.com');
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    // Chat-injected text arrives — should NOT clear the prompt hold
    emitPtyData('pane-prompt-chat-injected', '[DevGlide Chat] @codex-2: checking now');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(8000);

    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  it('detects lowercase allow prompts', async () => {
    createPtyWithOnData('pane-prompt-lowercase');
    const participant = registry.join('claude', 'llm', 'pane-prompt-lowercase', 'claude', '\r');

    emitPtyData('pane-prompt-lowercase', 'allow webfetch https://example.com');
    await vi.advanceTimersByTimeAsync(2000);

    // Prompt holds working
    await vi.advanceTimersByTimeAsync(8000);
    expect(registry.getParticipant(participant.name)?.status).toBe('working');

    registry.leave(participant.name);
  });

  // ── Watcher lifecycle ─────────────────────────────────────────

  it('cleans up watcher on leave', async () => {
    const mockEntry = createPtyWithOnData('pane-prompt-6');
    const participant = registry.join('claude', 'llm', 'pane-prompt-6', 'claude', '\r');

    expect((mockEntry.ptyProcess as { onData: ReturnType<typeof vi.fn> }).onData).toHaveBeenCalled();

    registry.leave(participant.name);

    expect(dataListeners.length).toBe(0);
  });

  it('cleans up watcher on detach', async () => {
    createPtyWithOnData('pane-prompt-7');
    const participant = registry.join('claude', 'llm', 'pane-prompt-7', 'claude', '\r');

    registry.detach(participant.name);

    expect(dataListeners.length).toBe(0);

    registry.leave(participant.name);
  });
});
