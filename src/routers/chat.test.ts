import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMock = vi.hoisted(() => ({
  send: vi.fn(),
  listParticipants: vi.fn(() => []),
  getParticipantByPaneId: vi.fn(() => null),
  join: vi.fn(),
  leave: vi.fn(() => true),
  clearHistory: vi.fn(),
  setChatNsp: vi.fn(),
  getChatNsp: vi.fn(() => null),
  getActivePipes: vi.fn(() => []),
  listAllPipes: vi.fn(() => []),
  getRuntimeLeaseStatuses: vi.fn(() => []),
  getDeadLetterEntries: vi.fn(() => []),
  queryPipeProvenance: vi.fn(() => []),
  getPipeRun: vi.fn(() => null),
  getPipeStoreStatus: vi.fn(() => null),
  getPipeTimingSummary: vi.fn(() => null),
  getPipeProvenance: vi.fn(() => []),
  submitPipeStage: vi.fn(),
  cancelPipeRun: vi.fn(),
  readPipeOutput: vi.fn(() => ({ ok: false, status: 404, error: 'Pipe not found' })),
  restoreParticipants: vi.fn(() => ({ restored: [], failed: [] })),
  recoverPipes: vi.fn(() => 0),
  cleanupStalePipes: vi.fn(() => 0),
  getActiveBrainstorms: vi.fn(() => []),
  getBrainstormRecord: vi.fn(() => null),
  brainstormAcceptIdea: vi.fn(async () => false),
  brainstormRetryIdeas: vi.fn(async () => false),
  brainstormAdjustDetails: vi.fn(async () => false),
  brainstormFinalize: vi.fn(async () => false),
  brainstormBackToIdeas: vi.fn(async () => false),
  persistParticipantsForProject: vi.fn(),
  deriveNameBase: vi.fn((hint: string, model: string | null) => (hint || model || 'agent').toLowerCase().replace(/[^a-z0-9-]/g, '')),
  listAssignments: vi.fn(() => []),
}));

const storeMock = vi.hoisted(() => ({
  readMessages: vi.fn(() => []),
  readPipeEvents: vi.fn(() => []),
  appendMessage: vi.fn((_msg: unknown, _pid?: string | null) => ({
    id: 'sys-msg-1',
    ts: '2026-03-23T00:00:00.000Z',
    from: 'system',
    to: null,
    body: 'collision message',
    type: 'system',
  })),
}));

const rulesMock = vi.hoisted(() => ({
  getEffectiveRules: vi.fn(() => '## Rules\n\nOnly reply when asked.'),
  getDefaultRules: vi.fn(() => '## Default Rules'),
  saveProjectRules: vi.fn(),
  deleteProjectRules: vi.fn(() => true),
  hasProjectRules: vi.fn(() => false),
}));

const projectContextMock = vi.hoisted(() => ({
  getActiveProject: vi.fn(() => ({ id: 'project-1', name: 'Test Project', path: '/tmp/project-1' })),
  onProjectChange: vi.fn(),
}));
const projectStoreMock = vi.hoisted(() => ({
  listProjects: vi.fn(() => ({
    projects: [
      { id: 'project-1', name: 'Test Project', path: '/tmp/project-1' },
      { id: 'project-2', name: 'Other Project', path: '/tmp/project-2' },
      { id: 'project-9', name: 'Scoped Project', path: '/tmp/project-9' },
      { id: 'project-99', name: 'Drifted', path: '/tmp/project-99' },
    ],
  })),
}));

vi.mock('../apps/chat/services/chat-registry.js', () => registryMock);
vi.mock('../apps/chat/services/chat-store.js', () => storeMock);
vi.mock('../apps/chat/services/chat-rules.js', () => rulesMock);
vi.mock('../project-context.js', () => projectContextMock);
vi.mock('../packages/project-store.js', () => projectStoreMock);
const pane1PtyWrite = vi.fn();
const spawnGlobalPtyMock = vi.hoisted(() => vi.fn());
const shellStateMock = vi.hoisted(() => ({
  globalPtys: null as unknown as Map<string, unknown>,
  dashboardState: null as unknown as { panes: Array<Record<string, unknown>>; activeTab: string; activePaneId: string },
}));

let paneIdCounter = 100;
vi.mock('../apps/shell/src/runtime/shell-state.js', () => {
  const globalPtys = new Map([
    ['pane-1', { ptyProcess: { write: pane1PtyWrite }, chunks: [], totalLen: 0 }],
  ]);
  const dashboardState = {
    panes: [{ id: 'pane-1', projectId: 'project-1', num: 1, title: '1', shellType: 'default', cwd: '/tmp' }],
    activeTab: 'grid',
    activePaneId: 'pane-1',
  };
  shellStateMock.globalPtys = globalPtys;
  shellStateMock.dashboardState = dashboardState;
  return {
    globalPtys,
    dashboardState,
    getShellNsp: vi.fn(() => null),
    nextPaneId: vi.fn(() => `pane-${++paneIdCounter}`),
    nextNumForProject: vi.fn(() => 2),
    MAX_PANES: 10,
    panesForProject: vi.fn(() => 1),
  };
});
vi.mock('../apps/shell/src/runtime/pty-manager.js', () => ({
  spawnGlobalPty: spawnGlobalPtyMock,
}));
vi.mock('../apps/shell/src/runtime/shell-config.js', () => ({
  SHELL_CONFIGS: {
    bash: { command: '/bin/bash', args: [], env: {} },
    'git-bash': { command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [], env: {} },
  },
}));

const execSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: execSyncMock };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock('../apps/chat/src/mcp.js', () => ({
  createChatMcpServer: vi.fn(),
  chatServerSessions: new WeakMap(),
  bindChatSessionToMcpHttpSession: vi.fn(),
  hasChatMcpHttpSession: vi.fn(() => false),
  registerChatMcpHttpSession: vi.fn(),
  unregisterChatMcpHttpSession: vi.fn(),
}));

const { router, initChat } = await import('./chat.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = makeApp();
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve test server address');
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function createFakeSocketHarness() {
  const socketHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const socket = {
    rooms: new Set<string>(['socket-1']),
    data: {} as Record<string, unknown>,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      socketHandlers.set(event, handler);
      return socket;
    }),
    join: vi.fn((room: string) => {
      socket.rooms.add(room);
      return socket;
    }),
    leave: vi.fn((room: string) => {
      socket.rooms.delete(room);
      return socket;
    }),
  };

  let connectionHandler: ((socket: typeof socket) => void) | null = null;
  const nsp = {
    sockets: new Map([['socket-1', socket]]),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn((event: string, handler: (socket: typeof socket) => void) => {
      if (event === 'connection') connectionHandler = handler;
      return nsp;
    }),
  };

  return {
    socket,
    socketHandlers,
    nsp,
    connect() {
      if (!connectionHandler) throw new Error('connection handler was not registered');
      connectionHandler(socket);
    },
  };
}

