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
  it('extracts the first #topic from message bodies', () => {
    const message = appendMessage({
      from: 'user',
      to: null,
      body: 'Please handle #rules cleanup first',
      type: 'message',
    });

    expect(message.topic).toBe('rules');
  });

  it('filters history by topic', () => {
    appendMessage({
      from: 'user',
      to: null,
      body: 'Discuss #rules first',
      type: 'message',
    });
    appendMessage({
      from: 'user',
      to: null,
      body: 'Then review #kanban next',
      type: 'message',
    });

    const rulesMessages = readMessages({ topic: 'rules' });
    const kanbanMessages = readMessages({ topic: 'kanban' });

    expect(rulesMessages).toHaveLength(1);
    expect(rulesMessages[0]?.topic).toBe('rules');
    expect(kanbanMessages).toHaveLength(1);
    expect(kanbanMessages[0]?.topic).toBe('kanban');
  });

  it('clears persisted message history', () => {
    appendMessage({
      from: 'user',
      to: null,
      body: 'clear #chat please',
      type: 'message',
    });

    clearMessages();

    expect(readMessages()).toEqual([]);
  });
});
