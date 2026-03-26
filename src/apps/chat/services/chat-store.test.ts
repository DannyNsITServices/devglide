import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';

vi.mock('../../../packages/paths.js', () => ({
  projectDataDir: (projectId: string, sub: string) => `/tmp/devglide-chat-store-tests/${projectId}/${sub}`,
}));

vi.mock('../../../project-context.js', () => ({
  getActiveProject: () => ({ id: 'chat-store-project', name: 'Chat Store', path: '/tmp/chat-store-project' }),
}));

const { appendMessage, clearMessages, readMessages } = await import('./chat-store.js');

afterEach(() => {
  rmSync('/tmp/devglide-chat-store-tests', { recursive: true, force: true });
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
    expect(existsSync('/tmp/devglide-chat-store-tests/chat-store-project/chat/pipes/def456.jsonl')).toBe(true);

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
    const pipePath = '/tmp/devglide-chat-store-tests/chat-store-project/chat/pipes/old123.jsonl';
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

    expect(existsSync('/tmp/devglide-chat-store-tests/chat-store-project/chat/pipes/xyz789.jsonl')).toBe(true);

    clearMessages();

    expect(existsSync('/tmp/devglide-chat-store-tests/chat-store-project/chat/pipes/xyz789.jsonl')).toBe(false);
    expect(readMessages({ limit: 100 })).toEqual([]);
  });
});