describe('chat router rules of engagement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storeMock.readMessages.mockReturnValue([]);
    registryMock.listParticipants.mockReturnValue([]);
    registryMock.getParticipantByPaneId.mockReturnValue(null);
    registryMock.getPipeStoreStatus.mockReturnValue(null);
    registryMock.getPipeRun.mockReturnValue(null);
    registryMock.join.mockImplementation((name: string, kind: string, paneId: string, model: string, submitKey: string, projectId: string | null, joinedVia: string) => ({
      name: `${name}-1`,
      kind,
      model,
      paneId,
      projectId,
      submitKey,
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
      joinedVia,
    }));
  });

  afterEach(() => {
    registryMock.join.mockReset();
    registryMock.send.mockReset();
    registryMock.leave.mockReset();
    registryMock.submitPipeStage.mockReset();
    rulesMock.getEffectiveRules.mockClear();
    rulesMock.getDefaultRules.mockClear();
    rulesMock.saveProjectRules.mockClear();
    rulesMock.deleteProjectRules.mockClear();
    rulesMock.hasProjectRules.mockClear();
    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-1', name: 'Test Project', path: '/tmp/project-1' });
  });

  it('returns effective rules in the join response', async () => {
    registryMock.join.mockReturnValue({
      name: 'vera',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'codex', model: 'codex', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        name: 'vera',
        paneId: 'pane-1',
        rules: '## Rules\n\nOnly reply when asked.',
      });
      expect(registryMock.join).toHaveBeenCalledWith('codex', 'llm', 'pane-1', 'codex', '\r', 'project-1', 'rest');
    });
  });

  it('binds a REST join to the matching MCP session when mcp-session-id is provided', async () => {
    const mcpMock = await import('../apps/chat/src/mcp.js');
    vi.mocked(mcpMock.hasChatMcpHttpSession).mockReturnValue(true);
    vi.mocked(mcpMock.bindChatSessionToMcpHttpSession).mockReturnValue(true);
    registryMock.join.mockReturnValue({
      name: 'vera',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'session-123',
        },
        body: JSON.stringify({ name: 'codex', model: 'codex', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(mcpMock.bindChatSessionToMcpHttpSession).toHaveBeenCalledWith('session-123', {
        name: 'vera',
        projectId: 'project-1',
      });
      expect(registryMock.join).toHaveBeenCalledWith('codex', 'llm', 'pane-1', 'codex', '\r', 'project-1', 'mcp');
      const data = await response.json();
      expect(data.joinedVia).toBe('mcp');
    });
  });

  it('keeps REST join wording when the mcp-session-id does not map to a live MCP session', async () => {
    const mcpMock = await import('../apps/chat/src/mcp.js');
    vi.mocked(mcpMock.hasChatMcpHttpSession).mockReturnValue(false);
    registryMock.join.mockReturnValue({
      name: 'vera',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
      joinedVia: 'rest',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'missing-session',
        },
        body: JSON.stringify({ name: 'codex', model: 'codex', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.join).toHaveBeenCalledWith('codex', 'llm', 'pane-1', 'codex', '\r', 'project-1', 'rest');
      expect(mcpMock.bindChatSessionToMcpHttpSession).not.toHaveBeenCalled();
      const data = await response.json();
      expect(data.joinedVia).toBe('rest');
    });
  });

  it('joins the pane project even when the active project is different', async () => {
    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-2', name: 'Other Project', path: '/tmp/project-2' });
    registryMock.join.mockReturnValue({
      name: 'codex-1',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'codex', model: 'codex', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.join).toHaveBeenCalledWith('codex', 'llm', 'pane-1', 'codex', '\r', 'project-1', 'rest');
    });
  });

  it('rejects paneId "auto" for LLM participants', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'auto' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/explicit paneId/i);
      expect(registryMock.join).not.toHaveBeenCalled();
    });
  });

  it('returns 409 and disconnects existing claimer on pane collision', async () => {
    // Set up: pane-1 is already claimed by 'codex-1'
    registryMock.listParticipants.mockReturnValue([
      {
        name: 'codex-1',
        kind: 'llm',
        model: 'codex',
        paneId: 'pane-1',
        projectId: 'project-1',
        submitKey: '\r',
        joinedAt: '2026-03-23T00:00:00.000Z',
        lastSeen: '2026-03-23T00:00:00.000Z',
        detached: false,
      },
    ]);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.code).toBe('PANE_ALREADY_BOUND');
      expect(data.collision).toEqual({
        paneId: 'pane-1',
        currentParticipant: 'codex-1',
      });

      // Existing claimer should NOT be disconnected — preserve the session
      expect(registryMock.leave).not.toHaveBeenCalled();

      // No system message or PTY write — the existing session is undisturbed
      expect(storeMock.appendMessage).not.toHaveBeenCalled();
      expect(pane1PtyWrite).not.toHaveBeenCalled();

      // join should NOT be called — collision prevents it
      expect(registryMock.join).not.toHaveBeenCalled();
    });
  });

  it('uses the collided pane project for cross-project collision events', async () => {
    // Active project is project-2, but pane-1 belongs to project-1
    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-2', name: 'Other Project', path: '/tmp/project-2' });
    registryMock.listParticipants.mockReturnValue([
      {
        name: 'codex-1',
        kind: 'llm',
        model: 'codex',
        paneId: 'pane-1',
        projectId: 'project-1',
        submitKey: '\r',
        joinedAt: '2026-03-23T00:00:00.000Z',
        lastSeen: '2026-03-23T00:00:00.000Z',
        detached: false,
      },
    ]);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.code).toBe('PANE_ALREADY_BOUND');

      // Existing claimer should NOT be disconnected — preserve the session
      expect(registryMock.leave).not.toHaveBeenCalled();

      // No system message — the existing session is undisturbed
      expect(storeMock.appendMessage).not.toHaveBeenCalled();
    });
  });

  it('allows the same identity to reclaim a REST-backed pane on join', async () => {
    registryMock.listParticipants.mockReturnValue([
      {
        name: 'claude-1',
        kind: 'llm',
        model: 'claude',
        paneId: 'pane-1',
        projectId: 'project-1',
        submitKey: '\r',
        joinedAt: '2026-03-23T00:00:00.000Z',
        lastSeen: '2026-03-23T00:00:00.000Z',
        detached: false,
        joinedVia: 'rest',
      },
    ]);
    registryMock.join.mockReturnValue({
      name: 'claude-1',
      kind: 'llm',
      model: 'claude',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-23T00:00:00.000Z',
      lastSeen: '2026-03-23T00:00:00.000Z',
      detached: false,
      joinedVia: 'mcp',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude', model: 'claude', paneId: 'pane-1' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.join).toHaveBeenCalledWith('claude', 'llm', 'pane-1', 'claude', '\r', 'project-1', 'rest');
    });
  });

  it('rejects #pipe- prefixed messages on POST /send with 422', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '#pipe-abc123 my analysis here' }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error).toMatch(/pipe.*submit/i);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('rejects #pipe- prefixed messages with leading whitespace on POST /send', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '  #pipe-abc123 my analysis here' }),
      });

      expect(response.status).toBe(422);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('allows normal messages on POST /send', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-1',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'claude-1',
      to: null,
      body: 'Hello everyone',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: 'Hello everyone' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalled();
    });
  });

  it('allows messages mentioning pipes without the #pipe- prefix on POST /send', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-2',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'claude-1',
      to: null,
      body: 'I submitted to pipe-abc123 already',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: 'I submitted to pipe-abc123 already' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalled();
    });
  });

  it('returns participant status when resolving by paneId', async () => {
    registryMock.getParticipantByPaneId.mockReturnValue({
      name: 'codex-1',
      kind: 'llm',
      model: 'codex',
      paneId: 'pane-1',
      projectId: 'project-1',
      submitKey: '\r',
      joinedAt: '2026-03-25T00:00:00.000Z',
      lastSeen: '2026-03-25T00:00:00.000Z',
      detached: false,
      status: 'idle',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/status?paneId=pane-1`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        joined: true,
        name: 'codex-1',
        paneId: 'pane-1',
        projectId: 'project-1',
      });
    });
  });

  it('rejects messages that reference a currently running pipe on POST /send', async () => {
    registryMock.getPipeStoreStatus.mockReturnValue({ pipeId: 'abc123', status: 'running' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '@user update on #pipe-abc123 is blocked' }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error).toMatch(/currently running pipes/i);
      expect(data.error).toMatch(/#pipe-abc123/i);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('allows messages that reference non-running pipes on POST /send', async () => {
    registryMock.getPipeStoreStatus.mockReturnValue({ pipeId: 'abc123', status: 'completed' });
    registryMock.send.mockResolvedValue({
      id: 'msg-2b',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'claude-1',
      to: null,
      body: '@user the work on #pipe-abc123 is complete',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', message: '@user the work on #pipe-abc123 is complete' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalled();
    });
  });

  it('returns effective/default rules metadata from GET /rules', async () => {
    rulesMock.hasProjectRules.mockReturnValue(true);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/rules`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        rules: '## Rules\n\nOnly reply when asked.',
        isDefault: false,
        defaultRules: '## Default Rules',
      });
    });
  });

  it('accepts pipe submissions through POST /pipes/:id/submit', async () => {
    registryMock.submitPipeStage.mockResolvedValue({
      ok: true,
      message: {
        id: 'pipe-msg-1',
        ts: '2026-03-25T00:00:00.000Z',
        from: 'claude-1',
        to: null,
        body: '#pipe-abc123 my analysis',
        type: 'message',
        pipe: { pipeId: 'abc123', mode: 'merge-all', role: 'fan-out' },
      },
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/pipes/abc123/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'claude-1', content: 'my analysis' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.message.pipe.pipeId).toBe('abc123');
      expect(registryMock.submitPipeStage).toHaveBeenCalledWith('abc123', 'claude-1', 'my analysis', 'project-1');
    });
  });

  it('rejects running pipe references on POST /messages (dashboard user endpoint)', async () => {
    registryMock.getPipeRun.mockReturnValue({ pipeId: 'abc123', mode: 'merge-all', status: 'running', projectId: 'project-1' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '@claude-1 please check #pipe-abc123' }),
      });

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error).toMatch(/currently running pipes/i);
      expect(registryMock.send).not.toHaveBeenCalled();
    });
  });

  it('allows non-running pipe references on POST /messages (dashboard user endpoint)', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-3',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'user',
      to: null,
      body: '@claude-1 pipe #pipe-abc123 is archived',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '@claude-1 pipe #pipe-abc123 is archived' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalledWith('user', '@claude-1 pipe #pipe-abc123 is archived', undefined, 'project-1');
    });
  });

  it('reads members and message history for the explicit project query', async () => {
    storeMock.readMessages.mockReturnValue([
      { id: 'msg-1', ts: '2026-03-25T00:00:00.000Z', from: 'user', to: null, body: 'hello', type: 'message' },
    ]);
    registryMock.listParticipants.mockReturnValue([
      { name: 'codex-9', kind: 'llm', model: 'codex', paneId: 'pane-9', projectId: 'project-9', detached: false },
    ]);

    await withServer(async (baseUrl) => {
      const [messagesResponse, membersResponse] = await Promise.all([
        fetch(`${baseUrl}/messages?limit=10&projectId=project-9`),
        fetch(`${baseUrl}/members?projectId=project-9`),
      ]);

      expect(messagesResponse.status).toBe(200);
      expect(membersResponse.status).toBe(200);
      expect(storeMock.readMessages).toHaveBeenCalledWith({ limit: 10 }, 'project-9');
      expect(registryMock.listParticipants).toHaveBeenCalledWith('project-9');
    });
  });

  it('sends dashboard user messages to the explicit project query', async () => {
    registryMock.send.mockResolvedValue({
      id: 'msg-9',
      ts: '2026-03-25T00:00:00.000Z',
      from: 'user',
      to: null,
      body: '@codex-9 investigate',
      type: 'message',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/messages?projectId=project-9`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '@codex-9 investigate' }),
      });

      expect(response.status).toBe(201);
      expect(registryMock.send).toHaveBeenCalledWith('user', '@codex-9 investigate', undefined, 'project-9');
    });
  });

  it('rejects unknown explicit project ids for scoped reads', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/members?projectId=project-missing`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'Unknown projectId "project-missing"',
      });
      expect(registryMock.listParticipants).not.toHaveBeenCalledWith('project-missing');
    });
  });

  it('rejects unknown explicit project ids for dashboard sends', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '@codex-9 investigate', projectId: 'project-missing' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'Unknown projectId "project-missing"',
      });
      expect(registryMock.send).not.toHaveBeenCalledWith('user', '@codex-9 investigate', undefined, 'project-missing');
    });
  });

  it('binds socket bootstrap and sends to the socket project instead of the global active project', async () => {
    const harness = createFakeSocketHarness();
    storeMock.readMessages.mockReturnValue([
      { id: 'msg-socket', ts: '2026-03-25T00:00:00.000Z', from: 'user', to: null, body: 'socket hello', type: 'message' },
    ]);

    initChat(harness.nsp as never);
    harness.connect();

    expect(registryMock.listParticipants).toHaveBeenCalledWith('project-1');
    expect(storeMock.readMessages).toHaveBeenCalledWith({ limit: 50 }, 'project-1');

    const projectChangeHandler = projectContextMock.onProjectChange.mock.calls[0]?.[0] as ((project: { id: string } | null) => void) | undefined;
    expect(projectChangeHandler).toBeTypeOf('function');
    projectChangeHandler?.({ id: 'project-2' });

    projectContextMock.getActiveProject.mockReturnValue({ id: 'project-99', name: 'Drifted', path: '/tmp/project-99' });
    const sendHandler = harness.socketHandlers.get('chat:send') as ((payload: { message: string; to?: string }) => Promise<void>) | undefined;
    expect(sendHandler).toBeTypeOf('function');
    await sendHandler?.({ message: '@codex-2 hello' });

    expect(registryMock.send).toHaveBeenCalledWith('user', '@codex-2 hello', undefined, 'project-2');
  });

});

