import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_ROOT = join(tmpdir(), 'devglide-chat-store-tests');

vi.mock('../../../packages/paths.js', () => ({
  projectDataDir: (projectId: string, sub: string) => join(TEST_ROOT, projectId, sub),
}));

vi.mock('../../../project-context.js', () => ({
  getActiveProject: () => ({ id: 'chat-store-project', name: 'Chat Store', path: '/tmp/chat-store-project' }),
}));

const { appendMessage, appendPipeEvent, clearMessages, readMessages, readPipeEvents } = await import('./chat-store.js');

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('chat-store', () => {
  it('persists and reads messages', () => {
    appendMessage({
      from: 'user',
      to: null,
      body: 'Hello world',
      type: 'message',
    });

    const messages = readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('Hello world');
  });

  it('clears persisted message history', () => {
    appendMessage({
      from: 'user',
      to: null,
      body: 'test message',
      type: 'message',
    });

    clearMessages();

    expect(readMessages()).toEqual([]);
  });
});

describe('per-pipe JSONL storage', () => {
  it('dual-writes pipe messages to both unified and per-pipe files', () => {
    appendMessage({
      from: 'system',
      to: null,
      body: '#pipe-abc123 Stage handoff',
      type: 'system',
      pipe: { pipeId: 'abc123', mode: 'linear', role: 'handoff', stage: 1 } as any,
    });

    appendMessage({
      from: 'user',
      to: null,
      body: 'Regular chat message',
      type: 'message',
    });

    // Unified log has both messages
    const all = readMessages({ limit: 100 });
    expect(all).toHaveLength(2);

    // Per-pipe read returns only the pipe message
    const pipeMessages = readMessages({ limit: 100, pipeId: 'abc123' });
    expect(pipeMessages).toHaveLength(1);
    expect(pipeMessages[0]?.body).toBe('#pipe-abc123 Stage handoff');
  });

  it('reads from per-pipe file without parsing unified log', () => {
    // Write a pipe message (creates per-pipe file)
    appendMessage({
      from: 'claude-1',
      to: null,
      body: '#pipe-def456 My output',
      type: 'message',
      pipe: { pipeId: 'def456', mode: 'merge-all', role: 'fan-out' } as any,
    });

    // Per-pipe file should exist
    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'def456.jsonl'))).toBe(true);

    // Reading with pipeId should use the per-pipe file
    const result = readMessages({ limit: 100, pipeId: 'def456' });
    expect(result).toHaveLength(1);
    expect(result[0]?.from).toBe('claude-1');
  });

  it('falls back to unified log for pipes without per-pipe file', () => {
    // Simulate pre-migration data: write directly to unified log with pipe metadata
    // by appending a message, then deleting the per-pipe file
    appendMessage({
      from: 'system',
      to: null,
      body: '#pipe-old123 Legacy handoff',
      type: 'system',
      pipe: { pipeId: 'old123', mode: 'linear', role: 'handoff', stage: 1 } as any,
    });

    // Delete the per-pipe file to simulate pre-migration state
    const pipePath = join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'old123.jsonl');
    if (existsSync(pipePath)) {
      rmSync(pipePath);
    }

    // Should fall back to unified log and filter by pipeId
    const result = readMessages({ limit: 100, pipeId: 'old123' });
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe('#pipe-old123 Legacy handoff');
  });

  it('clearMessages removes per-pipe files', () => {
    appendMessage({
      from: 'system',
      to: null,
      body: '#pipe-xyz789 Test',
      type: 'system',
      pipe: { pipeId: 'xyz789', mode: 'linear', role: 'handoff', stage: 1 } as any,
    });

    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'xyz789.jsonl'))).toBe(true);

    clearMessages();

    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'xyz789.jsonl'))).toBe(false);
    expect(readMessages({ limit: 100 })).toEqual([]);
  });

  it('persists pipe UI events without leaking them into chat history', () => {
    appendPipeEvent({
      type: 'stage-output',
      pipeId: 'evt123',
      from: 'claude-1',
      role: 'stage-output',
      stage: 1,
      content: '#pipe-evt123 intermediate analysis',
    });

    expect(readMessages({ limit: 100 })).toEqual([]);

    const allEvents = readPipeEvents({ limit: 100 });
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]?.content).toBe('#pipe-evt123 intermediate analysis');

    const pipeEvents = readPipeEvents({ limit: 100, pipeId: 'evt123' });
    expect(pipeEvents).toHaveLength(1);
    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'evt123.events.jsonl'))).toBe(true);
  });

  it('clearMessages removes persisted pipe UI events', () => {
    appendPipeEvent({
      type: 'instruction',
      pipeId: 'evt999',
      assignee: 'codex-2',
      actionType: 'handoff',
      stage: 2,
    });

    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipe-events.jsonl'))).toBe(true);
    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'evt999.events.jsonl'))).toBe(true);

    clearMessages();

    expect(readPipeEvents({ limit: 100 })).toEqual([]);
    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipe-events.jsonl'))).toBe(false);
    expect(existsSync(join(TEST_ROOT, 'chat-store-project', 'chat', 'pipes', 'evt999.events.jsonl'))).toBe(false);
  });
});
