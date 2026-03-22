import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'fs';

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
