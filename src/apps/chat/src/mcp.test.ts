import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredTools = vi.hoisted(() => new Map<string, (args: any) => Promise<any>>());

const createDevglideMcpServerMock = vi.hoisted(() => vi.fn(() => {
  const server = {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) => {
      registeredTools.set(name, handler);
    }),
  };
  return server;
}));

vi.mock('../../../packages/mcp-utils/src/index.js', () => ({
  createDevglideMcpServer: createDevglideMcpServerMock,
  jsonResult: (data: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }),
  errorResult: (message: string) => ({
    content: [{ type: 'text', text: message }],
    isError: true,
  }),
}));

vi.mock('../services/chat-store.js', () => ({
  readMessages: vi.fn(() => []),
}));

vi.mock('../services/chat-rules.js', () => ({
  getEffectiveRules: vi.fn(() => '## Rules'),
}));

function mockJsonResponse(ok: boolean, status: number, data: unknown) {
  return {
    ok,
    status,
    json: vi.fn(async () => data),
  };
}

function parseJsonResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('chat MCP session ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.clear();
  });

  it('rejects a second join on the same live MCP session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'alpha-1', projectId: 'project-1' }))
      .mockResolvedValueOnce(mockJsonResponse(true, 200, {
        joined: true,
        name: 'alpha-1',
        paneId: 'pane-1',
        detached: false,
        projectId: 'project-1',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { createChatMcpServer, chatServerSessions } = await import('./mcp.js');
    const server = createChatMcpServer();
    const chatJoin = registeredTools.get('chat_join');
    expect(chatJoin).toBeTypeOf('function');

    const first = await chatJoin!({ name: 'alpha', paneId: 'pane-1', submitKey: 'cr' });
    const second = await chatJoin!({ name: 'beta', paneId: 'pane-2', submitKey: 'cr' });

    expect(parseJsonResult(first)).toMatchObject({ name: 'alpha-1', projectId: 'project-1' });
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain('already joined as "alpha-1"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/chat/join');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/chat/status?name=alpha-1&projectId=project-1');
    expect(chatServerSessions.get(server as never)).toEqual([{ name: 'alpha-1', projectId: 'project-1' }]);
  });

  it('allows a new join when the tracked participant is already gone', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'alpha-1', projectId: 'project-1' }))
      .mockResolvedValueOnce(mockJsonResponse(false, 404, { error: 'Participant "alpha-1" not found', joined: false }))
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'beta-2', projectId: 'project-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { createChatMcpServer, chatServerSessions } = await import('./mcp.js');
    const server = createChatMcpServer();
    const chatJoin = registeredTools.get('chat_join');
    expect(chatJoin).toBeTypeOf('function');

    await chatJoin!({ name: 'alpha', paneId: 'pane-1', submitKey: 'cr' });
    const second = await chatJoin!({ name: 'beta', paneId: 'pane-2', submitKey: 'cr' });

    expect(second.isError).not.toBe(true);
    expect(parseJsonResult(second)).toMatchObject({ name: 'beta-2', projectId: 'project-1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(chatServerSessions.get(server as never)).toEqual([{ name: 'beta-2', projectId: 'project-1' }]);
  });

  it('allows a new join when the tracked participant is detached', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'alpha-1', projectId: 'project-1' }))
      .mockResolvedValueOnce(mockJsonResponse(true, 200, {
        joined: true,
        name: 'alpha-1',
        paneId: 'pane-1',
        detached: true,
        projectId: 'project-1',
      }))
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'beta-2', projectId: 'project-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { createChatMcpServer, chatServerSessions } = await import('./mcp.js');
    const server = createChatMcpServer();
    const chatJoin = registeredTools.get('chat_join');
    expect(chatJoin).toBeTypeOf('function');

    await chatJoin!({ name: 'alpha', paneId: 'pane-1', submitKey: 'cr' });
    const second = await chatJoin!({ name: 'beta', paneId: 'pane-2', submitKey: 'cr' });

    expect(second.isError).not.toBe(true);
    expect(parseJsonResult(second)).toMatchObject({ name: 'beta-2', projectId: 'project-1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(chatServerSessions.get(server as never)).toEqual([{ name: 'beta-2', projectId: 'project-1' }]);
  });

  it('rejects overlapping joins on the same MCP session before a second participant is created', async () => {
    const joinResponse = deferred<ReturnType<typeof mockJsonResponse>>();
    const fetchMock = vi.fn(() => joinResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { createChatMcpServer, chatServerSessions } = await import('./mcp.js');
    const server = createChatMcpServer();
    const chatJoin = registeredTools.get('chat_join');
    expect(chatJoin).toBeTypeOf('function');

    const firstJoinPromise = chatJoin!({ name: 'alpha', paneId: 'pane-1', submitKey: 'cr' });
    const second = await chatJoin!({ name: 'beta', paneId: 'pane-2', submitKey: 'cr' });

    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain('already in progress');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    joinResponse.resolve(mockJsonResponse(true, 201, { name: 'alpha-1', projectId: 'project-1' }));
    const first = await firstJoinPromise;

    expect(parseJsonResult(first)).toMatchObject({ name: 'alpha-1', projectId: 'project-1' });
    expect(chatServerSessions.get(server as never)).toEqual([{ name: 'alpha-1', projectId: 'project-1' }]);
  });

  it('rejects overlapping joins while stale-session recovery is still in progress', async () => {
    const statusResponse = deferred<ReturnType<typeof mockJsonResponse>>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'alpha-1', projectId: 'project-1' }))
      .mockImplementationOnce(() => statusResponse.promise)
      .mockResolvedValueOnce(mockJsonResponse(true, 201, { name: 'beta-2', projectId: 'project-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { createChatMcpServer, chatServerSessions } = await import('./mcp.js');
    const server = createChatMcpServer();
    const chatJoin = registeredTools.get('chat_join');
    expect(chatJoin).toBeTypeOf('function');

    await chatJoin!({ name: 'alpha', paneId: 'pane-1', submitKey: 'cr' });

    const firstRecoveryJoin = chatJoin!({ name: 'beta', paneId: 'pane-2', submitKey: 'cr' });
    const secondRecoveryJoin = await chatJoin!({ name: 'gamma', paneId: 'pane-3', submitKey: 'cr' });

    expect(secondRecoveryJoin.isError).toBe(true);
    expect(secondRecoveryJoin.content[0]!.text).toContain('already in progress');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    statusResponse.resolve(mockJsonResponse(false, 404, { error: 'Participant "alpha-1" not found', joined: false }));
    const recovered = await firstRecoveryJoin;

    expect(parseJsonResult(recovered)).toMatchObject({ name: 'beta-2', projectId: 'project-1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(chatServerSessions.get(server as never)).toEqual([{ name: 'beta-2', projectId: 'project-1' }]);
  });
});