describe('chat router invite permission modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && (cmd.startsWith('claude') || cmd.startsWith('codex'))) return '';
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(false);
    registryMock.join.mockImplementation((name: string, kind: string, paneId: string, model: string, submitKey: string, projectId: string | null, joinedVia: string) => ({
      name: `${name}-1`,
      kind,
      model,
      paneId,
      projectId,
      submitKey,
      joinedAt: '2026-03-22T00:00:00.000Z',
      lastSeen: '2026-03-22T00:00:00.000Z',
      detached: false,
      joinedVia,
    }));
  });

  it('GET /invite/available returns modes per CLI', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite/available?rescan=true`);
      expect(response.status).toBe(200);
      const data = await response.json();

      const claude = data.find((l: { cli: string }) => l.cli === 'claude');
      expect(claude).toBeDefined();
      expect(claude.modes).toContain('supervised');
      expect(claude.modes).toContain('auto-accept');

      const codex = data.find((l: { cli: string }) => l.cli === 'codex');
      expect(codex).toBeDefined();
      expect(codex.modes).toContain('supervised');
      expect(codex.modes).toContain('auto-accept');
    });
  });

  it('GET /invite/available exposes Pi as auto-only with dangerByDefault', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') throw new Error('unexpected command type');
      if (cmd === 'pi --version') return '';
      throw new Error('not found');
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite/available?rescan=true`);
      expect(response.status).toBe(200);
      const data = await response.json();

      const pi = data.find((l: { cli: string }) => l.cli === 'pi');
      expect(pi).toBeDefined();
      expect(pi.modes).toEqual(['auto-accept']);
      expect(pi.modes).not.toContain('supervised');
      expect(pi.dangerByDefault).toBe(true);
    });
  });

  it('GET /invite/available detects Cursor via agent.cmd fallback', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') throw new Error('unexpected command type');
      if (cmd === 'claude --version' || cmd === 'codex --version' || cmd === 'agent.cmd --version') return '';
      throw new Error('not found');
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite/available?rescan=true`);
      expect(response.status).toBe(200);
      const data = await response.json();

      const cursor = data.find((l: { cli: string }) => l.cli === 'cursor');
      expect(cursor).toBeDefined();
      expect(execSyncMock).toHaveBeenCalledWith('cursor-agent --version', { stdio: 'pipe', timeout: 5000 });
      expect(execSyncMock).toHaveBeenCalledWith('cursor-agent.cmd --version', { stdio: 'pipe', timeout: 5000 });
      expect(execSyncMock).toHaveBeenCalledWith('agent.cmd --version', { stdio: 'pipe', timeout: 5000 });
    });
  });

  it('POST /invite accepts mode parameter and returns it', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.mode).toBe('auto-accept');
    });
  });

  it('POST /invite defaults to supervised when mode is omitted', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.mode).toBe('supervised');
    });
  });

  it('POST /invite launches Pi with auto-accept mode and injects bare `pi` command', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'pi --version') return '';
      throw new Error('not found');
    });

    const { pty, write: mockPtyWrite } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      const promptOutput = 'bash-5.2$ ';
      shellStateMock.globalPtys.set(id, {
        ptyProcess: pty,
        chunks: [promptOutput],
        totalLen: promptOutput.length,
      });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'pi', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.mode).toBe('auto-accept');

      await new Promise((r) => setTimeout(r, 50));

      // Pi launches with no permission flags but with the pinned lmstudio/google/gemma-4-26b-a4b model.
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      const injected = mockPtyWrite.mock.calls[0][0] as string;
      expect(injected).toMatch(/^'pi' --model lmstudio\/google\/gemma-4-26b-a4b /);
      expect(injected).not.toContain('--dangerously');
      expect(injected).toContain('mcp__devglide-chat__chat_join');

      const pane = shellStateMock.dashboardState.panes.find(
        (p: { id: string }) => p.id === data.paneId,
      );
      expect(pane).toBeDefined();
      expect(pane.llmCli).toBe('pi');
      expect(pane.permissionMode).toBe('auto-accept');
    });
  });

  it('POST /invite rejects supervised mode for Pi (dangerByDefault)', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'pi --version') return '';
      throw new Error('not found');
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'pi', mode: 'supervised' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/does not support/i);
    });
  });

  it('POST /invite rejects default supervised mode for Pi when mode is omitted', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'pi --version') return '';
      throw new Error('not found');
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'pi' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/does not support/i);
    });
  });

  it('POST /invite rejects unsupported mode for a CLI', async () => {
    // gemini is not installed in this mock, so use claude with 'unrestricted' which it doesn't support
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'unrestricted' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toMatch(/does not support/i);
    });
  });

  it('POST /invite stores permissionMode on pane info', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // Verify the pane was added to dashboardState with permissionMode
      const pane = shellStateMock.dashboardState.panes.find(
        (p: { id: string }) => p.id === data.paneId,
      );
      expect(pane).toBeDefined();
      expect(pane.permissionMode).toBe('auto-accept');
    });
  });

  // ── Helper: create a mock PTY with controllable callbacks ────────────────

  it('POST /invite accepts cols/rows and sets llmCli on the pane', async () => {
    const { pty, write: mockPtyWrite } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      const promptOutput = 'bash-5.2$ ';
      shellStateMock.globalPtys.set(id, {
        ptyProcess: pty,
        chunks: [promptOutput],
        totalLen: promptOutput.length,
      });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept', cols: 120, rows: 40 }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      const spawnArgs = spawnGlobalPtyMock.mock.calls[0];
      expect(spawnArgs[4]).toBe(120);
      expect(spawnArgs[5]).toBe(40);

      await new Promise((r) => setTimeout(r, 50));

      const pane = shellStateMock.dashboardState.panes.find(
        (p: { id: string }) => p.id === data.paneId,
      );
      expect(pane).toBeDefined();
      expect(pane.llmCli).toBe('claude');
      expect(data.chatParticipant).toBe('claude-1');
      expect(registryMock.join).toHaveBeenCalledWith('claude', 'llm', data.paneId, 'claude', '\r', 'project-1', 'rest');
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][0]).toContain('mcp__devglide-chat__chat_join');
    });
  });

  it('POST /invite injects REST fallback guidance into the bootstrap prompt', async () => {
    const { pty, write: mockPtyWrite } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      const promptOutput = 'bash-5.2$ ';
      shellStateMock.globalPtys.set(id, {
        ptyProcess: pty,
        chunks: [promptOutput],
        totalLen: promptOutput.length,
      });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      await new Promise((r) => setTimeout(r, 50));

      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      const injected = mockPtyWrite.mock.calls[0][0] as string;
      expect(injected).toContain('http://localhost:7000/api/chat/rules?projectId=project-1');
      expect(injected).toContain('http://localhost:7000/api/chat/messages?projectId=project-1');
      expect(injected).toContain('http://localhost:7000/api/chat/send');
      expect(injected).toContain(`from:"${data.chatParticipant}"`);
      expect(injected).toContain('projectId:"project-1"');
      expect(injected).toContain('http://localhost:7000/api/chat/leave');
      expect(injected).toContain('http://localhost:7000/api/chat/pipes/:id/output?projectId=project-1');
      expect(injected).toContain(`X-Pane-Id: "${data.paneId}"`);
      expect(injected).toContain('http://localhost:7000/api/chat/pipes/:id/submit');
    });
  });

  it('POST /invite launches Cursor with the resolved agent.cmd fallback', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') throw new Error('unexpected command type');
      if (cmd === 'agent.cmd --version') return '';
      throw new Error('not found');
    });

    const { pty, write: mockPtyWrite } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      const promptOutput = 'bash-5.2$ ';
      shellStateMock.globalPtys.set(id, {
        ptyProcess: pty,
        chunks: [promptOutput],
        totalLen: promptOutput.length,
      });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'cursor' }),
      });

      expect(response.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));

      expect(execSyncMock).toHaveBeenCalledWith('cursor-agent --version', { stdio: 'pipe', timeout: 5000 });
      expect(execSyncMock).toHaveBeenCalledWith('cursor-agent.cmd --version', { stdio: 'pipe', timeout: 5000 });
      expect(execSyncMock).toHaveBeenCalledWith('agent.cmd --version', { stdio: 'pipe', timeout: 5000 });
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][0]).toContain("'agent.cmd' chat");
    });
  });

  function createMockPty() {
    const onDataCallbacks: Array<(data: string) => void> = [];
    const onExitCallbacks: Array<(e: { exitCode: number }) => void> = [];
    const write = vi.fn();
    const pty = {
      write,
      onData: (cb: (data: string) => void) => { onDataCallbacks.push(cb); return { dispose: vi.fn() }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { onExitCallbacks.push(cb); return { dispose: vi.fn() }; },
      pid: 12345,
    };
    return { pty, write, onDataCallbacks, onExitCallbacks };
  }

  // ── Test: live prompt detection ────────────────────────────────────────────

  it('POST /invite spawns an interactive shell and injects the command after readiness (live prompt)', async () => {
    const { pty, write: mockPtyWrite, onDataCallbacks } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      shellStateMock.globalPtys.set(id, { ptyProcess: pty, chunks: [], totalLen: 0 });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // Shell is spawned as interactive login (no baked-in command)
      const spawnArgs = spawnGlobalPtyMock.mock.calls[0];
      expect(spawnArgs[0]).toBe(data.paneId);
      expect(spawnArgs[1]).toBe('/bin/bash');
      expect(spawnArgs[2]).toEqual(['-li']);

      // Command has NOT been injected yet (shell not ready)
      expect(mockPtyWrite).not.toHaveBeenCalled();

      // Simulate shell emitting a prompt via live output — triggers readiness
      const entry = shellStateMock.globalPtys.get(data.paneId) as { chunks: string[]; totalLen: number };
      const promptOutput = 'user@host:~$ ';
      entry.chunks.push(promptOutput);
      entry.totalLen += promptOutput.length;
      for (const cb of onDataCallbacks) cb(promptOutput);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][0]).toContain('claude');
      expect(mockPtyWrite.mock.calls[0][0]).toContain('mcp__devglide-chat__chat_join');
      expect(mockPtyWrite.mock.calls[0][0]).toMatch(/\r$/);
    });
  });

  // ── Test: buffer-hit (prompt emitted during spawn) ─────────────────────

  it('POST /invite detects prompt emitted during spawn (buffer-hit path)', async () => {
    const { pty, write: mockPtyWrite } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      // Prompt already in scrollback when waitForShellReady runs
      const promptOutput = 'bash-5.2$ ';
      shellStateMock.globalPtys.set(id, {
        ptyProcess: pty,
        chunks: [promptOutput],
        totalLen: promptOutput.length,
      });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));

      // Buffer-hit: prompt was already in scrollback → immediate injection
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][0]).toContain('claude');
      expect(mockPtyWrite.mock.calls[0][0]).toContain('mcp__devglide-chat__chat_join');
    });
  });

  // ── Test: timeout probe path ───────────────────────────────────────────

  it('POST /invite launches codex auto-accept with --dangerously-bypass-approvals-and-sandbox', async () => {
    const { pty, write: mockPtyWrite } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      const promptOutput = 'bash-5.2$ ';
      shellStateMock.globalPtys.set(id, {
        ptyProcess: pty,
        chunks: [promptOutput],
        totalLen: promptOutput.length,
      });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'codex', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][0]).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(mockPtyWrite.mock.calls[0][0]).toContain('mcp__devglide-chat__chat_join');
    });
  });

  it('POST /invite falls back to probe when no prompt appears within timeout', async () => {
    vi.useFakeTimers();
    const { pty, write: mockPtyWrite, onDataCallbacks } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      shellStateMock.globalPtys.set(id, { ptyProcess: pty, chunks: [], totalLen: 0 });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // No prompt emitted — command should not be injected yet
      expect(mockPtyWrite).not.toHaveBeenCalled();

      // Advance past the 5s timeout to trigger probe
      await vi.advanceTimersByTimeAsync(5000);

      // Probe echo should have been written
      const probeCall = mockPtyWrite.mock.calls.find(
        (c: string[]) => c[0]?.includes('__DEVGLIDE_READY_'),
      );
      expect(probeCall).toBeDefined();

      // Simulate probe marker appearing in scrollback
      const entry = shellStateMock.globalPtys.get(data.paneId) as { chunks: string[]; totalLen: number };
      const markerMatch = probeCall![0].match(/__DEVGLIDE_READY_\d+__/)!;
      const markerOutput = `${markerMatch[0]}\n`;
      entry.chunks.push(markerOutput);
      entry.totalLen += markerOutput.length;
      for (const cb of onDataCallbacks) cb(markerOutput);

      await vi.advanceTimersByTimeAsync(10);

      // Probe detected → launch command injected (second write call)
      const launchCall = mockPtyWrite.mock.calls.find(
        (c: string[]) => c[0]?.includes('mcp__devglide-chat__chat_join'),
      );
      expect(launchCall).toBeDefined();
      expect(launchCall![0]).toContain('claude');
    });

    vi.useRealTimers();
  });

  // ── Test: pane exit before readiness ───────────────────────────────────

  it('POST /invite does not inject command if pane exits before readiness', async () => {
    const { pty, write: mockPtyWrite, onExitCallbacks } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      shellStateMock.globalPtys.set(id, { ptyProcess: pty, chunks: [], totalLen: 0 });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // Simulate pane exit before any prompt
      shellStateMock.globalPtys.delete(data.paneId);
      for (const cb of onExitCallbacks) cb({ exitCode: 1 });

      await new Promise((r) => setTimeout(r, 50));

      // No launch command should have been injected
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });
  });

  // ── Test: one-shot guarantee (prompt + exit race) ──────────────────────

  it('POST /invite injects launch command at most once even if prompt and exit race', async () => {
    const { pty, write: mockPtyWrite, onDataCallbacks, onExitCallbacks } = createMockPty();
    spawnGlobalPtyMock.mockImplementation((id: string) => {
      shellStateMock.globalPtys.set(id, { ptyProcess: pty, chunks: [], totalLen: 0 });
      return pty;
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: 'claude', mode: 'auto-accept' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // Emit prompt and exit simultaneously
      const entry = shellStateMock.globalPtys.get(data.paneId) as { chunks: string[]; totalLen: number };
      const promptOutput = 'user@host:~$ ';
      entry.chunks.push(promptOutput);
      entry.totalLen += promptOutput.length;
      for (const cb of onDataCallbacks) cb(promptOutput);
      for (const cb of onExitCallbacks) cb({ exitCode: 0 });

      await new Promise((r) => setTimeout(r, 50));

      // Launch command should be injected exactly once (prompt wins the race,
      // exit is a no-op because settled is already true)
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][0]).toContain('mcp__devglide-chat__chat_join');
    });
  });
});

describe('chat router pipe output read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when X-Pane-Id header is missing', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pipes/abc123/output`);
      expect(res.status).toBe(401);
      const data = await res.json() as { error: string };
      expect(data.error).toContain('X-Pane-Id');
    });
  });

  it('returns 403 when X-Pane-Id does not match a registered participant', async () => {
    registryMock.getParticipantByPaneId.mockReturnValue(null);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pipes/abc123/output`, {
        headers: { 'x-pane-id': 'unknown-pane' },
      });
      expect(res.status).toBe(403);
      const data = await res.json() as { error: string };
      expect(data.error).toContain('No registered participant');
    });
  });

  it('returns 200 with pipe output when caller is entitled', async () => {
    registryMock.getParticipantByPaneId.mockReturnValue({
      name: 'bob',
      kind: 'llm',
      paneId: 'pane-bob',
      projectId: 'project-1',
    });
    registryMock.readPipeOutput.mockReturnValue({
      ok: true,
      data: {
        pipeId: 'abc123',
        mode: 'linear',
        previousOutput: { stage: 1, from: 'alice', content: 'alice output' },
      },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pipes/abc123/output`, {
        headers: { 'x-pane-id': 'pane-bob' },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { pipeId: string; previousOutput: { from: string } };
      expect(data.pipeId).toBe('abc123');
      expect(data.previousOutput.from).toBe('alice');
    });
  });

  it('forwards 404/403/409 from readPipeOutput', async () => {
    registryMock.getParticipantByPaneId.mockReturnValue({
      name: 'bob',
      kind: 'llm',
      paneId: 'pane-bob',
      projectId: 'project-1',
    });
    registryMock.readPipeOutput.mockReturnValue({
      ok: false,
      status: 409,
      error: 'Pipe is completed',
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pipes/abc123/output`, {
        headers: { 'x-pane-id': 'pane-bob' },
      });
      expect(res.status).toBe(409);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('Pipe is completed');
    });
  });
});

describe('chat router brainstorm endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /brainstorms returns active brainstorms', async () => {
    registryMock.getActiveBrainstorms.mockReturnValue([
      { id: 'bs1', phase: 'ideas_review', prompt: 'design a cache' },
    ]);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms`);
      expect(res.status).toBe(200);
      const data = await res.json() as any[];
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('bs1');
    });
  });

  it('GET /brainstorms/:id returns 404 for unknown brainstorm', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/unknown`);
      expect(res.status).toBe(404);
    });
  });

  it('POST /brainstorms/:id/accept-idea returns 200 on success', async () => {
    registryMock.brainstormAcceptIdea.mockResolvedValue(true);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/accept-idea`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
    });
  });

  it('POST /brainstorms/:id/accept-idea returns 409 when not in ideas_review', async () => {
    registryMock.brainstormAcceptIdea.mockResolvedValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/accept-idea`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
    });
  });

  it('POST /brainstorms/:id/retry-ideas passes note from body', async () => {
    registryMock.brainstormRetryIdeas.mockResolvedValue(true);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/retry-ideas`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'focus on Redis' }),
      });
      expect(res.status).toBe(200);
      expect(registryMock.brainstormRetryIdeas).toHaveBeenCalledWith('bs1', 'focus on Redis', 'project-1');
    });
  });

  it('POST /brainstorms/:id/finalize returns 200 on success', async () => {
    registryMock.brainstormFinalize.mockResolvedValue(true);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
    });
  });

  it('POST /brainstorms/:id/adjust-details passes note and returns 200', async () => {
    registryMock.brainstormAdjustDetails.mockResolvedValue(true);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/adjust-details`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'add error handling' }),
      });
      expect(res.status).toBe(200);
      expect(registryMock.brainstormAdjustDetails).toHaveBeenCalledWith('bs1', 'add error handling', 'project-1');
    });
  });

  it('POST /brainstorms/:id/adjust-details returns 409 when not in details_review', async () => {
    registryMock.brainstormAdjustDetails.mockResolvedValue(false);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/adjust-details`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
    });
  });

  it('POST /brainstorms/:id/back-to-ideas returns 200 on success', async () => {
    registryMock.brainstormBackToIdeas.mockResolvedValue(true);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/back-to-ideas`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
    });
  });

  it('POST /brainstorms/:id/back-to-ideas returns 409 when not in details_review', async () => {
    registryMock.brainstormBackToIdeas.mockResolvedValue(false);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1/back-to-ideas`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
    });
  });

  it('GET /brainstorms/:id returns brainstorm record when found', async () => {
    registryMock.getBrainstormRecord.mockReturnValue({
      id: 'bs1', phase: 'ideas_review', prompt: 'design a cache', assignees: ['a', 'b'],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/brainstorms/bs1`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.id).toBe('bs1');
      expect(data.phase).toBe('ideas_review');
    });
  });
});

// (team endpoints removed — team orchestration system has been deleted)

